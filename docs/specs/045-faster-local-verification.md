# Spec 045: faster local verification

Status: **Implementation ready for review**
Type: **development tooling / test performance**  
Branch: `feature/faster-local-verification`

## Goal

Reduce the wall-clock time of CellXplorer's normal local verification without reducing test coverage or weakening the canonical verification contract.

The main target remains:

```powershell
python scripts\preflight.py
```

This is tooling only. No application, scientific, API, database, cache-science, or UI behavior should change.

## Current implementation

Relevant files:

```text
scripts/preflight.py
scripts/run_backend_tests.py
tests/test_preflight_script.py
tests/test_run_backend_tests.py
frontend/tests/*.test.ts
tests/test_*.py
```

Current preflight runs version consistency first, then backend tests, frontend policy tests, TypeScript, and Vite. The later stages run concurrently, but test scheduling is asymmetric: backend `test_*.py` modules use an explicit worker pool, while all frontend policy files are launched together as one `node --test ...` stage. The existing `.preflight-cache.json` can skip unchanged TypeScript/Vite work, but frontend policy tests always run.

## Locked decisions

- Keep `python scripts\preflight.py` as the canonical local verification command.
- `python scripts\preflight.py --no-cache` must still execute every required verification stage.
- Do not delete, weaken, sample, or make existing tests optional.
- Do not cache backend tests in this spec.
- Do not change Vite output semantics, minification, targets, scientific tolerances, fixtures, or expected results merely for speed.
- Do not modify the implementer/reviewer workflow; its verification-efficiency rules are handled separately.
- Prefer one shared bounded test-concurrency mechanism rather than competing backend/frontend worker budgets.

## 1. Unified backend + frontend test pool

Replace the current asymmetric test execution with one shared worker pool for test files/modules.

Conceptually:

```text
shared test worker pool
    ├── python -m unittest tests.test_parser_identity
    ├── node --test frontend/tests/appUpdater.test.ts
    ├── python -m unittest tests.test_import_flow
    ├── node --test frontend/tests/analysisWorkspace.test.ts
    └── ...
```

Each worker slot runs one backend test module or one frontend test file.

Requirements:

- every existing backend test module still runs;
- every existing `frontend/tests/*.test.ts` file still runs;
- backend tests retain their per-module `CELLXPLORER_DATA` isolation;
- backend and frontend test tasks share the same bounded worker budget;
- reuse the existing `CELLXPLORER_PREFLIGHT_CPU_BUDGET` concept rather than inventing unrelated limits;
- avoid nested oversubscription: a task must not silently spawn a second large worker pool that defeats the global budget;
- failures must identify the exact backend module or frontend test file;
- TypeScript and Vite are not test files and remain separate preflight stages.

The implementer may generalize/rename `scripts/run_backend_tests.py` if that is the cleanest way to own the unified pool, but do not leave two competing orchestration paths.

## 2. Timing and bottleneck reporting

Measure with a monotonic clock:

- total preflight wall time;
- each major preflight stage;
- every backend test module;
- every frontend test file.

At the end of the test stage, print a concise list of the ten slowest test files/modules, for example:

```text
Slowest test files/modules:
24.3 s  tests.test_example
10.2 s  frontend/tests/appUpdater.test.ts
 8.7 s  tests.test_other
```

Do not parse unittest/Node text to infer timing; measure the subprocess directly. Timing output must not change pass/fail or exit-code behavior.

## 3. Optimize confirmed slow-test hotspots

After timing exists, inspect the actual slowest modules/files and optimize the few that materially dominate runtime when there is a clear behavior-preserving improvement.

Typical valid causes include:

- repeatedly parsing the same expensive fixture;
- recreating expensive setup for every test unnecessarily;
- independent comparisons performed serially;
- duplicated database/application initialization;
- safe reusable setup or bounded inner parallelism.

Do not guess before measuring. Do not change what a test verifies to make it faster. Preserve all current cases, inputs, comparisons, assertions, and scientific regression guarantees.

Record the before/after duration of each hotspot changed. If a slow test cannot be improved safely, leave it unchanged and record that conclusion.

## 4. Cache unchanged frontend policy tests

