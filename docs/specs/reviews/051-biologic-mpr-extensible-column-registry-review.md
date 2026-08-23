# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Review clean — final cumulative review pending**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Workflow initialization: `f4ebb10e2b347f62544b700d3781f96be7390704`  
Initial implementation handoff: `09f584f32d095edb70efb18147b8aeb0eeb918eb`  
R1/R2 returned-fix handoff: `f038322082dc8e4751535fa6f53d260d35273748`  
R3 returned-fix handoff: `868d66c92737609a64b358ebd926bd0b114bc7a2`

## Review summary

The child review is clean. The low-level MPR reader now resolves ordinary encoded IDs generically through `encoded_id % 256` against the project-owned 100-entry storage registry, while the six packed flag IDs retain exact shared-byte semantics. Record stride is derived from the actual VMP record area, required fields use explicit offsets in a NumPy dtype whose itemsize is the observed stride, known optional columns may be interleaved, and unknown widths fail closed unless they form a trailing opaque suffix after all required fields are located.

The previous end-to-end blocker is resolved for the motivating single-direction 21-ID/93-byte EGG source. The GCPL adapter accepts only the source-evidenced per-`Ns` ID-211 counter-origin reset shape and otherwise preserves the existing fail-closed boundary-transfer guard. The implementer reports that the real source now reaches canonical parsing, temporary cache construction, and ordinary voltage analysis. The repeating/mixed-direction EGG example remains metadata-only under the pre-existing Spec 041 cycle-identity contract and is outside Spec 051's binary-layout widening.

The documentation and implementation record are now consistent with the code: R2 uses the actual feature-branch name, and R3 correctly distinguishes ID 211 as the cumulative/source-dependent charge-discharge quantity from ID 7 as incremental `dQ`.

## Verification evidence

Implementer-reported evidence across the accepted executable checkpoint `f0383220`:

- focused MPR/GCPL/parser/metadata/closure tests: **PASS (163)**;
- `tests.test_analysis_engine`: **PASS (107)**;
- canonical `python scripts\\preflight.py`: **PASS (4/4; 81 backend modules and 72 frontend tests)**;
- real single-direction EGG temporary cache and ordinary voltage analysis: **PASS**;
- browser/manual checks: **NOT RUN**.

For documentation-only handoff `868d66c9`, the implementer reports `git diff --check` PASS, `tests.test_biologic_gcpl` PASS (47), and `tests.test_time_capacity_workers` PASS (7). A canonical preflight rerun reached 80/81 backend modules with all frontend tests, type checking, and bundle passing before a reported transient worker-warmup failure. No executable or test code changed after `f0383220`, whose canonical preflight passed.

Reviewer verification is code inspection only. I inspected the cumulative branch diff against merge base `706dc0f1`, the registry/stride resolver, low-level record decoder, GCPL capacity-boundary fix, parser identity/reinspection integration, regression tests, and current documentation. I did not independently execute repository tests or the private EGG files; there are no GitHub status checks on the feature-branch handoff commit.

## Findings

### R1 — High: The motivating 21/93 BioLogic source still becomes metadata-only, so Analysis cannot use it

**Resolution: RESOLVED in `f0383220`.**

**Affected files:** `backend/app/services/biologic_gcpl.py`, `tests/test_biologic_gcpl.py`, related BioLogic/canonical documentation.

**Current**

The adapter now accepts the verified GCPL6 per-`Ns` capacity-counter origin only when the boundary is an actual `Ns` transition into an active row, ID 211 is near zero, and ID 7 incremental `dQ` matches that short origin interval. Arbitrary non-zero boundary transfer still fails closed.

**Target**

Complete the evidence-backed canonical path for the real 21/93 single-direction GCPL source without weakening the generic safety boundary.

**Acceptance criteria**

- **Satisfied:** real single-direction EGG source reported canonical rather than metadata-only.
- **Satisfied:** real source reported successful canonical parsing, temporary cache preparation, and ordinary voltage analysis.
- **Satisfied:** synthetic regression reproduces the observed approximately `1.75e-6 mA.h` reset.
- **Satisfied:** generic ambiguous boundary transfer remains rejected.

### R2 — Low: The Spec 051 implementation record names a non-existent feature branch

**Resolution: RESOLVED in `f0383220`.**

**Affected file:** `docs/specs/051-biologic-mpr-extensible-column-registry.md`.

**Current**

The implementation record names `feature/biologic-mpr-extensible-columns-051`.

**Target**

Keep the implementation record consistent with the actual workflow branch.

**Acceptance criteria**

- **Satisfied:** exact branch name corrected.

### R3 — Low: Capacity-reset documentation attributes `dQ` to the wrong MPR column ID

**Resolution: RESOLVED in `868d66c9`.**

**Affected file:** `docs/biologic-mpr-format.md`.

**Current**

The format documentation now states that the new active row has an ID-211 cumulative charge/discharge quantity near zero and an ID-7 incremental `dQ` equal to the same short origin interval. This matches the storage registry and production field mapping.

**Target**

Keep the source-format documentation aligned with the actual ID 7 / ID 211 field identities used by the safety rule.

**Acceptance criteria**

- **Satisfied:** ID 7 is explicitly identified as incremental `dQ` and ID 211 as the cumulative/source-dependent quantity.
- **Satisfied:** no implementation behavior changed in the R3 correction.

## Child-review conclusion

**Review clean.** All R findings are resolved. The workflow proceeds to the required fresh cumulative final review before merge readiness is declared.
