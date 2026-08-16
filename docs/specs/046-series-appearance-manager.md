# 046 — Series appearance manager

**Status:** Implementation complete; final acceptance pending the cumulative manual/browser matrix.
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring baseline / merge base:** `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
**Shared feature branch:** `feature/series-appearance-manager`  
**Depends on:** the current per-series style editor descended from Spec 037  
**Shape:** three sequential implementation children

All UI work inherits `AGENTS.md`, `docs/specs/README.md`, `docs/agent-knowledge/README.md`, `docs/agent-knowledge/visual-style-guide.md`, and `docs/specs/037-per-series-style-editor.md`.

## Goal

Turn the existing **Series appearance** modal into a compact series manager without replacing its styling architecture.

The user must be able to:

1. edit one series as today;
2. select several arbitrary series or a whole plotted quantity and style them together;
3. show/hide the selected set in the legend in one action;
4. reorder series inside one quantity, persist that order, and use it for the real Plotly legend;
5. preview the resulting Plotly legend below the scientific preview without allowing legend geometry to resize that plot;
6. keep the current global Palettes editor intact.

Keep the current overall composition:

```text
Preview | Series | Appearance
```

and the right-side tabs:

```text
Series | Rules | Palettes
```

## Current implementation anchors

### `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`

Already owns:

- `activeKey` and the separate `ALL_SERIES_KEY` aggregate/global-settings mode;
- `tab` (`series`, `rules`, `palettes`);
- `seriesGroups`, grouped by plot and quantity/axis;
- preview-only `previewHidden`;
- debounced `draftOverrides`, `draftRules`, and `draftBaseStyle`;
- `resolvedByKey`;
- the fixed Plotly preview geometry;
- the full current Palettes editor;
- `show_in_legend` as a per-series override;
- `dnd-kit`, already used for palette swatches.

The scientific preview deliberately sets:

```ts
showlegend: false
legend: undefined
```

That remains correct.

### `frontend/src/features/analyses/editor/plotting/seriesStyling.ts`

Owns `SeriesDescriptor`, rule matching, style resolution, palette-slot assignment, descriptor builders, Plotly style translation, and preview helpers.

### `frontend/src/features/analyses/editor/plotting/PlotStylePanel.tsx`

Builds descriptors, `baseFor`, scoped `PlotStyle`, palette callbacks, and the family-specific `buildPreview` callback supplied to the modal.

### `frontend/src/api.ts`

`PlotStyle` already persists `series_overrides` and `series_rules`. Parent 046 adds only optional presentation order; no relational schema is expected.

### `frontend/tests/seriesStyling.test.ts`

Already covers override precedence, legend visibility, descriptor identity, palette slots, and preview decimation. Extend this surface rather than creating a parallel styling model.

## Locked decisions

### 1. Preserve the current Palettes editor

Do not redesign or squeeze Palettes beside Series controls. Preserve its current preset selector, editable/reorderable swatches, colour picker, palette preview plot, overflow mode, save/update workflow, Reset, and Apply palette behavior.

Only add a restrained visual/accessibility cue that **Palettes is global**.

### 2. Deliberate series selection always returns to Series

The following set `tab = "series"` immediately:

- row click;
- row selection checkbox;
- Ctrl/Cmd-click;
- Shift-click;
- quantity select/clear all.

The following do **not** switch tabs:

- preview-only eye toggle;
- collapse/expand;
- drag reorder;
- palette interaction.

No warning/banner is required.

### 3. Standard desktop multi-selection semantics

- click → only that row;
- Ctrl/Cmd-click → toggle arbitrary rows;
- Shift-click → contiguous range inside the current quantity only;
- row checkbox → toggle while retaining other selection;
- quantity checkbox → checked / indeterminate / unchecked select-all state.

Ctrl/Cmd selection may span quantities. Shift must not.

### 4. `All series` aggregates effective appearance without selecting rows

`ALL_SERIES_KEY` remains a separate entry from selecting all concrete rows, but its per-series
appearance controls now aggregate the effective styles of every current concrete series. Homogeneous
values display normally; disagreement displays `Mixed`, and choosing a value writes one explicit
override to every current series so it takes effect immediately, including when it matches the old
base/default value. Global-only settings such as secondary-axis linking and secondary legend-name
policy remain base-style controls. Selecting concrete rows still writes explicit overrides only to
those selected keys.

### 5. Bulk edits use the existing explicit override layer

The only precedence model remains:

```text
base PlotStyle
→ ordered rules
→ explicit SeriesStyleOverride
```

Bulk editing writes the same explicit field value to several selected keys; it does not introduce another layer.

Bulk fields include at minimum colour, opacity, line/points mode, dash, width, line shape where already supported, marker symbol, marker size, open/filled marker, and `show_in_legend`.

Legend name remains single-series only.

When selected series resolve to different values, show `Mixed` / indeterminate rather than an arbitrary first value.

### 6. Preview visibility and legend membership remain separate

The eye in the Series list remains **preview-only**. Legend membership remains persisted `show_in_legend` and gains bulk Show/Hide actions. Never overload one control with both meanings.

### 7. Series ordering is group-local persisted presentation state

Series may be reordered only within their current quantity. Quantity groups themselves are fixed.

Add one optional `PlotStyle` preference list:

```ts
series_order?: string[];
```

Known stored keys keep their order; new keys fall back to descriptor order; stale/duplicate keys are ignored safely. Ordering never changes scientific identity or colour. No migration or `CALC_VERSION` bump.

The order controls Series-manager row order and real Plotly legend order. Prefer `legendrank` or an equivalent legend-only mechanism so trace z-order does not change merely because the legend was reordered.

### 8. Detached legend preview uses Plotly, not HTML

Keep the main scientific preview fixed-size and legend-free. Add a separate bounded `Legend preview` below it, rendered by Plotly from the same effective trace presentation.

It must reflect effective names, colours, line/marker styles, legend membership, user order, palette/rule effects, and relevant existing legend styling without altering the scientific plot's dimensions or axes.

### 9. Reuse the real preview/figure path

Do not reconstruct legend semantics from descriptor labels. Transform the same family-specific Plotly traces/layout produced by the current preview builders, respecting `showlegend: false` helper/shadow traces.

### 10. Frontend presentation scope only

No scientific formula, parser, backend analysis, SQLite migration, cache invalidation, or `CALC_VERSION` change is expected. Reuse existing dependencies.

## Child plan

Implement sequentially on the same branch with a review checkpoint after each child.

### 046.1 — Series selection and bulk editing

Owns only:

- click/Ctrl/Cmd/Shift selection;
- row checkboxes and quantity tri-state select-all;
- automatic return to Series;
- compact global cue on Palettes without changing its contents;
- pure bulk override helper;
- multi-selection inspector and mixed values;
- bulk Show/Hide in legend;
- Reset selected.

**No ordering or detached legend preview.**

### 046.2 — Series ordering and legend order

Owns only:

- persisted `series_order`;
- stale/new key normalization;
- drag and keyboard reorder inside one quantity;
- rejection of cross-quantity moves;
- colour-identity regression protection;
- real Plotly legend order propagation.

**No detached legend preview.**

### 046.3 — Detached legend preview and integration closure

Owns:

- separate passive Plotly legend preview;
- faithful names/styles/membership/order;
- independence from preview-eye hiding;
- helper-trace filtering;
- bounded layout and memoized performance;
- supported-family integration audit;
- live/saved/export consistency;
- final Parent 046 regression matrix.

## Out of scope

- redesigning palette contents or persistence;
- applying a palette only to the current selection;
- replacing Rules with selection;
- changing series identity;
- moving rows between quantities;
- reordering quantity groups;
- backend/scientific persistence changes.

## Parent acceptance criteria

Parent 046 is complete when:

- single/Ctrl/Cmd/Shift/quantity selection works;
- deliberate selection always opens Series;
- a selected set can be bulk-styled and bulk-shown/hidden in the legend;
- mixed values are represented honestly;
- `All series` reports effective mixed values and homogenizes each per-series appearance field in one action;
- Legend name remains single-series only;
- rows reorder only within their quantity and the order persists;
- reorder does not recolour series or alter scientific trace meaning;
- real plot/export legend uses stored order;
- Palettes remains the existing editor and is clearly global;
- a detached Plotly legend appears below the fixed scientific preview;
- it reflects style, names, membership, rules/palette, and order;
- preview-only eye hiding remains distinct from legend membership;
- light/dark chrome, truncation, keyboard access, and accessible names remain usable;
- no backend/scientific/cache/migration change is introduced.

## Parent verification

Each child runs its focused checks. The final child runs the current canonical full verification from the branch, including frontend policy tests/typecheck/build and:

```powershell
python scripts\preflight.py
```

Manual/browser checks must be recorded as PASS / FAIL / NOT RUN; build success is not a substitute for them.