Extend the existing `.preflight-cache.json` mechanism with a separate frontend-policy fingerprint.

The fingerprint must conservatively include at least:

```text
frontend/tests/**
frontend/src/**
frontend/package.json
frontend/package-lock.json
frontend/tsconfig.json
```

and the relevant Node/toolchain identity already available to preflight.

Expected behavior:

```text
backend-only change
→ backend tests RUN
→ frontend policy tests SKIP if unchanged
→ TypeScript/Vite may use their existing skip

frontend/tests/** change
→ frontend policy tests RUN
→ TypeScript/Vite remain eligible for their existing skip

frontend/src/** change
→ frontend policy tests RUN
→ TypeScript/Vite RUN

--no-cache
→ everything RUN
```

A missing, old, or malformed cache entry must fail safe by running the tests. A failed preflight must not establish a reusable successful cache state. Any skip must be explicit in the output.

## Implementation order

1. Record a current preflight baseline.
2. Add per-stage and per-test timing.
3. Implement the shared backend/frontend test pool.
4. Run it and identify the real slow-test hotspots.
5. Optimize the few confirmed major hotspots that can be made faster safely.
6. Add frontend-policy caching.
7. Record final before/after timings.

## Expected files

Likely:

```text
scripts/preflight.py
scripts/run_backend_tests.py
tests/test_preflight_script.py
tests/test_run_backend_tests.py
```

Plus this spec and the spec index. No broad documentation work is required unless implementation establishes a durable rule that existing documentation would otherwise state incorrectly.

## Verification

Add focused tooling tests covering at least:

- shared backend/frontend scheduling;
- worker-budget enforcement;
- exact task failure reporting;
- backend data isolation;
- timing output;
- frontend-policy cache hit/miss;
- frontend source/test invalidation;
- `--no-cache`;
- failed-cache safety.

Then run:

```powershell
python scripts\preflight.py --no-cache
python scripts\preflight.py
```

Both must pass.

Record before/after timing for:

- full no-cache preflight;
- immediate normal repeat;
- backend-only repeat;
- each individual slow test/module optimized.

## Acceptance criteria

1. Backend and frontend test files/modules share one bounded worker pool.
2. All existing backend and frontend test coverage is preserved.
3. Preflight and individual test tasks report useful timings.
4. The major measured test hotspots are investigated and safe worthwhile optimizations are implemented.
5. Unchanged frontend policy tests can be skipped safely.
6. Backend tests are never skipped through caching.
7. `--no-cache` still performs complete verification.
8. Backend isolation and exact failure reporting remain correct.
9. Canonical no-cache and normal preflight both pass.
10. Before/after timings demonstrate the actual effect of the changes.

## Implementation record

Branch: `feature/faster-local-verification`.

- Backend modules and frontend policy files now use one bounded worker pool controlled by
  `CELLXPLORER_PREFLIGHT_CPU_BUDGET`.
- Preflight and each test task report monotonic durations; the test stage reports the ten slowest
  files/modules.
- Frontend policy caching has its own conservative fingerprint covering frontend source/tests,
  package manifests, `tsconfig.json`, the test runner, and the installed Node toolchain. Backend
  tests are never skipped by this cache.
- The measured slowest modules were `tests.test_portable_analysis`, `tests.test_beta_bootstrap`,
  `tests.test_fast_neware`, and `tests.test_neware_excel`. They exercise isolated portable-report,
  database, binary-parity, and workbook fixtures respectively; no safe setup sharing was found
  that would preserve their isolation and full assertions, so those fixtures remain unchanged.

## Verification record

```text
Pre-implementation: python scripts\preflight.py --no-cache  ~84.6 s, passed
Final:             python scripts\preflight.py --no-cache  69.75 s, 4/4 stages, passed
Immediate normal/backend-only repeat: python scripts\preflight.py  70.80 s, passed
Focused tooling tests: python -m unittest tests.test_run_backend_tests tests.test_preflight_script -v  27 passed
```

The final no-cache run executed all 68 backend modules and 58 frontend policy files. The normal
repeat explicitly skipped unchanged frontend policy tests and the TypeScript/Vite stages.
