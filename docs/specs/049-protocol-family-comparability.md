# 049 — Protocol-family comparability review

**Status:** Final review in progress
**Branch:** `feature/semantic-protocol-signature`
**Depends on:** the semantic protocol signature contract already present on this branch
**Review document:** [`reviews/049-protocol-family-comparability-review.md`](reviews/049-protocol-family-comparability-review.md)

This parent records the original pairwise comparison surface. The user-authorized
[`049.1-protocol-family-grouping.md`](049.1-protocol-family-grouping.md) extension adds explicit,
named analysis-local grouping and source-local target expansion; that extension is part of the
current implementation and final review.

## Goal

Give a scientist a compact, read-only way to compare protocol families from the existing
protocol-segment editor. The action lives beside the current protocol selector and opens a modal
that explains whether two families are comparable under a strict scientific identity, a workflow
identity, or a user-selected set of dimensions.

This addresses the common case where a DCIR program is the same in workflow terms across cells,
but capacity-scaled currents or a voltage cutoff differ. The user must be able to see those
differences without CellXplorer silently treating unlike source-local step mappings as identical.

## Scientific decisions

### 1. Identity and comparability are different concepts

The existing `FileProtocol.signature` remains the identity used by protocol-derived analysis
targets. It is a normalized semantic identity: when a step has an explicit or capacity-derived
C-rate, its capacity-scaled `current_ma` (and a capacity-scaled stop-current threshold) is not a
protocol-family discriminator. Source-declared control and termination conditions are part of the
strict identity, including their thresholds and jump destinations. The actual current remains
available to DCIR calculations. An absolute-current step without a rate basis remains
current-controlled and is identity-relevant.

Comparability is an analysis-facing diagnostic, not a replacement signature. A workflow match
does not merge families, rewrite a `protocol_signature`, or copy step indices between files.

### 2. Comparison modes

The modal offers a short mutually exclusive `SegmentedControl`:

- **Strict** — compare all supported protocol dimensions, including voltage cutoffs, protection
  limits, timing, recording settings, ordered step identity, loop structure, and termination /
  control conditions. The
  semantic signature is authoritative for the overall strict result.
- **Workflow** — compare the ordered building blocks and their flow: step type/direction order,
  loop nesting and repeat counts, the C-rate/stop-rate schedule, and rest/hold/pulse timing.
  Termination/control conditions, voltage cutoffs, and protection limits are shown as evidence but
  are ignored for the workflow result by default. Recording settings are also shown but are not a
  workflow discriminator.
- **Custom** — start with the workflow dimensions selected and let the user include or exclude
  termination conditions, voltage/protection, timing/rate, and recording dimensions explicitly.

Every evidence row reports `Same`, `Different`, or `Ignored`. `Ignored` means only that the row is
outside the selected comparison basis; it is never hidden.

### 3. No silent grouping; explicit grouping is opt-in

The core comparison view does not silently change the analysis draft, saved plot, protocol
signature, database, source files, or scientific cache. The user-authorized 049.1 extension adds an
explicit create/apply action for named analysis-local groups. It stores no synthetic protocol
signature: applying a group expands the selection to exact `(protocol_signature, step_indices)`
targets for each member family, and the explicit targets remain authoritative.

## User experience

### Entry point

In the existing protocol picker inside the protocol-segment editor (including the compact
protocol selector in the DCIR suggested-pairs surface):

- keep the `Protocol` selector and `Cells (N)` control unchanged;
- add a compact settings `ActionIcon` immediately beside the protocol selector;
- give it the accessible name and tooltip `Compare protocol families`;
- opening it shows the modal for the currently selected family as the reference;
- the control remains available even when the user has not selected any steps.

### Modal

The modal title is `Compare protocol families`. It contains, in this order:

1. a concise explanation that the comparison is diagnostic and does not change source data;
2. the `Strict`, `Workflow`, and `Custom` comparison basis control;
3. reference and candidate family selectors, each showing protocol number, executable-step count,
   and cell count;
4. the custom dimension checkboxes when `Custom` is selected;
5. a compact evidence table with `Dimension`, `Reference`, `Candidate`, and `Result` columns;
6. a calm result alert explaining what the selected basis permits and warning when selected
   dimensions differ;
7. a single `Close` action. The modal may also close through the standard close button or escape.

When fewer than two families are available, the modal explains that a second family is required
and does not fabricate a comparison.

The pairwise comparison view is intentionally diagnostic until the user enters the explicit
049.1 grouping workflow. The grouping extension provides a named create/apply action only after
the selected workflow dimensions support source-local mapping; it never silently merges source
families or rewrites their signatures.

## Comparison evidence contract

The frontend derives evidence from the already fetched `FileProtocol` payload; no new endpoint or
database field is required.

| Dimension | Compared content | Workflow default |
| --- | --- | --- |
| Step flow and loops | Ordered step types/directions, loop nesting and repeat counts; strict mode also respects the identity-level step arrangement | Included |
| Termination and control conditions | Ordered source-declared condition expressions, thresholds, comparator identifiers, variable bindings, and jump destinations | Ignored |
| C-rate / pulse schedule | Per-step C-rate and stop C-rate, using the backend's normalized rate representation; absolute-current steps remain current-controlled | Included |
| Rest and hold timing | Time limits and rest/hold/pulse durations in protocol order | Included |
| Voltage cutoffs | Target/stop voltage and protection lower/upper limits | Ignored |
| Recording settings | Record interval and voltage-delta settings | Ignored |

Evidence values must be human-readable and retain scientific units. Numeric equality must use the
same tolerance policy as the semantic protocol/rate code rather than string formatting. Missing
values must be displayed as unavailable, not as zero.

