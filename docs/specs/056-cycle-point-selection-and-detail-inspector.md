# Spec 056 — Cycle point selection and detail inspector

> Implementation branch base: `main` at
> `7aae0021db94bd565320922a1a5be80fb7a1c05d` (2026-09-04), after Spec 055 and its
> follow-up export work landed.
> Branch: `feature/cycle-point-selection-inspector`.
> Re-verify every named anchor against that implementation branch before coding.

## Status

The original implementation and R1-R5 are independently review-clean. The user-approved R6/R7/R8
browser refinements are implemented and awaiting independent re-review. Focused browser evidence
is recorded below; the broader original manual matrix is not declared complete. Final workflow
completion and merge readiness remain reviewer-owned. This is one Cycles-only frontend feature.

Review document:
[`reviews/056-cycle-point-selection-and-detail-inspector-review.md`](reviews/056-cycle-point-selection-and-detail-inspector-review.md)

## Goal

### User-approved amendment — 2026-09-05

The user approved the browser review and the following refinements, superseding conflicting
original presentation rules below. Implement these together on the existing feature branch:

- Fix capability choices resetting while detail queries load, double-scaled overlay coordinates,
  and repeated polygon vertices admitting outside points.
- Label the cycle columns **Original cycle** and **Plotted cycle**.
- Any outside click, including Ctrl, dismisses the inspector; its own portalled dropdowns count
  as inside. Ctrl-clicking the same selected point retains it. Dismissal must preserve replacement
  polygon vertices and the incoming rectangle gesture; beginning a drag dismisses old inspection.
- Quantity changes retain the previous complete detail figure and its axes until the new result
  arrives. Show loading feedback without removing the plot or briefly shrinking the popup.
- Cycle detail is always expanded (user clarification on 2026-09-05); remove the collapse toggle.
  Selection therefore starts its detail query immediately, superseding the original lazy-fetch rule.
- The inspector grows naturally up to 70% of viewport height, keeping its header accessible.
  Check right, left, below, and above the selected marker bounds before reducing its size. Keep
  it inside the current viewport without covering selected markers whenever geometry permits.
  Use document scrolling only if no usable surrounding viewport area exists. It may extend beyond
  the plot card without resizing the plot.
- Use compact wrapped Cycles hover labels, suppress the separate Plotly name box, and keep
  hover clear of the point and hidden during Ctrl selection.
- Replace halos with temporary markers retaining the Cycles color and symbol, a dark-grey
  border, and a modest size increase (small markers +2 px capped at 8 px; large markers unchanged).
  Line-only traces receive small selected markers. Selection remains absent from artifacts.
- Preview polygon closure with dashed last-vertex/cursor/first-vertex edges.
- Detail offers all selected samples or one physical member Cell at a time, without changing
  the point selection, main analysis, or scientific request membership.
- Detail uses an independent compact white default plot, no legend, and the current Cycles
  colors. Table swatches identify samples; aggregate-member curves receive an external compact
  member key. Saved Time/Capacity presentation must not leak into detail styling.

- Later user refinement: when distinct visible Cycles sample names share a long prefix, show that prefix
  in the Sample header and shorten the rows. Preserve meaningful numeric identifiers and the full
  names on hover. A single distinct plotted sample or names without a useful common prefix stay unchanged.

The user explicitly requested implementation and browser testing after the reviewer discussion.
Final independent review remains required; this amendment does not grant self-approval or merge.

Let a user inspect one or many plotted points directly in the **Cycles** analysis tab without
changing the scientific analysis or leaving the plot:

1. `Ctrl` + pointer drag selects every eligible point inside a rectangle.
2. Repeated `Ctrl` + clicks define a polygon; releasing `Ctrl` closes it and selects every eligible
   point inside it.
3. One `Ctrl` + click selects the nearest eligible point.
4. A non-modal floating inspector shows the selected points' actual plotted X/Y values.
5. An expandable detail area shows the raw within-cycle curve for the selected cycle, with X/Y
   quantity selectors and previous/next navigation across the selected cycles.

The main Cycles result must remain visible and reusable throughout this workflow. Point inspection
is transient UI state: it must not mark the saved plot edited, change `AnalysisSpec`, run the Cycles
analysis again, or appear in any export or saved artifact.

## Approved design direction

The user approved a conceptual mockup on 2026-09-04. The live application layout remains
authoritative:

- the existing analysis tabs, sample/settings sidebar, Cycles plot header, plot card, saved-plots
  area, and collapsed Style rail remain in their current positions;
- the inspector floats over the central Cycles plot card and does not create another page column;
- no modal backdrop dims or blocks the rest of the interface;
- the written interaction and scientific rules in this spec win if a conceptual mockup differs.

Follow `docs/agent-knowledge/visual-style-guide.md` and match the current Cycles card rather than
reproducing mockup-only chrome.

## Terminology

- **Eligible point**: one visible, finite point belonging to a selectable scientific Cycles trace.
- **Selection gesture**: the transient rectangle, polygon, or single-point interaction performed
  while `Ctrl` is held.
