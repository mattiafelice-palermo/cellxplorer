# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Previous reviewer checkpoint: `1df9c83b244d46775875f8a2ee98881006fc8be7`  
Current implementation checkpoint: `3a5d99c43ca57c998d13e736d4af47aca87d9701`  
Status: **CHANGES REQUIRED — NOT READY TO MERGE**

## Scope and branch state

The branch is cleanly **12 commits ahead / 0 behind** the current `main`; the correct merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

This review is cumulative. In addition to the original Spec 049 comparator and the R1–R6 repair work, the branch now contains the user-authorized 049.1 grouping workflow and subsequent manual-feedback commits through `0.26.0-beta.4`: all-family comparison, persisted analysis-local protocol groups, group selection/mapping, grouped DCIR suggestions, removal/deduplication, and inline group renaming.

049.1 was added after the Spec 049 workflow had already been initialized, so `049-agent-state.json` still enumerates only `049`. The user explicitly requested review of the late manual-feedback scope while the workflow is in `REVIEWER + REVIEW`; this round therefore reviews that cumulative scope without silently treating it as already accepted. The reviewer must reconcile the late-child review bookkeeping before the workflow can reach `COMPLETE`.

## Verification record

### Implementer-reported before the late manual-feedback commits

The latest formal handoff recorded at `2026-08-17T20:41:48+02:00` reported:

- focused frontend tests: PASS (11 tests);
- focused backend tests: PASS (132 tests);
- golden analysis: PASS (30 tests; zero diffs);
- Neware Excel: PASS (67 tests);
- frontend type-check/build: PASS;
- version check: PASS (`0.25.0-beta.3`);
- canonical preflight: PASS (4/4 stages; all 132 backend/frontend modules);
- live read-only analysis 34 check: PASS (four 97% sources separated from seven 80% sources);
- browser checks: NOT RUN (delegated to the user).

Those results predate the current `0.26.0-beta.4` grouping/management checkpoint and therefore are not verification of the current head.

### Reviewer-independent

Using ChatGPT Chat + the GitHub connector, I independently inspected:

- current branch head and cumulative comparison against the confirmed merge base;
- Spec 049, late child 049.1, workflow state/coordination, and the prior canonical review;
- backend protocol identity/legacy alias generation and target-resolution helpers;
- Cycles, Steps and DCIR target-resolution call sites;
- analysis-result cache generation/invalidation;
- the frontend comparator, evidence generation and focused tests;
- protocol-group normalization/definition policy;
- group creation, rename, removal, selection and exact target mapping;
- grouped DCIR suggestion conversion/validation;
- BioLogic GCPL declared-protocol fields that participate in backend protocol identity;
- current GitHub status/workflow evidence for `3a5d99c`.

I did **not** independently execute the backend/frontend tests, Vite build, canonical preflight, or browser checks. GitHub exposes no CI status or workflow run for `3a5d99c`.

## Finding status

- **R1 — RESOLVED.** Legacy v1/v3 signatures are retained as aliases, Cycles/Steps/DCIR resolve targets through current-or-legacy identity, and analysis-result cache generation is bumped so pre-change warm results cannot survive into the new target-resolution generation.
- **R2 — RESOLVED.** Frontend C-rate normalization now follows the backend 2% relative semantic normalization, including the sub-1C boundary regressions.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6.** Termination conditions are no longer part of Workflow structure. They are a separate first-class dimension, ignored by Workflow by default and selectable in Custom; Strict still includes them.
- **R4 — OPEN.** Ordered structure/rate/timing evidence was repaired, but the new termination dimension can still report `Different` while rendering indistinguishable evidence.
- **R5 — RESOLVED.** Custom mode with zero selected dimensions fails closed.
- **R6 — RESOLVED for the common normalized condition model.** Backend v4 strict identity includes source-declared `conditions[]` fields with a v3 compatibility alias, and the frontend exposes a separate Termination/control row. R8 below covers additional declared-protocol controls that do not live in the common `conditions[]` object.

