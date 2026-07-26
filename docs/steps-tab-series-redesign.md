# Steps tab series-builder architecture

The Steps tab is implemented around explicit `(cell, protocol segment)` series. This document
records the data contract and the decisions that must remain stable when the tab is extended.

## What exists today (committed, working, verified)

- `backend/app/services/step_blocks.py` — block segmentation + `per_block` aggregation. Two modes:
  `union` (whole selected block per occurrence) and `contiguous` (each uninterrupted run). Verified
  on cell 12 (`JR_ME_LPMol_511_ALAVA-1-4FC`), fast-charge block 84–90 → 38 occurrences, CV time
  0.110→0.045 h. Tests: `tests/test_step_blocks.py` (10, passing).
- `analysis_engine.compute_steps` — one series per explicit `(cell, segment)` pair, matched to
  each source file by protocol signature. Older specs with a single global `segment_id` are
  expanded to every selected cell for compatibility.
- `POST /api/analyses/{id}/steps` — cached under kind `"steps"`.
- Frontend `frontend/src/components/StepsPlotCard.tsx` — `StepsPlotCard` + `StepsSettings`, reusing
  the exported `PlotHeader`/`PlotStylePanel`/`currentPlotStyle`/`plotPalette`/`tracesToColumns`/
  `downloadDataExport` from `AnalysisPage.tsx`. Its canonical trace and layout builders are also
  used by the live card and saved-plot thumbnail path; saved previews must call `POST /steps`, not
  the cycle-compute endpoint. Tab wired into `AnalysisPage.tsx` (tab key `"steps"` in `api.ts`
  ANALYSIS_TAB_KEYS, tab def, sidebar `StepsSettings`, `Tabs.Panel value="steps"`).

## Series model

The steps tab's unit of a **line is a (cell, segment) pair**, not a cell. This lets you plot the
same cell under two segments, or two cells whose FC segments have *different* step structures
(chemically-similar cells on different protocols), as separate comparable lines.

### 1. Explicit series list (replaces the single global segment)

New spec shape — **split compute inputs from display state so toggles don't invalidate the cache**:

```
spec.computation.steps = {              # affects compute + cache key
  series: [ { id: str, cell_id: int, segment_id: str }, ... ],
  mode: "union" | "contiguous",
}
spec.presentation.steps_view = {        # display only, NOT in cache key
  quantity: "time" | "cv_charge_time" | "voltage" | "capacity" | "block_duration",
  direction: "charge" | "discharge" | "total",
  include_rest: bool,
  x_axis: "occurrence" | "cycle" | "time",
}
```

Why the split: `computation` is in `analysis_cache._scientific_spec` (so `series`+`mode` correctly
invalidate the block cache); `presentation` is not (except `hidden_protocol_segment_ids`), so
quantity/direction/x-axis toggles are pure rendering and must live there to avoid a recompute per
click. Confirm `presentation` is still excluded from `_scientific_spec` when you start.

**compute_steps rework:** iterate the explicit `series` list instead of the selection units.
Resolve each series' cell from the analysis selection (build `cell_by_id` from `resolve_selection`).
For each series: get the cell's file protocol signature, look up the segment's target
`step_indices` for that signature, `_stitch_raw` → `per_block`. No-match → skip with a badge.
Emit **all three x candidates per series so the frontend switches axis without refetching**:

```
cell_series entry = {
  series_id, cell_id, cell_name, segment_id, segment_name,
  label: f"{cell_name} — {segment_name}",
  x_occurrence: [...], x_cycle: [...], x_time: [...],
  quantities: { <BLOCK_COLUMNS>: [...] },
  n_blocks,
}
```

Drop `aggregates`/replicate grouping entirely for steps (see decision 1). Result `type: "steps"`.

### 2. Quantity control on top, with a three-way direction selector

Move the quantity control **above** the plot settings. Model:

- Quantity dropdown (base): **Time, CV charge time, Voltage, Capacity, Block duration**.
- Direction segmented control **charge / discharge / total** — shown only for **Time** and
  **Voltage** (capacity keeps charge/discharge only; CV time, block duration have no direction).
- **Include rest** checkbox — shown only for **Time + total**.

Frontend maps (base, direction, include_rest) → a backend column:

