# 029 — CI on Python 3.14, and a smoke test that the packaged backend actually starts

**Status:** Implemented
**Branch:** `feature/ci-python-314-and-sidecar-smoke`
**Scope:** CI workflows + one new script + tests. No application code.

## Why

Two problems with one root: **CI does not build or run the thing we ship on the interpreter we develop against.**

### 1. The shipped sidecar is on a slower zlib than the dev machine

CPython switched its Windows build to zlib-ng in 3.14. Measured on one machine, same real
payload, so this is a build difference and not hardware:

| | zlib | largest `data.ndc` (47.6 MB) | whole library (473 MB of `.ndc`) |
|---|---|---:|---:|
| Python 3.13.14 | `1.3.1` (stock) | 96.8 ms — 492 MB/s | 1221 ms |
| Python 3.14.4 | `1.3.1.zlib-ng` | 62.8 ms — 758 MB/s | 753 ms |

**1.54× on inflate.** Both workflows pin `python-version: "3.12"`, so the PyInstaller sidecar we
ship gets stock zlib. Inflate is ~10 % of parse and parse ~60 % of import compute, so this is
worth **~4 %** of import compute — real, but the smaller of the two reasons.

### 2. `requirements.txt` is pinned from an interpreter CI never uses

The packaged-backend crash loop (`AttributeError: 'FastAPI' object has no attribute
'add_event_handler'`) happened because unpinned dependencies let CI resolve a newer Starlette.
The fix pinned every dependency — but those pins were captured on **Python 3.14** while CI builds
on **3.12**. A pin set verified on one interpreter and built on another is exactly the drift that
caused the original incident. Aligning them closes it.

### 3. Nothing verifies the sidecar can start

`release.yml` builds the sidecar and then checks only that the **file exists**:

```pwsh
$sidecar = "src-tauri/binaries/cellxplorer-backend-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path $sidecar)) { Write-Error "Missing backend sidecar at $sidecar"; exit 1 }
```

The crash loop shipped a sidecar that existed and died at import. A file-existence check cannot
catch that; only starting the binary can.

## Locked design decisions

1. **The smoke test runs the real PyInstaller binary**, not `app.main` under the CI interpreter.
   The whole failure class is "works from source, dies when frozen" — hidden imports, missing
   data files, a removed API in a differently-resolved wheel. Importing the module in-process
   would have passed during the crash-loop release.
2. **Stdlib only for HTTP polling.** `urllib.request`, never `httpx` or `TestClient`. Adding
   `httpx` to `requirements.txt` would bundle it into the sidecar, and a dev-only requirements
   file is another drift surface — this is the same trap that already broke
   `tests/test_app_startup.py` in CI once.
3. **The sidecar is launched exactly as Tauri launches it** — the env contract from
   `src-tauri/src/main.rs`: `CELLXPLORER_PORT`, `CELLXPLORER_DATA`, `CELLXPLORER_APP_VERSION`,
   `CELLXPLORER_CHANNEL`, `CELLXPLORER_STARTUP_MODE`. No CLI arguments. A smoke test that
   invokes it differently from the shell proves less than it appears to.
4. **An isolated `CELLXPLORER_DATA` per run.** The smoke test must never touch a real library,
   and it must exercise first-run database creation, which is itself a failure mode.
5. **Child stdout/stderr is captured and printed on failure.** The traceback is the entire value
   of this test. A bare "did not become ready" would have told us nothing during the crash loop.
6. **The gate lives in `release.yml`, not `preflight.yml`.** Only `release.yml` builds the
   sidecar (~70 s via PyInstaller). Adding that to every `main` push to catch a release-time
   failure is the wrong trade; release is what ships, so release is the gate. The script is
   runnable locally for the same check by hand.
7. **The process tree is killed with `taskkill /F /T`.** A frozen uvicorn spawns children;
   `Popen.kill()` leaves them holding the port, which would make a second run in the same job
   fail confusingly. This mirrors what `stop_backend()` already does.

## Tasks

### T1 — Bump both workflows to Python 3.14

**Files:** `.github/workflows/preflight.yml`, `.github/workflows/release.yml`

