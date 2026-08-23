# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Complete — ready to merge**  
Ready to merge: **Yes**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Workflow initialization: `f4ebb10e2b347f62544b700d3781f96be7390704`  
Initial implementation handoff: `09f584f32d095edb70efb18147b8aeb0eeb918eb`  
R1/R2 returned-fix handoff: `f038322082dc8e4751535fa6f53d260d35273748`  
R3 returned-fix handoff: `868d66c92737609a64b358ebd926bd0b114bc7a2`

## Final cumulative review

The cumulative branch is clean against current `main` / merge base `706dc0f14880202a8c5e22b35020502bcf3b4dc9`. The branch is ahead only and contains the Spec 051 implementation, its focused tests/documentation, and workflow/review records; there is no unrelated migration, frontend feature, or scientific-cache-version scope.

The final low-level reader matches the locked binary-safety design. Ordinary encoded IDs preserve their full source values while resolving storage generically through `encoded_id % 256`; the six packed logical flags retain exact-ID/shared-byte handling. The production registry contains 100 unique ordinary base definitions and the tests compare its dtype/width table directly with the checked-in Spec 051 asset. Record stride is derived from the VMP payload size divided by datapoints, bounded before allocation, and used as the explicit NumPy dtype itemsize. Known optional columns may shift required offsets safely; unknown interleaved widths fail closed; an unknown trailing suffix is treated as opaque only after every required field is located; duplicate resolved bases, malformed packed flags, missing required fields, non-divisible record areas, all-known width mismatches, and unsupported module versions remain rejected.

The focused test matrix covers the baseline 16-ID/53-byte layout, the required 21-ID/93-byte extended layout, generic high-byte resolution including `635 -> 123`, high-byte required-base resolution, known optional interleaving, multiple unknown trailing IDs, duplicate-base rejection, stride mismatch, packed-flag decoding, and a 500,000-row bulk NumPy decode path. Parser identity is advanced (`MPR_READER_REVISION = 2`, BioLogic adapter `gcpl9`) and existing lifecycle tests exercise reinspection/promotion from older BioLogic parser identities. `CALC_VERSION` is unchanged, consistent with the fact that Spec 051 primarily widens accepted binary layouts rather than globally redefining cached scientific results.

The user-reported end-to-end failure was addressed during review. The first implementation decoded the real EGG 21/93 layout but left the motivating source metadata-only at the GCPL capacity-boundary guard. Returned fix `f0383220` adds only the source-evidenced GCPL6 per-`Ns` counter-origin rule: the new active `Ns` must begin with an ID-211 cumulative quantity near zero and an ID-7 incremental `dQ` matching that short origin interval. Arbitrary non-zero boundary transfer still fails closed. A synthetic regression reproduces the observed approximately `1.75e-6 mA.h` pattern, and the implementer reports that the real single-direction EGG source now passes canonical parsing, temporary cache construction, and ordinary voltage analysis. The second repeating/mixed-direction EGG example remains metadata-only under the existing Spec 041 cycle-identity contract, which is intentionally out of scope for Spec 051.

R2 and R3 are also closed: the implementation record uses the actual plural feature-branch name, and the stable format documentation now correctly distinguishes ID 211 cumulative/source-dependent charge-discharge quantity from ID 7 incremental `dQ`.

## Verification

### Implementer-reported

At executable checkpoint `f0383220`:

- focused MPR/GCPL/parser/metadata/closure tests: **PASS (163)**;
- `tests.test_analysis_engine`: **PASS (107)**;
- canonical `python scripts\\preflight.py`: **PASS (4/4; 81 backend modules and 72 frontend tests)**;
- real single-direction EGG temporary cache and ordinary voltage analysis: **PASS**.

At documentation-only R3 checkpoint `868d66c9`:

- R3 documentation correction: **PASS**;
- `git diff --check`: **PASS**;
- `tests.test_biologic_gcpl`: **PASS (47)**;
- `tests.test_time_capacity_workers`: **PASS (7)**;
- a canonical preflight rerun completed 80/81 backend modules plus all frontend tests, type checking, and bundle before a reported transient worker-warmup failure.

No executable or test code changed after `f0383220`, whose canonical preflight passed. The current R3 delta is limited to the stable format documentation plus workflow handoff files, and the current focused worker module passed independently. I therefore do not treat the later warmup failure as a Spec 051 product defect or as invalidating the passing preflight on the identical executable/test tree.

### Reviewer-independent

I independently inspected the cumulative GitHub branch diff, current source code, test coverage, documentation, and workflow records. I did **not** independently execute the repository test suite or private EGG files because the reviewer environment has no repository checkout/private source corpus. There are no GitHub status checks on the feature-branch handoff commit. No browser/manual test is claimed by the reviewer.

## Findings

### R1 — High: The motivating 21/93 BioLogic source still becomes metadata-only, so Analysis cannot use it

**Resolution: RESOLVED in `f0383220`.**

**Affected files:** `backend/app/services/biologic_gcpl.py`, `tests/test_biologic_gcpl.py`, related BioLogic/canonical documentation.

**Current**

The real single-direction EGG source is reported to reach canonical parsing, cache construction, and ordinary voltage analysis. The adapter's exception is restricted to the verified `Ns` transition / near-zero ID-211 origin / matching ID-7 `dQ` shape.

**Target**

Support the motivating real 21/93 single-direction source without weakening generic capacity-boundary safety.

**Acceptance criteria**

- **Satisfied:** real source reported canonical rather than metadata-only.
- **Satisfied:** real source reported successful parse/cache/ordinary-voltage path.
- **Satisfied:** source-evidenced reset regression added.
- **Satisfied:** unrelated non-zero boundary transfer remains fail-closed.

### R2 — Low: The Spec 051 implementation record names a non-existent feature branch

**Resolution: RESOLVED in `f0383220`.**

**Affected file:** `docs/specs/051-biologic-mpr-extensible-column-registry.md`.

**Current**

The implementation record names `feature/biologic-mpr-extensible-columns-051`.

**Target**

Keep the implementation record consistent with the actual branch.

**Acceptance criteria**

- **Satisfied:** exact branch name corrected.

### R3 — Low: Capacity-reset documentation attributes `dQ` to the wrong MPR column ID

**Resolution: RESOLVED in `868d66c9`.**

**Affected file:** `docs/biologic-mpr-format.md`.

**Current**

The format documentation now identifies ID 211 as the cumulative charge/discharge quantity and ID 7 as incremental `dQ`, matching the storage registry and production mapping.

**Target**

Keep the documented evidence for the reset rule aligned with the actual source fields.

**Acceptance criteria**

- **Satisfied:** correct ID 7 / ID 211 distinction documented.
- **Satisfied:** R3 changed documentation only.

## Final conclusion

**Ready to merge: Yes.** All review findings are resolved, the cumulative implementation matches Spec 051's locked binary-safety architecture, and the motivating supported single-direction 21/93 source is reported analysis-capable rather than metadata-only.
