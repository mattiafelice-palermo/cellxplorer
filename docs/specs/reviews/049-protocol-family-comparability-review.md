# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Previous reviewer checkpoint: `54cfde1c0a239d083f89ee0e187e846b3bbc6e25`  
Current implementation checkpoint: `ba6357c668780bf9d5545d527b8a97056f9a7aa0`  
Status: **CHANGES REQUIRED — NOT READY TO MERGE**

## Scope and branch state

The branch is cleanly **14 commits ahead / 0 behind** current `main`; the correct merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

This review is cumulative. In addition to the original Spec 049 comparator and the R1–R6 repair work, it includes the user-authorized 049.1 grouping workflow and subsequent manual-feedback changes through `0.26.0-beta.5`: all-family comparison, analysis-local protocol groups, grouped step mapping, grouped DCIR suggestions, group removal/deduplication/renaming, and the latest R4/R7/R8/R9/R10 fixes.

049.1 was added after the workflow had already been initialized, so `049-agent-state.json` still enumerates only `049`. The user explicitly requested review of that late scope in this workflow. The reviewer must reconcile that bookkeeping before `COMPLETE`; it is not an implementer code finding in this round.

## Verification record

### Implementer-reported at current checkpoint

The formal handoff at `2026-08-17T23:49:16+02:00` reports:

- focused frontend comparator/grouping/DCIR tests: PASS (20/20);
- focused backend BioLogic/protocol/rate/identity tests: PASS (80 tests);
- frontend type-check/build: PASS (`npm.cmd run build`);
- version check: PASS (`0.26.0-beta.5`);
- canonical preflight: PASS (4/4 stages; all 134 backend/frontend test files/modules);
- browser checks: NOT RUN (delegated to the user).

This is current-head verification for the beta.5 fix checkpoint and resolves the prior verification-gap finding R11.

### Reviewer-independent

Using ChatGPT Chat + the GitHub connector, I independently inspected:

- current branch HEAD `ba6357c668780bf9d5545d527b8a97056f9a7aa0` and current `main`;
- cumulative branch comparison against merge base `9f0f69215182fbba67eb2c7fabce64369009b2b0`;
- the returned-fix commit against reviewer checkpoint `54cfde1c0a239d083f89ee0e187e846b3bbc6e25`;
- current Spec 049 / 049.1 workflow state and coordination handoff;
- comparator equality/evidence code and focused tests;
- protocol-group merge/membership policy and focused tests;
- grouped segment display attribution;
- grouped DCIR comparison/mapping/validation policy and focused tests;
- the BioLogic GCPL normalized protocol payload used by the comparator.

I did **not** independently execute backend/frontend commands, Vite, canonical preflight, or browser checks. The current command results above are implementer-reported through the formal workflow handoff.

## Finding status

- **R1 — RESOLVED.** Current/v3/v1 protocol aliases preserve persisted Cycles/Steps/DCIR targets and the analysis-result cache generation was separated across target-resolution semantics.
- **R2 — RESOLVED.** Frontend rate normalization follows the backend 2% relative semantic C-rate normalization.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6.** Termination/control conditions are a separate first-class dimension, ignored by Workflow by default and selectable in Custom; Strict still includes them.
- **R4 — RESOLVED at beta.5.** Termination evidence now exposes condition name, normalized comparator id, global-user binding, `stores_as`, value and jump destination. Focused tests cover comparator-only and binding-only differences while preserving normalized jump equivalence.
- **R5 — RESOLVED.** Custom mode with no selected dimensions fails closed.
- **R6 — RESOLVED.** Backend strict identity includes normalized source-declared conditions with compatibility aliases; frontend termination comparison represents the common condition model.
- **R7 — RESOLVED at beta.5.** `mergeProtocolGroups()` preserves existing groups/names and appends only new unique definitions; focused policy tests cover preservation, rename retention and duplicate exclusion.
- **R8 — OPEN, PARTIALLY FIXED.** Declared BioLogic controls are now represented, but the frontend still compares two storage-level representations as if they were independent semantic settings, creating false `Different` results across equivalent protocols.
- **R9 — RESOLVED at beta.5.** Group-authorized empty Rest/Pause skipping is shared by DCIR mapping/validation through `dcirProtocolPolicy.ts`, with focused comparison + DCIR regressions and fail-closed handling for configured pauses/conflicting policies.
- **R10 — OPEN, PARTIALLY FIXED.** Multiple same-membership group definitions now render neutrally while ambiguous, but a saved segment still carries no group provenance and the UI still infers a specific group whenever only one current membership match remains.
- **R11 — RESOLVED at beta.5.** Current focused tests, build, version check and canonical preflight are recorded in the formal implementer handoff.

## Open findings

### R8 — High: Declared-protocol extras still need semantic normalization before comparison

