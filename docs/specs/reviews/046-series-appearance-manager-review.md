# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
User-acceptance fix commit reviewed: `269f6f56a5f6430f106a2875a5a964440f06efa3`  
Status: **Changes required — R3 and R8 remain open after the first user-acceptance fix pass**

## Confirmed

- Parent 046 remains frontend presentation/state work only; no parser, migration, scientific calculation, cache-version or backend behavior is mixed into this feature.
- R1/R2 repository-closure findings remain resolved.
- The first user browser pass produced R3–R9.
- Commit `269f6f56a5f6430f106a2875a5a964440f06efa3` addresses the requested areas without unrelated implementation scope and updates the Parent/046.1 wording for the user's amended `All series` semantics.
- Effective-value aggregation is now shared through `sharedValue(...)`; `All series` targets all current descriptor keys and writes explicit per-series overrides for homogenization.
- Shift range selection now uses a bounded pure `seriesSelectionRange(...)`, suppresses row text selection, excludes Shift pointer-down from drag activation, and blocks Shift context-menu leakage on the row.
- Multi-selection legend membership is now one indeterminate-capable `Show in legend` checkbox.
- Pointer reordering can start from the non-interactive row body with the existing 4 px PointerSensor threshold; checkbox/eye/handle pointer-down paths remain isolated, and handle/keyboard reorder remain available.
- `Palettes · Global` now has a subtle non-focusable divider before it.
- Palette-preview theme chrome moved from SVG presentation attributes to CSS style properties. This is a plausible browser-compatibility fix, but the original user-reported blank-preview failure still requires the user's browser recheck before final acceptance.

## Verification record

### Implementer-reported — R3–R9 fix pass

- `node --test frontend\\tests\\seriesStyling.test.ts frontend\\tests\\legendPreview.test.ts frontend\\tests\\plotStylePalette.test.ts frontend\\tests\\plotStylePresets.test.ts`: PASS — 74 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `git diff --check`: PASS.
- `python scripts\\preflight.py`: PASS — expanded filesystem access, 4/4 stages, 127 backend/frontend modules.
- Manual/browser checks: NOT RUN by implementer; user-owned cumulative acceptance remains pending.

### Reviewer-independent — this round

I independently inspected:

