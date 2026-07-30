# 031 — Defer the science stack past first-serve (Lever B)

**Status:** Implemented
**Branch:** `feature/defer-science-imports`
**Scope:** backend only — 3 routers. No behaviour change.

## Why

Spec 030 (onedir) took packaged cold start from 8.58 s to 3.73 s. Profiling the remaining time
showed **~1.9 s is the science stack (pandas + numpy + pyarrow + NewareNDA) imported before uvicorn
can bind a port** — even though the endpoints the frontend waits on at startup
(`/api/database/status`, `/api/health`, `/api/meta`) and the landing-page endpoints
(`/api/tree`, `/api/library`, `/api/files`) need none of it.

Measured from source (fresh cold subprocess):

| | cost |
|---|---:|
| full `app.main` import (pulls pandas + NewareNDA) | 4.61 s |
| light path only (fastapi + uvicorn + DB init) | 2.71 s |
| **science on the critical path, avoidable** | **1.90 s** |

## What was actually leaking

`main.py` imports 11 routers at module load. Only **3** pull the science stack, and only through a
handful of eager service imports:

| router | eager heavy import | on startup path? |
|---|---|---|
| `analyses` | `analysis_usage` (→ `analysis_engine` → pandas) | no (opened on demand) |
| `beta_bootstrap` | `scanner` (→ `parsing` → pandas + NewareNDA) | beta only |
| `cache_management` | `cache_maintenance`, `scanner` | no (Settings only) |

Everything else in `analyses` was **already** function-local or wrapped in the repo's existing
`LazyModule`. `library`, `tree`, `files` are already light — that is why they render the first
screens without pandas. This spec just applies the same, proven pattern to the 3 routers that
skipped it.

## Locked design decisions

1. **Reuse `services/lazy_module.LazyModule`, do not invent a mechanism.** It already backs the
   light `library` router: a module-level proxy that imports its target on first attribute access
   and then behaves like the module. Zero call-site changes — `scanner.foo()` still reads
   `scanner.foo()`.
2. **No behaviour change and no route-availability change.** All routers stay registered at import;
   only the *import of the heavy service* is deferred to first use. There are no new 503s, no
   background route registration, no frontend changes. An endpoint that needs pandas pays the
   import on its first call — by which point the existing `_warm_scientific_services` background
   thread (which this finally makes useful) has typically already loaded it.
3. **Module-level numpy constants stay eager where they must.** `fast_neware` builds
   `np.dtype(...)` / `np.array(...)` at import; it is not touched. Deferral happens at the router
   boundary, not inside the science modules, so those constants are unaffected.
4. **Success is measured, not assumed.** The acceptance bar is `pandas not in sys.modules` after
   `import app.main`, plus a re-measured packaged cold start.

## Tasks

### T1 — `analyses` router: lazy `analysis_usage`

Replace the eager `from ..services import analysis_usage` with a `LazyModule` wrapper following the
loaders already in that file. `background_jobs` stays eager (it is light).

### T2 — `beta_bootstrap` router: lazy `scanner`

Import `LazyModule`; wrap `scanner`. `beta_bootstrap` and `scientific_preparation` stay eager
(both light).

### T3 — `cache_management` router: lazy `cache_maintenance` and `scanner`

Import `LazyModule`; wrap both. `cache_maintenance` is referenced ~21×; the proxy is transparent so
no call site changes.

### T4 — Regression guard

A test that asserts `import app.main` does **not** import pandas or NewareNDA, so a future eager
import in any router is caught. This is the invariant the whole spec exists to protect.

## Acceptance

- After `import app.main` in a fresh process: `pandas`, `numpy`, `pyarrow`, `NewareNDA` are all
  absent from `sys.modules`.
- Each of the 3 routers imports without pulling pandas.
- Opening an analysis, running a source check, and the cache-management endpoints all still work
  (the lazy proxy loads the module on first use).
- `python scripts/preflight.py` and the golden corpus are unchanged.

## Verification

- The T4 invariant test.
- `python -m unittest` for the affected routers' existing tests + `tests.test_golden_analysis`.
- Re-measure: build the onedir sidecar with this change and compare packaged cold start against the
  onedir baseline (spec 030).

## Implementation record

The leak was wider than the 3 routers: `main.py` itself imports `cache_maintenance` at module
load (to spawn the maintenance thread in the lifespan), and `cache_maintenance` imported
`analysis_cache` + `cache` at its top — both heavy. Fixed by wrapping those two in `LazyModule`
inside `cache_maintenance` as well; `start_cache_maintenance()` only spawns a daemon thread, so
the caches load in the background, not on the startup path. Final changes: lazy `analysis_usage`
(analyses), lazy `scanner` (beta_bootstrap), lazy `cache_maintenance` + `scanner`
(cache_management), lazy `analysis_cache` + `cache` (cache_maintenance service).

Measured, same machine:

| | `import app.main` | packaged cold start |
|---|---:|---:|
| before (onedir, spec 030) | 4.61 s | 3.70 s |
| after (this spec) | 3.02 s | **2.66 s** |

`import app.main` is confirmed pandas/numpy/pyarrow/NewareNDA-free (T4 guard). End-to-end across
both levers: **onefile 8.58 s → onedir 3.70 s → onedir+defer 2.66 s** — 3.2×, −5.9 s. The packaged
gain (~1.0 s) is smaller than the from-source import saving (~1.6 s) because the background warmup
thread now genuinely loads pandas and contends for CPU during startup — a fair trade, since that
work had to happen anyway and no longer blocks the port.

Golden corpus unchanged; 90 router/lifecycle tests pass; smoke test passes on the rebuilt onedir.

**Also fixed here:** `tests/test_app_channels.py` still asserted the spec-030 `externalBin` config
and was failing on `main` (missed because a truncated preflight read hid the backend-stage
failure). Updated to assert the onedir `resources` config.
