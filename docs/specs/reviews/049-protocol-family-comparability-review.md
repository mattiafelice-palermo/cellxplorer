# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Previous reviewer checkpoint: `79b62b795a0baa44d1e9ed928c4e841c4987939d`  
Current implementation checkpoint: `ff38407f877db2d5d84eaf9c0037aea24a665000`  
Status: **CHILD REVIEW CLEAN — FINAL PARENT REVIEW PENDING**

## Scope and branch state

The branch is cleanly **18 commits ahead / 0 behind** current `main`; the correct merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

This review is cumulative across Spec 049, the later user-authorized 049.1 grouping workflow, manual-feedback changes, and all returned fixes through `0.26.0-beta.6`.

049.1 was added after workflow initialization and therefore is not separately enumerated in the committed child list. Its full code/spec scope has nevertheless been included in every cumulative review round since it was introduced. The final parent review must explicitly include it before completion.

## Verification record

Latest implementer handoff (`2026-08-18T00:14:24+02:00`):

- focused analysis-cache tests: PASS (33 tests);
- focused frontend comparator/grouping/DCIR tests: PASS (21/21);
- frontend type-check/build: PASS at beta.6; unchanged and skipped by the incremental preflight;
- version check: PASS (`0.26.0-beta.6`);
- canonical preflight: PASS (4/4 stages; 70 backend modules; frontend stages skipped unchanged);
- browser checks: NOT RUN (delegated to the user).

The immediately preceding beta.6 handoff also recorded a full changed-frontend canonical preflight with all 134 backend/frontend test files/modules and frontend build passing.

Reviewer independently inspected the R12 implementation and focused test coverage but did not execute commands or browser checks.

## Finding status

- **R1 — RESOLVED.** Legacy/current protocol target compatibility and cache-generation separation are preserved.
- **R2 — RESOLVED.** Frontend/backend semantic C-rate normalization is aligned.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6.** Termination/control conditions are a separate comparison dimension.
- **R4 — RESOLVED.** Termination evidence exposes equality-relevant condition fields.
- **R5 — RESOLVED.** Zero-dimension Custom mode fails closed.
- **R6 — RESOLVED.** Strict identity and frontend comparison include normalized source-declared conditions.
- **R7 — RESOLVED.** Creating new groups preserves existing definitions/names.
- **R8 — RESOLVED.** Declared BioLogic controls are represented and cross-source storage duplicates are normalized in the analysis-facing comparison projection.
- **R9 — RESOLVED.** Grouped DCIR validation follows the authorized empty-step policy.
- **R10 — RESOLVED.** Explicit analysis-local `protocol_group_id` provenance prevents membership-based ownership transfer.
- **R11 — RESOLVED.** Current checkpoint verification is recorded.
- **R12 — RESOLVED at `ff38407f`.** `_scientific_spec()` removes only `protocol_group_id` from protocol/DCIR segment cache projections while retaining every other segment field. Focused tests prove provenance-only changes preserve `_scientific_spec()` and `result_key()` for Steps/DCIR, while protocol step and DCIR pulse target changes still invalidate both.

## Confirmed boundaries

- Exact source-local protocol/DCIR targets remain the scientific authority.
- Protocol-group provenance is persisted for editor/display attribution but is excluded from scientific cache identity.
- Group rename/removal does not rewrite scientific targets.
- Raw protocol families remain available alongside reviewed groups.
- No SQL migration or request-path source-file parsing was introduced.
- Browser verification remains explicitly user-delegated by the active specification.

## Decision

**CHILD REVIEW CLEAN.** No implementation findings remain from R1–R12. Advance to the required fresh cumulative `FINAL_REVIEW` before any merge-readiness decision.