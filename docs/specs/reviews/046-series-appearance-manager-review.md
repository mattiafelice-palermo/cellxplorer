# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Status: **Changes required — user manual/browser acceptance found R3–R9**

## Confirmed

- The feature branch remains based directly on `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`, is ahead only, and contains no unrelated parser, migration, cache, or scientific-calculation changes.
- 046.1, 046.2 and 046.3 each completed an independent child review and all prior child findings are resolved.
- Preview-only visibility remains local modal state and is not persisted as legend membership.
- `series_order` is additive `PlotStyle` presentation state. Stored known keys are normalized safely, quantity-group order is fixed, cross-group moves are rejected, and palette-slot identity is not derived from reordered rows.
- The supported Cycles, Time/Capacity, Steps, DCIR, Chargeability and Rate capability builders propagate deterministic `legendrank` values without reordering scientific trace arrays.
- The main scientific preview remains fixed at its existing geometry and explicitly legend-free.
- The detached legend is derived from the real unhidden family-specific Plotly preview, filters `showlegend: false` helper traces, preserves effective name/style/group/rank presentation, and strips scientific positional/customdata payloads before the second Plotly instance.
- The final legend-preview fix is compatible with the bundled Plotly 2.35.3 runtime: empty positional arrays suppress curve drawing, normal trace visibility avoids the `legendonly` muted style, and disabling item/double-click while leaving Plotly otherwise interactive permits its bounded internal legend scrolling.
- Final repository closure is present: all maintained version declarations are `0.24.0-beta.1`, `CHANGELOG.md` contains the Series appearance manager feature entry, all child specs are marked implemented/review-clean, Parent 046 records implementation complete with manual acceptance pending, and the spec index includes the complete 046 family.
- No durable architecture or project-context ownership boundary changes were introduced by Parent 046.

## Verification record

### Implementer-reported

046.1 final follow-up:

- `node --test frontend\\tests\\seriesStyling.test.ts`: PASS — 47 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS.

046.2 final follow-up:

- `node --test frontend\\tests\\seriesStyling.test.ts frontend\\tests\\plotStylePalette.test.ts frontend\\tests\\plotStylePresets.test.ts`: PASS — 66 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS — elevated rerun, 4/4 stages.

046.3 final follow-up:

- `node --test frontend\\tests\\legendPreview.test.ts frontend\\tests\\seriesStyling.test.ts frontend\\tests\\plotStylePalette.test.ts frontend\\tests\\plotStylePresets.test.ts`: PASS — 71 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS — elevated, 4/4 stages, 127 backend/frontend modules.

Parent closure follow-up:

- `python scripts\\check_versions.py --expected-version 0.24.0-beta.1`: PASS.
- `python scripts\\preflight.py`: PASS — 4/4 stages, 127 backend/frontend modules.
- `git diff --check`: PASS — exit 0; line-ending notices only.

### User manual/browser acceptance — round 1

The user resumed the required final browser pass and found the concrete issues recorded as R3–R9 below. The rest of the 33-item cumulative matrix is not yet considered complete; after these fixes, the affected checks and the remaining matrix must be rerun/continued rather than treating this partial pass as final acceptance.

### Reviewer-independent

I independently inspected:

- the complete cumulative branch scope against the original merge base;
- all three final child review records and their resolved findings;
- selection, pruning, bulk editing, effective mixed values, legend-membership and Reset wiring in `SeriesStyleModal.tsx`;
- the current `ALL_SERIES_KEY` base-style semantics versus the user's final acceptance expectation;
- the current multi-selection legend controls shown in the user screenshot and source;
- the current shift-selection row event wiring and row text/selectability boundary;
- the current handle-only `useSortable` activation in `SortableSeriesRow`;
- marker `Open` layout in both single- and multi-series editors;
- the Palettes tab label/Global badge composition;
- the hand-built SVG `PalettePreview`, including its theme-dependent SVG presentation attributes;
- group-local ordering, `legendrank`, palette-slot and linked-secondary helpers in `seriesStyling.ts`;
- fixed scientific-preview versus unhidden detached-legend preview construction;
- `legendPreview.ts`, including trace membership, style/rank copying, bounded geometry, payload stripping and passive interaction configuration;
- current repository lifecycle/versioning guidance.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