## Open findings

### R4 — Medium: Termination evidence still hides fields that make the row `Different`

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`

**Current**

`conditionToken()` compares `expression`, `name`, `value`, `comparator_id`, `global_user_id`, `stores_as`, and the normalized/raw jump destination. `conditionEvidence()`, however, renders only `expression=value` plus the jump. It even prints `=` regardless of `comparator_id`.

Consequently a comparator-only, condition-name-only, or variable-binding-only change can correctly make the Termination row `Different` while the Reference and Candidate evidence strings remain identical. That is the same diagnostic failure class as the original R4 and conflicts with the evidence contract now that termination is a first-class dimension.

**Target**

Every behavior-relevant field used to decide Termination equality must have a compact human-readable representation when it differs. Comparator semantics must not be rendered as a hard-coded equality operator; if a symbolic label is unavailable, expose the normalized comparator identifier rather than hiding it. Variable/binding/name fields may be shown only when present, but a difference in one of them must be visible.

**Acceptance criteria**

- Comparator-only difference => Termination `Different` and visibly distinguishable evidence.
- `global_user_id` / `stores_as`-only difference => `Different` and visibly distinguishable evidence.
- Existing value-only and jump-only tests remain green.
- Renumbered but structurally equivalent jump destinations remain `Same` in Custom workflow comparison.

### R7 — Medium: Creating a new protocol group deletes all previously applied groups

Affected files:
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`
- `frontend/src/features/analyses/editor/AnalysisEditor.tsx`
- `frontend/src/features/analyses/editor/families/dcir/DcirPlotCard.tsx`
- focused grouping tests

**Current**

`GroupedProtocolComparisonModal.applyGroups()` calls `onApplyGroups(normalizeProtocolGroups(newGroupProposals.map(...)))`: the callback receives only the newly created proposals. Both AnalysisEditor and the DCIR settings surface treat that callback value as the complete `protocol_groups` collection and replace the existing list.

Therefore, if group A already exists and the user creates genuinely new group B, group A is silently removed even though the 049.1 contract says creation persists only new metadata and removal is an explicit separate action. Renamed existing groups are lost the same way.

**Target**

Creating groups must preserve all existing normalized group definitions and append only genuinely new definitions. Existing identities/names remain unchanged unless the user explicitly renames or removes them. Deduplication still uses the complete definition key.

**Acceptance criteria**

- Start with existing group A; create new group B; persisted state contains both A and B.
- A renamed existing group keeps its id/name after another group is created.
- A duplicate proposal remains excluded and does not create a second definition.
- Explicit Remove remains the only normal action that deletes an existing group.
- Add focused regression coverage at the state/policy boundary or extract the merge operation into a pure tested helper so this cannot regress through modal wiring.

### R8 — High: Comparator/grouping omits supported declared-protocol controls that participate in backend identity

