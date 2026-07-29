# 030 — Adaptive Beta copied-library scientific preparation

**Status:** Implemented  
**Branch:** `feature/adaptive-beta-scientific-preparation`  
**Scope:** Beta copied-library preparation only; backend scheduler, one Beta endpoint, setup modal,
tests and durable documentation  
**Nature:** Performance and resource-policy change. Scientific outputs and persistent schema do not
change.

## Why

After a Stable library is copied into Beta, `scanner.start_capacity_summary_backfill()` starts the
one-time scientific-preparation job displayed by `BetaBootstrapCoordinator`. Today the job always
runs on one below-normal-priority background thread and `_run_capacity_summary_backfill()` prepares
each source serially.

That policy is correct after the user chooses **Continue in background**, because the app should
remain quiet and power-efficient. It is unnecessarily slow while the first-run setup modal is
blocking normal use and explicitly showing preparation progress. In that foreground phase, the user
is waiting for completion and a bounded amount of parallel work is preferable.

## Existing implementation anchors

- `backend/app/services/scanner.py`
  - `start_capacity_summary_backfill`
  - `_run_capacity_summary_backfill`
  - `_capacity_backfill_*` process-local job state
- `backend/app/services/cache.py`
  - `build`, `load_cycles`, `wait_for_pending`, `protect_hash_from_cleanup`
- `backend/app/services/process_priority.py`
  - below-normal thread/process priority helpers
- `backend/app/services/scientific_preparation.py`
  - durable copied-library preparation marker
- `backend/app/routers/beta_bootstrap.py`
  - Beta-only setup/status endpoints
- `frontend/src/components/BetaBootstrapCoordinator.tsx`
  - copied-library progress modal and current local-only **Continue in background** action
- `frontend/src/api.ts`
  - `BackgroundJob` and Beta setup response types
- `tests/test_scientific_preparation.py`
- `frontend/tests/betaBootstrap.test.ts`

The normal import path already proves that `cache.build` can execute in Windows worker processes.
Do not create another parsing implementation.

## Locked behavior

### Foreground phase

Only a scientific-preparation job created from a pending copied-library marker starts in foreground
mode. While the blocking progress modal remains open:

- different source files may be prepared in separate worker processes;
- workers use normal process priority;
- database reads/writes and progress accounting remain in the coordinator process and are committed
  serially;
- the worker limit is:

```text
min(number of remaining files, 4, max(1, floor(logical CPU count / 2)))
```

This deliberately leaves at least half the logical CPUs unused and caps peak parser memory. A
one-file job remains single-worker and receives no false parallelism claim.

### Continue in background

The button becomes a backend-confirmed, one-way resource transition:

1. frontend requests background mode for the active copied-library preparation;
2. backend stops submitting new work to the foreground pool;
3. already-running files finish normally and atomically — they are never killed mid-parse or
   mid-cache-write;
4. the process pool shuts down;
5. all remaining files run serially on the coordinator thread at below-normal priority;
6. the same job id, item list, counters and durable preparation marker continue to completion.

The modal closes only after the backend accepts the transition. A failed request leaves it open and
shows a concise inline error. CPU use may take one current worker batch to fall; the UI explains
that running files finish safely.

The transition cannot be reversed during the same job. Closing or hiding the modal through any
other path must never silently change backend resource mode.

### Unchanged low-impact paths

These remain serial and below-normal priority from their first item:

- ordinary startup capacity-summary repair;
- manual **Prepare scientific data** from Settings;
- any preparation without the copied-library pending marker.

## Backend contract

Add:

```text
POST /api/beta-bootstrap/preparation-background
```

No request body. Beta-only.

Success:

```json
{
  "jobId": 123,
  "resourceMode": "background",
  "workers": 1,
  "transitionPending": true
}
```

`transitionPending` is true while normal-priority worker files are still draining. Once serial
processing begins, the live background job reports it as false.

Return:

- `404` in Stable;
- `409` when no copied-library scientific preparation is active;
- no endpoint for switching back to foreground.

Extend scientific-preparation `BackgroundJob` snapshots with optional:

```json
{
  "resource_mode": "foreground",
  "workers": 3,
  "transition_pending": false
}
```

These are runtime diagnostics, not persistent schema.

## Worker and cache safety

- Worker arguments contain only primitive source/cache information; never pass SQLAlchemy objects or
  sessions across processes.
- A worker performs deterministic cache loading/building and returns result metadata or a safe error.
- The coordinator alone updates `SourceFile`, commits SQLite, records item results and completes the
  durable preparation marker.
