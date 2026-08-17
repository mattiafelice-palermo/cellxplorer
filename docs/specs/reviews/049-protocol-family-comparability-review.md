# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Previous reviewer checkpoint: `a2ef217f468e6ef0bc070965e9f81e7c851d3c86`  
Current implementation checkpoint: `18f58dc7bb4969ba56cf5e7e8775eb491889903e`  
Status: **CHANGES REQUIRED — NOT READY TO MERGE**

## Scope and branch state

The branch is cleanly **16 commits ahead / 0 behind** current `main`; the correct merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

This review is cumulative. It covers the original Spec 049 comparator, the later user-authorized 049.1 grouping workflow, the manual-feedback changes, and the returned-fix sequence through `0.26.0-beta.6`.

049.1 was added after the workflow had already been initialized, so `049-agent-state.json` still enumerates only `049`. The reviewer must reconcile that late-child bookkeeping before `COMPLETE`; it is not an implementer code finding in this round.

## Verification record

### Implementer-reported at current checkpoint

The formal handoff at `2026-08-18T00:06:20+02:00` reports:

- focused frontend comparator/grouping/DCIR tests: PASS (21/21);
- focused backend BioLogic/protocol/rate/identity tests: PASS (80 tests);
- frontend type-check/build: PASS (via canonical preflight);
- version check: PASS (`0.26.0-beta.6`);
- canonical preflight: PASS (4/4 stages; all 134 backend/frontend test files/modules);
- browser checks: NOT RUN (delegated to the user).

### Reviewer-independent

Using ChatGPT Chat + the GitHub connector, I independently inspected:

- current branch HEAD and cumulative comparison against current `main`;
- the beta.6 diff against reviewer checkpoint `a2ef217f468e6ef0bc070965e9f81e7c851d3c86`;
- R8 timing/loop semantic normalization and focused comparator tests;
- R10 explicit `protocol_group_id` provenance, normalization, DCIR propagation, display resolution and focused policy tests;
- the backend analysis-result cache projection after the new editor-only provenance field was introduced.

I did **not** independently execute backend/frontend commands, Vite, canonical preflight, or browser checks. Current command results are implementer-reported through the formal workflow handoff.

## Finding status

- **R1 — RESOLVED.** Persisted protocol targets retain current/v3/v1 compatibility and cache generation was separated across target-resolution semantics.
- **R2 — RESOLVED.** Frontend C-rate normalization follows the backend semantic normalization.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6.** Termination/control conditions are a separate comparison dimension.
- **R4 — RESOLVED.** Termination evidence exposes every behavior-relevant common condition field used by equality.
- **R5 — RESOLVED.** Zero-dimension Custom comparison fails closed.
- **R6 — RESOLVED.** Strict identity and frontend comparison include normalized source-declared conditions.
- **R7 — RESOLVED.** New group creation preserves existing definitions and names.
- **R8 — RESOLVED at beta.6.** Comparator timing collapses redundant BioLogic Rest storage while preserving genuine extra rest; non-loop `loop_body_inclusive=false` normalizes with absent Neware storage while real loop inclusivity remains structure-relevant. Focused tests cover both cases.
- **R9 — RESOLVED.** Grouped DCIR validation uses the same authorized empty-step policy as grouped mapping.
- **R10 — RESOLVED at beta.6.** Segments now persist explicit analysis-local `protocol_group_id` provenance. Missing/stale provenance stays neutral, membership is only a guard, and provenance does not transfer to another same-membership group after removal. The DCIR segment conversion path preserves the field.
- **R11 — RESOLVED.** Current beta.6 focused checks, version check and canonical preflight are formally recorded.
- **R12 — OPEN.** The new editor-only provenance field is currently part of the scientific result-cache key.

## Open finding

### R12 — Medium: Editor-only protocol-group provenance changes scientific cache identity

Affected files:
- `backend/app/services/analysis_cache.py`
- `tests/test_analysis_cache.py`
- frontend segment provenance fields as the source of the new metadata

**Current**

Beta.6 correctly stores `protocol_group_id` on `ProtocolSegment` and `DcirSegment` as **analysis-local provenance** while keeping the exact source-local targets authoritative. The frontend and comparison/grouping code do not use this field for scientific calculations.

However, `analysis_cache._scientific_spec()` currently copies `protocol_segments` and `dcir_segments` wholesale into the result-cache projection:

- `"protocol_segments": spec.get("protocol_segments") or []`
- `"dcir_segments": spec.get("dcir_segments") or []`

Therefore two otherwise identical scientific specs with the same `(protocol_signature, step_indices)` or DCIR rest/pulse targets but different `protocol_group_id` values produce different result keys. Clearing provenance by editing through a raw family, or changing only editor provenance while leaving the scientific targets unchanged, can force an expensive recompute and duplicate cached results.

This conflicts with the 049.1 state contract that the analysis engine ignores editor/group metadata and with the repository's cache ownership rule: scientific cache identity should change only when scientific inputs change.

**Target**

Keep `protocol_group_id` persisted for editor/display provenance, but exclude it from the scientific cache projection for both protocol and DCIR segments. Normalize only the scientific fields used by compute when building `_scientific_spec()` rather than hashing editor-only metadata.

Do not remove the provenance field from the analysis spec and do not weaken target identity. Changes to protocol signatures, selected step indices, DCIR rest/pulse indices or other scientific segment settings must continue to invalidate the cache normally.

**Acceptance criteria**

- Two specs differing only in `protocol_segments[*].protocol_group_id` produce the same scientific result key/data signature.
- Two specs differing only in `dcir_segments[*].protocol_group_id` produce the same scientific result key/data signature.
- Changing a protocol target signature or selected step indices still changes the key.
- Changing a DCIR rest/pulse target still changes the key.
- Add focused `tests/test_analysis_cache.py` coverage for the editor-only provenance exclusion.
- Canonical preflight passes at the next handoff.

## Confirmed good boundaries at beta.6

The following are not findings in this round:

- R8's cross-source timing/loop normalization now matches the intended semantic comparison projection;
- R10's provenance no longer transfers ownership by membership alone;
- exact scientific targets remain authoritative and are not rewritten by group rename/removal;
- legacy protocol target compatibility and target-resolution cache generation remain intact;
- grouped DCIR no-op handling remains fail-closed for configured pauses/conflicting policies;
- grouping metadata remains analysis-local;
- no migration or request-path source-file parsing was introduced;
- current beta.6 focused checks/build/version check/preflight are formally recorded.

## Decision

**CHANGES REQUIRED — NOT READY TO MERGE.**

Return only **R12** to the implementer. R8 and R10 are resolved at `18f58dc7bb4969ba56cf5e7e8775eb491889903e`; R12 is a narrow cache-identity/performance regression introduced by the provenance fix.