Affected files:
- `backend/app/services/protocol.py` (source-of-truth identity contract)
- `backend/app/services/biologic_gcpl.py` (declared-protocol fields)
- `frontend/src/api.ts`
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`

**Current**

The backend deliberately includes BioLogic declared-protocol controls such as `capacity_limit_mah`, `hold_duration_s`, `rest_duration_s`, `final_voltage_test_v`, and `loop_body_inclusive` in protocol identity. The GCPL adapter emits those fields on each step.

The frontend `ProtocolStep` contract/comparator does not model those fields. Termination equality only reads `conditions[]`; timing only reads `time_limit_s`; voltage only reads the common target/stop/protection fields; `isEmptyRestPauseStep()` likewise cannot consider source-supported fields it does not model.

This creates two distinct failures:

1. **Strict diagnostic evidence:** backend signatures can differ while all six visible comparison rows say `Same`, because Strict's overall result is signature-authoritative but the evidence does not explain the identity difference.
2. **Custom/grouping false positives:** when a scientist explicitly selects Termination and/or Timing, two declared protocols can still be grouped despite different capacity cutoffs, hold/post-step rest durations, or other source-declared controls that the backend considers identity-relevant.

This is scientific-comparability scope, not a cosmetic omission: 049 requires all supported dimensions in Strict, and 049.1 uses the same comparator to authorize source-local grouped step mapping.

**Target**

Bring the frontend comparison payload into alignment with the normalized declared-protocol contract. Reuse fields already present in `FileProtocol` JSON rather than inventing source-specific semantics in the UI. At minimum:

- capacity cutoff/control belongs in the termination/control evidence/equality policy;
- hold and source-declared rest durations belong in timing;
- final-potential/source-declared voltage controls must be assigned to the appropriate voltage/termination evidence;
- structural extras such as loop-body inclusivity must remain visible through structure if they are not already fully represented by normalized groups;
- the empty Rest/Pause predicate must fail closed when any supported source-declared setting makes the row non-empty.

A backend-provided normalized comparison projection is also acceptable if it avoids maintaining a second semantic contract in TypeScript, but no new source-file reads or request-path scientific work should be introduced.

**Acceptance criteria**

- Two GCPL-like protocols differing only in `capacity_limit_mah` are `Different` when Termination is selected and show the cutoff difference.
- A relevant `hold_duration_s` / non-redundant `rest_duration_s` difference is `Different` when Timing is selected and is visible with units.
- A relevant final-potential difference cannot produce six `Same` rows under Strict.
- Custom grouping with those dimensions selected cannot group protocols that differ in the selected declared control.
- Empty Rest/Pause classification has focused coverage for supported extra fields.
- Existing Neware comparator behavior and semantic-signature compatibility remain green.

### R9 — Medium: Ignored empty Rest/Pause rows can break grouped DCIR suggestion expansion

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`
- `frontend/src/features/analyses/editor/families/dcir/DcirPlotCard.tsx`
- focused DCIR/grouping tests

**Current**

049.1 can deliberately group a reference `Rest -> pulse` protocol with a candidate `Rest -> empty Pause -> pulse` protocol when `Ignore empty rest/pause steps` is enabled. `mapComparableProtocolStepNumbers()` correctly skips the empty row and maps the reference pair to the candidate's Rest and later pulse.

The resulting grouped DCIR target is then validated by `targetFromSteps()`. That function defines adjacency as the next protocol step whose `direction !== "control"`. A truly empty Rest/Pause still has `direction: "rest"`, so it remains in that list. The candidate Rest is therefore considered adjacent to the empty Pause rather than to the mapped pulse, and the grouped suggestion is rejected even though the grouping policy explicitly treated the Pause as a no-op for mapping.

The existing comparator test verifies ordinal mapping across an empty Pause, but it does not exercise the DCIR conversion/validation boundary.

**Target**

DCIR pair validation for grouped mappings must use a no-op/executable-order policy consistent with the comparison option that authorized the mapping, without weakening ordinary DCIR validation. A genuinely configured Rest/Pause must never be skipped.

**Acceptance criteria**

- Reference `Rest -> pulse` and candidate `Rest -> truly-empty Pause -> pulse`, grouped with `ignore_empty_rest_pause=true`: a suggested pair expands to exact source-local targets for both families and validates successfully.
- The candidate target contains the actual Rest and pulse step numbers, not the ignored Pause.
- With the empty-step policy disabled, the families do not gain this mapping path.
- A Pause carrying any current/rate/voltage/timing/recording/protection/termination setting is not skipped.
- Add a focused integration/pure-policy regression that covers comparison mapping **and** DCIR validation together.

### R10 — Medium: Segment-to-group display attribution is ambiguous when multiple definitions share the same membership