- Settle any write-behind cache for a hash before dispatching it.
- Keep each dispatched hash protected from cache cleanup until its worker result is collected.
- Do not dispatch the same hash concurrently.
- Process-pool infrastructure failure falls back safely to serial processing; idempotent cache builds
  may be retried.
- A source that is offline, changed during validation, or changes during its read retains the existing
  per-source failure behavior.

## Frontend behavior

The existing modal remains visually unchanged except for truthful resource/status text and the
backend-confirmed button:

- show “Preparing up to N files in parallel” only when `workers > 1` and mode is foreground;
- otherwise describe one-file foreground or serial background work accurately;
- while the transition request is pending, the button shows loading and cannot be clicked twice;
- on success, hide the modal and let the job continue;
- on failure, keep the modal open and show a red inline `Alert`;
- normal progress remains based on completed/total files; do not invent time-based percentage.

All geometry, colors, button hierarchy, dark-mode behavior and accessibility inherit the visual
style guide. No close button, outside-click dismissal or Escape dismissal is introduced.

## Tests

Backend focused tests cover:

- worker-count cap, half-CPU rule, one-file and one-CPU behavior;
- copied-library jobs start foreground; normal/manual jobs start background;
- the Beta endpoint is unavailable in Stable and rejects no-active-job;
- the mode request is one-way and updates job diagnostics;
- foreground processing uses multiple independent worker results while DB updates remain serial;
- a background request stops later parallel submissions and remaining work is serial;
- in-flight work is not cancelled;
- worker/pool failure falls back without losing job progress;
- source error and durable completion semantics remain intact.

Frontend policy/tests cover:

- the button sends the transition request before dismissing;
- pending and error states keep the modal gated;
- worker/mode text is truthful;
- Stable and non-copied-library paths remain unchanged.

## Data and scientific consequences

- No database migration.
- No `CALC_VERSION` bump.
- No cache-key or numerical-output change.
- No copied Stable file is modified.
- The preparation marker schema remains version 1.

## Verification

```powershell
python -m unittest tests.test_scientific_preparation tests.test_beta_bootstrap -v
node --test frontend\tests\betaBootstrap.test.ts
cd frontend
npx.cmd tsc --noEmit
npm.cmd run build
cd ..
python -m unittest discover tests
node --test frontend\tests\*.test.ts
```

Do not browser-test unless explicitly requested.

## Suggested implementation order

1. Extract a primitive, process-safe single-source preparation worker.
2. Add bounded worker-count and process-local foreground/background controller state.
3. Replace the copied-library serial loop with the adaptive scheduler while preserving the serial
   coordinator and existing completion/error semantics.
4. Add the Beta-only transition endpoint.
5. Wire the modal button and resource text.
6. Add focused tests and durable architecture/performance notes.
7. Run focused and full automated verification.

## Acceptance checklist

- [x] Copied-library preparation begins in bounded foreground mode.
- [x] At most half the logical CPUs and never more than four workers are used.
- [x] Continue in background is backend-confirmed and one-way.
- [x] In-flight files finish safely; later files become serial below-normal work.
- [x] Ordinary repair and manual preparation remain serial below normal.
- [x] SQLite updates and progress accounting remain serial.
- [x] Existing scientific results, cache identities and persistent schema do not change.
- [x] Focused and full automated verification passes.
- [x] No browser verification is claimed.

## Implementation record

Implemented on `feature/adaptive-beta-scientific-preparation`.

- Extracted a primitive, process-safe source worker and retained all SQLAlchemy work in the
  coordinator.
- Added the bounded foreground scheduler, one-way drain request, serial below-normal continuation,
  cache cleanup protection, and safe serial fallback when the process pool is unavailable.
- Added the Beta-only transition endpoint and made the modal dismiss only after backend
  confirmation.
- Added runtime resource diagnostics and truthful foreground, draining, and background copy.
- Documented the durable resource-policy boundary in the agent knowledge base.

Verification completed:

- `python -m py_compile backend\app\services\scanner.py backend\app\routers\beta_bootstrap.py`
- `python -m unittest tests.test_scientific_preparation -v` — 10 passed.
- `python -m unittest tests.test_beta_bootstrap -v` — 36 passed.
- `node --test frontend\tests\betaBootstrap.test.ts` — 9 passed.
- `npx.cmd tsc --noEmit`
- `python -m unittest discover tests` — 611 passed.
- `node --test frontend\tests\*.test.ts` — 245 passed.
- `npm.cmd run build`
- `git diff --check`

No browser, installed-Beta, or packaged/frozen-sidecar verification was run.
