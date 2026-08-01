# 035 — User experience and workflow optimization

**Status:** Plan — parent specification  
**Implementation:** Implement only through the child specifications listed below.  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Depends on:** None. Create the implementation branch from the then-current `main` when implementation begins.  
**Shared branch:** `feature/spec-035-user-experience-optimization`  
**Review document:** None. Each child has its own review; the parent closes through the final integration matrix.

All UI work inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Why this is a parent specification

A first-use review exposed several independent sources of friction:

- navigating the custom import browser can accidentally select an entire folder;
- the path bar does not behave like Windows Explorer;
- redirected Windows Desktop/Documents/Downloads locations can appear unavailable;
- large selections are not made sufficiently explicit;
- three import stages show generic spinners without saying what is happening;
- one exact duplicate can block a very large otherwise-valid batch;
- the import pipeline repeats avoidable work and processes previews too eagerly;
- Cell Database page-scoped select-all does not explain that additional matching cells exist;
- Cell Database selections cannot directly start an analysis;
- replicate groups cannot be created from an analysis workflow;
- plot presets are not consistently scoped to the plot type that can use them.

These changes share product principles but cross filesystem browsing, import performance,
background progress, database identity, analysis persistence, folder references, and plot settings.
One implementation would be too large for the intended coding agent. This parent locks the shared
decisions; each `035.x` file is one bounded implementation and review checkpoint.

## Authoring baseline and repository drift

This package was authored against the repository state available when the specification was
written. It is intentionally independent from every other numbered feature specification.

Before implementing each child:

1. create or continue the dedicated Spec 035 implementation branch from the then-current `main`;
2. verify every grep-able anchor and current component owner before editing;
3. follow current repository code and tests where filenames or ownership moved;
4. preserve all unrelated features and scientific/provenance invariants already present on `main`;
5. do not copy commits, implementation records, reviews, or branch history from another feature
   branch into Spec 035.

A moved component is not a reason to broaden the child. Follow the current owner while preserving
the child’s locked behavior and scope.

## Existing architecture to preserve

- `SourceFile → Test → Cell` remains the canonical scientific hierarchy.
- Exact source identity is checksum-based.
- Original source files remain at their registered paths.
- SQLite is canonical; scientific Parquet caches are regenerable.
- Replicate groups and folders hold references to Cells; they do not duplicate or own scientific
  data.
- An Analysis owns one shared sample set. Saved plots preserve their own selection visibility.
- Scientific calculations and cache construction remain backend-owned.
- Source checksum work, parsing, and cache building stay off list endpoints and ordinary UI
  rendering.
- `AnalysisPage.tsx` is sensitive. Extract one coherent responsibility at a time; do not broadly
  refactor it.
- The import pipeline already uses `backend/app/services/background_jobs.py` and background cache
  jobs. Reuse those patterns.
- Existing multi-source continuation identity and import semantics must remain intact. UX changes
  must not silently discard, reorder, or skip a continuation source.

## Locked shared decisions

### 1. Navigation and recursive selection are different actions

- A folder row is for navigation.
- A folder checkbox is the only control that recursively selects or deselects that folder.
- Trying to open a folder must never select hundreds of files.
- File-row selection keeps normal multi-selection behavior.
- Keyboard users have an equally explicit navigation and selection path.

### 2. Windows familiarity is preferred

- Address-bar segments are clickable.
- Manual path entry remains available.
- Desktop, Documents, and Downloads use Windows Known Folder resolution rather than
  `Path.home() / "<name>"`.
- OneDrive and corporate redirection are supported without adding a third-party dependency.

### 3. Large imports require an explicit consequence

- More than 30 selected files triggers a persistent warning.
- The warning states file count, total size, and contributing roots.
- The main action repeats the exact count, for example `Continue with 214 files`.
- This is a warning, not a hard limit.
- A time estimate is approximate and omitted when there is insufficient local history.

### 4. Progress must be truthful