Affected files:
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`
- `frontend/src/features/analyses/editor/protocol/protocolGroupPolicy.ts`
- focused grouping tests

**Current**

The current policy intentionally allows two protocol groups with the same member families when their reference, mode, selected dimensions, or empty-step policy differs; the complete definition key distinguishes them.

`segmentTargetGroup()`, however, reconstructs a segment's group solely from the set of target-family signatures and returns the first membership match. The saved segment contains exact targets but no unique group provenance. If group A and group B have the same families but different definitions/names, a segment created through B can be displayed as belonging to A. Renaming/removing/reordering A can therefore change the displayed attribution of a segment that was never created through A.

This does not change the exact scientific targets, but it violates the 049.1 follow-up requirement that the grouped segment card identify the applied group and makes the displayed provenance unreliable.

**Target**

Do not infer a unique applied group from membership when membership is ambiguous. Either retain sufficient analysis-local, non-scientific provenance to identify the source group, or render a neutral multi-family label when exact group attribution cannot be recovered. Do not re-collapse valid distinct group definitions merely to make the inference unique.

**Acceptance criteria**

- Create groups A and B with identical family membership but different valid definitions/names.
- A segment created through B is never labelled as A merely because A appears first.
- Renaming or removing A does not falsely relabel B's existing segment.
- Exact `(protocol_signature, step_indices)` targets remain unchanged.

### R11 — Medium: The current `0.26.0-beta.4` checkpoint has no canonical verification evidence

Affected scope:
- post-handoff grouping/management commits through `3a5d99c43ca57c998d13e736d4af47aca87d9701`;
- especially `ProtocolSegmentsPanel.tsx`, `protocolGroupPolicy.ts`, DCIR grouping integration, and synchronized version files.

**Current**

The formal workflow verification record stops before the late 049.1/manual-feedback commits. Current head is `0.26.0-beta.4`, while the latest recorded handoff verification is for the earlier `0.25.0-beta.3` checkpoint. The latest commit alone changes the grouping UI/policy and its tests; GitHub has no status check or workflow run for `3a5d99c`.

The reviewer cannot treat earlier preflight/build results as evidence for the current branch state.

**Target**

After R4/R7/R8/R9/R10 are addressed, run the repository's current focused checks for the touched comparator/group/DCIR areas, then the canonical aggregate verification sequence and record the exact current-head results in the implementer handoff. Browser/manual evidence remains user-delegated unless explicitly assigned to the implementer.

**Acceptance criteria**

- Focused frontend comparator/grouping/DCIR regressions required by the open findings: PASS.
- Relevant focused backend protocol/analysis/cache tests if R8 or compatibility code changes: PASS.
- Frontend type-check/build: PASS.
- Current synchronized version check: PASS.
- `python scripts\preflight.py`: PASS at the fix checkpoint.
- The coordination handoff records what was actually run; browser remains `NOT RUN` unless it was actually performed.

## Confirmed good boundaries at the current checkpoint

The following areas are not findings in this round:

- persisted pre-v4 protocol targets have current/v3/v1 compatibility resolution rather than being silently orphaned;
- analysis-result cache generation is separated across the target-resolution change;
- frontend/backend C-rate semantic normalization is aligned for the covered common protocol fields;
- zero-dimension Custom comparison fails closed;
- Workflow intentionally ignores the separate Termination dimension by current user decision;
- grouping metadata remains analysis-local and the backend scientific engine continues to consume explicit protocol/DCIR targets rather than group identities;
- raw protocol families remain selectable beside groups;
- group creation is blocked when structure is not selected;
- group removal is metadata-only and existing segment targets are not rewritten;
- version files are synchronized at the current `0.26.0-beta.4` checkpoint;
- no SQL migration or request-path source-file parsing was added by this feature scope.

## Decision

**CHANGES REQUIRED — NOT READY TO MERGE.**

R1, R2, R3, R5 and R6 are closed at this checkpoint. Keep **R4, R7, R8, R9, R10 and R11** open. R8 is the scientific-comparability blocker; R7 is a direct user-state loss regression; R9 breaks one of the explicit grouped-DCIR/empty-step paths; R4 and R10 are diagnostic/provenance correctness defects; R11 prevents merge-readiness claims for the current head.
