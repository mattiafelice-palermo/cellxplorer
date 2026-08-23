# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Changes requested**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Workflow initialization: `f4ebb10e2b347f62544b700d3781f96be7390704`  
Initial implementation handoff: `09f584f32d095edb70efb18147b8aeb0eeb918eb`  
Returned-fix handoff: `f038322082dc8e4751535fa6f53d260d35273748`

## Review summary

The low-level Spec 051 implementation remains aligned with the locked binary-layout design. The exact 16-column allowlist is no longer the decoder boundary; ordinary columns resolve through `encoded_id % 256` against the project-owned storage registry; observed record stride is derived from the VMP record area; required fields use explicit offsets and full-stride NumPy dtypes; packed flags retain shared-byte handling; diagnostics preserve full encoded IDs/resolved bases; and the BioLogic parser identity is `gcpl9`.

The returned fix resolves the previous merge-blocking R1 for the verified single-direction EGG source. The adapter now accepts only the independently observed GCPL6 per-`Ns` ID-211 counter-origin shape: a transition into an active `Ns`, a near-zero cumulative ID-211 value, and an ID-7 incremental `dQ` matching that origin interval. The existing generic non-zero boundary-transfer guard otherwise remains fail-closed. The focused synthetic regression reproduces the observed approximately `1.75e-6 mA.h` boundary pattern, and the implementer reports that the real single-direction EGG file now reaches canonical validation, temporary cache construction, and ordinary voltage analysis. The second local EGG file remains metadata-only because it is repeating/mixed-direction and therefore still outside the locked Spec 041 cycle-identity contract; that is not a Spec 051 regression.

R2 is also resolved: the implementation record now names the actual plural feature branch.

One new low-severity documentation defect remains. `docs/biologic-mpr-format.md` calls the matching incremental value an “ID-211 `dQ`”, but the checked-in registry and production mapping define ID 7 as incremental charge (`raw_dq_mAh`) and ID 211 as the cumulative/source-dependent charge-discharge quantity (`raw_q_charge_discharge_mAh`). Because the new safety rule explicitly compares these two distinct fields, the format documentation must preserve that distinction.

## Implementer-reported verification

Returned-fix handoff `f0383220` reports:

- focused MPR/GCPL/parser/metadata/closure tests: **PASS (163)**;
- `tests.test_analysis_engine`: **PASS (107)**;
- canonical `python scripts\preflight.py`: **PASS (4/4; 81 backend modules and 72 frontend tests)**;
- real EGG temporary cache and ordinary voltage analysis: **PASS**;
- browser/manual checks: **NOT RUN**.

The handoff further reports that both local EGG examples decode the 21-ID/93-byte registry layout without rewriting; the single-direction example reaches canonical/cache/ordinary-voltage analysis, while the repeating mixed-direction example remains metadata-only under the existing Spec 041 cycle-identity boundary.

## Reviewer verification

I independently inspected the returned-fix diff from reviewer checkpoint `8586c0bac728b3ca3448fea884ff1f639088a67c` to `f038322082dc8e4751535fa6f53d260d35273748`, the current GCPL mapper, the new focused regression, the stable format documentation, the registry asset, and the governing canonical-capacity rules.

The returned implementation keeps the boundary exception local to `backend/app/services/biologic_gcpl.py`; it does not weaken canonical validation or generic services. The existing arbitrary boundary-transfer rejection remains present. The new positive regression reproduces the real reset shape and still runs through `canonical_cycling.validate_raw_timeseries`.

I did not independently execute repository tests or the private EGG-file acceptance because this reviewer environment has no repository checkout/private source files. The implementer-reported commands and real-file checks are therefore recorded as reported evidence, not independent execution. There are no GitHub status checks on the feature-branch commit.

## Findings

### R1 — High: The motivating 21/93 BioLogic source still becomes metadata-only, so Analysis cannot use it

**Resolution: RESOLVED in returned fix `f0383220`.**

**Affected files:** `backend/app/services/biologic_gcpl.py`, `tests/test_biologic_gcpl.py`, related BioLogic/canonical documentation.

**Current**

The returned fix adds a narrowly bounded exception for the verified EGG GCPL6 per-`Ns` capacity-counter origin. It accepts only an actual `Ns` transition into an active row where ID 211 is near zero and ID 7 `dQ` matches that same short origin interval. Other ambiguous boundary transfer still raises `UnsupportedBiologicGcplError`.

The committed regression reproduces the observed `-1.75e-6 mA.h` origin and confirms the resulting frame passes canonical raw validation. The implementer additionally reports that the real single-direction EGG file now parses canonically, builds a temporary cache, and supports ordinary voltage analysis.

**Target**

Complete the evidence-backed canonical path for the real 21/93 single-direction GCPL source without weakening fail-closed behavior.

**Acceptance criteria**

- **Satisfied:** real single-direction EGG source reported canonical rather than metadata-only.
- **Satisfied:** real source reported successful `parsing.parse_timeseries(...)`/canonical path.
- **Satisfied:** real source reported successful temporary cache and ordinary voltage analysis.
- **Satisfied:** committed synthetic regression reproduces the observed capacity-counter reset pattern.
- **Satisfied:** original generic boundary-transfer guard remains fail-closed outside the verified reset shape.
- **Satisfied:** focused tests and canonical preflight reported passing.

### R2 — Low: The Spec 051 implementation record names a non-existent feature branch

**Resolution: RESOLVED in returned fix `f0383220`.**

**Affected file:** `docs/specs/051-biologic-mpr-extensible-column-registry.md`.

**Current**

The implementation record now correctly names `feature/biologic-mpr-extensible-columns-051`.

**Target**

Keep the implementation record consistent with the actual branch.

**Acceptance criteria**

- **Satisfied:** exact branch name corrected.

### R3 — Low: Capacity-reset documentation attributes `dQ` to the wrong MPR column ID

**Affected file:** `docs/biologic-mpr-format.md`.

**Current**

The new GCPL canonical-mapping paragraph says the first active row has an ID-211 cumulative value near zero and an “ID-211 `dQ`” equal to the same short origin interval.

That is inconsistent with the checked-in storage/production contract:

- base ID **7** is the incremental charge field mapped as `raw_dq_mAh`;
- base ID **211** is the charge/discharge quantity mapped as `raw_q_charge_discharge_mAh`.

The new production guard itself correctly compares these two different arrays. The documentation currently collapses them into one ID and therefore misstates the evidence supporting the safety exception.

**Target**

Describe the observed reset using the actual field identities: the new active row's **ID-211 cumulative charge/discharge quantity** is near zero and its **ID-7 incremental `dQ`** matches that short origin interval.

**Acceptance criteria**

- Replace “ID-211 `dQ`” with wording that explicitly identifies `dQ` as ID 7 while retaining ID 211 as the cumulative/source-dependent quantity.
- Do not change implementation behavior for this documentation-only correction.

## Review conclusion

**Changes requested.** R1 and R2 are resolved. R3 is a low-severity but concrete source-format documentation error and is the only remaining finding. The branch is not yet ready to merge.