- Do not display a fabricated percentage when the total is unknown.
- Folder discovery may be indeterminate while showing roots scanned and files found.
- Inspection and registration use determinate file-count progress because their totals are known.
- Show the current file and the actual stage.
- ETA is shown only after enough measured work exists and is presented as an approximate range.
- Blocking registration and background scientific-cache preparation are different states.

### 5. Duplicate identity remains fail-safe

- Exact duplicates are never imported as new Cells.
- A possible update is not an exact duplicate and remains a separate, explicit state.
- In separate-cell mode, exact duplicates are excluded from submission and do not block valid
  files.
- In continued-cell mode, a duplicate/registered source remains a blocking chain finding until the
  user removes it; never silently shorten a continuation chain.
- The backend performs final duplicate and checksum validation even if the UI already inspected the
  file.

### 6. Concurrency is bounded

- Filesystem work may use conservative thread pools.
- No SQLAlchemy Session or ORM instance is shared with worker threads.
- SQLite writes and the final relational transaction remain serialized.
- Return order remains the same as input order even when workers finish out of order.
- Worker counts are small and deterministic; do not use unbounded parallelism.

### 7. Repeated work is removed only when integrity is preserved

- Inspection metadata may be reused after a final checksum proves the file is unchanged.
- Preview generation may reuse an inspected checksum after a stat-fingerprint check.
- Final registration keeps a content-integrity check and transactional duplicate enforcement.
- Automatically parsing every staged file only to show unused previews is prohibited.

### 8. Import success is not cache readiness

- The blocking import flow ends after relational registration commits and cache work is queued.
- The user is told that scientific data are preparing in the background.
- Cache failures appear through existing source/activity status; they do not retroactively claim
  that Cell registration failed.

### 9. Replicate creation from an analysis is persistent

- It creates a real library `ReplicateGroup`.
- The selected direct Cell entries are replaced by that group in the current Analysis.
- Folder replacement is explicit and limited to named folder-reference pairs.
- Cells remain in the Cell Database and in every folder not explicitly changed.
- The relational group creation, folder changes, and Analysis-spec replacement are atomic.

### 10. Plot presets have an explicit scope

- A family preset is offered only for its plot family.
- A universal preset contains visual properties only.
- Universal presets cannot overwrite axis titles, axis ranges, ticks, or family-specific
  presentation fields.
- Existing presets remain loadable through documented compatibility normalization.

### 11. Page selection and full-result selection are distinct

- The Cell Database header checkbox remains page-scoped and must not silently select cells on other
  pages.
- When the full current page is selected and additional matching cells exist, the UI explicitly
  offers selection of the complete current search/filter result set.
- The escalation action selects only cells matching the current search and column filters, never
  hidden filtered-out cells.
- Counts and wording distinguish the current page from the complete matching result set.
- Existing bulk actions continue to consume the one explicit selected-id set.

## Child specifications and dependency graph

| Child | Purpose | Depends on |
|---|---|---|
| [035.1](035.1-import-browser-folder-interaction.md) | Separate folder navigation from recursive selection | Parent |
| [035.2](035.2-import-browser-clickable-breadcrumbs.md) | Clickable path segments plus retained manual path entry | 035.1 |
| [035.3](035.3-windows-known-folder-resolution.md) | Resolve redirected Windows quick-access locations | Parent |
| [035.4](035.4-large-import-selection-warning-and-estimate.md) | Warn on large batches and show size/available estimate | 035.1, 035.2 |
| [035.5](035.5-staged-file-removal-and-duplicate-handling.md) | Remove staged files and prevent one duplicate blocking a batch | 035.4 |
| [035.6](035.6-import-progress-ui.md) | Explain and report all three import stages | 035.4, 035.5 |
| [035.7](035.7-import-inspection-concurrency-and-deduplication.md) | Bounded I/O concurrency and safe reuse of inspection work | 035.6 |
| [035.8](035.8-lazy-import-preview-and-cache-handoff.md) | Active-file-only preview and explicit background-cache handoff | 035.6, 035.7 |
| [035.9](035.9-create-analysis-from-selected-cells.md) | Start a populated Analysis from Cell Database selection | Parent |
| [035.10](035.10-create-replicate-group-from-analysis.md) | Create and place a persistent replicate group from an Analysis | 035.9 |
| [035.11](035.11-plot-type-scoped-style-presets.md) | Scope preset storage, editing, and application by plot family | Parent |
| [035.12](035.12-import-browser-select-shown-and-resizable-panes.md) | Clarify import and Cell Database selection scope; resize import-browser panes | 035.1, 035.2 |