- **Selection record**: a stable frontend record identifying the rendered series, underlying sample
  context, scientific global cycle, displayed X value, displayed Y value, quantity, axis, and source
  provenance available for one selected point.
- **Active cycle**: the selected scientific global cycle currently shown in the expanded detail
  plot.
- **Inspector**: the persistent interactive Popover/Paper opened after a successful selection. It
  is not an ephemeral tooltip despite being visually lightweight.

## Locked decisions

### Scope and ownership

- This feature applies only to the **Cycles** family.
- Do not generalize point selection to Time/Capacity, Steps, DCIR, Chargeability, C-rate, Recap, or
  portable reports in this change.
- Selection state is owned by the mounted Cycles plot card or a Cycles-local hook/component.
- Do not add point-selection fields to `AnalysisSpec`, saved plots, plot signatures, backend result
  signatures, database models, or portable artifacts.
- Do not refactor the general analysis editor or replace the shared Plotly wrapper merely to host
  this feature. A narrow optional event/ref passthrough is acceptable if the current wrapper lacks
  one that Plotly already supports.

### Selection does not change the analysis

The following actions are inspection only and must not call the normal plot `update(...)` path:

- starting, changing, completing, or clearing a point selection;
- opening, expanding, collapsing, moving, or closing the inspector;
- changing the inspector's X/Y detail quantities;
- moving to the previous or next selected cycle.

Consequently they must not:

- enable `Update` or create an `Edited`/`Unsaved` state;
- trigger an analysis `PUT`/autosave;
- trigger a new Cycles compute request;
- alter the main Cycles query/cache/data signature;
- reset the main plot's zoom, legend position, or style.

### Selection replacement

- A newly completed selection replaces the previous selected-point set.
- Additive/subtractive selection modifiers are out of scope.
- A completed gesture containing no eligible points clears the inspector and selection overlay.
- `Escape` cancels an in-progress gesture. If no gesture is in progress, it closes the inspector and
  clears the completed selection.

## Current implementation context

Re-verify these anchors before implementation:

- `frontend/src/features/analyses/editor/families/cycles/CyclePlotCard.tsx`
  - `cycleTracesForResult(...)` builds aggregate, cell, CE, band, low-n, and source-boundary traces;
  - `CyclePlotCard(...)` owns the live Cycles Plotly surface, zoom memory, plot header, export, and
    Style panel;
  - current cell traces already carry global/local-cycle and source information in `customdata`,
    but aggregate/CE/helper traces do not all expose a uniform selection identity.
- `frontend/src/components/Plot.tsx`
  - shared `react-plotly.js`/Plotly wrapper;
  - existing Plotly props should be used where sufficient, without changing behavior for other
    families.
- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx`
  - owns existing within-cycle raw plotting, scientific request, adaptive overview/refinement, and
    quantity conversion behavior.
- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
  - visual reference for compact previous/next controls only; do not reuse its saved-range state
    machine for the transient inspector.
- `frontend/src/api.ts`
  - `ComputeResult`, `CellSeries`, `AggregateSeries`, `TimeCapacityResult`, and
    `TimeCapacityTrace` contracts.

The current Cycles figure may contain `scatter` traces that the interactive renderer converts to
`scattergl`. Do not rely on DOM marker elements or SVG-only behavior.

## Selection gestures

### Common rules

- Selection activates only when the pointer begins inside the main Cycles plotting area while the
  platform `Ctrl` modifier is pressed.
- Existing unmodified Plotly hover, zoom, pan, autoscale, legend, and toolbar behavior remains
  unchanged.
- Suppress browser/Plotly behavior only for the active modified gesture and only inside the plot.
- Use pointer capture so a drag remains coherent if the pointer briefly leaves the plotting area.
- Geometry is evaluated in rendered screen/pixel coordinates after Plotly transforms. This keeps
  rectangle and polygon behavior correct after zooming and for points on `y2`.
- Selection includes points on the rectangle/polygon boundary.
- Only points currently rendered inside the plot viewport are candidates.
- Null, `NaN`, infinite, hidden, clipped, or non-rendered points cannot be selected.
- Perform point hit-testing only when a gesture commits, not on every pointer move. Pointer movement
  should update only the lightweight shape overlay.

### Distinguishing click from rectangle drag

Use one documented CSS-pixel movement threshold, expected to be about 6 px at normal UI zoom:

- movement below the threshold is a polygon/single-point click;
- movement at or above the threshold is a rectangle drag.

The threshold must be applied to the complete pointer displacement from pointer-down, not to each
individual move event, and must remain usable under CellXplorer UI zoom and Windows display scaling.

### Rectangle selection

1. The user presses `Ctrl` and pointer-down inside the plot.
2. Movement beyond the threshold starts a translucent theme-primary rectangle with a clear border.
3. Pointer-up commits every eligible point inside or on the rectangle.
4. The inspector opens immediately when at least one point was selected.
5. Releasing `Ctrl` after pointer-up has no second effect.

If `Ctrl` is released before pointer-up, cancel the incomplete rectangle rather than committing an
ambiguous area.

### Polygon selection

1. While keeping `Ctrl` held, each click below the drag threshold appends one vertex.
2. Show small theme-primary vertex handles and connecting segments while the polygon is being built.
3. Releasing `Ctrl` commits the gesture:
   - one vertex selects the nearest eligible point within the hit radius;
   - two vertices select the unique eligible points hit by those two clicks, if any;
   - three or more vertices close the polygon and select every eligible point inside or on it.
4. The committed closed polygon remains visible while its selection is active.

Use an approximately 10 px hit radius for direct point clicks, adjusted only if the repository has
an established Plotly hover tolerance that is demonstrably better. A direct click on empty space
must not select a distant point merely because it is the mathematically nearest candidate.

### Keyboard and cancellation behavior

- Losing window focus, changing analysis tab, unmounting the plot, or replacing the underlying
  Cycles scientific result cancels any in-progress gesture.
- `Escape` during polygon construction removes the unfinished polygon without changing the existing
  completed selection.
- Closing the inspector, clicking its close action, or pressing `Escape` with no active gesture
  clears the selected-point halos and committed shape.
- Do not globally intercept `Ctrl`; shortcuts and text-input behavior outside the plot must remain
  intact.

## Selectable trace and point identity

### Eligible scientific traces

The following visible traces are selectable:

- individual Cell primary-quantity traces;
- replicate aggregate primary-quantity traces;
- the visible coulombic-efficiency trace when the CE overlay is enabled.

The following helper/presentation traces are not independently selectable:

- dispersion-band polygons;
- below-minimum-n helper markers when they duplicate an aggregate point;
- source-boundary marker helpers;
- legend-only, hidden, or styling-preview traces;
- thumbnail/export-only traces.

If a helper marker visually overlaps an eligible scientific point, selection resolves to the
underlying scientific point once, not to duplicate table rows.

### Stable selection record

Build selection records from explicit Cycles trace metadata rather than parsing trace names or hover
HTML. Each record must provide at least:

```ts
type CyclePointSelectionRecord = {
  key: string;                  // deterministic and unique within the figure
  seriesKey: string;            // existing application series identity
  sampleKind: "cell" | "replicate";
  cellId: number | null;
  groupId: number | null;
  sampleLabel: string;
  scientificCycle: number;      // original global cycle used for detail requests
  localCycle: number | null;
  sourcePosition: number | null;
  sourceFilename: string | null;
  quantityKey: string;
  quantityLabel: string;
  axis: "y" | "y2";
  displayedX: number;
  displayedY: number;
};
```

Equivalent naming is acceptable.

The record's `scientificCycle` must remain the original global cycle even when diagnostic cycles
are hidden and the Cycles X axis is reindexed. `displayedX` is what appears in the table's X column;
it must never be reused as the scientific request cycle unless both values are known to be equal.

The key should be composed from stable application identity, measure/axis, scientific cycle, and
any source context required to prevent collisions. Never use trace array index alone as durable
identity because helper-trace emission and visibility can change the index.

### Aggregate points

- An aggregate point is represented by one table row labelled with its replicate-group name.
- Its displayed Y is the exact aggregate mean used by the main Cycles trace.
- Its detail context remains that replicate group; do not pretend the mean point belongs to an
  arbitrary member Cell.
- The expanded detail plot may render the selected group's eligible member Cell curves using the
  existing Time/Capacity behavior. Do not fabricate a raw mean curve unless the existing scientific
  path already defines one.

## Inspector presentation and behavior

### Container

- Use a Mantine Popover/Paper-style floating inspector anchored to the completed selection's visible
  bounding box.
- Prefer the right side of the selection, flip left when space requires, and clamp to the plot-card
  viewport so the inspector remains reachable.
- The inspector may use a Portal if required to avoid the current plot card's `overflow: hidden`,
  but its anchor and lifecycle remain owned by the Cycles card.
- It must not resize the plot, create a fourth analysis column, dim the page, trap focus, or prevent
  interaction with the rest of the analysis.
- It remains open when the pointer leaves it. This is an interactive inspector, not a hover-only
  Tooltip.
- Header: `Selected point` for one record or `Selected points` plus a compact count Badge for many,
  and an accessible close ActionIcon.

### Table

Show one row per selection record. Required columns:

- Sample;
- Cycle;
- the current plotted X quantity and unit;
- the current plotted Y quantity and unit.

For the ordinary Cycles plot, X will normally be Cycle, but the table must derive its heading and
value from the rendered point rather than hardcoding an unrelated quantity. The Y heading must use
the active Cycles quantity label, including normalization and units; CE selections use the CE label
and right-axis value.

Additional source-local context may appear in a compact secondary line or Tooltip when available,
but must not make the core table horizontally unusable.

- Right-align comparable numeric columns.
- Use the same meaningful numeric formatting as the current Cycles hover presentation; do not expose
  meaningless floating-point tails.
- Preserve full numeric values in the selection record so formatting does not alter detail identity.
- Truncate long sample names and expose the full value by Tooltip/title.
- Order rows deterministically by scientific cycle, then series/measure order as drawn.
- If several selected rows refer to the active cycle, emphasize all of them with bold text and the
  theme-primary light background.
- Clicking a row sets its scientific cycle as the active cycle when the detail section is expanded.

The table may scroll vertically after a reasonable compact maximum height. The header and detail
disclosure should remain visible; do not allow a very large selection to produce a page-height
popover.

### Completed-point emphasis

While the inspector is open:

- selected points receive a visible theme-primary halo or outline without replacing their original
  series color;
- the rectangle/polygon outline remains visible at low opacity;
- emphasis is an overlay and must not rebuild or restyle all scientific traces;
- closing/clearing selection removes the overlay cleanly.

## Expanded cycle detail

### Disclosure and defaults

- A collapsed disclosure labelled `Cycle detail` appears below the table.
- It is collapsed by default so ordinary point inspection is immediate and request-free.
- Expanding it initializes the active cycle to the first deterministic selected row unless the user
  previously activated another surviving row in the same selection.
- Default quantities are X = `Time` in the analysis's current Time/Capacity time unit and
  Y = the primary available cell voltage.

### Quantity selectors

Provide two compact selectors:

- **X quantity**: Time, capacity (mAh), specific capacity (mAh/g), and areal capacity (mAh/cm²) when
  supported by the selected sample context.
- **Y quantity**: cell voltage and any verified working/counter potential channels; current (mA),
  current density, and C-rate when their required metadata is available.

Options must use the existing Time/Capacity capability and conversion rules. Disable or omit a
quantity when required mass, area, nominal capacity, or voltage-channel data is unavailable. Do not
recalculate scientific quantities independently in the inspector.

Derivative views, arbitrary mathematical expressions, dual Y axes, and stacked voltage/current
layout are out of scope for this inspector.

### Selected-cycle navigation

- Previous/next buttons traverse the sorted unique `scientificCycle` values represented in the
  current selected rows.
- They do not move to an unselected adjacent cycle.
- Disable Previous at the first selected cycle and Next at the last selected cycle.
- The compact center label reads `Cycle N`.
- If several rows share cycle N, all those rows become active/bold and the detail plot includes all
  selected sample contexts represented by those rows.
- If a selected replicate aggregate and a directly selected member Cell would request the same
  physical Cell/cycle twice, deduplicate the detail request/rendering by stable Cell identity while
  preserving both table rows.

### Data path

The table and selection overlay must use the already returned Cycles `ComputeResult`; they require no
network request.

Only expansion of `Cycle detail` may request raw within-cycle data. Build a transient request from:

- the live analysis's selected sample definitions and scientific filters;
- only the sample contexts represented by selected rows for the active cycle;
- the active original global cycle as an explicit one-cycle selection;
- the local inspector X/Y quantity choices;
- existing Time/Capacity voltage/capability semantics.

The transient request must not be written back to the live plot spec. Its query identity and request
body must be derived from the same object.

Prefer reusing/extracting the smallest existing Time/Capacity request/trace policy needed to obtain
and render exact within-cycle rows. Preserve that path's canonical cache, indexed read, worker,
global/local-cycle, source-provenance, and adaptive-refinement behavior. Do not duplicate raw Parquet
reading or scientific phase/capacity/current conversion in the frontend.

The desired detail behavior is:

```text
expand Cycle detail or change active selected cycle/quantity
        ↓