`python-version: "3.12"` → `"3.14"` in both, so preflight validates the same interpreter the
release builds with.

**Acceptance:** both workflows run green on CI. The pinned stack is known to work on 3.14
locally (`pandas 3.0.3`, `pyarrow 24.0.0`, `NewareNDA 2026.6.11`, `fastapi 0.115.6`,
`sqlalchemy 2.0.51`, `pyinstaller 6.21.0`), but **wheel availability on the
`windows-latest` runner and PyInstaller's 3.14 support can only be proven by an actual CI run.**
If a wheel is unavailable for 3.14, stop and report rather than unpinning it — unpinning is what
caused the original incident.

### T2 — `scripts/smoke_packaged_backend.py`

**File (new):** `scripts/smoke_packaged_backend.py`

```
python scripts/smoke_packaged_backend.py [--sidecar PATH] [--timeout SECONDS]
```

Defaults to `src-tauri/binaries/cellxplorer-backend-x86_64-pc-windows-msvc.exe`.

Behaviour:

1. pick a free loopback port (bind :0, release it — same trick as `available_backend_port()`);
2. create a temporary data directory;
3. spawn the sidecar with the Tauri env contract, capturing stdout+stderr;
4. poll `GET /api/health` until it answers or the timeout expires, failing early if the child
   exits;
5. assert `/api/health` reports a status, `/api/database/status` reports `compatible: true` and
   a `schema_revision`, and `/api/meta` reports `app_version` matching `config.APP_VERSION` and
   a `calc_version`;
6. terminate the process tree and clean up the temp directory;
7. on any failure print the captured child output and exit non-zero.

**Acceptance:** exits 0 against a good sidecar; exits non-zero with the child's traceback
visible if the sidecar dies at import; exits non-zero if the sidecar never binds; leaves no
process holding the port.

### T3 — Wire it into the release workflow

**File:** `.github/workflows/release.yml`

A step immediately after *Verify packaged inputs exist*:

```yaml
      - name: Smoke test the packaged backend
        shell: pwsh
        run: python scripts/smoke_packaged_backend.py
```

Placed before anything signs, uploads, or publishes, so a sidecar that cannot start fails the
release instead of shipping.

**Acceptance:** a deliberately broken sidecar fails the job at this step and nothing is
published.

### T4 — Tests

**File (new):** `tests/test_smoke_packaged_backend_script.py`

The script's decisions are testable without a 100 MB binary; loading it via
`importlib.util.spec_from_file_location` follows `tests/test_golden_approval_checkpoints.py`.

Cover: a free port is returned and is actually bindable; the environment built for the child
carries every variable Tauri sets, with the chosen port and temp data dir; the readiness
predicate accepts a healthy payload and rejects a degraded/incompatible one; the module imports
without `httpx` present (guard against the dependency creeping back).

### T5 — Report the interpreter and zlib build in diagnostics

**File:** `backend/app/routers/diagnostics.py`

`/api/diagnostics/health`'s `backend` block gains `python_version` and `zlib_version`.

Without this, the whole premise of T1 is unfalsifiable in the field: there is no way to tell
whether an installed build actually got zlib-ng. It is also the kind of build-environment fact
the crash-loop investigation needed and did not have.

**Acceptance:** `/api/diagnostics/health` reports e.g. `python_version: "3.14.4"`,
`zlib_version: "1.3.1.zlib-ng"`. A build made on 3.12 must report stock `1.3.1`, which is how
we confirm after the first 3.14 release that the change landed.

## Verification

- `python -m unittest tests.test_smoke_packaged_backend_script`
- `python scripts/preflight.py`
- **Locally, against a real sidecar:** `.\scripts\build-app.ps1 -SkipInstall -SkipFrontend
  -SkipInstaller -ForceBackend` then `python scripts/smoke_packaged_backend.py`.
- **On CI:** the 3.14 bump is only proven by a real run on `windows-latest`.

## Expected outcome

- ~4 % faster import compute in the shipped app, from zlib-ng, with no new dependency.
- `requirements.txt` pins verified on the interpreter that builds them.
- The crash-loop failure class becomes a red release job instead of a broken installer.
