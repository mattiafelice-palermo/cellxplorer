# 026 — Metric columns and plot hover previews in the project explorer

**Status:** Implemented
**Branch:** `feature/projects-explorer-metrics`
**Scope:** backend (`routers/tree.py`, `routers/analyses.py`) + frontend (`api.ts`,
`ProjectsPage.tsx`, new pure module) + tests

## Goal

Two right-hand columns in the project explorer:

- **cells and replicate groups** — number of cycles, and maximum specific discharge capacity
  in mAh/g (raw mAh remains available in the tooltip);
- **analyses** — number of saved plots, with a hover preview of those plots.

## What exists (do not rebuild)

- `SourceFile.cycle_count` and `SourceFile.max_discharge_capacity_mah` are already cached
  columns, backfilled by `scanner.start_capacity_summary_backfill`. `capacity_summary_status`
  is `pending` / `ready` / `error` per file.
- `library.py::_cell_file_summaries` already rolls these up per cell with a single grouped
  query joining `Test → TestFile → SourceFile`. **Copy that query shape.**
- Saved plots live in `Analysis.spec["saved_plots"]`, so a plot count needs no extra query.
- `analysis_cache.load_latest_thumbnail(analysis_id, plot_id)` returns the most recent cached
  thumbnail for a plot. The warmup coordinator populates that cache.

## Locked design decisions

1. **Aggregates are one grouped query, not one per node.** `/api/tree` already loads every
   folder, cell, group and analysis in a single pass and is invalidated often. A per-node lookup
   would turn it into an N+1 and regress the whole page for everyone.
2. **Replicate groups report the mean of their member cells' values** — the mean of the member
   maxima for capacity, and the mean cycle count, rounded. A group's row is labelled so this is
   not misread as a raw maximum.
3. **`pending` and `error` render as "—", never as 0.** During an import a column full of zeros
   reads as data loss. A cell whose files are not all `ready` reports `null`.
4. **The columns are not sortable.** Sorting fights the manual `position` drag-ordering that the
   tree already supports, and reconciling the two is a larger feature than the columns.
5. **Folder rows do not show scientific metric rollups.** Summing cycle counts across unrelated
   cells and presenting one peak capacity for a heterogeneous subtree creates a number without a
   useful scientific interpretation. Folder rows keep their direct-item count; metric columns
   belong to cell and replicate-group rows.
6. **Projects and the Analysis Database use the same preview component.** The tree carries the
   same compact saved-plot index (id, name, tab, subtitle, quantity) as the Analysis Database
   summary. Both render `components/AnalysisPlotSummary.tsx`, including its list selection,
   loading state, click behavior, and 4:3 preview.
7. **Only the selected preview image is fetched.** The shared component reads the cached
   `variant=preview` asset through the existing latest-thumbnail endpoint when its hover card
   opens. Sweeping the pointer through the tree does not request every saved thumbnail.

## Tasks

### T1 — Backend aggregates in `/api/tree`

**File:** `backend/app/routers/tree.py`

New `cell_metrics(db, cell_ids) -> dict[int, CellMetrics]` using one grouped query over
`Test → TestFile → SourceFile`, returning per cell:

```python
{
    "cycle_count": int | None,
    "max_discharge_capacity_mah": float | None,
    "max_specific_discharge_capacity_mah_g": float | None,
    "summary_pending": bool,
}
```

`summary_pending` is true when the cell has files whose `capacity_summary_status` is not
`ready`; both metrics are `None` in that case rather than a partial total.

Specific capacity uses the same effective active-mass precedence as the Cell Database:
`override.active_mass_mg` → legacy active-mass metadata → source-file active mass. The mass and
metadata values are bulk-loaded for the complete cell set; this must not introduce per-cell
queries.

`cell_ref_dict` gains those four metric fields. `replicate_group_ref_dict` gains the same shape,
computed as the mean over member cells that have values, plus `member_count`.
Folder analyses and `project_dict` analyses gain `plot_count` from
`len(a.spec.get("saved_plots") or [])`. `folder_dict` does not carry metric rollups.