Affected files:
- `backend/app/services/biologic_gcpl.py` (source payload contract)
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`

**Current**

The beta.5 fix correctly adds `capacity_limit_mah`, `hold_duration_s`, `rest_duration_s`, `final_voltage_test_v` and `loop_body_inclusive` to the frontend model and assigns them to Termination, Timing, Voltage and Structure evidence/equality. It also makes empty Rest/Pause detection fail closed for those controls. Those parts of the original R8 are fixed.

Two normalization defects remain:

1. `build_gcpl_protocol()` represents a BioLogic Rest with both `time_limit_s = rest_duration` **and** `rest_duration_s = rest_duration`. `dimensionEqual("timing")` compares both values independently. An equivalent Neware Rest normally carries only `time_limit_s`. The comparator therefore reports Timing `Different` solely because BioLogic preserves the same rest duration twice. This conflicts with R8's acceptance wording requiring a **non-redundant** `rest_duration_s` difference to matter.
2. BioLogic emits `loop_body_inclusive: false` for every non-loop step (`bool(loop_start is not None)`), while Neware steps omit that optional field. `structureToken()` compares `false` against `null`, so otherwise equivalent non-loop steps can be split purely by source representation. The flag is semantically relevant on an actual loop/control step, not on ordinary non-loop rows.

These are false-negative comparability errors: they can prevent valid Workflow/Custom grouping of semantically equivalent protocols from different supported sources.

**Target**

Compare a normalized semantic projection, not raw optional-field storage:

- collapse redundant Rest timing representation so a source-provided `rest_duration_s` that is merely the same effective rest duration already represented by `time_limit_s` does not create a second discriminator;
- treat `loop_body_inclusive` as meaningful only where loop structure exists, and normalize absent/false appropriately for non-loop rows (and for an exclusive loop representation if that is the established semantic default);
- preserve real differences: non-redundant post-step rest, hold duration, capacity cutoff, final-potential control and genuinely different loop-body semantics must still split the selected dimension and remain visible.

Do not weaken Strict identity or erase source provenance; this normalization is for the analysis-facing comparability projection.

**Acceptance criteria**

- BioLogic-like Rest `{time_limit_s: 1800, rest_duration_s: 1800}` versus equivalent Neware-like Rest `{time_limit_s: 1800, rest_duration_s: null/absent}` => Timing `Same`.
- A genuinely additional/non-redundant `rest_duration_s` difference => Timing `Different` with visible units.
- BioLogic non-loop step with `loop_body_inclusive: false` versus equivalent Neware non-loop step with the field absent => Structure `Same` in Workflow/Custom.
- Actual inclusive versus exclusive loop-body semantics => Structure `Different` with visible evidence.
- Existing capacity-limit, hold-duration, final-potential, empty-step and Neware comparator tests remain green.
- Current focused comparator tests and canonical preflight pass at the next handoff.

### R10 — Medium: Membership-only attribution can still relabel a segment after group removal

Affected files:
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`
- `frontend/src/features/analyses/editor/protocol/protocolGroupPolicy.ts`
- focused grouping/display tests

**Current**

The beta.5 fix improves the original defect: `segmentTargetGroup()` now collects all same-membership definitions and returns `null` when more than one selectable group matches, and `segmentTargetLabel()` renders `Grouped selection - N families` in that ambiguous case. It no longer blindly chooses the first group while A and B coexist.

However, `ProtocolSegment` still persists only exact `(protocol_signature, step_indices)` targets; it stores no analysis-local `group_id` or equivalent provenance. `segmentTargetGroup()` still returns a specific group whenever the **current** group list contains exactly one membership match.

That means provenance can still be fabricated after state changes. Example: groups A and B have identical membership but different definitions. A segment was created through A, so while both groups exist it renders neutrally. If A is explicitly removed, B becomes the only membership match and the unchanged old segment is now displayed as belonging to B even though it was never created through B. The same membership-only inference can also label a manually constructed multi-family segment as a group it did not originate from.

The new policy test proves membership ambiguity is enumerable, but it does not cover this segment-attribution lifecycle.

**Target**

Do not claim a specific applied-group provenance when the saved segment does not contain enough information to establish it.

Acceptable implementations include:

- persist a small analysis-local, non-scientific group provenance identifier with the segment and use it only for editor/display attribution; or
- keep saved multi-family segment attribution neutral whenever provenance cannot be proven, instead of reconstructing a group name from membership alone.

Exact scientific targets must remain authoritative and unchanged. Removing a group must never rewrite segment targets or cause another definition to inherit ownership of that segment.

**Acceptance criteria**

- Create same-membership groups A and B; a segment created through A is not labelled B while both exist.
- Remove A while B remains; that unchanged segment is still **not** relabelled as B unless persisted provenance explicitly proves B ownership.
- A manually constructed multi-family segment matching the membership of one saved group is not automatically attributed to that group without provenance.
- If explicit provenance is added, a segment created through B retains B attribution across unrelated A rename/removal.
- Exact `(protocol_signature, step_indices)` targets remain byte-for-byte/structurally unchanged by group rename/removal.
- Add focused regression coverage for the segment attribution lifecycle.

## Confirmed good boundaries at beta.5

The following are not findings in this round:

- legacy protocol target compatibility remains intact;
- analysis-result cache invalidation remains separated across target-resolution changes;
- frontend/backend common C-rate normalization remains aligned;
- termination/control evidence is now explanatory for the common Neware condition model;
- creating groups preserves existing definitions and names;
- duplicate group definitions remain excluded;
- grouped DCIR validation now uses the authorized empty-step policy without weakening ordinary configured-pause validation;
- zero-dimension Custom comparison fails closed;
- grouping metadata remains analysis-local and scientific compute continues to consume explicit source-local targets;
- raw protocol families remain selectable beside groups;
- no migration or request-path source-file parsing was introduced;
- current beta.5 focused checks/build/version check/preflight are formally recorded.

## Decision

**CHANGES REQUIRED — NOT READY TO MERGE.**

Return only **R8** and **R10** to the implementer. R4, R7, R9 and R11 are resolved at `ba6357c668780bf9d5545d527b8a97056f9a7aa0`; R8 remains the scientific-comparability blocker and R10 remains a display/provenance correctness defect.