build transient one-cycle Time/Capacity request
        ↓
reuse cached/indexed backend result where available
        ↓
render overview immediately when available
        ↓
apply the existing bounded high-resolution refinement behavior
```

If the existing endpoint cannot safely satisfy this without mutating the analysis, add only the
narrowest request adapter needed; do not change the meaning of the ordinary Time/Capacity tab.

### Loading and errors

- Loading is confined to the expanded detail area. The main Cycles plot and table remain visible.
- Preserve the previous valid detail curve while a next/previous result loads, dimming it if needed.
- Delay any spinner/loader enough to avoid flashes on warm one-cycle requests.
- Never replace the main plot with `Preparing plot data` for inspector work.
- Show detail failures inline inside the expander with a concise retry action; do not close the
  inspector or clear the point table.
- Collapsing the disclosure may cancel work that is no longer useful, but must not invalidate shared
  Time/Capacity caches.

## Main-result and visibility lifecycle

- A new Cycles result identity, quantity change, diagnostic reindex change, aggregation change, or
  selected-sample membership change clears the transient selection unless every record can be
  revalidated exactly against the new trace metadata. Prefer deterministic clearing over showing
  stale values.
- Style-only changes may preserve the selection when its stable point keys still exist; halos must
  follow the newly rendered coordinates/colors.
- If a selected sample/series is hidden, remove its records immediately. Close the inspector if none
  remain.
- If it becomes visible again, do not silently recreate an old selection; the user can select it
  again.
- Main-plot zoom/relayout may preserve records and recompute overlay pixel positions for still-visible
  selected points. Records outside the new viewport remain in the table but need no off-screen halo.
- Opening another saved plot, switching analysis tab, or leaving the analysis clears all inspector
  state.

## Persistence, dirty state, and exports

Point inspection is intentionally session-local and non-persistent:

- no `AnalysisSpec` or saved-plot schema field;
- no dirty/edit state;
- no automatic analysis save;
- no restore after reload/reopen;
- no database migration;
- no portable-report state;
- no thumbnail representation.

The selection shape, point halos, inspector, and detail navigation chrome must be excluded from PNG,
SVG, PDF, CSV, XLSX, Parquet, portable report, and saved preview output. Existing scientific export
data and visibility semantics remain unchanged.

## Suggested implementation structure

Keep geometry and state policy outside the already large Cycles card where practical:

```text
frontend/src/features/analyses/editor/families/cycles/
├── CyclePlotCard.tsx
├── CyclePointInspector.tsx              # floating table + detail disclosure
├── cyclePointSelectionPolicy.ts          # pure gesture/geometry/identity helpers
└── useCyclePointSelection.ts             # optional pointer/keyboard/overlay controller
```

Equivalent names are acceptable. A narrowly shared within-cycle detail request helper may live under
the Time/Capacity family if it truly reuses that family's scientific ownership. Do not move generic
Cycles code into `AnalysisEditor.tsx`.

Expected responsibilities:

- trace construction publishes explicit selectable metadata;
- the selection controller owns pointer/keyboard state and screen-space hit-testing;
- pure policy owns rectangle/polygon containment, click tolerance, deduplication, ordering, active
  cycle navigation, and request-context projection;
- the inspector owns Mantine presentation and transient quantity/navigation state;
- the existing Cycles card composes these pieces and remains the owner of the main plot.

## Performance requirements

- No backend request is made merely to select points or display the table.
- No point-in-shape scan occurs for every pointer move.
- A committed selection may scan the currently rendered eligible points once. If real figures make
  that measurably slow, add a Cycles-local spatial index without changing result semantics.
- The shape overlay and halos must not cause `Plotly.react` to rebuild all scientific traces on every
  pointer event.
- Detail requests are lazy, one active cycle at a time, cancellable/stale-safe, and cached by exact
  sample context + scientific cycle + quantity/capability identity.
- Rapid previous/next actions must never let an older response overwrite the newest active cycle.

## Accessibility and visual contract

- Use Mantine components/theme tokens and Tabler icons.
- Inspector chrome uses semantic light/dark surfaces; the Plotly paper remains publication-white.
- The inspector must remain readable in Light, Dark, and Auto modes.
- Header, table, disclosure, selectors, navigation buttons, retry, and close action are keyboard
  reachable and have accessible names.
- Icon-only buttons have Tooltips and `aria-label`s.
- Focus moves into the inspector only when the user explicitly tabs/clicks into it; opening it must
  not steal focus in a way that loses an in-progress `Ctrl` keyup.
- The plot should expose a compact discoverability hint such as
  `Ctrl+drag: rectangle · Ctrl+click: polygon` through an info Tooltip or low-noise plot-adjacent
  helper. Do not place instructional text inside exported plot content.
- Do not make hover the only way to discover the controls required to use the inspector.
- Keep the inspector compact at normal desktop geometry; allow table scrolling rather than covering
  the whole plot.

The `Ctrl`-modified direct-manipulation gesture is a deliberate desktop interaction. This spec does
not require keyboard-only geometric point selection, but every resulting inspector action must be
keyboard operable and the existing Plotly toolbar selection tools must not be broken.

## Cache and version decisions

Expected:

- no database migration;
- no `SPEC_VERSION` change;
- no `CALC_VERSION` bump;
- no parser/cache-layout version change;
- no Cycles result-schema change;
- no portable artifact version change.

Transient frontend trace metadata is not a backend result-schema change. If implementation discovers
that exact one-cycle detail cannot be obtained from the existing Time/Capacity request/refinement
contracts, stop and document the smallest required API change before implementing it.

## Out of scope

Do not add:

- point editing, deletion, annotation, labels, tagging, or comments;
- additive/subtractive selection sets;
- freehand lasso drawing;
- selection persistence or saved named selections;
- selection-driven CSV/image export;
- synchronization to other analysis tabs;
- autoplay through selected cycles;
- derivatives or stacked/dual-axis detail plots;
- new backend scientific formulas;
- broad Plotly gesture, touchpad, zoom, or pan changes;
- changes to ordinary sample visibility, legend visibility, plot dirty state, or saved-plot workflow.

## Implementation order

1. **Rebase and verify owners**
   - begin from `main` after Spec 055 is present;
   - re-read the visual guide and relevant agent knowledge;
   - verify current Cycles trace construction, Plot wrapper events, and Time/Capacity request helpers.
2. **Define selectable metadata and pure policy**
   - stable point identity, original-cycle preservation, eligible-trace filtering;
   - rectangle/polygon/click geometry, deduplication, sorting, active-cycle navigation;
   - focused policy tests.
3. **Implement Cycles-local gesture overlay**
   - pointer capture and movement threshold;
   - rectangle/polygon drawing and cancellation;
   - selected-point halos without main-trace rebuilds.
4. **Implement the inspector table**
   - anchored non-modal geometry;
   - exact quantity labels/values, active-cycle emphasis, close/empty behavior;
   - no dirty state or requests.
5. **Add lazy cycle detail**
   - transient one-cycle request projection;
   - existing Time/Capacity data/refinement reuse;
   - quantity availability, previous/next selected-cycle navigation, stale-response safety.
6. **Regression and acceptance**
   - test other Plotly gestures/toolbar behavior;
   - light/dark/narrow geometry;
   - focused tests, TypeScript, production build, canonical preflight, and manual browser matrix.

## Focused automated tests

Add a pure policy test such as:

```text
frontend/tests/cyclePointSelectionPolicy.test.ts
```

At minimum cover:

### Gesture and geometry

- movement below threshold is a click; movement at/above it is a rectangle;
- rectangle selection includes boundary points and excludes outside points;
- a concave polygon selects correctly;
- polygon boundary points are included;
- one vertex uses bounded nearest-point selection;
- an empty direct click beyond the hit radius selects nothing;
- two direct vertices return unique hit points;
- duplicate helper/scientific representations deduplicate to the scientific point;
- `y2` and zoomed points are selected by screen coordinates, not raw Y values.

### Identity and ordering

- cell, replicate aggregate, primary, and CE records receive stable distinct keys;
- hidden/helper/non-finite points are ineligible;
- deterministic row ordering is cycle then rendered series/measure order;
- reindexed diagnostic display X retains the original global `scientificCycle`;
- multiple rows on one cycle produce one navigation stop and all become active;
- previous/next boundaries disable correctly;
- direct Cell plus overlapping replicate context deduplicates physical detail requests.

### State and request projection

- a new committed selection replaces the old one;
- hiding selected records removes only those records and closes on empty;
- main-result identity change clears stale records;
- detail request uses the original scientific cycle, not displayed/reindexed X;
- detail request narrows to selected sample contexts while preserving applicable scientific filters;
- request key and request body derive from the same transient spec;
- creating/changing selection and detail controls does not mutate the live `AnalysisSpec`;
- collapse prevents/cancels unnecessary detail work without clearing the point table.

If current mounted-component/query test infrastructure makes it straightforward, also prove:

- selecting points opens the table without another Cycles request;
- the detail request starts only after expansion;
- rapid cycle navigation cannot display an out-of-date response.

Do not introduce heavy browser-component infrastructure solely for those assertions when the pure
policy/request tests establish the invariant clearly.

## Verification

Use focused checks while implementing, then the repository's current canonical workflow. Expected
commands at this authoring baseline:

```powershell
node --test frontend\tests\cyclePointSelectionPolicy.test.ts
cd frontend
npx.cmd tsc --noEmit
npm.cmd run build
cd ..
python scripts\preflight.py --no-cache
```

Record exact results. Do not claim browser/manual acceptance unless it was actually run.

## Manual browser acceptance matrix

### Rectangle and polygon

- `Ctrl` + drag draws a smooth rectangle and selects all/only enclosed visible scientific points;
- a tiny movement remains a click, not an accidental rectangle;
- repeated `Ctrl` + clicks draw vertices/segments and releasing `Ctrl` closes the polygon;
- a concave polygon behaves correctly;
- one `Ctrl` + click selects the intended nearby point;
- clicking empty space outside the hit radius clears rather than choosing a distant point;
- releasing `Ctrl` early cancels an incomplete rectangle;
- `Escape`, tab change, and result replacement cancel in-progress geometry safely.

### Table and inspector

- inspector opens beside the selection without dimming, resizing, or blocking the analysis;
- Sample, Cycle, X, Y, quantity labels, normalization, and units match the plotted data;
- Cell, replicate aggregate, and CE points are identified truthfully;
- helper traces do not create duplicate rows;
- long names truncate and remain discoverable;
- a large selection scrolls inside a bounded inspector;
- closing clears shape/halos and does not affect plot dirty state.

### Detail plot

- expanding the disclosure, not selecting points, starts the first detail request;
- default Time/Voltage detail appears for the first selected scientific cycle;
- available X/Y quantities work and unavailable mass/area/C-rate/potential choices are not offered;
- previous/next moves only through selected unique cycles and disables at boundaries;
- corresponding table row(s) become bold/light-primary;
- row click activates that row's cycle;
- repeated points on the same cycle show the applicable selected sample contexts without duplicate
  physical traces;
- rapid navigation settles on the last requested cycle;
- detail loading/error never hides the main Cycles plot or point table.

### Scientific and lifecycle boundaries

- no new Cycles request occurs for rectangle, polygon, single-point, close, or table interaction;
- the first detail expansion reuses the existing Time/Capacity scientific path;
- continued Cells use original global cycles and retain source-local provenance;
- diagnostic-cycle reindex displays the reindexed X but requests the correct original global cycle;
- hidden/non-rendered samples cannot be selected;
- hiding a selected sample removes its rows immediately;
- main plot zoom and style remain stable;
- selecting/navigating/closing never enables `Update` and never autosaves;
- saved-plot reopen does not restore transient selections.

### Existing behavior regression

- ordinary hover labels;
- Plotly zoom box, pan, autoscale, reset, and toolbar actions;
- legend drag and application-owned visibility actions;
- PNG/SVG/PDF and CSV/XLSX/Parquet export;
- saved thumbnails and portable reports;
- Light and Dark themes;
- Style panel open at normal desktop width.

## Acceptance criteria

Spec 056 is complete when:

- [ ] `Ctrl` + drag selects visible eligible Cycles points using a rectangle.
- [ ] Repeated `Ctrl` + clicks create a polygon that closes/selects on `Ctrl` release.
- [ ] One `Ctrl` + click selects the intended nearby point.
- [ ] Selection uses screen-space geometry correctly after zoom and on either Y axis.
- [ ] A bounded non-modal inspector lists the exact selected Sample, Cycle, X, and Y data.
- [ ] Original global cycle identity remains correct under diagnostic-cycle reindexing.
- [ ] Cell, replicate aggregate, and CE points are truthful; helper traces do not duplicate them.
- [ ] The main Cycles result stays visible and no Cycles request is triggered by inspection.
- [ ] Selection and inspector controls never dirty, autosave, or mutate the analysis spec.
- [ ] The collapsed detail disclosure makes ordinary selection request-free.
- [ ] Expanded detail reuses the existing Time/Capacity scientific/refinement path for one active
      selected cycle.
- [ ] X/Y detail options follow existing capability and unit rules.
- [ ] Previous/next traverses selected unique cycles and emphasizes every matching table row.
- [ ] Detail loading/errors are confined to the inspector and stale responses cannot win.
- [ ] Selection chrome is absent from every saved artifact and export.
- [ ] Existing Plotly hover/zoom/pan/toolbar, visibility, styling, and saved-plot behavior regressions
      are absent.
- [ ] Focused tests, TypeScript, production build, no-cache preflight, and the manual browser matrix
      are recorded truthfully.

## Implementation record

Implemented on `feature/cycle-point-selection-inspector` for `ACTIVE_CHILD: 056`.

- Implementation checkpoints: `c36d356` (initial implementation) and `55abb63` (R1-R4 fixes).
- Files changed: `AnalysisEditor.tsx`, `CyclePlotCard.tsx`, new
  `CyclePointInspector.tsx`, new `useCyclePointSelection.ts`, new
  `cyclePointSelectionPolicy.ts`, `cycleTraceRenderer.test.ts`, and new
  `cyclePointSelectionPolicy.test.ts`.
- Ownership: Cycles trace construction publishes explicit selectable-point metadata; the
  Cycles-local hook owns pointer capture, screen projection, geometry, lifecycle, and selection;
  the non-modal inspector owns transient table/detail state. Shared `Plot.tsx`, saved plot state,
  exports, the backend, schemas, migrations, and calculation versions are unchanged.
- Scientific detail: collapsed selection is request-free. Expansion derives one immutable
  Time/Capacity request for the active original global cycle and exact contributing Cells, with
  canonical query-key/body identity, cancellation, compatible placeholder reuse, and the existing
  refinement endpoint.
- R1-R4 fixes: the inspector now uses the shared latest-generation refinement lifecycle; mixed
  primary/CE selections show each row's exact measure label; point-selection metadata is
  interactive-only and defensively removed from portable artifacts; and relayout clears the
  complete transient selection when its screen-space outline can no longer remain truthful.
- Focused re-verification: `node --test frontend\tests\cyclePointSelectionPolicy.test.ts
  frontend\tests\cycleTraceRenderer.test.ts frontend\tests\plotArtifactPolicy.test.ts
  frontend\tests\timeCapacityRefinementPolicy.test.ts` PASS (39/39); full frontend suite PASS
  (779/779); `npx.cmd tsc --noEmit` PASS; `npm.cmd run build` PASS; `git diff --check` PASS.
- Canonical re-verification: `python scripts\preflight.py --no-cache` PASS — 4/4 stages and all 163
  backend/frontend test files/modules passed in 53.02 seconds.
- Manual browser acceptance matrix: NOT RUN in this implementation turn.
- Review: initial review returned R1-R4; all four are independently closed. R5 updates only the
  durable status documentation. The pending manual browser matrix and final completion decision
  remain reviewer-owned.


## R6 implementation and browser evidence — 2026-09-05

- Always-expanded detail, stable capability choices during axis requests, original/plotted cycle
  labels, outside dismissal including portalled-select containment, and natural popup sizing.
- Independent detail defaults retain Cycles colors, remove the legend, and provide per-Cell/all
  filtering without changing request membership. Table/member swatches identify curve colors.
- Small selected markers grow modestly with a grey border; symbols and colors are preserved.
  Screen-space overlays measure their rendered viewport directly, including CSS UI zoom.
- Polygon construction previews dashed closure edges. Repeated vertices no longer admit outside
  points; a 0.01-screen-pixel segment-distance tolerance handles Plotly SVG coordinate rounding.
- Live Gen2C analysis, Cycles: Ctrl-click selected original/plotted cycle 85; detail opened
  automatically; specific capacity persisted through response loading and switching Y to current;
  portalled dropdowns stayed open inside the inspector; outside clicks dismissed selection.
- Browser geometry: marker centers aligned at 90% and 110% UI zoom; a 620 px viewport constrained
  the popup to 434 px (70%), kept it inside the window and clear of the selected point, and left
  its close control accessible after scrolling. UI zoom restored to 100%; viewport override reset.
- Isolated browser component fixture using the production inspector/controller and synthetic cached
  curves: two colored curves ignored deliberately conflicting saved Time/Capacity styling;
  All -> Cell 2 -> All worked with the selection table retained and no legend. Repeating the first
  triangle vertex selected cycles 1,2,3,4, including the interior and all boundary points, while
  excluding outside cycle 5. Dashed preview updated with construction vertices; Escape cleared it.
  Temporary fixture files and their browser tab were removed after verification.
- Browser scope limits: this session did not execute a native Ctrl-drag rectangle (the available
  browser API cannot hold a modifier across its drag action), the full replicate/CE/hidden-series
  manual matrix, or the document-scroll fallback for a selection filling the entire viewport.
  Rectangle/identity/artifact rules and placement fallbacks remain covered by focused policy tests.
- Final automated verification at 0.27.1-alpha.21: `python scripts/preflight.py --no-cache`
  PASS, 4/4 stages and all 163 backend/frontend files/modules, 70.49 seconds total. The focused
  selection policy suite passes 23/23, including marker size, repeated vertices, subpixel boundaries,
  placement at 90/100/110% scaling, and the unavoidable document-scroll fallback.
- Application version/changelog advance to 0.27.1-alpha.21 under the repository's completed-work
  versioning policy. This is a review checkpoint, not a release/tag or merge.
- R6 remains open for independent review; these implementation observations do not self-close it.


## R7 shared-prefix verification - 2026-09-05

The comparison set is the visible selectable samples in the current Cycles plot, so even a single
selected point can use the family context. Helper/hidden traces are excluded; repeated quantities
from the same sample are deduplicated. The inspector header shows the shared prefix, rows and the
detail sample picker show suffixes, and full names remain on hover. Common numeric digits are
retained with the differing digits (e.g. 2436-1 and 2437-1); only redundant leading zero padding is
removed. Short generic prefixes, a single distinct plotted sample, and empty suffixes are unchanged.

Live Gen2C browser check: the Sample header showed `1012-BQV00000000000` and the selected row showed
`2436-1`; its title retained `1012-BQV000000000002436-1`. The chart remained expanded, clear of the
selected point, and inside the viewport. Focused policy tests pass 26/26. The application version
and changelog advance to 0.27.1-alpha.22 for this completed user-facing refinement.

Final R7 verification: `python scripts/preflight.py --no-cache` at 0.27.1-alpha.22 PASS, all 4 stages
and all 163 backend/frontend test files/modules, 67.34 seconds total. `git diff --check` PASS.
R6 and R7 remain pending independent review with the manual limits recorded above.


## R8 transition and replacement-gesture verification - 2026-09-05

The inspector retains the last complete figure (traces and layout together) for quantity requests
within the same cycle/sample context. It swaps to the new figure only when a matching response is
available, with loading feedback and retained error context. Retained plots cannot issue refinement
requests using the pending quantity; refinement responses are keyed to their original request.

Outside Ctrl clicks now clear the prior selected rows/shape without clearing construction vertices.
The incoming pointer-down still starts the replacement gesture. A nearest hit on an already selected
point retains the popup, and crossing the rectangle drag threshold dismisses old inspection.

Browser evidence using production components/controller with an isolated 18-second delayed transport:
Time -> Specific capacity retained one plot with Time axes and a 504 px popup while fetching; after
the response, the axes changed to Specific capacity, one plot remained, and height stayed 504 px.
Ctrl-click on the selected point retained the popup and first polygon vertex. Clicking a second,
outside point with Ctrl immediately closed it while retaining both vertices. A third vertex and
Ctrl release completed selection of cycles 1,2,3,4 and excluded outside cycle 5. In live Gen2C,
Ctrl-clicking the selected point retained detail, and Ctrl-clicking the heading dismissed it.
Temporary fixture files/tab were removed. Native held-modifier rectangle dragging remains within the
previously documented manual acceptance limits. Focused policy/refinement tests passed 38/38;
TypeScript and diff whitespace checks passed. Version/changelog advance to 0.27.1-alpha.23.

Final R8 verification at `0.27.1-alpha.23`: `python scripts/preflight.py --no-cache`
passed **4/4 stages and all 163 backend/frontend files/modules**, in **72.86 s**.
R6/R7/R8 are handed back for independent final review; the previously documented broader
manual matrix remains outstanding. No merge, tag, or release was performed.
