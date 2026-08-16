# Review 045 — faster local verification

Specification: [`../045-faster-local-verification.md`](../045-faster-local-verification.md)
Branch: `feature/faster-local-verification`
Merge base: `main` at `218146446b738bc6359a35cbf344a4e362617f35`
Implementation commit: `f89ccb6b5baa535f761080be0310a875ca246f56`
Final implementation-affecting checkpoint: `f89ccb6b5baa535f761080be0310a875ca246f56`
Status: **FINAL REVIEW CLEAN — READY TO MERGE**

## Confirmed

- The feature branch is cleanly based on `main@218146446b738bc6359a35cbf344a4e362617f35`; final comparison is ahead and not behind.
- Cumulative branch scope is limited to Spec 045 tooling/tests, its workflow/review/spec documentation, and the matching one-line `AGENTS.md` runner-description update.
- Backend modules and individual `frontend/tests/*.test.ts` files use one bounded shared `ThreadPoolExecutor` in `scripts/run_backend_tests.py`.
- Backend modules retain unique per-module `CELLXPLORER_DATA` directories.
- The shared test pool is capped by `CELLXPLORER_PREFLIGHT_CPU_BUDGET`; the existing NDAX inner pool is reduced against that outer budget.
- Backend and frontend task subprocesses are timed with a monotonic clock, exact task names are retained on failure, and the ten slowest tasks are reported.
- Frontend-policy caching is separate from the frontend-build cache and conservatively includes frontend source/tests, package manifests/lockfile, `tsconfig.json`, the preflight/test runner, and Node/toolchain identity.
- Missing, old, malformed, or failed cache state causes frontend policy tests to run. Backend tests are never cache-skipped. `--no-cache` disables both frontend skips.
- No application, scientific, API, database, cache-science, or UI behavior changed.
- No implementation code changed after the initial implementation checkpoint; R1/R2 follow-ups were verification/workflow documentation only.

## Verification record

### Implementer-reported

- `python -m unittest tests.test_run_backend_tests tests.test_preflight_script -v`: PASS, 27 tests.
- Initial `python scripts\preflight.py --no-cache`: PASS, 4/4 stages, 69.75 s.
- Initial `python scripts\preflight.py`: PASS, 4/4 stages, 70.80 s; frontend policy tests and TypeScript/Vite reported skipped.
- R1 same-machine matrix, all PASS:
  - merge base: 70.39 s no-cache / 74.62 s unchanged normal / 71.86 s backend-only normal;
  - Spec 045: 84.24 s no-cache / 71.37 s unchanged normal / 85.72 s backend-only normal.
- R2 balanced triplets completed before further timing was stopped by user direction:
  - full no-cache merge base: 68.04 / 78.76 / 68.02 s;
  - full no-cache Spec 045: 82.96 / 82.82 / 78.71 s;
  - unchanged normal merge base: 63.42 / 66.62 / 67.39 s;
  - unchanged normal Spec 045: 67.30 / 66.09 / 71.92 s.
- All completed R2 runs passed. Full no-cache ran frontend policy tests, TypeScript and Vite on both checkouts. Unchanged-normal merge-base runs ran frontend policy tests while skipping build; Spec 045 unchanged-normal runs skipped frontend policy tests and build.
- The backend-only triplet was intentionally not completed; only one baseline run (66.36 s, PASS) exists and is not treated as a paired performance result.
- In cache-hit Spec 045 normal/backend-only runs, backend modules ran while unchanged frontend policy tests and TypeScript/Vite were explicitly skipped.
- Current Spec 045 no-cache verification included all 68 backend modules and 58 frontend policy files.
- `py_compile` and `git diff --check`: PASS.
- Browser checks: NOT RUN; this is tooling-only work.

### Reviewer-independent

Using ChatGPT Chat + the GitHub connector, I independently inspected:

- the final cumulative branch diff against `main@2181464...`;
- `scripts/preflight.py`;
- `scripts/run_backend_tests.py`;
- `tests/test_preflight_script.py`;
- `tests/test_run_backend_tests.py`;
- the relevant nested NDAX worker-budget interaction;
- frontend-policy cache inputs and failure safety;
- the slow-test fixture patterns in `tests/test_fast_neware.py`, `tests/test_portable_analysis.py`, `tests/test_beta_bootstrap.py`, and `tests/test_neware_excel.py`;
- the locked scientific-regression contract in `docs/agent-knowledge/scientific-regression-testing.md` and `tests/test_golden_analysis.py`;
- Spec 045, workflow state/coordination, and all review follow-ups.

