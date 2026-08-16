# Review 045 — faster local verification

Specification: [`../045-faster-local-verification.md`](../045-faster-local-verification.md)
Branch: `feature/faster-local-verification`
Merge base: `main` at `218146446b738bc6359a35cbf344a4e362617f35`
Implementation commit: `458c91edd64b185172b8e44c18f1cb802e0e7703`
Status: **Changes required — final review**

## Confirmed

- The branch remains cleanly based on current `main` at `218146446b738bc6359a35cbf344a4e362617f35`; it is ahead and not behind.
- The cumulative implementation scope is limited to Spec 045 tooling/tests plus its spec/review/workflow documentation and the matching `AGENTS.md` runner-description update.
- Backend modules and `frontend/tests/*.test.ts` files are scheduled through one bounded `ThreadPoolExecutor` in `scripts/run_backend_tests.py`.
- Backend modules retain unique per-module `CELLXPLORER_DATA` directories.
- The shared test pool is capped by `CELLXPLORER_PREFLIGHT_CPU_BUDGET`; the existing NDAX inner pool is reduced against that outer budget.
- Backend and frontend task subprocesses are timed with `time.monotonic()`, exact task names are retained on failure, and the ten slowest tasks are reported.
- Frontend-policy caching is separate from the existing frontend-build cache and includes `frontend/src/**`, `frontend/tests/**`, package manifests/lockfile, `tsconfig.json`, the preflight/test-runner scripts, and Node/toolchain identity.
- Missing, old, malformed, or failed cache state causes frontend policy tests to run. Backend tests are never cache-skipped. `--no-cache` disables both frontend skips.
- No application, scientific, API, database, cache-science, or UI behavior changed.

## Verification record

### Implementer-reported

- `python -m unittest tests.test_run_backend_tests tests.test_preflight_script -v`: PASS, 27 tests.
- Initial `python scripts\preflight.py --no-cache`: PASS, 4/4 stages, 69.75 s.
- Initial `python scripts\preflight.py`: PASS, 4/4 stages, 70.80 s; frontend policy tests and TypeScript/Vite reported skipped.
- R1 same-machine timing matrix:
  - merge base `2181464...`: 70.39 s no-cache / 74.62 s unchanged normal / 71.86 s backend-only normal;
  - Spec 045 `458c91e...`: 84.24 s no-cache / 71.37 s unchanged normal / 85.72 s backend-only normal;
  - all runs passed; cache-hit Spec 045 normal/backend-only runs skipped frontend policy tests and TypeScript/Vite while backend modules ran.
- For backend-only timing rows, only a temporary comment in `tests/test_preflight_script.py` changed after the seed run; no frontend input changed.
- `py_compile` and `git diff --check`: PASS.
- Browser checks: NOT RUN; this is tooling-only work.

### Reviewer-independent

I independently inspected the cumulative branch diff and current versions of:

- `scripts/preflight.py`;
- `scripts/run_backend_tests.py`;
- `tests/test_preflight_script.py`;
- `tests/test_run_backend_tests.py`;
- the Spec 045 implementation/verification record;
- workflow state/coordination and branch scope against merge base `2181464...`.

I did **not** independently execute repository test commands; this review is using ChatGPT Chat + the GitHub connector only.

## Findings

### R1 — RESOLVED: Required before/after timing matrix

The implementation record now distinguishes the three requested scenarios and records cache RUN/SKIP behavior on the merge-base and Spec 045 checkouts.

### R2 — Medium: The primary performance goal is not established by the timing evidence

Affected files:
- `docs/specs/045-faster-local-verification.md`
- potentially `scripts/preflight.py` / `scripts/run_backend_tests.py` if repeated measurements confirm a regression

**Current**

Spec 045 exists to reduce normal local-verification wall time. The new same-machine matrix is too contradictory to support that conclusion from one sample per scenario:

- full no-cache: 70.39 s baseline → 84.24 s Spec 045 (`+13.85 s`);
- immediate unchanged normal: 74.62 s → 71.37 s (`-3.25 s`);
- backend-only normal: 71.86 s → 85.72 s (`+13.86 s`).

The backend-only case is specifically expected to benefit from the new frontend-policy cache, yet its measured total wall time is materially slower despite the expected frontend skips. More importantly, the earlier implementation handoff recorded roughly the opposite no-cache result (`~84.6 s` before vs `69.75 s` after). That direction reversal shows run-to-run noise is large enough that single measurements cannot demonstrate the feature's actual performance effect.

The logic/caching behavior is verified by inspection; what remains unproven is the performance objective and acceptance criterion 10.

**Target**

Repeat the before/after measurements as paired runs on the same machine under comparable load, using enough repetitions to separate the implementation effect from run-to-run noise. At minimum, use three paired measurements per required scenario and report a representative statistic (median is sufficient) plus the observed range. Alternate or otherwise balance merge-base/Spec 045 run order so machine drift does not systematically favor one checkout.

If the repeated cache-hit normal/backend-only results do not actually improve over merge base, investigate the measured stage/task timings and make the smallest behavior-preserving adjustment needed to meet the Spec 045 goal before returning to final review.

**Acceptance criteria**

- At least three paired merge-base/Spec 045 measurements are recorded for each of the three required scenarios.
- The record reports median (or equivalently robust representative) wall time and observed range for each side, plus frontend RUN/SKIP behavior.
- The unchanged-normal and backend-only cache-hit scenarios demonstrate a reproducible wall-time improvement over merge base rather than a result determined by one noisy run.
- The full no-cache path still executes every required stage; any reproducible regression there is quantified and either mitigated or explicitly justified against the normal-run optimization goal.
- If repeated evidence exposes an implementation bottleneck, focused tests remain passing and no coverage/verification contract is weakened to improve the number.

## Decision

**CHANGES REQUIRED — R2 must be resolved before Spec 045 is ready to merge.**
