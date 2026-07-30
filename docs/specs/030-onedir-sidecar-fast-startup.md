# 030 — onedir backend sidecar for fast cold startup

**Status:** Implemented (updater apply cycle pending a real signed release)
**Branch:** `feature/onedir-sidecar-fast-startup`
**Scope:** packaging — PyInstaller build, Tauri bundle config, Rust spawn, capabilities, NSIS,
release CI, smoke test. No application logic.

## Why

A fresh beta install took **20 s** to start on another PC. Measured on packaged binaries
(3 runs each, fast SSD, Defender quiet — so conservative vs a cold machine):

| build | time to first `/api/health` |
|---|---:|
| onefile (current) | **8.58 s** median |
| onedir (prototype) | **3.73 s** median |

**2.3×, −4.85 s here; larger on a fresh PC.** The cause: PyInstaller `--onefile` re-extracts the
entire 85 MB bundle to `%TEMP%\_MEIxxxxx` on **every launch**, and on a fresh machine Windows
Defender rescans every extracted file each time. onedir keeps the files on disk next to the
launcher — extracted nothing, scanned once at install. (The symptom is already visible: dozens
of stale `_MEI*` dirs accumulate in the user's temp folder.)

Correction to an earlier assumption: UPX is **not** a factor. `upx=True` in the generated spec is
inert because `upx` is not on PATH; the binary is uncompressed.

## Locked design decisions

1. **onedir via `bundle.resources` + the shell `Command` API, not `sidecar()`.** Tauri's
   `externalBin`/`sidecar()` mechanism is single-file only and cannot ship a onedir folder. The
   supported pattern for a multi-file backend is to bundle the folder as a resource and spawn the
   inner exe with `app.shell().command(path)`. This is the one correct approach; the alternatives
   (shipping `_internal` as loose siblings of an `externalBin` launcher) fight Tauri's install
   layout and are fragile.
2. **Same spawn contract.** The `Command` must set the identical environment the `sidecar()` call
   set — `CELLXPLORER_PORT`, `CELLXPLORER_DATA`, `CELLXPLORER_APP_VERSION`, `CELLXPLORER_CHANNEL`,
   `CELLXPLORER_STARTUP_MODE`, and optionally `CELLXPLORER_INSTALL_INSTANCE_ID`. The child handle
   is still managed as `BackendChild` and killed on exit exactly as before. Nothing about the
   backend's behaviour changes.
3. **The shell scope is the narrowest that works.** A single `shell:allow-execute` scope entry for
   the resolved backend exe under `$RESOURCE`, with `sidecar: false`. No general command
   execution is granted.
4. **Dev and bundled both resolve through one helper.** In `tauri dev` the resource dir is the
   crate dir; bundled, it is the install dir. A single Rust function returns the backend exe path
   for both so there is no divergence between what developers run and what ships.
5. **The size cost is accepted.** Installed footprint grows from ~82 MB (one file) to ~199 MB (the
   folder). The NSIS download grows far less because zlib still compresses the DLLs inside the
   installer. For a pandas/pyarrow scientific desktop app this is a normal and worthwhile trade
   for a 2.3× cold-start win; the user approved it explicitly.
6. **The updater is unchanged in shape.** `createUpdaterArtifacts` packages the whole install; a
   onedir folder is simply more files inside the same NSIS artifact, signed the same way. No
   updater code changes — but the apply cycle can only be proven by a real signed release, so it
   is called out as unverifiable locally, exactly as spec 029's CI bump was.

## What must change

### T1 — PyInstaller: build onedir, not onefile

- `package.json` `build:backend`: `--onefile` → `--onedir`. The output becomes
  `dist/cellxplorer-backend/` (a folder: `cellxplorer-backend.exe` + `_internal/`).
- Replace the committed `cellxplorer-backend.spec` with the onedir form (or delete it if the
  flag-driven invocation regenerates it; keep the tree honest — no stale onefile spec).
- Drop the inert `upx=True` intent from any committed spec, and note UPX is deliberately not used.

**Acceptance:** `npm run build:backend` produces `dist/cellxplorer-backend/cellxplorer-backend.exe`
that starts and serves. A committed spec, if any, matches the onedir invocation.

### T2 — `build-app.ps1`: stage the folder, not one file

Currently copies one exe to `src-tauri/binaries/cellxplorer-backend-<triple>.exe` and stamps a
fingerprint. It must instead place the onedir output where the Tauri bundle expects the resource,
keep the up-to-date fingerprint-skip behaviour, and keep verifying the result exists before
proceeding. The staged location is whatever `tauri.conf.json`'s `resources` glob points at
(T3).

**Acceptance:** a clean build stages the whole folder; a second build with an unchanged
fingerprint still skips PyInstaller; an interrupted build re-runs (stamp written only after the
copy fully succeeds).

### T3 — Tauri bundle: resource instead of externalBin

- `tauri.conf.json`: remove `externalBin`; add the onedir folder to `bundle.resources` so it lands
  at a known path under the resource dir (e.g. `resources/backend/`). The Beta conf inherits this.
- The onedir launcher must be able to find its `_internal` sibling, so the folder is shipped whole
  with its internal structure intact.

**Acceptance:** a local `tauri build` (via `build-app.ps1`, `--no-sign` for local) produces an
NSIS installer that contains the backend folder under the resource dir.

### T4 — Rust: spawn the resource exe

- New helper resolving the backend exe path from `resource_dir()` for both dev and bundled.
- Replace `app.shell().sidecar("cellxplorer-backend")` with
  `app.shell().command(backend_exe_path())`, preserving every `.env(...)` and the `BackendChild`
  management and shutdown kill.
- `available_backend_port()`, the port env, and the readiness the frontend polls are all unchanged.

**Acceptance:** `cargo build` succeeds; a bundled launch starts the backend and the window loads
the app; quitting kills the backend process (no orphan holding the port).

### T5 — Capabilities: scope the execute permission

`src-tauri/capabilities/default.json` gains `shell:allow-execute` (and `shell:allow-kill` if the
kill path needs it) scoped to the resolved backend exe under `$RESOURCE`, `sidecar: false`.
Nothing broader.

**Acceptance:** the app can spawn the backend and is denied executing anything else.

### T6 — NSIS: the folder installs and uninstalls cleanly

The custom template (`cellxplorer-installer.nsi`) copies external binaries via `{{#each binaries}}`
and deletes them on uninstall via the matching loop. With the backend moved to resources, verify
Tauri's resource handling installs the folder and that uninstall removes it (no orphaned backend
folder left behind). The `nsis-hooks.nsh` process-kill logic is unaffected — it targets process
names, not paths — but re-read it to confirm.

