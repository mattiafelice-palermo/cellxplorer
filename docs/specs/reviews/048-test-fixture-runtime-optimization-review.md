# Spec 048 implementation review — Test fixture runtime optimization

Status: **Changes requested — R1/R2 remain open; R3 resolved**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed implementation: `bbae98e247df3bf23ace5ba038846e24000fae0f`

## Review scope and result

The original Spec 048 fixture/setup implementation remains review-clean. This review round covers the
reviewer-authorized performance extension R1-R3 added after that checkpoint.

The implementer reported for the returned fixes:

- focused partitioned suite: **PASS**, 149 tests, 56.149 s; all 34 portable-analysis and 67 Neware
  Excel cases exactly once;
- `python scripts\\preflight.py --no-cache`: **PASS**, 82.07 s total; test pool 81.29 s;
- normal `python scripts\\preflight.py`: **PASS**, 79.63 s total; backend pool 78.62 s;
- worker sweep: **PASS** at 4/8/12/16 workers, with 16 fastest in the measured environment;
- Vite 8.2.1/Rolldown migration: `npm ci`, TypeScript, 568 frontend policy tests and direct build
  **PASS**;
- `git diff --check`: **PASS**;
- `compileall`: **PASS**;
- golden scientific source/manifest files: **unchanged**.

Reviewer verification in this round was code-reading through the GitHub connector, including the
current merge base, runner scheduling, partition discovery/wrappers, preflight orchestration, Vite
configuration and the implementation timing record. I did not independently rerun commands in this
Chat + GitHub-only reviewer session.

The key result is that R3 produced a useful direct-build improvement, but the R1/R2 test-side changes
have not yet demonstrated the required end-to-end performance improvement. The latest canonical test
pool is substantially slower than the original-scope checkpoint, and the implementation record says
those measurements were affected by an existing `run.py` process/resource contention. That makes
those measurements unsuitable as the required comparable before/after proof.

## R1 — High — OPEN: provide controlled evidence for cost-aware scheduling and worker tuning

Affected files:

- `scripts/run_backend_tests.py`
- `scripts/preflight.py`
- `tests/test_run_backend_tests.py`
- `tests/test_preflight_script.py`

### Current

The implementation now persists successful task durations in `.preflight-cache.json`, submits unknown
tasks first and known tasks longest-first, and preserves the per-module subprocess/data-root model.
The worker sweep also measured 4/8/12/16 workers and retained 16.

The tooling implementation itself is coherent, but the acceptance evidence is not. The original-scope
checkpoint measured:

- normal backend pool: **36.54 s**;
- no-cache backend/frontend pool: **42.42 s**.

The returned implementation measured:

- normal backend pool: **78.62 s**;
- no-cache backend/frontend pool: **81.29 s**.

The implementation record attributes the large variation to an existing local `run.py` process and
resource contention. Because the background conditions changed, the measurements do not establish
whether longest-first scheduling improves the pool, whether it is neutral, or whether another worker
count would be preferable under a clean comparable run. R2 also changes the task topology at the same
time, so its cost is currently mixed into the R1 evidence.

### Target

After R2 is corrected, obtain a controlled same-machine comparison with equivalent background load:

1. run the same task topology with no/empty timing history and with populated timing history;
2. repeat the bounded worker sweep on that same topology and environment;
3. retain the measured best worker default/heuristic;
4. retain duration-based ordering only if it improves wall time or controlled evidence shows it is
   effectively neutral and not the remaining limiter.

Timing history must continue to affect ordering only. No backend/frontend test may be skipped or
cached as part of R1.

### Acceptance criteria

- Existing runner tests for malformed/missing history, ordering, isolation and failure attribution
  remain green.
- Controlled A/B measurements use the same checkout, task topology and comparable background load.
- The chosen worker count is the best measured bounded option for that environment.
- The final canonical test-pool timing is not materially regressed by R1 relative to the
  original-scope checkpoint under comparable conditions.
- The implementation record states the controlled before/after values and what conclusion they
  support.

## R2 — High — OPEN: partitioning must reduce aggregate wall time, not only individual task duration

Affected files:

- `tests/test_portable_analysis.py`
- `tests/test_portable_analysis_*.py`
- `tests/test_neware_excel.py`
- `tests/test_neware_excel_*.py`
- `scripts/run_backend_tests.py`

### Current

The partition wrappers keep the original test bodies as the source of truth and the implementer
reports all 34 portable-analysis and 67 Neware Excel cases exactly once. The individual partition
measurements are all at or below about 9.24 s, satisfying the narrow longest-task objective.

However, aggregate performance regressed materially:

- the focused 149-test set increased from **35.573 s** at the original checkpoint to **56.149 s**;
- normal canonical backend execution increased from **36.54 s** to **78.62 s**;
- the no-cache test pool increased from **42.42 s** to **81.29 s**.

Therefore the current split does not satisfy the actual performance objective. Reducing each module's
reported duration is not useful if repeated process/import/setup/resource costs make the complete
verification path slower.

### Target

Redesign or revert the partition strategy so it produces a **net canonical wall-time reduction** under
controlled comparable conditions. Reasonable outcomes include fewer/coarser partitions, a different
ownership split, or returning one/both suites to their original single-module discovery if splitting
cannot beat the original checkpoint.

Do not optimize toward an arbitrary number of partition files. The correct granularity is the one
that minimizes the complete bounded runner wall time while preserving coverage and isolation.

### Acceptance criteria

- All 34 portable-analysis and 67 Neware Excel tests remain represented exactly once with equivalent
  assertions, tolerances, dialects and failure cases.
- Every test still receives private mutable DB/workbook/cache/report/data-root state where required.
- A controlled same-machine A/B comparison demonstrates that the retained topology reduces, rather
  than increases, the canonical backend/test-pool wall time.
- Long individual tasks should remain below roughly 8-10 s only where doing so does not worsen the
  aggregate critical path.
- If no partition topology beats the original modules, revert the split rather than keeping a
  performance regression.
- The final implementation record includes per-task durations and aggregate backend/test-pool timing.

## R3 — Medium — RESOLVED: Rolldown-powered Vite migration

Affected files:

- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/vite.config.ts`

The migration to Vite 8.2.1 / `@vitejs/plugin-react` 6.0.5 is accepted in this review round. The
implementation record reports a clean direct production-build reduction from **42.79 s** to
**20.10 s** (with a 9.67 s warm run), and reports successful `npm ci`, TypeScript, all 568 frontend
policy tests, Plotly runtime consistency and canonical no-cache preflight. Code review found no
concrete application or packaging semantic regression from the retained dependency/configuration
change.

Do not reopen or modify R3 merely to address R1/R2 unless a direct interaction is demonstrated.

## Merge readiness

**Not ready to merge.** R1 and R2 remain open. R3 is resolved. Once the test-side performance
extension has controlled, non-regressing evidence, review child 048 again; if clean, the workflow can
advance to queued child 048.1.