Implement children on the one shared branch. Children 035.1–035.11 follow the original numeric
sequence. Child 035.12 is a corrective follow-up discovered after 035.1 implementation and may be
implemented at the next clean checkpoint without waiting for unrelated later children; finish the
currently active child checkpoint first and do not mix both implementations in one commit.

Each child receives:

1. one focused implementation commit;
2. a pushed review checkpoint;
3. a separate review file;
4. all blocking review findings resolved before the next child begins.

Do not merge the shared branch between children.

## Parent-level acceptance matrix

### Import browser

- Single-clicking a folder opens it and never recursively selects it.
- Only explicit selection controls change recursive folder selection.
- The header checkbox and **Select shown** include every currently shown selectable file and folder.
- Clearing shown entries preserves selections hidden by filtering or navigation.
- The quick-access and file-browser panes are horizontally resizable with accessible separator
  behavior, bounded widths, and adequate scrollbar clearance.
- Breadcrumb segments, parent navigation, manual path entry, and keyboard paths work.
- Desktop/Documents/Downloads resolve correctly on redirected Windows installations.

### Cell Database selection

- The table header checkbox remains page-scoped.
- Selecting every cell on a page while additional matching cells exist shows a compact orange scope
  prompt between the table and pagination.
- The prompt reports the current-page count and complete matching-result count.
- The escalation action selects exactly the current search/filter result set and no filtered-out
  cells.
- Existing pagination, sorting, range selection, selection pruning, and bulk actions remain correct.

### Import safety

- A batch above 30 files shows count, size, contributing roots, and an explicit continue label.
- One exact duplicate cannot block the remaining valid separate-cell batch.
- A staged file can be removed without clearing edits on other drafts.
- Continued-cell mode never silently skips a chain source.

### Import transparency and performance

- Folder scanning, file inspection, and Cell registration have distinct labels.
- Inspection and registration show current file and determinate progress.
- ETA appears only when supportable.
- Inspection uses bounded workers without sharing a database session.
- Registered-source identity data are loaded once per batch.
- Only the active staged file loads a capacity preview.
- The import modal closes after database registration; scientific caches continue in background.

### Analysis workflows

- Selected Cell Database Cells can create a populated Analysis directly.
- Empty Analysis creation remains available.
- An Analysis can create a persistent replicate group from at least two direct Cell entries.
- The action replaces the selected direct entries in the current Analysis and preserves saved-plot
  visibility semantics.
- Folder-reference removal is explicit and limited to selected folders.

### Presets

- Cycles, Time/capacity, Steps, C-rate, Chargeability, and DCIR presets are isolated by family.
- Universal visual presets do not change axis/family-specific fields.
- Legacy saved presets remain readable.

## Final verification and closure

After every required child, including 035.12, and all child reviews are clean:

```powershell
python -m unittest discover tests
node --test frontend\tests\*.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py
```

Use disposable test data for import and Analysis lifecycle checks. Do not use the real user
database. Browser checks are manual unless the user explicitly authorizes automated browser
interaction.

The parent closes only when:

- all child implementation records name their exact branch, commit, commands, and results;
- every required child review has no open blocking finding;
- the final matrix is recorded after the last implemented child;
- `docs/specs/README.md`, `AGENTS.md`, and durable knowledge documents are updated where the final
  code makes them misleading.