**Acceptance:** install → the backend folder is present under the install dir; uninstall → it is
gone; the process-kill hook still stops a running backend before install/uninstall.

### T7 — Smoke test + release CI follow the new path

- `scripts/smoke_packaged_backend.py`: its default sidecar path (`src-tauri/binaries/...exe`) no
  longer exists; point it at the onedir launcher, or accept the folder and find the exe inside.
- `release.yml` "Verify packaged inputs exist" checks `src-tauri/binaries/...exe`; update to the
  new staged path. The spec-029 smoke step still runs against the real binary.

**Acceptance:** `python scripts/smoke_packaged_backend.py` passes against the onedir build;
the release workflow's existence check and smoke step reference the new path.

## Verification

- Local: `npm run build:backend` → `python scripts/smoke_packaged_backend.py` (onedir path).
- Local: `build-app.ps1` (no-sign) → install the produced NSIS → launch → confirm the window
  loads and startup is visibly faster → run the smoke test against the installed layout →
  uninstall and confirm the folder is removed.
- `cargo build` / `cargo clippy` for the Rust change.
- Re-measure cold start of the installed build vs the current onefile install.

## Cannot be verified locally

The **updater apply cycle** (download a signed onedir NSIS update, apply it, relaunch onto the new
version) needs a real signed release with `TAURI_SIGNING_*` secrets and two published versions.
Like spec 029's Python bump, this is flagged for a real release run, not asserted from a green
local build. Do not tag a release until it has been exercised on a prerelease.

## Implementation record

Implemented as specced. Notable outcomes:

- **T5 was a no-op.** The spawn is native Rust in `setup()`, not a webview IPC call, so it is not
  gated by the shell ACL scope. `cargo check` and a full release build confirmed `.command()`
  needs no capability change; `capabilities/default.json` is untouched.
- **Resource path confirmed empirically.** `resources: { "binaries/backend": "binaries/backend" }`
  placed the folder at `<resource_dir>/binaries/backend/cellxplorer-backend.exe` with `_internal/`
  as its sibling — exactly where `resolve_backend_exe` looks. A full `tauri build` + launch of the
  release exe spawned the backend, which bound a loopback port and served; quitting killed the
  tree with no orphan.
- **Installer download size is unchanged.** The onedir NSIS installer is **90 MB**, matching the
  onefile betas (89–90 MB): NSIS zlib compresses the loose DLLs as well as the onefile archive.
  The +114 MB is purely *installed* footprint, not download — better than the spec assumed.
- **NSIS needed no template change.** `cellxplorer-installer.nsi` already handles
  `{{#each resources}}` / `{{#each resources_dirs}}` on install and uninstall; the now-empty
  `{{#each binaries}}` loops are harmless.
- Verified: `npm run build:backend` (onedir) → smoke test passes; `cargo check`; full installer
  build; release-exe launch spawns + serves + clean shutdown; `tests.test_smoke_packaged_backend_script`.

**Still unverified (needs a real signed release):** a full **install → uninstall** cycle on a
clean machine (local build was verified via the release exe, not an actual Program Files install),
and the **updater apply cycle**. Do not tag a release until both are exercised on a prerelease.

## Follow-up

Spec 031 (Lever B, deferring the science stack past first-serve) is deliberately separate so the
packaging and import-graph risks never move together, and so B's contribution can be measured on
top of this onedir baseline rather than estimated.
