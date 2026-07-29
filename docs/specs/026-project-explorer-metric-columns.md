# 026 — Metric columns and plot hover previews in the project explorer

**Status:** Implemented
**Branch:** `feature/projects-explorer-metrics`
**Scope:** backend (`routers/tree.py`, `routers/analyses.py`) + frontend (`api.ts`,
`ProjectsPage.tsx`, new pure module) + tests

## Goal

Two right-hand columns in the project explorer:

- **cells and replicate groups** — number of cycles, and maximum discharge capacity;
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
5. **Folder rows show a rollup of everything beneath them** (their own cells plus all
   descendants', deduplicated by cell id). A collapsed folder that says nothing about its
   contents makes Collapse all tidy but useless.
6. **The hover preview uses a dedicated endpoint, not the existing artifact lookup.**
   `POST .../thumbnail/lookup` requires a client-computed plot `signature`; reproducing that
   derivation in the Projects page would duplicate non-trivial logic that must stay in step
   with the analysis engine. A read-only `GET /api/analyses/{id}/plot-thumbnails` returning the
   latest cached thumbnails is what a preview actually wants.
7. **Six thumbnails are fetched eagerly, the rest lazily after them.** Hovering across a folder
   of analyses must not fire an unbounded burst; but nothing is hidden behind a "+N more" —
   the remainder streams in.

## Tasks

### T1 — Backend aggregates in `/api/tree`

**File:** `backend/app/routers/tree.py`

New `cell_metrics(db, cell_ids) -> dict[int, CellMetrics]` using one grouped query over
`Test → TestFile → SourceFile`, returning per cell:

```python
{"cycle_count": int | None, "max_discharge_capacity_mah": float | None, "summary_pending": bool}
```

`summary_pending` is true when the cell has files whose `capacity_summary_status` is not
`ready`; both metrics are `None` in that case rather than a partial total.

`cell_ref_dict` gains those three fields. `replicate_group_ref_dict` gains the same shape,
computed as the mean over member cells that have values, plus `member_count`.
Folder analyses and `project_dict` analyses gain `plot_count` from
`len(a.spec.get("saved_plots") or [])`. `folder_dict` gains a `metrics` rollup over its own
cells and its children's rollups, deduplicated by cell id.

**Acceptance:** a cell with two files of 100 and 150 cycles reports 250; its max capacity is the
max of the two file maxima; a cell with a `pending` file reports `None` and `summary_pending`;
a group of three cells reports the mean of their maxima; a folder reports the union of its own
and its descendants' cells, counting a cell filed in both places once.

### T2 — Latest-thumbnail endpoint

**File:** `backend/app/routers/analyses.py`

```
GET /api/analyses/{analysis_id}/plot-thumbnails?limit=<n>  →
  {"plots": [{"plot_id": str, "title": str, "thumbnail": str | null}], "total": int}
```

Reads `spec["saved_plots"]` for identity and `analysis_cache.load_latest_thumbnail` for the
image. A plot the warmup coordinator has not reached yet returns `thumbnail: null` — the
caller shows a placeholder, never an error.

**Acceptance:** returns every saved plot in spec order; `limit` slices from the front and
`total` still reports the full count; an analysis with no saved plots returns an empty list.

### T3 — Formatting rules as a pure module

**File (new):** `frontend/src/explorerMetrics.ts` + `frontend/tests/explorerMetrics.test.ts`

```ts
export function formatCycleCount(value: number | null, pending: boolean): string;
export function formatCapacity(value: number | null, pending: boolean): string;  // mAh, 1 dp; k for ≥ 10 000
export function eagerAndLazyPlots<T>(plots: T[], eager: number): { eager: T[]; lazy: T[] };
```

**Acceptance:** `null` → `"—"` whether or not pending; 0 cycles → `"0"` (a real zero is not
unknown); capacity rounds to one decimal; 12 500 mAh → `"12.5 k"`; the split is stable when
there are fewer plots than the eager count.

### T4 — Columns in the tree

**File:** `frontend/src/pages/ProjectsPage.tsx`

A fixed-width right-hand gutter on every row, before the existing action buttons, so the
columns line up down the tree regardless of indentation; the label column truncates rather than
pushing the numbers around. Cells, replicate groups and folders show cycles + capacity;
analyses show the plot count. A replicate group's numbers carry a tooltip naming them as an
average over N cells.

Visibility is a **Show metrics** switch in the View menu added by spec 025, persisted with the
other view preferences. Default on.

Inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md);
numbers are dimmed, tabular, and smaller than the row label so they read as metadata.

**Acceptance:** columns align across depths; long names truncate with an ellipsis; the page body
never scrolls horizontally; turning the switch off removes the gutter entirely.

### T5 — Plot hover preview

**File:** `frontend/src/pages/ProjectsPage.tsx`

Hovering an analysis row's plot count opens a `HoverCard` with the plot thumbnails, using the
same image presentation as the analysis page. Fetched through React Query so repeat hovers are
free, with `openDelay` so sweeping the pointer down the tree fetches nothing.

States: in flight → skeletons; `thumbnail: null` → a placeholder tile with the plot title and a
note that it has not been rendered yet; zero saved plots → the hover does not open at all.

**Acceptance:** hovering repeatedly issues one request; moving quickly across several analyses
issues none; an analysis whose thumbnails are not cached shows placeholders, not an error.

## Implementation order

T1 → T2 → T3 → T4 → T5.

## Verification

- `python -m unittest tests.test_tree_router tests.test_analysis_lifecycle`
- `node --test frontend/tests/explorerMetrics.test.ts`
- `npx tsc --noEmit`, `npx vite build`.
- Manual: confirm a folder's rollup equals the sum of its descendants, and that a cell mid-import
  shows "—" rather than 0.

## Environment note

Mantine dropdown/hover surfaces (`Menu`, `Popover`, `HoverCard`) do **not** open under the
Browser-pane automation used to verify specs 025–026 — the pre-existing "Expand options" menu
fails the same way. The View menu and the hover card must therefore be checked by hand; the
underlying data and the tree rendering can be verified by driving preferences through
`localStorage` and reading the DOM.