- the complete `ca906042… -> 269f6f56…` fix diff;
- current `SeriesStyleModal.tsx` selection, aggregate, colour-link, drag, legend, marker-alignment, palette-preview and tab-label wiring;
- `sharedValue(...)`, `seriesSelectionRange(...)`, linked-secondary semantics and focused tests in `seriesStyling.ts` / `seriesStyling.test.ts`;
- the amended Parent 046 and 046.1 wording.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` effective aggregation/homogenization is incomplete for linked secondary colours

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- focused frontend tests, preferably `frontend/tests/seriesStyling.test.ts` or a small pure helper test if extraction is useful

**Current**

The main R3 redesign is present: `All series` aggregates effective concrete values and bulk-patches every descriptor. However, colour still uses the multi-selection guard unchanged:

- `linkedBulkColourKeys` is computed over `bulkTargetKeys`;
- when `isAllSeries`, `bulkTargetKeys` contains every descriptor;
- `bulkColourEnabled = linkedBulkColourKeys.length === 0`.

Therefore, as soon as any present secondary series inherits colour from its primary, the entire `All series` Colour control is disabled. This violates the amended acceptance criterion that `All series` can homogenize **colour** in one action.

This case is solvable without breaking linked-colour semantics because `All series` also contains every present primary. Applying the chosen colour to the non-linked concrete targets/primaries makes the linked secondaries resolve to that same colour automatically. The existing stricter behavior may remain for an arbitrary multi-selection where the required primary is not part of the target set.

**Target**

`All series` must keep the Colour aggregate actionable even when one or more secondary series inherit from present primaries. Homogenization must respect the link rather than writing an ineffective secondary override or disabling the whole operation.

**Acceptance criteria**

- `All series` Colour remains enabled when linked secondaries have their present primaries in the all-series target set.
- Choosing one colour makes every current concrete series, including linked secondaries, resolve to that colour in one action.
- Do not silently disable or break `link_color` / global `link_secondary_colors`.
- Ordinary arbitrary multi-selection may retain the existing fail-safe disable behavior where a selected linked secondary cannot truthfully be recoloured through the selected target set.
- Add focused coverage for an all-series set containing primary + linked secondary, including mixed starting colours and one-action homogenization.

### R4 — Medium: Palette preview renders as blank white space

**Resolution state: CODE CHANGE ACCEPTED FOR RECHECK; browser acceptance still pending.**

The fix moves Mantine `light-dark(...)` values into CSS style properties on the SVG grid/axis/text chrome. No additional repository defect is proven in this pass. Because the original failure was visual/runtime-only and the implementer did not run the user browser matrix, the user must recheck the palette preview in light and dark mode before R4 can be finally closed.

### R5 — Medium: Shift-click range selection is unreliable and leaks into browser-native text/context behaviour

**Resolution: CODE REVIEW CLEAN in `269f6f56a5f6430f106a2875a5a964440f06efa3`; user browser recheck required.**

The row now uses `userSelect: "none"`, prevents Shift-click default/context behavior, excludes Shift pointer-down from row-body drag activation, and delegates bounded inclusive ranges to `seriesSelectionRange(...)` with focused tests.

### R6 — Low: Multi-selection exposes redundant legend controls instead of one honest tri-state control

**Resolution: RESOLVED in `269f6f56a5f6430f106a2875a5a964440f06efa3`.**

The duplicate Show/Hide buttons are removed. One `Show in legend` checkbox represents checked / unchecked / indeterminate, and the mixed-state first action deterministically sets the full target to shown.

### R7 — Low: Reordering is unnecessarily dependent on hitting the small drag handle

**Resolution: CODE REVIEW CLEAN in `269f6f56a5f6430f106a2875a5a964440f06efa3`; user browser recheck required.**

Non-interactive row-body pointer-down now forwards to the existing sortable listener under the 4 px activation threshold. Interactive descendants stop propagation; Shift pointer-down is excluded; the visible handle and keyboard path remain.

### R8 — Low: `Open` marker control remains structurally misaligned with adjacent labelled fields

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

**Current**

The fix removes the previous hard-coded `mt={22}` from both single- and multi-series Open controls, but does not give Open the same labelled-control geometry as its neighbours.

In the single-series row, `Symbol` and `Size` are Mantine inputs with labels rendered above their controls, while `Switch label="Open"` renders its label inline beside the switch. With `Group align="start"`, the switch now starts at the top/label line rather than aligning with the Select/NumberInput control row.

The multi-series row has the same structural mismatch: Symbol/Size each render a top label block plus the input below it, while the direct `Checkbox label="Open"` begins at the group's top edge.

**Target**

Use equivalent form-field geometry for Open instead of either a guessed margin or no alignment structure. The visual label may stay `Open`, but the toggle itself should sit on the same control baseline as Symbol and Size in both single- and multi-selection views.

**Acceptance criteria**

- Single-series Symbol, Size and Open controls share the same labelled-field vertical rhythm and control baseline.
- Multi-series Symbol, Size and Open controls share the same labelled-field vertical rhythm and control baseline, including the indeterminate state.
- Do not restore a magic top-margin approximation.
- Preserve compact Mantine sizing, disabled behavior and keyboard accessibility.

### R9 — Low: `Palettes · Global` needs stronger separation from the per-selection tabs

**Resolution: RESOLVED in `269f6f56a5f6430f106a2875a5a964440f06efa3`.**

A restrained `aria-hidden` one-pixel divider now separates Series/Rules from Palettes while preserving the existing Global badge and tab interaction.

## Decision

**CHANGES REQUIRED — fix only the remaining R3 linked-secondary all-series colour case and R8 form-control alignment, run focused verification plus canonical preflight, then hand back to REVIEWER for the same cumulative FINAL_REVIEW. R4/R5/R7 still require user browser recheck after the next reviewer-clean code pass; do not claim the cumulative manual matrix complete.**