All maintained declarations now use `0.24.0-beta.1`, `CHANGELOG.md` has a concise `New features` entry for the Series appearance manager, and the implementer reports both the exact version-consistency command and canonical preflight passing after the change. No release tag or publishing work was added.

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

046.1–046.3 now record `Implemented — review-clean`; Parent 046 records implementation complete with final acceptance pending the cumulative manual/browser matrix; and `docs/specs/README.md` lists Parent 046 and all three children with the same truthful state. The documentation does not claim the unrun manual matrix passed.

### R3 — Medium: `All series` shows base defaults instead of the effective aggregate, so it cannot directly homogenize mixed series

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts` if a pure aggregate helper is appropriate
- focused frontend tests
- `docs/specs/046-series-appearance-manager.md` / related child text where the original `All series` distinction is now superseded by the user's final acceptance decision

**Current**

`ALL_SERIES_KEY` enters a pure base-style editor. If some concrete series have explicit/rule-resolved squares and others circles, `All series` still displays the base marker symbol (for example Circle) instead of `Mixed`. Selecting Circle again therefore produces no change, so the user must first choose another value and then return to Circle to force a visible result.

The same semantic problem applies to every per-series appearance field where current effective values differ: showing the base/default value is not an honest representation of the current set.

**Target**

For per-series appearance controls, `All series` must behave as a true aggregate/homogenizer over the current concrete series: homogeneous effective values display normally; heterogeneous values display `Mixed`/indeterminate; choosing a value makes every current concrete series resolve to that value in one action.

This user acceptance decision supersedes Parent 046's earlier locked distinction **for the per-series appearance controls**. Genuinely base/global-only settings that do not have a per-series equivalent (for example secondary-link/name policy) may remain global/default controls and must not be conflated with the aggregate fields.

Do not introduce another style-precedence layer. Reuse base/rules/explicit overrides in a way that leaves the effective result truthful and deterministic.

**Acceptance criteria**

- In `All series`, colour, opacity, line/points mode, dash, width, line shape, marker symbol, marker size, open/filled state and legend membership report `Mixed`/indeterminate whenever the effective concrete series disagree.
- If all current concrete series resolve to the same value, that value is shown.
- From a mixed state, choosing a value once makes all current concrete series resolve to that value immediately; choosing the value that happens to equal the old base/default must still work on the first action.
- Legend name remains unavailable as an all-series bulk field.
- Base/global-only controls remain available without pretending they are aggregate per-series fields.
- Update the Parent 046 decision/acceptance wording so repository documentation reflects this explicit user amendment.
- Add focused tests for mixed detection and one-action homogenization, including a value equal to the prior base default.

### R4 — Medium: Palette preview renders as blank white space

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- focused palette-preview/policy tests as practical

**Current**

During the user's final browser pass, the `Current palette` scientific preview area is blank white space: no sample curves, axes, grid or legend are visible. The source currently uses a hand-built SVG preview and passes Mantine `light-dark(...)` expressions directly through several SVG `stroke`/`fill` presentation attributes; the implementer must verify the actual browser failure rather than assuming the pure path-generation code proves the rendered preview works.

**Target**

The palette preview must visibly render its scientific sample chart in the real app and update as the scratch palette changes, in both light and dark themes.

**Acceptance criteria**

- A non-empty palette visibly renders sample curves in every palette colour plus readable axes/grid/legend chrome.
- Preset selection, reverse, colour edit, reorder, add/remove/duplicate all update the preview.
- The preview is not blank in light or dark mode and uses browser-valid SVG/CSS colour values.
- Empty-palette handling remains safe even though the normal editor prevents an invalid zero-colour palette.
- Add focused coverage for the render model/theme-token policy where practical; final browser confirmation remains required.

### R5 — Medium: Shift-click range selection is unreliable and leaks into browser-native text/context behaviour

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- focused selection interaction/policy tests where practical

**Current**

The user reports Shift-click worked once, selected page text/opened native contextual browser behaviour, and then stopped behaving reliably. The row currently relies on ordinary clickable DOM text plus `event.shiftKey`, without a clear prevention boundary for browser text selection while performing range selection.

**Target**

Shift-click must be repeatable and deterministic within one quantity group, without selecting text, opening native context behaviour, or corrupting the selection anchor. Normal text-selection/browser gestures elsewhere in the modal should not be globally disabled.

**Acceptance criteria**

- Repeated Shift-click operations within the same quantity continue to select the intended contiguous range.
- The range uses the established anchor predictably after prior plain/Ctrl/checkbox/range operations.
- Shift-click on a series row does not highlight row text or trigger native context behaviour.
- Shift across quantities retains the existing no-cross-group policy.
- Checkbox, preview-eye and drag interactions remain isolated from row range selection.
- Add focused interaction/policy coverage where practical and rerun the manual Shift-selection checks.

### R6 — Low: Multi-selection exposes redundant legend controls instead of one honest tri-state control

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

**Current**

For multiple selected series, the Legend section shows separate `Show in legend` and `Hide from legend` buttons and, when homogeneous, an additional `Show in legend` checkbox. This is redundant and visually heavier than the single-series control. In mixed state the checkbox disappears and a `Legend membership: Mixed` badge appears instead.

**Target**

Use one legend-membership control for multi-selection. An indeterminate-capable checkbox is preferred because it can truthfully represent true / false / mixed in one compact control. Do not keep duplicate Show/Hide buttons merely to resolve the mixed case.

**Acceptance criteria**

- Multi-selection shows exactly one `Show in legend` membership control.
- All shown → checked; all hidden → unchecked; mixed → indeterminate.
- Activating an indeterminate control sets a deterministic whole-selection value (prefer checked/show on first activation), after which it toggles normally.
- No duplicate Show/Hide buttons remain.
- Single- and multi-series Legend sections remain visually consistent.

### R7 — Low: Reordering is unnecessarily dependent on hitting the small drag handle

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

**Current**

Pointer reordering can start only from the dedicated grip handle. The user would like the row itself to offer a deliberate drag gesture so reordering does not require precise handle targeting.

**Target**

Keep the visible handle and keyboard reorder path, but also allow pointer drag activation from the non-interactive row body after a deliberate hold/movement threshold. This is preferred over a literal double-click-and-hold gesture because it is more standard and avoids adding another click-count state machine to a row that already owns click/Ctrl/Shift selection.

**Acceptance criteria**

- Pressing/holding and moving on a non-interactive part of the row can begin the same group-local reorder operation without first targeting the grip.
- An ordinary click still selects the row and does not reorder it.
- Checkbox, preview-eye, drag handle and other interactive descendants do not accidentally start row-body dragging.
- Shift/Ctrl selection remains reliable after this change.
- Cross-quantity moves remain rejected and keyboard/handle reordering remains available.

### R8 — Low: `Open` marker control is vertically misaligned with adjacent marker fields

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

**Current**

The `Open` marker control uses a hard-coded top margin (`mt={22}`) and appears visibly off-centre relative to the adjacent Symbol/Size controls in the user's browser. The same pattern exists in both single- and multi-series marker rows.

**Target**

Align `Open` with the adjacent marker controls using the normal compact form-control geometry rather than an approximate hard-coded offset.

**Acceptance criteria**

- Symbol, Size and Open read as one aligned marker-control row in both single- and multi-selection views.
- Alignment remains correct at normal desktop scaling in light/dark themes.
- No regression to compact spacing or wrapping.

### R9 — Low: `Palettes · Global` needs stronger separation from the per-selection tabs

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

**Current**

The `Global` badge correctly communicates scope, but `Palettes · Global` sits immediately beside `Series` and `Rules`, so its global scope is still visually grouped too tightly with the selection-scoped tabs.

**Target**

Add a restrained vertical separator/gap immediately before the Palettes tab while retaining the existing `Global` badge and the compact Mantine tab row.

**Acceptance criteria**

- A subtle vertical divider or equivalent border visually separates `Series | Rules` from `Palettes · Global`.
- The separator works in light and dark themes and does not look like another clickable tab.
- Tab keyboard navigation/accessibility is preserved.
- The actual Palettes editor contents remain unchanged except for fixes required by R4.

## Decision

**CHANGES REQUIRED — fix R3–R9, verify the affected focused paths and canonical preflight, then hand back to REVIEWER for the same cumulative FINAL_REVIEW. Do not mark the remaining manual/browser matrix complete; the user will continue/rerun acceptance after these fixes.**
