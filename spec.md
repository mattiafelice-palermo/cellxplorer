# Build: Battery-Cycling Data Management & Analysis App

You are building a single-user desktop-style application for experimental
battery researchers to organize, analyze, compare, and revisit Neware
battery-cycling data. The current directory contains an existing Python
library that reads Neware binary files. Your job is to build the application
around it.

## STEP 0 — Before writing any application code

1. Explore the existing Python library in this directory. Read its source,
   its public API, its data structures, and any tests or examples. Do NOT
   assume its interface — discover it. Produce a short written summary of:
   - How to open/parse a Neware file and what object(s) you get back
   - How to access raw time-series data (voltage, current, time, etc.)
   - How to get derived per-cycle quantities (charge/discharge capacity,
     coulombic efficiency, etc.)
   - What metadata the files/headers expose (cycler, channel, dates, etc.)
   - Whether files carry any stable cell/test identifier
2. Then present me with: (a) that summary, (b) a concrete data schema, and
   (c) a phased build plan. WAIT for my confirmation before building beyond
   the scaffold. Do not scaffold the whole app in one shot.

## The conceptual model — read this carefully, it is the heart of the app

The single most important architectural rule: **containment never does the
work of reference.** Organizational structures hold *references* to data,
never copies, and never implicit scope. Violating this rule is the main
failure mode — guard against it everywhere.

### Identity layer (the canonical Library — one flat store)

There is ONE canonical library where data actually lives. Everything else
is a view of references into it.

- **SourceFile** — one Neware binary file. Identity = content hash (not
  path). The network path is a mutable *location attribute*. Store: hash
  (unique), current path, size, cycler/channel, dates, parse status.
- **Cell** — the physical cell; the scientific object users think in.
  Carries structured metadata. This is the primary unit of selection in
  the UI.
- **Test** — one cycling procedure on one cell, composed of an *ordered
  list* of one or more SourceFiles (handles formation-in-one-file,
  cycling-in-another, restarts, channel moves). Stitches its files into
  one continuous cycle-numbered record with explicit segment boundaries.

Relationships: File → belongs to one Test; Test → belongs to one Cell;
Cell → many Tests. A Cell may be referenced by many projects, groups, and
analyses at zero cost.

Parsed time-series and derived per-cycle properties are NOT user-facing
entities. They are **caches**, keyed by (file hash, parser version,
calculation version), stored as Parquet on local disk, regenerable from
source at any time.

### Organization layer (views over the library — ONE tree only)

- **Folder** — a navigation node. Contains folders, projects, and
  (optionally) filed analyses. It holds NO cell references, NO groups, and
  imposes NO data scope. Folders organize; they never compute. Filing an
  analysis under a folder must NEVER mean the analysis auto-includes cells
  beneath that folder. Hold this line in the UI copy: a folder *contains*
  an analysis, it never *feeds* one.
- **Project** — a working context. Contains cell references, groups, and
  (optionally) filed analyses. Roughly "a campaign or activity."
- **Group** — a named, ordered set of cell references with a display label.
  This is the explicit **replicate** concept (e.g. "Formulation A" = 3
  cells). Keep it THIN: just a named set of references + label + order. No
  enforced metadata equality, no nesting, no lifecycle. A cell may belong
  to many groups.

There is exactly ONE hierarchy in the whole system: this data tree. It
earns its hierarchy because experimental structure is genuinely, stably
nested. Nothing else gets a hierarchy.

### Analysis layer (recipes that select freely from the library)

- **Analysis** — a persistent *specification* (a recipe), NOT a one-off
  plot. It stores: selected cells/groups (as explicit frozen references),
  per-analysis exclusions (cells masked in THIS analysis only, with
  optional reason), cycle ranges, derived quantities, normalization rules,
  filters, statistics/dispersion choice, plot config, labels, and
  provenance (the file hashes + parser/calc versions used when last
  computed).

Analysis rules:
- An analysis selects cells **by identity from anywhere in the library**.
  Where it is filed has ZERO effect on what data it can reach.
- Filing is OPTIONAL. An analysis may be filed at any node in the data
  tree (folder or project) for co-location convenience, OR filed nowhere
  at all (a homeless cross-cutting analysis lives only in the library and
  is found via the global index). Never force the user to invent an empty
  container just to park a comparison.