| base | direction | column |
|---|---|---|
| Time | charge | `charge_time_h` |
| Time | discharge | `discharge_time_h` |
| Time | total, rest on | `block_duration_h` |
| Time | total, rest off | `total_time_h` |
| CV charge time | — | `cv_charge_time_h` |
| Voltage | charge | `mean_charge_voltage_v` |
| Voltage | discharge | `mean_discharge_voltage_v` |
| Voltage | total | `mean_voltage_v` |
| Capacity | charge | `charge_capacity_mah` |
| Capacity | discharge | `discharge_capacity_mah` |
| Block duration | — | `block_duration_h` |

Rationale for keeping "total" off capacity: charge and discharge capacity are physically distinct,
not two halves of a sum — a "total capacity" number would be untrustworthy. (User agreed.)

`active_time_h` is intentionally not part of the model. The total-time selector already expresses
both useful meanings: elapsed block duration when rest is included, and summed charge plus
discharge phase time when it is excluded.

### 3. X-axis dropdown: occurrence / cycle / time

Replace the occurrence/cycle segmented toggle with a **3-way dropdown adding "time"**. Time =
elapsed hours at the block's start, relative to the cell's raw start (`start_time_h`). Occurrence
compares cleanly across protocols (both start at 1); cycle and time put differing protocols on
different scales — that's fine, keep all three.

## Backend block columns

Add three columns so the view controls have data:
- `total_time_h` = `charge_time_h + discharge_time_h` (excludes rest).
- `mean_voltage_v` = mean of `voltage_v` over all block records (overall, no direction mask).
- `start_time_h` = `(block first timestamp − cell raw first timestamp) / 3600`. Compute the cell
  raw start once from the full `df["timestamp"].min()` inside `per_block` before segmentation, then
  per block use its own `timestamp.min()`.

`BLOCK_COLUMNS` and `per_block` expose all three. `BLOCK_QUANTITIES` was removed because the
frontend owns the user-facing base-quantity and direction mapping.

## Frontend build

- **Series builder panel** (sidebar, replacing the single segment picker in `StepsSettings`): a list
  of (cell, segment) rows with add/remove. Cell dropdown from the analysis selection cells; segment
  dropdown from `spec.protocol_segments` (optionally filter to segments whose targets include the
  cell's protocol signature). Each row needs a stable `id` for React keys. "Add series" appends a
  row defaulting to the first cell + first segment.
- **Quantity + direction + include-rest + x-axis** controls on top of the plot settings, writing to
  `spec.presentation.steps_view`.
- **StepsPlotCard**: one trace per series (no bands), `y` = mapped column, `x` = `x_<axis>`, name =
  series label. Reuse the existing shell (`PlotHeader`, `PlotStylePanel` scope `"steps"`).
- `useStepsResult` query key must depend only on `series` + `mode` + `selection` (NOT the view
  state), so quantity/x-axis/direction toggles never refetch.

## Decisions locked with the user

1. **No replicates in steps for now.** Each (cell, segment) is its own line; drop the band. Prevent
   replicate creation across differing protocols *later* — not this pass.
2. Legend label `cell — segment`; any (cell, segment) combo allowed, including same cell twice with
   different segments.
3. X-axis is a dropdown of occurrence / cycle / **time** (not a two-way toggle).

## Testing hygiene (important)

Browser verification writes to the shared dev DB at `~/.cellxplorer` (port 8642 = the user's running
app, 8643 = dev). **Use the "Test" analysis (id 8, single cell = 511, already has an "FC" segment)**
for UI checks, and **snapshot its spec to a file before touching it** (a page reload loses in-memory
JS snapshots — this bit us once). Restore from the file after. To point a production build at the
dev backend for testing, copy `dist/assets/index-*.js` to `.bak` and `sed 's/127.0.0.1:8642/…8643/'`,
then restore the `.bak` and stop the preview server when done.

## Verification targets

- `per_block` new columns: unit test with known inputs.
- `compute_steps`: build a spec with two series (same cell, or two cells) and assert two labelled
  cell_series with the right `n_blocks` and all three x arrays; run through `POST /steps` (rename any
  temp script off `http.py` — it shadows stdlib `http`).
- Browser: Test analysis → Steps tab → add two series → switch quantity/direction/x-axis with no
  refetch (check the network tab) and no console errors → restore spec.
- Full suites: `python -m unittest discover -s tests -q` and `npx tsx --test frontend/tests/*.test.ts`.
