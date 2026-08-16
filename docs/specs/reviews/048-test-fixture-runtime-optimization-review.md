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
have not yet demonstrated the required end-to-end performance improvement. The latest local canonical
test-pool measurements are substantially slower than the original-scope checkpoint, but the user
confirmed that the development machine is currently behaving erratically and can vary materially in
performance. Therefore those local values are no longer treated as reliable evidence that the
implementation itself regressed. R1/R2 remain open only because they still need a controlled reference
measurement.

For R1/R2 timing acceptance, prefer a **clean GitHub Actions Windows runner**. The existing
`preflight.yml` supports manual `workflow_dispatch`, and manual dispatch always runs preflight. For the
strongest A/B evidence, benchmark baseline and candidate sequentially inside the same Windows Actions
job/runner when practical, using the same dependency environment, worker budget and benchmark command.
A small temporary/diagnostic benchmark workflow or script is acceptable and need not become a permanent
required CI gate.

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

The tooling implementation itself is coherent. The remaining gap is only trustworthy acceptance
evidence: the previous local measurements were taken under materially changing workstation load, so
they cannot distinguish implementation cost from unrelated machine contention. R2 also changes the
task topology, so R1 must be measured on the final retained topology.

### Target

After R2 is corrected/finalized, obtain a controlled GitHub Actions Windows comparison:

1. use the same final task topology with no/empty timing history and with populated timing history;
2. repeat a bounded worker sweep on the same runner environment/topology (for example 4/8/12/16 when
   within the runner CPU budget);
3. retain the measured best worker default/heuristic;
4. retain duration-based ordering only if it improves wall time or controlled evidence shows it is
   effectively neutral and not the remaining limiter.

Prefer running the A/B variants sequentially in one Actions job so both measurements share the same
runner. If separate workflow runs are used instead, record enough repeated measurements to avoid
mistaking normal hosted-runner variation for a meaningful difference.

Timing history must continue to affect ordering only. No backend/frontend test may be skipped or
cached as part of R1.

### Acceptance criteria

- Existing runner tests for malformed/missing history, ordering, isolation and failure attribution
  remain green.
- Controlled A/B measurements use the same code topology and equivalent GitHub Windows runner setup;
  same-job sequential measurement is preferred.
- The chosen worker count is the best measured bounded option for that CI environment.
- The final canonical test-pool timing is not materially regressed by R1 under controlled CI
  conditions.
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
reports all 34 portable-analysis and 67 Neware Excel cases exactly once. The individual local partition
measurements are all at or below about 9.24 s, satisfying the narrow longest-task objective.

The previous local aggregate measurements cannot be used to decide whether this topology is actually
faster because the user confirmed substantial unrelated workstation performance variation during the
benchmark period.

### Target

Measure the retained partition strategy against the original single-module topology on a clean GitHub
Actions Windows runner and keep the topology that gives the lower **aggregate canonical wall time**.
Reasonable outcomes include the current split, fewer/coarser partitions, a different ownership split,
or returning one/both suites to their original single-module discovery if splitting does not help.

Prefer an A/B benchmark inside one Actions job: run the baseline topology and candidate topology
sequentially with the same installed dependencies, worker budget and environment. The benchmark may
use a temporary diagnostic checkout/worktree or benchmark-only discovery switch; do not weaken or
sample the tests themselves.

Do not optimize toward an arbitrary number of partition files. The correct granularity is the one
that minimizes the complete bounded runner wall time while preserving coverage and isolation.

### Acceptance criteria

- All 34 portable-analysis and 67 Neware Excel tests remain represented exactly once with equivalent
  assertions, tolerances, dialects and failure cases.
- Every test still receives private mutable DB/workbook/cache/report/data-root state where required.
- A controlled GitHub Actions A/B comparison demonstrates whether the retained topology reduces the
  canonical backend/test-pool wall time relative to the original topology.
- Long individual tasks should remain below roughly 8-10 s only where doing so does not worsen the
  aggregate critical path.
- If no partition topology beats the original modules in controlled CI, revert the split rather than
  keeping complexity with no demonstrated benefit.
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

**Not ready to merge.** R1 and R2 remain open only for controlled CI performance evidence and any
resulting topology/worker adjustments. R3 is resolved. Once that evidence is available and the
retained test topology is non-regressing, review child 048 again; if clean, the workflow can advance
to queued child 048.1.
