# 049 — Protocol-family comparability review

**Status:** Plan — implementation follows this document
**Branch:** `feature/semantic-protocol-signature`
**Depends on:** the semantic protocol signature contract already present on this branch

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
protocol-family discriminator. The actual current remains available to DCIR calculations. An
absolute-current step without a rate basis remains current-controlled and is identity-relevant.

Comparability is an analysis-facing diagnostic, not a replacement signature. A workflow match
does not merge families, rewrite a `protocol_signature`, or copy step indices between files.

### 2. Comparison modes

The modal offers a short mutually exclusive `SegmentedControl`:

- **Strict** — compare all supported protocol dimensions, including voltage cutoffs, protection
  limits, timing, recording settings, ordered step identity, and loop/control structure. The
  semantic signature is authoritative for the overall strict result.
- **Workflow** — compare the ordered building blocks and their flow: step type/direction order,
  loop nesting and repeat counts, the C-rate/stop-rate schedule, and rest/hold/pulse timing.
  Voltage cutoffs and protection limits are shown as evidence but are ignored for the workflow
  result by default. Recording settings are also shown but are not a workflow discriminator.
- **Custom** — start with the workflow dimensions selected and let the user include or exclude
  voltage/protection, timing/rate, and recording dimensions explicitly.

Every evidence row reports `Same`, `Different`, or `Ignored`. `Ignored` means only that the row is
outside the selected comparison basis; it is never hidden.

### 3. No silent grouping

This feature is a review surface. It does not change the analysis draft, saved plot, protocol
signature, database, source files, or scientific cache. The existing segment editor continues to
store exact `(protocol_signature, step_indices)` targets. A future feature may add reviewed,
source-local semantic mappings, but this spec must not infer those mappings from a workflow match.

## User experience

### Entry point

In the existing protocol picker inside the protocol-segment editor:

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

The modal is intentionally read-only. There is no `Merge`, `Apply`, or `Use workflow grouping`
action in this feature because those labels would imply a persisted mapping that the current
source-local target model cannot safely provide.

## Comparison evidence contract

The frontend derives evidence from the already fetched `FileProtocol` payload; no new endpoint or
database field is required.

| Dimension | Compared content | Workflow default |
| --- | --- | --- |
| Step flow and loops | Ordered step types/directions, control conditions, loop nesting and repeat counts; strict mode also respects the identity-level step arrangement | Included |
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

- no API route, SQLAlchemy migration, analysis-spec field, cache-version bump, or source-file
  mutation;
- no automatic family regrouping or target-index translation;
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
   the structure, rates, and timing match.
6. Custom mode exposes the relevant dimension controls and updates the evidence/result state
   without mutating the segment draft.
7. The modal never creates, removes, rewrites, or merges protocol targets.
8. One-family and missing-value states are explicit and fail closed.
9. The helper tests cover matching families, voltage-only differences, capacity-scaled rate
   current differences, strict/workflow/custom selection, and missing values.
10. Frontend type-check/build and the repository preflight pass; the modal is manually exercised
    at desktop width in the in-app browser.

## Reference asset

[Open the protocol comparability modal mockup](assets/049-protocol-family-comparability.html)

The mockup opens in workflow mode and demonstrates the selector-adjacent settings action,
evidence table, ignored voltage cutoff, and strict/workflow/custom controls.
