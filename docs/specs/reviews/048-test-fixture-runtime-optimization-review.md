# Spec 048 implementation review — Test fixture runtime optimization

Status: **Changes requested — R1 open; R2/R3 resolved**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed implementation: `dad22243446e4f6c171cda05d0025b9243bd0c88`

## Review scope and result

The original Spec 048 fixture/setup implementation remains review-clean. R2 remains resolved by
reverting the unsuccessful test partition experiment, and R3 remains resolved by the compatible
Vite 8/Rolldown migration.

This round reviews the final R1 evidence requested after the user identified the local workstation as
an unreliable timing reference.

The implementer supplied a clean Windows GitHub Actions benchmark in run `31964460774`. The
benchmark used the restored 68-module topology, a warm-up, and counterbalanced
ordered/unordered/unordered/ordered passes on the same hosted runner. The runner exposed four logical
CPUs, so requested 16 workers resolved to four in every pass. All 68 modules passed every measured
run.

Measured wall times were:

- timing-history longest-first: **61.808 s**, **55.815 s**;
- no timing history / ordinary discovery order: **51.013 s**, **49.882 s**.

The clean reference therefore shows a repeatable **regression** from longest-first scheduling. The
implementer correctly restored the previous `min(16, CPU budget)` worker default because the hosted
runner could not distinguish 8 from 16 workers. However, `scripts/run_backend_tests.py` still reads,
persists, and applies timing history, so the measured slower scheduling behavior is still active.

Reviewer independently inspected the benchmark workflow/run metadata, current runner code, restored
worker default, and removal of the temporary benchmark workflow.

## R1 — High — OPEN: remove the timing-history scheduler that clean CI showed is slower

Affected files:

- `scripts/run_backend_tests.py`
- `scripts/preflight.py` only for stale timing-history/cache coupling if applicable
- `tests/test_run_backend_tests.py`
- `tests/test_preflight_script.py`
- `docs/specs/048-test-fixture-runtime-optimization.md`

### Current

`run_backend_tests.py` still contains `TEST_TIMINGS_KEY`, `read_timing_history()`,
`task_order_key()`, `order_task_names()`, `persist_timing_history()`, reads the history before task
submission, sorts tasks by it, and writes successful durations back to `.preflight-cache.json`.

That behavior is now contradicted by the clean CI result: both ordered passes were slower than both
unordered passes on the same runner. The local result that previously favored longest-first is not
authoritative because the user confirmed substantial workstation variability.

### Target

Revert the R1 timing-history scheduling experiment completely:

1. Restore ordinary deterministic discovery/submission ordering for backend modules and frontend
   policy files.
2. Remove timing-history reads, task-ordering logic, and timing-history persistence from the runner.
3. Remove tests that exist only to prove the now-rejected timing-history feature; preserve all
   existing isolation, failure attribution, bounded parallelism, slow-task reporting, frontend cache
   behavior, and `--jobs`/`CELLXPLORER_PREFLIGHT_JOBS` overrides.
4. Keep the restored worker default `min(16, CPU budget)`; the clean four-CPU runner could not support
   a valid 8-vs-16 default decision.
5. Update the implementation record so it states clearly that the CI experiment **rejected**
   longest-first scheduling and the feature was reverted. Retain the CI run ID and measured values as
   evidence.
6. The ignored `.preflight-cache.json` may tolerate an old unused `test_timings` field; no migration
   of developer-local cache files is required. New code must simply stop consuming/writing it.

### Acceptance criteria

- No timing-history value can affect task order or whether a test executes.
- Runner task order is deterministic without `.preflight-cache.json` timing data.
- The prior one-subprocess/private-data-root-per-backend-module contract remains unchanged.
- Worker default is again `min(16, CPU budget)` and explicit overrides remain supported.
- Focused runner/preflight tests pass.
- Canonical `python scripts\\preflight.py --no-cache` and normal `python scripts\\preflight.py` pass.
- Golden source/manifest files remain unchanged.
- The implementation record documents the clean CI rejection: ordered 61.808/55.815 s versus
  unordered 51.013/49.882 s in run 31964460774.

## R2 — High — RESOLVED: partition experiment reverted

The Neware Excel and portable-analysis partition wrappers/discovery exclusions are removed. The
original modules again own and run their complete suites directly. No partition-related change
remains to review.

## R3 — Medium — RESOLVED: Rolldown-powered Vite migration

The retained Vite 8.2.1 / `@vitejs/plugin-react` 6.0.5 migration remains accepted based on the prior
successful dependency installation, TypeScript, frontend policy, Plotly consistency and production
build verification, with a material direct-build reduction.

## Merge readiness

**Not ready to merge.** The only remaining change is to revert the R1 timing-history scheduling
experiment that the clean CI benchmark disproved. Once that is removed and canonical verification is
green, child 048 can advance to queued child 048.1.