I did **not** independently execute repository test commands, preflight, or browser/manual checks.

## Finding status

### R1 — RESOLVED: Required before/after scenario matrix

The verification record now distinguishes full no-cache, immediate unchanged normal, and a genuine backend-only repeat, identifies the merge-base checkout, and records frontend RUN/SKIP behavior.

### R2 — CLOSED BY USER DIRECTION: Additional repeated performance characterization

The one-shot timing matrix is noisy and does **not** establish a reproducible performance delta: it includes both faster and slower Spec 045 runs, and the earlier no-cache handoff showed the opposite direction from the later matrix. I therefore requested repeated paired measurements in final review.

The later balanced triplets confirm that complete local verification is operating in roughly the same minute-scale range rather than exposing a multi-minute regression, but they still do not establish a robust speedup for every scenario. During the R2 follow-up, the user explicitly prioritized correct complete verification and avoiding super-long local runs over exhaustive timing characterization; the backend-only triplet was therefore intentionally stopped.

Accordingly, the extra repeated-timing requirement is no longer a merge gate. This is a scope override, **not** experimental proof that every scenario is reproducibly faster. The existing timing variability remains documented rather than being converted into a stronger performance claim.

### Post-completion user follow-up — reducing slow tests by subsetting source data

Replacing the long scientific fixtures with arbitrary fractions such as the first 1/10 of each file is **not recommended for canonical preflight** and does not reopen Spec 045.

- `tests/test_fast_neware.py` deliberately performs full-file equality between original `NewareNDA.read` and the optimized path across both committed NDAX samples, three cycle modes, and both software-cycle settings. Truncating or replacing those files with small extracts would weaken coverage of container/block boundaries, late-file status/cycle transitions, and exact whole-file DataFrame parity. It would also contradict Spec 045's locked decision not to sample or weaken existing tests.
- The golden scientific layer is explicitly defined as complete committed Neware binaries exercised through production parsing, cache construction, and analysis. It verifies source SHA-256, parses each unique source once, and the durable guidance explicitly says not to trim or rewrite those binaries. Subsetting those fixtures would weaken the end-to-end scientific-regression guarantee.
- `tests/test_portable_analysis.py` already uses a tiny two-row synthetic cycling frame for its portable-report logic; its cost is packaging/database/round-trip behavior, so reducing data volume would not materially target the expensive boundary.
- `tests/test_neware_excel.py` already constructs compact synthetic workbooks designed around edge cases such as repeated programmed steps, charge/CV/discharge transitions and dialect variations. A 1/10 reduction would mostly remove cases rather than remove bulk data.
- `tests/test_beta_bootstrap.py` is dominated by isolated SQLite/bootstrap/migration scenarios, not large scientific files. File-data subsetting is not relevant to its main cost.

Potential future speed work should therefore preserve the scientific inputs and target measured setup overhead instead: for example, reuse immutable prebuilt workbook/report/database templates by copying them into each test's private temporary directory, or avoid repeated migrations/setup where the individual test does not need to exercise migration itself. Any such change must preserve per-test isolation and first be shown by timing to attack a real hotspot. It should be a separate follow-up/spec rather than silently weakening Spec 045's completed verification contract.

## Final decision

**FINAL REVIEW CLEAN — READY TO MERGE.**

There are no open implementation defects or spec-behavior findings. The shared runner, isolation, bounded concurrency, failure attribution, timing instrumentation, cache invalidation/safety, and complete `--no-cache` path are consistent with Spec 045 and the focused tests. Required preflight executions are implementer-reported passing. Branch scope is clean and the branch is not behind its merge base.

Known non-blocking limitation: the available wall-clock measurements remain noisy. Do not interpret this review as claiming a statistically robust speedup for every measured scenario. The user follow-up does not change merge readiness: arbitrary fixture subsetting would weaken the verification contract, while setup-level optimization remains a safe candidate for future work if measurement justifies it.
