# 052 — Time/Capacity cycle navigation

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring baseline / merge base:** `main` at `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
**Feature branch:** `feature/time-capacity-cycle-navigation`  
**Depends on:** the current modularized Time/Capacity family from Spec 038.5 and global-cycle semantics from Spec 034.7; no backend/scientific dependency  
**Review document:** `docs/specs/reviews/052-time-capacity-cycle-navigation-review.md` — create during review  
**Reference asset:** [`assets/052-time-capacity-cycle-navigation.html`](assets/052-time-capacity-cycle-navigation.html)

## Goal

Make continuous cycle-range inspection in the **Time / capacity** analysis feel like direct plot
navigation rather than repeated form editing.

Today the user chooses `From` and `To` inside the left Time/Capacity settings panel. Those values are
scientifically correct, but moving from one nearby range to another requires repeated editing and gives
no compact "previous/next view" workflow. This spec adds one editor-only navigation strip immediately
above the Time/Capacity plot.

The strip must let the user:

- choose a range width quickly;
- shift the current range by one cycle;
- move by one whole current range;
- type exact start/end cycles;
- jump to a cycle by pressing Enter;
- show all available cycles;
- return to the previous cycle-range visualization;
- open a small anchored slider from the separator between `From` and `To` and drag the current window
  across the complete cycling extent.

This is a **frontend interaction improvement over the existing scientific range fields**. It must use
the existing `time_capacity.cycle_start`, `cycle_end`, and `cycles` semantics rather than creating a
second scientific selection model.

This is one coherent frontend feature and should remain a standalone spec. Do not split it into child
specs unless the live implementation has materially changed and an independent ownership boundary
appears before implementation begins.

## Required reading

Before implementation, read:

- `AGENTS.md`;
- `docs/agent-knowledge/README.md`;
- `docs/agent-knowledge/visual-style-guide.md`;
- `docs/agent-knowledge/state-and-performance.md`;
- `docs/agent-knowledge/change-playbooks.md`;
- `docs/specs/README.md`;
- `docs/specs/workflow/README.md`;
- `docs/specs/workflow/implementer-prompt.md`;
- `docs/specs/workflow/reviewer-prompt.md`;
- Spec 034.7, especially global-cycle semantics for continued Cells;
- Spec 038.5, especially Time/Capacity ownership, result identity, query behavior, and saved/portable
  builder reuse.

Reverify every anchor below against the current branch before editing. Spec 050 is expected to touch
runtime performance; if it has merged before Spec 052 implementation begins, preserve its current
Time/Capacity request/cache/runtime behavior and adapt these UI changes to the new owner rather than
restoring the authoring-baseline implementation.

## Reference asset and visual authority

The interactive HTML mockup is committed at:

```text
docs/specs/assets/052-time-capacity-cycle-navigation.html
```

It exists so an implementation agent can open the interaction and understand the intended geometry,
button grouping, anchored separator popover, and navigation semantics without access to the original
chat.

The asset is **inspiration, not executable product code**:

- do not copy its hand-written CSS, canvas plotting, fake data generator, inline SVG, or JavaScript
  state model into the application;
- use Mantine components, Tabler icons, theme tokens, existing CellXplorer state/update paths, and the
  real Plotly Time/Capacity card;
- where the HTML and this written specification disagree, **this specification wins**;
- the final implementation must follow `visual-style-guide.md` for light/dark chrome. Plotly keeps its
  existing independent light presentation.

## Verified current implementation

### Time/Capacity configuration and settings

Current owner:

```text
frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx
```

Grep-able anchors:

- `export const DEFAULT_TIME_CAPACITY`
- `export function timeCapacityConfig`
- `export function TimeCapacitySettings`
- `<Accordion.Item value="cycles">`
- `function TimeCapacityPlotCardView`
- `const dataSignature = useMemo`
- `<PlotHeader`
- `queryKey: ["time-capacity", analysisId, dataSignature]`

At the authoring baseline, `DEFAULT_TIME_CAPACITY` includes:

```ts
cycle_start: 1,
cycle_end: 3,
cycles: [],
max_points_per_cell: 4000,
```

Do **not** change those defaults merely to match the mockup's example `101–120` range.

The current `Cycles` accordion owns:

- `From` -> `cfg.cycle_start`;
- `To` -> `cfg.cycle_end`;
- `Specific cycles` -> `cfg.cycles`;
- `Max points per cell` -> `cfg.max_points_per_cell`.

`cycle_start`, `cycle_end`, and `cycles` already participate in the Time/Capacity `dataSignature`, so a
committed range change naturally uses the existing React Query/result-cache path.

### Backend selection semantics

Current owner:

```text
backend/app/services/analysis_engine.py
```

Grep-able anchor:

```py
def compute_time_capacity(
```

The existing selection semantics are important:

```py
if settings["cycles"]:
    raw = raw[raw["cycle"].isin(settings["cycles"])]
else:
    # filter by cycle_start / cycle_end
```

Therefore a non-empty `Specific cycles` list **overrides the continuous range**. A range navigator must
not pretend to work while that mode is active, and it must not silently clear the user's explicit cycle
list.

Continued Cells use the global/dense cycle identity established by Spec 034.7. The navigator operates
only on that existing displayed/scientific global cycle number. Do not introduce source-local cycle
navigation.

### Editor/controller data already available

Current owner:

```text
frontend/src/features/analyses/editor/AnalysisEditor.tsx
```

Grep-able anchors:

- `const groupsQuery = useQuery`
- `const cellsQuery = useQuery`
- `const update = useCallback`
- `const sidebar = (`
- `<TimeCapacitySettings`
- `<TimeCapacityPlotCard`
- `const buildPersistPayload = useCallback`

The editor already loads:

```ts
get<CellSummary[]>("/api/cells")
get<ReplicateGroupSummary[]>("/api/replicate-groups")
```

and passes the live `spec` plus the canonical `update(...)` callback into the Time/Capacity family.

`update(...)` marks the plot workspace touched/dirty and the normal autosave/persist path owns the
result. Saved plots already store the computation view, so the scientific cycle range is already
persisted/restored with saved Time/Capacity plots.

### Existing relational cycle extent

Current type owner:

```text
frontend/src/api.ts
```

Grep-able anchors:

- `export interface CellSummary`
- `total_cycles: number`
- `export interface ReplicateGroupSummary`
- `cell_ids: number[]`

Use this already-loaded relational summary to determine the available upper cycle bound. Do not add a
new API route, raw-cache read, source-file read, analysis compute, or per-row scientific lookup merely
to render the navigator.

## Locked domain decisions

### 1. One authoritative continuous range

The navigation strip edits the same:

```ts
spec.computation.time_capacity.cycle_start
spec.computation.time_capacity.cycle_end
```

that the existing `From`/`To` fields edit.

There must not be a second persisted range, a navigation-only range sent separately to the endpoint, or
a presentation copy that can drift from the computation spec.

As part of this feature:

- remove the duplicated `From` and `To` editors from the left `TimeCapacitySettings` `Cycles`
  accordion;
- keep `Specific cycles` and `Max points per cell` there;
- place the continuous-range editing/navigation controls above the plot.

Saved plot, draft, autosave, export, artifact, and portable-report meaning therefore remains the
existing meaning of `cycle_start`/`cycle_end`.

### 2. Upper bound comes from selected Cells, not plot contents

Define one pure frontend resolver equivalent to:

```ts
selectedTimeCapacityCycleMax(
  selectionEntries,
  cells,
  replicateGroups,
): number | null
```

Rules:

1. Expand selected replicate-group entries through their `cell_ids`.
2. Include directly selected Cell entries.
3. Deduplicate Cell IDs.
4. Read `CellSummary.total_cycles` from the already-loaded Cell summaries.
5. Ignore non-finite/non-positive values if encountered defensively.
6. Return the **maximum** valid `total_cycles` across the selected underlying Cells.
7. Return `null` if no reliable positive bound is currently available.

Use all selected underlying Cells regardless of per-plot visibility/exclusion state. Hiding a Cell must
not make the navigator's total extent jump.

Rationale: selected Cells can have different lifetimes. A range is allowed to contain no points for a
shorter Cell while still showing later cycles from a longer Cell.

Do not derive the upper bound from the currently returned `TimeCapacityResult`: that result has already
been filtered to the current range and cannot truthfully describe the complete available extent.

Do not reinterpret `total_cycles` as source-local cycle. For continued Cells the app's global dense
cycle model remains authoritative.

### 3. No automatic spec mutation when the bound changes

If source updates, sample edits, or refreshed summaries change the resolved upper bound, update the
navigator's allowed extent but do not silently rewrite the saved `cycle_start`/`cycle_end` merely
because a summary changed.

A later user navigation/edit command normalizes the requested range against the current known bound.

Changing the selected sample set or opening a different saved/new plot must clear the transient
navigation-history stack described below.

## Locked navigation layout

Render one compact navigation strip **inside the Time/Capacity plot card**, immediately after the
existing `PlotHeader` and before error/loading/empty/Plotly content.

It is editor chrome and must not become part of Plotly figure data/layout or exported images.

At normal desktop width the continuous-range mode is ordered left-to-right as:

```text
Cycle navigation
[window size]
[ « | ‹ ]
[from] [separator trigger] [to]
[ › | » ]
<flexible space>
[← previous view] [home]
Jump to [cycle]
```

The exact pixel values may follow neighboring Mantine geometry, but the grouping and relative order are
locked.

### Window-size selector

- It is on the left, before the navigation arrows.
- Display only the number, e.g. `20`, **not** `20 cycles`.
- Accessible name/tooltip: `Cycle window size`.
- Start with a compact set of presets such as `1`, `5`, `10`, `20`, `50`, `100`.
- Filter impossible presets above the known maximum.
- If the current width is not one of the presets, include that current width as a temporary option so
  the control always tells the truth.
  - Example: the existing default `1–3` displays `3`.
  - After Home on a 720-cycle Cell, it displays `720`.
- Do not change `DEFAULT_TIME_CAPACITY` just to make a preset selected by default.

### Merged backward/forward buttons

Use the established split/segmented-button visual pattern: adjacent controls share one outer boundary
and an internal divider rather than appearing as four unrelated square buttons.

Prefer Mantine `Button.Group` (or the current equivalent already used in the app) and Tabler chevron
icons.

Backward group:

- `«` / double-left icon: previous **whole window**;
- `‹` / single-left icon: shift by **one cycle**.

Forward group:

- `›` / single-right icon: shift by **one cycle**;
- `»` / double-right icon: next **whole window**.

Every icon-only segment requires an `aria-label` and Tooltip.

### Exact From / To inputs

Use compact Mantine numeric inputs with visible integer values but no repeated visible `From`/`To`
labels in the toolbar. Their accessible names must be `From cycle` and `To cycle`.

Do not send a scientific request for every digit while the user is still typing.

Recommended commit model:

- keep a small local text/number draft while focused;
- commit on Enter or blur;
- Escape restores the last committed value.

On commit:

- integer only;
- minimum 1;
- clamp to the known upper bound when available;
- committing `From > To` also moves `To` up to the new `From`;
- committing `To < From` also moves `From` down to the new `To`;
- one user commit -> one canonical `update(...)` call for the range.

## Locked movement semantics

Let:

```text
start = current cycle_start
end   = current cycle_end
width = end - start + 1
max   = selectedTimeCapacityCycleMax(...)
```

When `max` is known, every navigation action preserves a valid inclusive range in `[1, max]`.

### Single-cycle arrows

```text
‹ : shift [start, end] by -1
› : shift [start, end] by +1
```

Preserve `width` whenever `width <= max`. At the lower/upper boundary, clamp the whole window rather
than shrinking it.

Example for width 20:

```text
101–120 -> › -> 102–121
1–20    -> ‹ -> 1–20
701–720 -> › -> 701–720
```

### Whole-window arrows

```text
« : shift by -width
» : shift by +width
```

These are page-style, non-overlapping moves whenever the boundary allows it.

Example:

```text
101–120 -> » -> 121–140
101–120 -> « -> 81–100
```

At a boundary, preserve width and clamp the window to the first/last valid window.

### Changing window size

Selecting a numeric window size keeps the current `start` as the preferred anchor.

- requested `end = start + requestedWidth - 1`;
- if that exceeds `max`, shift the whole range left enough to preserve the requested width;
- if `requestedWidth >= max`, the result is `[1, max]`.

### Jump to

The right-side `Jump to` field has **no Go button**.

- It is a compact integer field.
- Pressing Enter commits the jump.
- Blur alone does not jump; it may leave/clear the draft according to normal Mantine input behavior.
- The entered cycle becomes the **center target** of the current-width window.
- Clamp the window at the beginning/end while preserving width where possible.
- Empty/invalid input does nothing.
- After a successful jump, clear or select the field text so another jump can be entered efficiently.

For even widths, use one deterministic convention and test it. Recommended:

```ts
start = target - Math.floor(width / 2)
```

followed by whole-window clamping.

### Home: show all cycles

Use an icon-only Home action (`IconHome`/current Tabler equivalent), not a text button.

When `max` is known:

```text
Home -> [1, max]
```

Tooltip/accessible name: `Show all cycles`.

When no reliable upper bound is known, Home is disabled with a truthful tooltip such as
`Cycle extent is not available yet`.

### Previous visualization

Use an icon-only left-arrow action (`IconArrowLeft`/current Tabler equivalent), not a text `Back`
button.

It restores the previous **committed continuous cycle-range visualization**.

Tooltip/accessible name: `Previous cycle view`.

This is intentionally **not**:

- browser-history navigation;
- saved-plot history;
- tab history;
- Plotly zoom/pan undo;
- a general undo for other style/scientific settings.

## Transient range-history contract

The previous-view action uses session-only frontend state owned by the navigation component (or a
small colocated hook/reducer).

Before each successfully committed continuous-range action, push the prior normalized `[start, end]`
onto a bounded stack.

Actions that create one history entry:

- single-cycle arrow;
- whole-window arrow;
- window-size change;
- exact From/To commit;
- Jump to Enter;
- Home;
- completed slider drag.

Rules:

- do not push duplicate consecutive ranges;
- Back pops one entry and restores it;
- Back itself does not push the range being left;
- disable Back when the stack is empty;
- keep the stack bounded (e.g. latest 50 entries);
- the history is **never written to `AnalysisSpec`, saved plots, workspace persistence, portable
  reports, local storage, or the backend**;
- clear history when selection identity changes, a different saved plot is opened, a new plot is
  started/reset, or the Time/Capacity plot session is replaced by a different spec identity.

A normal React remount may also clear this convenience history. Persisting it is explicitly out of
scope.

## Separator-triggered draggable navigator

The control between the two numeric boxes replaces the plain visual dash.

### Resting appearance

It must still read visually as a **separator between the two numbers**, not as a normal toolbar
button.

Target visual idea:

```text
[from]  —o—  [to]
```

Requirements:

- approximately the footprint of the old separator/gap;
- no normal rectangular button chrome at rest;
- a short horizontal line with a centered circular marker;
- subtle hover/focus/open states may use the app's teal accent;
- it remains a real keyboard-focusable button/target underneath the visual styling;
- accessible name: `Open cycle position slider`;
- Tooltip may read `Move cycle window`.

Do not use the mockup's literal text glyph if CSS/current icons can render the line-dot-line more
cleanly.

### Popover/callout

Clicking/keyboard-activating the separator opens a small Mantine `Popover` immediately below it.

- Use the Popover arrow so the panel clearly **originates from the separator**, like a small callout.
- Do not render a mini plot, histogram, cycle timeline, protocol markers, tick bar, or overview chart.
- The body contains only a clean horizontal `Slider` conceptually equivalent to:

```text
--------o--------
```

- The slider represents position across cycles `1..max`.
- The slider value is the **target center cycle** for the current window.
- Use Mantine's normal thumb and optional thumb label/tooltip while dragging; avoid permanent noisy
  labels.
- The popover should remain compact (~one short control row, not another panel).

### Drag performance

Dragging must not trigger a Time/Capacity request for every pointer movement.

Required behavior:

1. `Slider.onChange` (or equivalent) updates only local transient thumb state.
2. The visible plot/spec remains at the last committed range during the drag.
3. `onChangeEnd`/pointer release computes the centered/clamped range and performs exactly one
   canonical range commit.
4. Closing/Escape before a commit discards transient slider state.
5. Keyboard interaction with the slider remains functional; each completed keyboard adjustment may
   commit normally.

If the current range already spans all available cycles, moving its center cannot change the view.
Disable the slider/trigger or make it inert with a truthful tooltip rather than generating redundant
updates.

## Specific-cycles mode

A non-empty:

```ts
cfg.cycles
```

is the existing explicit/non-contiguous selection mode and backend code gives it precedence over
`cycle_start`/`cycle_end`.

Therefore:

- do not silently clear `cfg.cycles` when the user presses a range-navigation control;
- do not issue range edits that appear to work while the backend is still using explicit cycles;
- keep the navigation strip in its normal location to avoid layout jumps, but place it in a clear
  disabled state;
- show a compact neutral indication such as `Specific cycles active` in the strip;
- tooltip/help text should say `Clear Specific cycles in the Cycles settings to navigate a continuous range`;
- the left `TimeCapacitySettings` `Cycles` accordion keeps the `Specific cycles` editor so the user
  has one obvious place to clear/edit that mode;
- once the list becomes empty, the range navigator immediately re-enables using the retained
  `cycle_start`/`cycle_end`.

Do not invent mixed union semantics between explicit cycles and the range.

## Bound-loading, empty, and error states

The plot card must not disappear or layout-shift merely because the relational cycle bound is still
resolving.

When `maxAvailableCycle === null`:

- render the current stored From/To values;
- disable actions whose semantics require the upper bound (window paging/forward movement, Home,
  slider, bounded resize);
- do not invent `max = cycle_end`;
- do not start another backend request just to find the bound;
- expose a concise Tooltip for disabled bound-dependent actions.

If the existing Time/Capacity scientific query is loading/refetching:

- preserve the current card behavior (cached/current result remains visible and dims according to the
  existing implementation);
- the navigation row stays mounted;
- do not add a second loading overlay/spinner for ordinary range changes.

Existing error and scientific-empty states remain authoritative and appear below the navigation strip.

## State, query, cache, and persistence consequences

### Existing result identity remains authoritative

Do not change the Time/Capacity endpoint, request shape, response shape, or query-key/data-signature
fields for this feature.

The existing signature already includes:

- selection;
- protocol filtering/hiding;
- `cfg.cycles`;
- `cfg.cycle_start`;
- `cfg.cycle_end`;
- point limit;
- X-axis/time/display/area/voltage/derivative inputs.

A committed navigation action should therefore naturally select/fetch the correct existing result.

### No duplicate compute or new data source

This feature must not:

- start the generic Cycles analysis engine;
- create a "cycle extent" analysis request;
- read Parquet or source files in the frontend;
- perform per-sample backend requests;
- add one query per selected Cell;
- recompute scientific values client-side.

Use the relational summaries already loaded by `AnalysisEditor`.

### Saved plots and drafts

The actual selected range is already part of the Time/Capacity computation spec and therefore follows
the normal saved-plot/draft behavior.

Verify:

- navigating a draft marks the plot workspace dirty through the existing `update(...)` path;
- navigating an opened saved plot produces the existing edited-saved-plot state;
- Save/Update preserves the selected range;
- reopening the saved plot restores exactly that range;
- previous-view history does not survive reopen and does not affect saved-plot equality/signatures;
- navigation chrome itself is not included in thumbnails, images, CSV/XLSX, SVG/PDF, or portable
  report figures.

### Autosave

Do not create a new autosave mechanism. Range commits feed the current editor update/autosave model.

The slider's transient drag state must not mark the spec dirty until the final drag commit.

### Cache/version decisions

Expected:

- no database migration;
- no `SPEC_VERSION` change;
- no `CALC_VERSION` bump;
- no parser version change;
- no Time/Capacity result-schema/cache-format version change;
- no artifact format change.

If implementation unexpectedly requires one of these, stop and explain why before doing it. This spec
is intended to be frontend-only apart from consuming existing API types/data.

## Suggested implementation structure

Prefer a small coherent extraction instead of growing `TimeCapacityPlotCard.tsx` with navigation policy
and history arithmetic.

Expected shape:

```text
frontend/src/features/analyses/editor/families/time-capacity/
├── TimeCapacityPlotCard.tsx
├── TimeCapacityCycleNavigation.tsx        # new UI component
└── timeCapacityCycleNavigation.ts         # new pure range/bound policy helpers
```

Equivalent names are acceptable.

### Pure helper responsibilities

Keep deterministic, Node-testable functions out of React where practical:

- expand selected Cell IDs / resolve `maxAvailableCycle`;
- normalize/clamp an inclusive range;
- shift by one cycle;
- shift by one full window;
- resize the window;
- center a window on a Jump/slider target;
- normalize manual From/To commits.

Do not move scientific calculations into this helper.

### UI component responsibilities

`TimeCapacityCycleNavigation.tsx` should own:

- compact Mantine geometry;
- local numeric-input drafts;
- transient slider thumb state;
- transient previous-view stack;
- Popover open/close state;
- one callback that commits a final range into the canonical analysis spec.

The plot card remains responsible for scientific query/render/export behavior.

### AnalysisEditor wiring

Compute/pass `maxAvailableCycle` using the already-loaded `cellsQuery.data`, `groupsQuery.data`, and the
live selection.

Keep this change narrowly scoped. Do not refactor unrelated `AnalysisEditor.tsx` state, saved-plot
lifecycle, autosave, tab routing, or sample-panel code.

If the live branch has already extracted a better family-local route for these summaries, follow the
current owner instead of forcing this exact prop path.

## Style and accessibility contract

Follow `docs/agent-knowledge/visual-style-guide.md`.

Required:

- Mantine components and theme tokens;
- Tabler icons for previous-view, Home, and chevrons where available;
- compact `xs`/neighboring plot-toolbar geometry;
- merged split-button appearance for the two arrow groups;
- semantic light/dark chrome;
- Plotly itself remains in the current light scientific presentation;
- no fixed light background copied from the HTML mockup;
- every icon-only control has an `aria-label` and Tooltip;
- separator trigger is keyboard reachable despite its intentionally low-chrome appearance;
- Popover opens with click and keyboard activation and closes with Escape/outside click;
- slider supports keyboard adjustments;
- disabled controls communicate why through Tooltip/accessibility text;
- no horizontal overflow at the normal desktop analysis geometry with the Plot style panel open;
- at narrower supported widths, controls may wrap in one compact second line rather than overlap or
  clip. Preserve the plot width as the priority.

The separator trigger is an explicit design exception to ordinary button chrome: it should visually
read as punctuation between From/To until hovered/focused/open. This exception is limited to this one
Popover trigger; all other actions use standard CellXplorer/Mantine affordances.

## Out of scope

Do not:

- add cycle navigation to the Cycles, Steps, DCIR, Chargeability, C-rate, or Recap tabs;
- add a full mini timeline/overview plot;
- add protocol/source/event markers to the slider;
- add playback/animation/autoplay;
- add keyboard shortcuts outside normal focused-control behavior;
- change scientific global/local cycle mapping;
- change Time/Capacity formulas, downsampling, export fidelity, or source provenance;
- change Plotly zoom memory;
- turn previous-view into a general undo system;
- persist navigation history;
- redesign the left analysis sidebar beyond removing duplicate From/To fields;
- broadly refactor `AnalysisEditor.tsx`;
- add backend/schema/cache work unless a current-branch fact proves it unavoidable.

## Implementation order

1. **Rebase/verify current owners**
   - fetch current `main`/feature branch;
   - re-read the required docs;
   - verify the Time/Capacity query and explicit-cycle precedence still match this spec;
   - if Spec 050 changed these paths, preserve its behavior.

2. **Add pure navigation policy**
   - range normalization/movement/centering/resize;
   - selected-Cell max-cycle resolver;
   - focused Node tests.

3. **Add the navigation component**
   - range inputs;
   - window-size selector;
   - grouped arrows;
   - Back/Home/Jump;
   - separator Popover/Slider;
   - local history and drag-only transient state;
   - specific-cycles and no-bound disabled states.

4. **Integrate with Time/Capacity**
   - mount after `PlotHeader`;
   - commit through existing `update(...)`;
   - remove duplicate sidebar From/To inputs;
   - pass `maxAvailableCycle` from the current relational data owner.

5. **Regression/a11y/layout pass**
   - verify saved/draft/edited behavior;
   - verify no query flood during slider drag;
   - light/dark and narrow-width checks;
   - run focused tests, TypeScript/build, then canonical preflight.

## Focused automated tests

Add:

```text
frontend/tests/timeCapacityCycleNavigation.test.ts
```

or the current nearest policy-test location.

At minimum cover:

### Range arithmetic

- shift one cycle forward/back while preserving width;
- whole-window forward/back;
- lower and upper boundary clamping;
- width 1;
- requested width larger than/equal to max -> all cycles;
- resize near the upper boundary preserves requested width;
- Jump centering in the middle;
- Jump centering near cycle 1 and near max;
- exact From/To normalization when the fields cross;
- non-integer/invalid defensive normalization as appropriate to the helper's typed contract.

### Selected maximum

- one selected Cell;
- multiple directly selected Cells with different `total_cycles` -> maximum;
- replicate group expansion;
- mixed direct Cell + replicate group;
- duplicate Cell present directly and through a group is counted once;
- invalid/non-positive summaries ignored;
- no valid summary -> `null`;
- visibility/exclusion state is not an input to the resolver.

### Explicit-cycle policy

- non-empty `cfg.cycles` is detected as range-navigation-disabled;
- clearing it re-enables continuous range without mutating the retained range.

Keep the tests pure. Do not create React component-test infrastructure solely for this feature unless the
repository has gained such a pattern before implementation starts.

## Verification

During implementation, use focused checks first. Before reviewer handoff, follow the current workflow
prompt and run canonical preflight rather than duplicating its full suites.

Expected commands at the authoring baseline:

```powershell
node --test frontend\tests\timeCapacityCycleNavigation.test.ts
cd frontend
npx.cmd tsc --noEmit
npm.cmd run build
cd ..
python scripts\preflight.py
```

`frontend/src/**` changes make the Vite production build required under current repository policy.

If command names have changed by implementation time, use the current canonical commands from
`AGENTS.md`/`docs/specs/README.md` and record the exact commands actually run.

Do not claim browser/manual checks passed unless they were actually performed.

## Manual browser acceptance matrix

This feature is interaction/layout sensitive, so implementation review must record the following as
RUN or NOT RUN:

### Normal navigation

- default `1–3` range renders correctly without changing current defaults;
- select window `20`, then verify exact From/To;
- `‹` / `›` move by one cycle;
- `«` / `»` move by one full current window;
- controls correctly stop/clamp at first and last valid windows;
- manual From/To commits work on Enter/blur and do not request per keystroke;
- `Jump to` works on Enter with no Go button and centers/clamps correctly;
- Home displays every available cycle;
- previous-view arrow walks backward through several committed ranges and disables when exhausted.

### Popover slider

- separator still visually reads as the punctuation between From and To;
- click opens a small arrowed callout directly below that separator;
- callout contains a simple line/handle, not a mini timeline;
- dragging the handle does not continuously refetch/recompute;
- release causes one range update and one history step;
- click outside/Escape closes it;
- keyboard focus and slider arrow keys work.

### Data/selection boundaries

- two Cells with different cycle counts use the longer selected Cell as max;
- a replicate group resolves member cycle extents;
- a continued Cell navigates global cycles correctly;
- hiding a Cell does not change the total navigation extent;
- a source-summary refresh does not silently overwrite the current saved range;
- temporarily unavailable bound disables bound-dependent controls without blocking the plot.

### Specific cycles

- enter a non-contiguous `Specific cycles` list;
- range navigator becomes clearly disabled and explains why;
- backend/plot continues showing those explicit cycles;
- clearing Specific cycles immediately restores range navigation with the previously retained range.

### Saved/draft lifecycle

- new draft navigation marks the draft edited using existing semantics;
- Save as preserves the range;
- opening that saved plot restores it;
- editing a saved plot's range marks it dirty and Update writes the new range;
- previous-view history is not persisted across reopen/new plot;
- thumbnails/image/portable output contain the selected data but no navigation chrome.

### Visual states

- light theme;
- dark theme chrome;
- Plot style panel open at normal desktop width;
- a narrower supported width where the toolbar may wrap;
- cached refetch dimming;
- initial loading;
- scientific empty result;
- Time/Capacity error state.

## Acceptance criteria

Spec 052 is complete when all of the following are true:

- [ ] Time/Capacity continuous cycle range is edited above the plot rather than duplicated in the
      sidebar.
- [ ] Window size is left-positioned and displays a bare number.
- [ ] Backward and forward pairs are visually merged split-button groups.
- [ ] Single arrows shift one cycle; double arrows shift one full window with deterministic boundary
      clamping.
- [ ] Exact From/To inputs commit without per-keystroke scientific requests.
- [ ] The middle separator visually reads as `line-dot-line` and opens a small arrowed Popover.
- [ ] The Popover contains only a draggable slider/handle, not a timeline plot.
- [ ] Slider dragging is transient and commits one scientific range update on completion.
- [ ] Previous visualization uses an icon-only left arrow and restores session-local range history.
- [ ] Show-all uses an icon-only Home action and selects `[1, maxAvailableCycle]`.
- [ ] Jump to has no Go button and commits on Enter.
- [ ] `Showing X–Y` or equivalent redundant status text is absent.
- [ ] Maximum cycle extent comes from existing relational Cell summaries with replicate expansion and
      no new API/scientific read.
- [ ] Non-empty Specific cycles cannot make the range controls misleading; range navigation is
      clearly disabled without silently clearing the list.
- [ ] Continued Cells retain existing global-cycle semantics.
- [ ] Navigation uses the existing `cycle_start`/`cycle_end` result identity; no endpoint/result/cache
      contract changes.
- [ ] Saved plots persist the selected range but never persist previous-view history or navigation
      chrome.
- [ ] No new backend, database migration, `CALC_VERSION`, parser version, or result-schema bump is
      introduced.
- [ ] Light/dark chrome, keyboard access, Tooltips/accessible names, loading/error/empty states, and
      compact desktop geometry satisfy the visual guide.
- [ ] Focused navigation tests, TypeScript, production build, and canonical preflight are recorded.
- [ ] Manual browser acceptance above is recorded truthfully as RUN/NOT RUN.

## Implementation record

Implemented on `feature/time-capacity-cycle-navigation` for `ACTIVE_CHILD: 052`.

- Implementation commit: the single workflow checkpoint commit for this handoff (hash assigned at commit).
- Files changed: `AnalysisEditor.tsx`, `TimeCapacityPlotCard.tsx`, new `TimeCapacityCycleNavigation.tsx`, new `timeCapacityCycleNavigationPolicy.ts`, and new `frontend/tests/timeCapacityCycleNavigation.test.ts`.
- Anchors moved: the duplicate sidebar `From`/`To` editors were removed; the compact navigation strip is mounted immediately after `PlotHeader`; the existing `cycle_start`/`cycle_end` update and query identity remain authoritative.
- Focused verification: `node --test frontend\tests\timeCapacityCycleNavigation.test.ts` PASS (12/12); `npx.cmd tsc --noEmit` PASS; `npm.cmd run build` PASS; `git diff --check` PASS.
- Canonical preflight: `python scripts\preflight.py` PASS — all 4 stages, including 155 backend/frontend test files/modules, passed.
- Manual/browser acceptance: NOT RUN in this implementation turn.
- Review: pending repository reviewer handoff; `docs/specs/reviews/052-time-capacity-cycle-navigation-review.md` remains reviewer-owned.

When implementation begins, keep this section concise and record:

- branch and implementation commit;
- actual files changed;
- any authoring-baseline anchors that moved;
- focused verification results;
- canonical preflight result;
- manual/browser checks as RUN/NOT RUN;
- review link and final review status.