- Selection tools (browse tree, filter by metadata, filter by tag, search)
  are ways of *building* the explicit reference list. They are selection
  gestures, not live queries. The stored list is frozen.
- Optionally record the query that produced a selection as a **refresh
  suggestion**: a "Refresh selection" button re-runs it, shows a diff
  ("+3 cells, −1"), and applies only on user confirmation.
- **THE INVARIANT: an analysis never changes unless the user changes it.**
  Everything reactive is a badge, never a silent mutation.

### Flat faceted layer for organizing analyses (NOT a second tree)

- **Global Analysis Index** — a flat, searchable, filterable list of every
  analysis regardless of where (or whether) it is filed. This is the
  PRIMARY way analyses are organized.
- **Tags** — free labels on cells AND on analyses, drawn from a centrally
  registered tag list (creating a new tag is deliberate: confirm step +
  autocomplete against existing tags). For flagging/finding, not for
  encoding relationships.
- **Collections** — optional named sets an analysis can belong to several
  of at once (e.g. "Paper X", "Q1 review"). FLAT, many-to-many, NO nesting.
  Do not make collections nestable — analyses are cross-cutting and want
  faceted (many overlapping labels), not hierarchical (one home),
  classification.

Division of labor to reflect in help text: *filter on it → metadata;
flagging something unexpected → tag; how you navigate data → folder; a body
of work → project; cells you'll plot together → group; grouping analyses by
purpose → collection.*

## Reproducibility & change semantics (implement exactly)

- File moved on drive → relink automatically by hash (background/on-demand
  scan). Until relinked, analysis still opens from cache with "source
  offline" badge.
- File content changed (hash differs) → badge "source data changed since
  computed"; show cached result + explicit recompute button. NEVER silently
  recompute.
- Cell removed from a project → irrelevant to analyses (they reference cells,
  not membership).
- Cell deleted → soft-delete only; analyses show it "archived", keep working
  from cache.
- New cells added to a project → existing analyses untouched; refresh
  suggestion is the opt-in.
- Parser/calc code updated → versioned caches keep old results reproducible;
  analysis shows "computed with vX; vY available — recompute?" as a
  per-analysis choice with a visible version stamp.

## Statistics on replicates (implement exactly)

Aggregation is a RENDERING, never a stored dataset. Always compute per-cell
cycle-level series first (from cache), then compute mean/SD (or chosen
dispersion) at analysis time, per cycle index, over group members minus
exclusions. Requirements:
- Replicates die at different cycle counts: track n(cycle); only show
  mean±band where n ≥ threshold (default 2); fade band where n drops.
- Default alignment by cycle index; offer alignment by check/RPT cycles.
- Every aggregate view has a one-click "show individual cells" toggle (thin
  lines behind the mean). This is how outliers are found → how exclusions
  happen → the daily loop.
- Dispersion choice (SD / SEM / min–max / percentile) is part of the
  persisted analysis spec.

## Tech stack (use this)

- Backend: Python, FastAPI, SQLAlchemy over SQLite (local, single file).
  Wrap the existing Neware library behind a parsing/service layer — never
  call it directly from route handlers.
- Caches: Parquet (pyarrow/pandas), keyed by hash + parser/calc versions,
  on local disk. Raw Neware files stay on the network drive; never copy them.
- Background scanning/parsing: simple thread pool or FastAPI background
  tasks (single-user — no Celery).
- Frontend: React + Vite + TypeScript, served as static files by FastAPI.
  Mantine for UI (tree, tables, modals), TanStack Query (server state),
  TanStack Table (cell tables), Plotly for charts (client-side plotting from
  JSON the API returns). All current UI work follows the canonical visual
  contract in `docs/agent-knowledge/visual-style-guide.md`; explicit locked
  decisions in a feature spec may override it narrowly.
- Persistence shape: ~10 tables — files(hash unique), cells, tests,
  test_files(ordered), metadata fields + cell_metadata (or JSONB),
  tags + cell_tags + analysis_tags, folders(parent_id), projects(folder_id),
  project_cells, groups(project_id) + group_cells, collections +
  analysis_collections, analyses(spec JSON, provenance JSON, optional
  folder_id/project_id — nullable, so analyses can be homeless).
  Store the analysis spec as a versioned JSON document, not fully normalized.
