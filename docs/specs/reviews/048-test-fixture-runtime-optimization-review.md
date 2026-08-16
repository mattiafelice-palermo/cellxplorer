# Spec 048 implementation review — Test fixture runtime optimization

Status: **Review clean — child 048 complete**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed implementation: `2f6c8b8a45ded698234c1cc5ad6f00cafb403805`

## Review scope and result

Child 048 is review-clean.

The original fixture/setup optimizations remain accepted: Fast Neware replaces the repeated long optional-file matrix with compact exact-parity coverage plus a committed real-source smoke; Beta bootstrap reuses an immutable migrated database template while preserving per-test writable isolation; portable-analysis removes repeated valid-export setup without weakening import/inspection failure assertions; Neware Excel remains unchanged because profiling did not justify a shortcut.

The reviewer-authorized performance experiments were also resolved conservatively:

- **R1 resolved:** the timing-history/longest-first scheduler was rejected by clean Windows CI and has now been fully removed. In run `31964460774`, ordered passes measured **61.808 s / 55.815 s**, while ordinary unordered discovery measured **51.013 s / 49.882 s** on the same four-CPU hosted runner. The runner again uses deterministic discovery order, retains one subprocess/private data root per backend module, keeps slow-task reporting and bounded parallelism, and restores the prior `min(16, CPU budget)` default with explicit job overrides.
- **R2 resolved:** the Neware Excel and portable-analysis partition experiment was reverted because it did not improve aggregate wall time. The original single-module topology is retained, so all original test cases remain in their original process ownership.
- **R3 resolved:** the Vite 8.2.1 / Rolldown migration remains accepted. The prior verification showed successful install, TypeScript, frontend policy tests, Plotly consistency and production build, with a material direct-build reduction.

No scientific calculation, parser semantics, migration, golden corpus expectation, tolerance or application behavior was weakened to obtain these gains.

## Verification record

### Implementer-reported final checkpoint

- focused Spec 048 suite: **PASS**, 149 tests, 38.454 s;
- runner/preflight unit tests: **PASS**, 30 tests, 2.539 s;
- `python scripts\\preflight.py --no-cache`: **PASS**, 4/4 stages, 79.73 s; all 128 backend/frontend tasks executed;
- `python scripts\\preflight.py`: **PASS**, 4/4 stages, 71.21 s; all 68 backend modules executed and unchanged frontend stages were skipped by the existing conservative cache;
- `compileall`, `check_versions`, `git diff --check`: **PASS**;
- golden source/manifest files: **NO CHANGES**;
- browser/manual UI checks: **NOT REQUIRED** for this tooling/test-only child.

### Reviewer-independent

I independently inspected through the GitHub connector:

- the final R1 revert commit `2f6c8b8a45ded698234c1cc5ad6f00cafb403805`;
- current `scripts/run_backend_tests.py` and confirmed timing-history read/order/persistence logic is gone;
- current `scripts/preflight.py` and confirmed `.preflight-cache.json` is again only the established frontend build/policy cache rather than a test-ordering input;
- the hosted benchmark metadata and counterbalanced timing result used to reject longest-first scheduling;
- removal of the temporary benchmark workflow and the unsuccessful partition wrappers.

I did **not** independently execute local commands in this Chat + GitHub-only reviewer session.

## Findings

No open findings.

### R1 — RESOLVED: timing-history scheduler reverted

Clean hosted evidence showed the scheduler was slower. The implementation now removes its timing-history reads, ordering, persistence, cache coupling and dedicated tests, while retaining deterministic task discovery and all verification coverage.

### R2 — RESOLVED: partition experiment reverted

The original Neware Excel and portable-analysis module topology is restored. No partition support files or discovery exclusions remain.

### R3 — RESOLVED: Rolldown-powered Vite migration

The compatible Vite 8 / Rolldown migration remains retained based on the prior successful verification and direct-build speedup.

## Decision

**REVIEW CLEAN — child 048 is complete.**

The queued child `048.1-release-ci-runtime-optimization.md` may begin on the same branch. The branch is **not yet ready to merge** because child 048.1 still requires implementation and independent review.
