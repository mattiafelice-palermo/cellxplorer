# Review 045 — faster local verification

Specification: [`../045-faster-local-verification.md`](../045-faster-local-verification.md)
Branch: `feature/faster-local-verification`
Merge base: `main` at `218146446b738bc6359a35cbf344a4e362617f35`
Implementation commit: `458c91edd64b185172b8e44c18f1cb802e0e7703`
Status: **Review clean — entering final review**

## Confirmed

- The branch is cleanly based on current `main`; there is no unrelated implementation scope in the feature diff.
- Backend modules and `frontend/tests/*.test.ts` files are scheduled through one bounded `ThreadPoolExecutor` in `scripts/run_backend_tests.py`.
- Backend modules retain unique per-module `CELLXPLORER_DATA` directories.
- The shared test pool is capped by `CELLXPLORER_PREFLIGHT_CPU_BUDGET`; the existing NDAX inner pool is reduced against that outer budget.
- Backend and frontend task subprocesses are timed with `time.monotonic()`, exact task names are retained on failure, and the ten slowest tasks are reported.
- Frontend-policy caching is separate from the existing frontend-build cache and includes `frontend/src/**`, `frontend/tests/**`, package manifests/lockfile, `tsconfig.json`, the preflight/test-runner scripts, and Node/toolchain identity.
- Missing, old, malformed, or failed cache state causes frontend policy tests to run. Backend tests are never cache-skipped. `--no-cache` disables both frontend skips.
- No application, scientific, API, database, cache-science, or UI code changed.

## Verification record

### Implementer-reported

- `python -m unittest tests.test_run_backend_tests tests.test_preflight_script -v`: PASS, 27 tests.
- `python scripts\preflight.py --no-cache`: PASS, 4/4 stages, 69.75 s during initial handoff.
- `python scripts\preflight.py`: PASS, 4/4 stages, 70.80 s during initial handoff; frontend policy tests and TypeScript/Vite reported skipped.
- R1 timing rerun on the same Windows environment: merge base `2181464...` = 70.39 s / 74.62 s / 71.86 s; Spec 045 `458c91e...` = 84.24 s / 71.37 s / 85.72 s for no-cache / unchanged normal / backend-only normal respectively; all passed.
- For the backend-only timing rows, only a temporary comment in `tests/test_preflight_script.py` changed after the seed run; no frontend input changed.
- `py_compile` and `git diff --check`: PASS.
- Browser checks: NOT RUN; this is tooling-only work.

### Reviewer-independent

I independently inspected:

- `scripts/preflight.py`;
- `scripts/run_backend_tests.py`;
- `tests/test_preflight_script.py`;
- `tests/test_run_backend_tests.py`;
- the relevant nested NDAX worker-budget path in `tests/test_fast_neware.py`;
- the full branch scope against merge base `2181464...`;
- the Spec 045 implementation and timing record;
- the R1 documentation-only fix and its three-scenario timing matrix.

I did **not** independently execute repository test commands; this review is using ChatGPT Chat + the GitHub connector only.

## Findings

None open.

### R1 — RESOLVED: Required before/after timing matrix

The implementation record now distinguishes all three required scenarios on the merge base and Spec 045 checkout: full no-cache, immediate unchanged normal repeat, and a normal repeat after a genuine backend-only input change. It also records frontend policy/build RUN/SKIP behavior and identifies the baseline commit and same-machine environment.

## Decision

**REVIEW CLEAN — enter the cumulative final review for standalone Spec 045.**
