# 032 — Drop the unused `uvicorn[standard]` extras

**Status:** Implemented (dependency hygiene — **not** a startup optimisation)
**Branch:** `feature/faster-startup-uvicorn-alembic`
**Scope:** backend only — `requirements.txt`, `packaging/backend_entry.py`, `run.py`.

## What this is, honestly

This started as a startup-speed spec (trim `uvicorn[standard]` + defer alembic, predicted ~1 s).
**Both ideas were measured in the packaged binary and neither reduced cold start** — 2.66 s before,
2.68 s after, within noise. See "Why it doesn't help startup" below. The alembic change was
reverted (churn on critical migration code for no gain). What remains is kept purely as
**dependency hygiene**: we ship `uvicorn`, not `uvicorn[standard]`, because we use none of the
extras.

## Changes

- `requirements.txt`: `uvicorn[standard]==0.32.1` → `uvicorn==0.32.1`. The extras
  (`watchfiles`, `websockets`, `httptools`) are for `--reload`, WebSocket endpoints, and a faster
  HTTP parser — none of which this app uses (no reload, no websockets anywhere, single loopback
  client).
- `packaging/backend_entry.py` and `run.py`: `uvicorn.run(..., ws="none", http="h11")`, so uvicorn
  never imports the WebSocket/httptools machinery even in a dev environment where the extras happen
  to be installed. `h11` is pure-Python and correct for a one-client loopback backend.

## Why it doesn't help startup (the finding worth keeping)

Packaged cold start of the onedir binary is ~2.66 s. Isolating it: `import app.main` + exit (no
serve) is **2.52 s**; the serve itself is **0.16 s**. So the entire cost is interpreter bootstrap
plus importing fastapi + sqlalchemy from the frozen archive — **GIL-bound bytecode execution**.

The extras looked expensive when profiled in a **dev/source environment** (`watchfiles` 373 ms,
etc.), but that cost is filesystem/`site-packages`/`.pth` traversal that **does not exist in the
packed `_internal` archive**. Removing them shrank the bundle by ~1 MB and changed startup by 0.

The same measurement killed a parallel-import prototype (importing fastapi and sqlalchemy on
separate threads): it saved 655 ms *in source* but **0 ms frozen**, because the frozen import is
GIL-held CPU work, not the concurrent file I/O that overlaps in a dev tree.

**Rule for this repo:** any startup optimisation must be measured in the frozen binary. Source
profiling is systematically misleading here — the dev environment's import cost is dominated by
filesystem overhead the shipped binary does not pay.

## Verification

- `test_app_startup` drives the lifespan; the packaged smoke test starts the real binary and
  serves. Both pass with plain uvicorn (`ws="none"`, `http="h11"`) — uvicorn falls back cleanly
  when the extras are absent.
- `python scripts/preflight.py` green.

## Not pursued

The 2.66 s is a genuine floor for a fresh-process fastapi + sqlalchemy backend frozen with
PyInstaller. Going lower needs a different **process model** — keeping a warm sidecar across app
launches rather than importing the framework fresh each time — which is an architectural change,
not a tuning one, and is out of scope here.