## Implementation boundaries

### Required files

- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx` — settings action,
  modal composition, family selection, and local mode state;
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts` — pure comparison
  dimensions, normalization, evidence rows, and result policy;
- `frontend/tests/protocolComparability.test.ts` — focused mode, tolerance, missing-value, and
  evidence tests;
- `docs/specs/assets/049-protocol-family-comparability.html` — the generated visual reference;
- this spec and `docs/specs/README.md`.

### Not required

- no backend API route, SQLAlchemy migration, or source-file mutation; the 049.1 extension adds
  only analysis-local frontend group metadata and exact target expansion. The review compatibility
  fix may bump the disposable analysis-result cache generation when target-resolution semantics
  change;
- no silent workflow-based family regrouping or target-index translation in the core comparator;
  explicit reviewed grouping and target expansion are defined by 049.1, while strict protocol
  identity may still create a new family when source-declared termination conditions differ;
- no new global CSS or one-off color system;
- no change to DCIR's use of the reconstructed per-step current;
- no broad refactor of `AnalysisEditor.tsx`.

## Style and accessibility

The implementation follows `docs/agent-knowledge/visual-style-guide.md` and the neighbouring
protocol editor:

- use Mantine `Modal`, `Paper`, `SegmentedControl`, `Select`, `Checkbox`, `Table`, `Alert`, and
  existing compact button sizes;
- use Tabler icons and a tooltip plus `aria-label` for the icon-only settings action;
- use current Mantine primary/teal tokens for active and success states, orange for a selected
  dimension that differs, and dimmed text for metadata;
- keep the modal dense but readable, with a scrollable body and visible close action;
- keep the comparison usable with keyboard focus and escape; never rely on color alone for result
  state;
- preserve light and dark theme-safe surfaces with Mantine semantic variables.

The HTML asset is a visual reference only. These written rules win if the reference and the
implementation details disagree.

## Acceptance criteria

1. A settings icon is visible immediately beside the protocol selector and has an accessible name.
2. Clicking it opens `Compare protocol families` without closing the surrounding segment editor.
3. The current family is initially selected as reference, and another available family can be
   selected as candidate.
4. Strict mode marks a voltage-cutoff difference as `Different` and reports the families as not
   strictly comparable.
5. Workflow mode leaves that voltage row visible as `Ignored` and can report a workflow match when
   the structure, rates, timing, and termination conditions are not selected as discriminators.
6. Custom mode exposes the relevant dimension controls and updates the evidence/result state
   without mutating the segment draft.
7. The core pairwise modal never creates, removes, rewrites, or merges protocol targets. The
   explicit 049.1 grouping workflow may create analysis-local group metadata and expand exact
   source-local targets without changing protocol signatures or source data.
8. One-family and missing-value states are explicit and fail closed.
9. The helper tests cover matching families, voltage-only differences, capacity-scaled rate
   current differences, termination-only differences, strict/workflow/custom selection, and
   missing values.
10. Frontend type-check/build and the repository preflight pass. In-app browser verification is
    intentionally deferred to the user for this handoff, per the explicit request to test the app
    manually.

## Implementation record

- Added the selector-adjacent settings action in both the normal protocol picker and the DCIR
  suggested-pairs picker.
- Added the read-only Mantine comparison modal with Strict, Workflow, and Custom modes, explicit
  Same/Different/Ignored evidence, and fail-closed unavailable-family states.
- Added the pure comparison policy and focused frontend tests for voltage-only differences,
  backend-aligned C-rate boundaries, termination-only differences, ordered evidence, custom
  dimensions, and missing values. Workflow structure now compares step/loop shape separately from
  source-declared termination/control conditions; Strict and Custom can compare the new
  termination dimension explicitly.
- Added termination conditions to the version-4 semantic protocol identity so family recognition
  separates source-declared thresholds while preserving version-3 and version-1 signature aliases
  for persisted Cycles, Steps, and DCIR targets. Bumped the disposable analysis-result cache
  generation to invalidate old warm results deterministically.
- Fixed the Vite 8 CommonJS/ESM interop at the Plotly factory boundary, preventing the local
  frontend from stopping at a blank page during startup.
- Implemented the user-authorized 049.1 grouping extension in the current beta6 behavior: named
  analysis-local groups expand reference selections into exact source-local protocol/DCIR targets;
  group provenance is editor-only and excluded from the scientific cache identity. Removing or
  renaming a group does not rewrite source data or existing explicit targets.

## Verification record

- `node --test frontend\\tests\\protocolComparability.test.ts frontend\\tests\\protocolGroupPolicy.test.ts frontend\\tests\\dcirProtocolPolicy.test.ts` — PASS (21 tests).
- `python -m unittest tests.test_analysis_cache` — PASS (33 tests, including editor-only group
  provenance exclusion from the scientific cache identity).
- `npm.cmd run build` — PASS (TypeScript build and Vite production bundle).
- `python scripts\\check_versions.py --expected-version 0.26.0-beta.6` — PASS.
- `python scripts\\preflight.py` — PASS (4/4 stages; complete backend/frontend preflight).
- Read-only inspection of analysis 34 (`Bump study cells`) — PASS: the 11 selected sources resolve to
  four semantic signatures with the four 97% termination sources separated from the seven 80% sources;
  explicit grouping then expands selections to exact source-local targets.
- In-app browser check — NOT RUN, per the explicit request that the user test the app manually.

## Reference asset

[Open the protocol comparability modal mockup](assets/049-protocol-family-comparability.html)

The mockup opens in workflow mode and demonstrates the selector-adjacent settings action,
evidence table, ignored termination/voltage rows, and strict/workflow/custom controls.