**Acceptance:** a cell with two files of 100 and 150 cycles reports 250; its max capacity is the
max of the two file maxima; a cell with a `pending` file reports `None` and `summary_pending`;
a group of three cells reports the mean of their maxima; a cell with 2 mAh maximum discharge and
10 mg effective active mass reports 200 mAh/g; an explicit mass override wins over legacy and
source mass.

### T2 — Compact plot index in `/api/tree`

**File:** `backend/app/routers/tree.py`

`analysis_ref_dict` includes `saved_plots`, using the same compact fields exposed by
`analyses.analysis_dict`: id, name, tab, subtitle, and quantity. This reads the already-loaded
analysis spec and issues no additional query.

**Acceptance:** plot order matches the saved spec; `plot_count` equals the compact index length;
an analysis without plots returns an empty index.

### T3 — Formatting rules as a pure module

**File (new):** `frontend/src/explorerMetrics.ts` + `frontend/tests/explorerMetrics.test.ts`

```ts
export function formatCycleCount(value: number | null): string;
export function formatCapacity(value: number | null): string;  // mAh, 1 dp; k for ≥ 10 000
export function formatSpecificCapacity(value: number | null): string;  // mAh/g, whole number
```

**Acceptance:** `null` → `"—"` whether or not pending; 0 cycles → `"0"` (a real zero is not
unknown); raw capacity rounds to one decimal; 12 500 mAh → `"12.5 k"`; specific capacity is
shown as a whole number.

### T4 — Columns in the tree

**File:** `frontend/src/pages/ProjectsPage.tsx`

A fixed-width right-hand gutter on every row, before the existing action buttons, so the
columns line up down the tree regardless of indentation; the label column truncates rather than
pushing the numbers around. Cells and replicate groups show cycles + maximum specific discharge
capacity; analyses show the plot count; folders show neither. Raw maximum discharge capacity
remains in the cell/group tooltip. A replicate group's numbers carry a tooltip naming them as an
average over N cells and using the same units as the visible column.

Visibility is a **Show metrics** switch in the View menu added by spec 025, persisted with the
other view preferences. Default on.

Inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md);
numbers are dimmed, tabular, and smaller than the row label so they read as metadata.

**Acceptance:** columns align across depths; long names truncate with an ellipsis; the page body
never scrolls horizontally; turning the switch off removes the gutter entirely.

### T5 — Shared plot hover preview

**Files:** `frontend/src/components/AnalysisPlotSummary.tsx`,
`frontend/src/components/AnalysisDatabaseTable.tsx`, `frontend/src/pages/ProjectsPage.tsx`

The Analysis Database's plot-count/preview UI lives in the shared component. Both surfaces render
that exact component. Hovering opens the saved-plot list and selected 4:3 preview; selecting a
different list item updates the preview, and clicking it opens that saved plot.

States and timing remain owned by the shared component: loading text while the current preview is
requested, a cache-miss message when warmup has not rendered it, and no hover for zero plots.

**Acceptance:** the Projects and Analysis Database hover cards are visually and behaviorally
identical because there is only one implementation; repeat hovers reuse the React Query cache.

## Implementation order

T1 → T2 → T3 → T4 → T5.

## Verification

- `python -m unittest tests.test_tree_router tests.test_analysis_lifecycle`
- `node --test frontend/tests/explorerMetrics.test.ts`
- `npx tsc --noEmit`, `npx vite build`.
- Manual: confirm the mAh/g column agrees with the Cell Database for cells with source, legacy,
  and overridden active mass, and that a cell mid-import shows "—" rather than 0.

## Environment note

Mantine dropdown/hover surfaces (`Menu`, `Popover`, `HoverCard`) do **not** open under the
Browser-pane automation used to verify specs 025–026 — the pre-existing "Expand options" menu
fails the same way. The View menu and the hover card must therefore be checked by hand; the
underlying data and the tree rendering can be verified by driving preferences through
`localStorage` and reading the DOM.
