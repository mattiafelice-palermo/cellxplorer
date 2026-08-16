# Spec 048 implementation review — Test fixture runtime optimization

Status: **Changes requested — R1 open; R2/R3 resolved**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed implementation: `27d7dc058ecec1075efcd4055ed901e241c9955d`

## Review scope and result

The original Spec 048 fixture/setup implementation remains review-clean. This round reviews the
returned R1/R2 performance follow-up after the user clarified that the local workstation is currently
behaving erratically and should not be treated as a stable performance reference.

The implementer reported:

- restored focused suite: **PASS**, 149 tests; 50.824 s unittest / 51.414 s `Measure-Command`;
- runner/preflight tooling tests: **PASS**, 33 tests in 3.558 s;
- local same-topology R1 A/B: 100.088 s with empty timing history vs 80.767 s with populated
  longest-first timing history, all 68 modules passing;
- local worker sweep 4/8/12/16: 117.098 / 79.917 / 93.313 / 88.433 s;
- `python scripts\\preflight.py --no-cache`: **PASS**, 102.09 s;
- normal `python scripts\\preflight.py`: **PASS**, 80.04 s;
- R2 partition experiment reverted; original Neware Excel and portable-analysis module topology
  restored;
- Vite 8.2.1/Rolldown R3 evidence remains green;
- `git diff --check`: **PASS**;
- `compileall`: **PASS**;
- golden source/manifest files: **unchanged**.

Reviewer verification was code-reading through the GitHub connector. I confirmed that the partition
support modules and discovery exclusions are removed, the original two source test modules are again
normal discovery targets, and the R1 timing-history implementation still affects ordering only.
I also checked the live Actions history: at this review point there are **no manual workflow-dispatch
runs for this feature branch**, so the clean GitHub reference requested after the user's clarification
has not yet been collected.

## R1 — High — OPEN: validate longest-first scheduling on a clean CI runner; do not encode a noisy worker default

Affected files:

- `scripts/run_backend_tests.py`
- `scripts/preflight.py`
- `tests/test_run_backend_tests.py`
- `tests/test_preflight_script.py`
- `.github/workflows/preflight.yml` only if temporary/manual benchmark plumbing is needed

### Current

The implementation persists successful task durations in the ignored `.preflight-cache.json`, puts
unknown tasks in the first wave, then known tasks longest-first, and preserves one subprocess/private
`CELLXPLORER_DATA` root per backend module. The relevant tooling tests are present and pass.

The latest local same-topology run suggests a material scheduling gain (100.088 -> 80.767 s), but the
user explicitly confirmed that the workstation is currently varying substantially in performance.
Also, the ordered run followed the empty-history run, so filesystem/process warm-up may contribute to
the apparent gain. The result is useful evidence but not yet a clean acceptance measurement.

The code also changes the default worker cap from 16 to 8 based on the same unstable local machine.
Two local sweeps in this review cycle disagreed materially about the best worker count. That is not a
reliable basis for a permanent default change.

### Target

1. Validate **ordering only** on a clean GitHub Actions Windows runner using the final restored
   68-module topology.
2. Prefer one workflow job/runner and counterbalance warm-up effects. A suitable diagnostic sequence
   is a warm-up followed by ordered/unordered/unordered/ordered (or equivalent A/B + B/A), with
   distinct private data roots and the same effective worker count for every measured run.
3. Every measured run executes the full same backend module set. Timing history may change order only;
   no test skipping/caching is allowed.
4. Record the runner-reported CPU budget/effective worker count and the individual/aggregate A/B
   timings. Keep longest-first scheduling if the counterbalanced CI result is beneficial or neutral;
   remove it if CI shows a repeatable regression.
5. Treat worker-count selection separately from ordering. If the hosted Windows runner exposes enough
   CPUs to genuinely distinguish 8 vs 16, a CI sweep may decide the default. If it does not, **do not
   use that runner to justify the local 8-vs-16 choice**. In that case restore the previous
   `min(16, cpu_budget())` default and keep `CELLXPLORER_PREFLIGHT_JOBS` as the explicit override;
   a future stable high-core benchmark may revisit the default.
6. Temporary benchmark-only workflow plumbing may be added to run the experiment, but remove it before
   final handoff unless it is genuinely useful as a small maintained diagnostic path.

### Acceptance criteria

- Clean GitHub Windows A/B evidence exists for scheduling on the exact retained topology.
- The A/B design controls warm-up/order bias sufficiently to support the conclusion.
- All 68 backend modules execute and pass in every measured variant; failure attribution and private
  data-root isolation remain unchanged.
- Timing history remains ordering-only and malformed/missing history still fails closed.
- The permanent default worker cap is supported by a runner that can actually exercise the candidate
  counts; otherwise restore the prior 16-worker cap and retain explicit overrides.
- Canonical preflight remains green after the retained R1 configuration.
- The implementation record contains the CI run ID/linkable evidence, effective CPU/worker count and
  final conclusion.

## R2 — High — RESOLVED: partition experiment reverted

The partition experiment is resolved by reversion. The branch again discovers and runs
`tests.test_neware_excel` and `tests.test_portable_analysis` directly, with no partition wrappers or
special discovery exclusions. Therefore all original test cases/assertions remain in their original
module/process ownership and the branch no longer carries partition complexity without demonstrated
benefit.

No further R2 timing proof is required unless the partition strategy is reintroduced.

## R3 — Medium — RESOLVED: Rolldown-powered Vite migration

The Vite 8.2.1 / `@vitejs/plugin-react` 6.0.5 migration remains accepted. Prior evidence reported a
clean direct production-build reduction from 42.79 s to 20.10 s, plus successful `npm ci`, TypeScript,
568 frontend policy tests, Plotly runtime consistency and canonical no-cache preflight. No concrete
application or packaging semantic regression was found in review.

## Merge readiness

**Not ready to merge.** Only R1 remains open, specifically the clean CI scheduling measurement and the
worker-default decision above. R2 and R3 are resolved. Once R1 is clean, child 048 can advance directly
to queued child 048.1.