- Packaging: run locally (uvicorn + built frontend at localhost) for v1.
  Leave a clean seam for a Tauri wrapper later; don't build it now.

## Target workflow (build toward this)

Import (scan folders → hash → parse headers → inbox of unregistered files →
register File→Test→Cell with minimal input, no forced classification before
viewing) → Organize (project, metadata via table paste, groups) → Analyze
(pick groups, choose quantity, mean±SD, normalize, exclude an outlier in-
this-analysis-only with reason) → Save (spec + provenance) → Cross-project
comparison (filter library by tag across projects, file it nowhere or at a
common folder) → Reopen a year later (renders identically from versioned
cache, shows "new data"/"newer parser" badges, duplicate-and-recompute to
update while leaving the record intact).

## Constraints

- No forced classification before data can be viewed (plot a cell seconds
  after import).
- No hidden inheritance, no implicit scope, no analysis that changes
  unexpectedly.
- Never duplicate raw datasets. Reference by identity everywhere.
- Keep it understandable for a non-database-specialist researcher.
- Must scale from a few cells to thousands of files over years.

## Build phases (propose your own refinement in Step 0)

1. Scaffold: FastAPI + SQLite + Vite/React, health check, DB migrations.
2. Identity layer: file scan/hash/parse, File→Test→Cell registration,
   Parquet cache with version keys.
3. Organization: data tree (folders/projects), cell references, metadata,
   tags, groups.
4. Analysis engine: spec model, explicit selection, exclusions, per-cell
   series + on-the-fly aggregation, provenance/version stamping.
5. Frontend: tree navigator, cell table + metadata editor, group builder,
   analysis editor, Plotly canvas with individual-cell toggle.
6. Faceted layer: global analysis index, collections, refresh-selection
   diff, change/recompute badges.

Start with Step 0. Show me the library summary, schema, and plan, then wait.

## Analysis spec format
{
  "spec_version": 3,
  "id": "an_7f3a9c",
  "title": "Capacity fade, Formulation A vs B",
  "created_at": "2026-07-04T10:30:00Z",
  "modified_at": "2026-07-04T10:30:00Z",

  "filing": {
    "node_type": "project",
    "node_id": "proj_gen2_activityC",
    "note": "null node_id + node_type='none' = homeless (library-only)"
  },

  "selection": {
    "entries": [
      { "kind": "group", "ref_id": "grp_formA", "label_override": null },
      { "kind": "group", "ref_id": "grp_formB", "label_override": null },
      { "kind": "cell",  "ref_id": "cell_KX041", "label_override": "A (repeat)" }
    ],
    "exclusions": [
      { "cell_id": "cell_A_rep2", "reason": "suspected leak", "excluded_at": "2026-07-04T10:28:00Z" }
    ],
    "refresh_suggestion": {
      "query": { "tags_all": ["reference-cell"], "metadata": { "electrolyte_gen": "Gen2" } },
      "last_applied_at": "2026-07-04T10:25:00Z"
    }
  },

  "computation": {
    "quantity": "discharge_capacity",
    "x_axis": "cycle_index",
    "cycle_range": { "start": 1, "end": null },
    "cycle_alignment": "cycle_index",
    "filters": [
      { "kind": "exclude_check_cycles", "params": { "every_n": 25 } }
    ],
    "normalization": {
      "kind": "reference_cycle",
      "params": { "cycle": 3 }
    }
  },

  "aggregation": {
    "mode": "group_mean",
    "dispersion": "std",
    "min_n_for_band": 2,
    "fade_low_n": true
  },

  "presentation": {
    "show_individual_cells": true,
    "series_style": { "grp_formA": { "color": "#2E86AB" }, "grp_formB": { "color": "#E63946" } },
    "axis_labels": { "x": "Cycle", "y": "Discharge capacity (mAh)" },
    "legend": true
  },

  "provenance": {
    "computed_at": "2026-07-04T10:30:00Z",
    "parser_version": "1.3.0",
    "calc_version": "1.1.0",
    "sources": [
      { "cell_id": "cell_A_rep1", "test_id": "test_991", "file_hashes": ["a3f9...", "b1c2..."] },
      { "cell_id": "cell_A_rep2", "test_id": "test_992", "file_hashes": ["c8d4..."] }
    ]
  }
}
