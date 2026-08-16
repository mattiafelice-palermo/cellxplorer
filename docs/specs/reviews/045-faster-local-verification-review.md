# Review 045 — faster local verification

Specification: [`../045-faster-local-verification.md`](../045-faster-local-verification.md)
Branch: `feature/faster-local-verification`
Merge base: `main` at `218146446b738bc6359a35cbf344a4e362617f35`
Implementation commit: `f89ccb6b5baa535f761080be0310a875ca246f56`
Status: **Changes required**

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
- `python scripts\preflight.py --no-cache`: PASS, 4/4 stages, 69.75 s.
- `python scripts\preflight.py`: PASS, 4/4 stages, 70.80 s; frontend policy tests and TypeScript/Vite reported skipped.
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
- the Spec 045 implementation and timing record.

I did **not** independently execute repository test commands; this review is using ChatGPT Chat + the GitHub connector only.

## Findings

### R1 — Medium: Required before/after timing matrix is incomplete

Affected files:
- `docs/specs/045-faster-local-verification.md`

**Current**

Spec 045 explicitly requires before/after timing for three distinct scenarios: full no-cache preflight, immediate normal repeat, and backend-only repeat. The implementation record provides a pre-implementation value only for the no-cache run (`~84.6 s`) and post-implementation values for no-cache (`69.75 s`) plus one unchanged normal repeat (`70.80 s`). That single repeat is labelled `Immediate normal/backend-only repeat`, but no backend-only change was made and no pre-implementation normal/backend-only timings are recorded.

This leaves acceptance criterion 10 unproven for the cache-focused scenarios and makes it impossible to quantify whether the new frontend-policy skip improves normal/backend-only verification relative to the merge-base implementation.

**Target**

Complete the requested timing evidence using comparable runs on the merge-base implementation and the Spec 045 implementation. Keep the three scenarios distinct:

1. full `--no-cache` preflight;
2. immediate unchanged normal repeat after a successful seed run;
3. normal repeat after a harmless backend-only source/test change, with no frontend input changed.

No code change is required unless those measurements expose a functional/performance problem.

**Acceptance criteria**

- The Spec 045 verification record contains separate before/after timings for all three required scenarios.
- The backend-only scenario actually changes only a backend/Python input between the seeded successful run and the measured repeat; it is not merely an unchanged repeat relabelled as backend-only.
- The record states which frontend policy/build stages ran or skipped in each normal/backend-only case so the cache behavior is auditable.
- Measurements use the same machine/environment as closely as practical and identify the merge-base commit used for the baseline.

## Decision

**CHANGES REQUIRED — satisfy R1 before Spec 045 can enter final review.**
