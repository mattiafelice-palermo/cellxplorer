# Changelog

This changelog is based on the git history after the initial CellXplorer baseline
(`81b79a1`). Technical-only changes and test updates are summarized in terms of their
user-facing impact.

## 0.11.1 - 2026-07-20

- Opening an analysis whose cache is already built is now roughly three times faster for cycle
  plots and four times faster for time/capacity plots. Reading a cell's mass, nominal capacity, or
  electrode area used to load every metadata row for that cell — tens of thousands of rows — on
  every request, and large results were serialized twice on the way out.
- Global search now matches across entities: searching a cell name together with another term
  surfaces the analyses and saved plots that contain that cell. Results are grouped by kind, and an
  entry that matched through its contents lists the cell names responsible, so it is clear why it
  appeared. The header search box is gone; Ctrl+K is the way in.
- The downloads list no longer scrolls sideways, long filenames are truncated with the full name on
  hover, and a row can be double-clicked to open the file.
- The downloads copy button now places the file itself on the clipboard, so an exported plot can be
  pasted into a presentation or a folder rather than pasting its location as text.
- The downloads badge counts only exports that have not been acted on yet, and clears an entry once
  it is opened, revealed, or copied.

## 0.11.0 - 2026-07-20

- Added a downloads manager beside the activity indicator: every exported plot, data file, and
  portable report is recorded with its location, a popup announces each new download, and the
  history survives restarts. Files can be opened, shown in their folder, copied as a path, or
  deleted, and entries whose file has moved are marked instead of silently disappearing.
- Added global search on Ctrl+K over cells, analyses, saved plots, replicate groups, and folders,
  with fuzzy matching that still finds the intended item when nothing matches exactly. Opening a
  result jumps to the right place: a cell shows its details, a saved plot opens its analysis on the
  matching tab, and a folder opens the project tree expanded to it.
- Added Ctrl+B to collapse and restore the sidebar, plus a toggle beside the application title.
- Plot and data export buttons now download immediately using the current settings; the adjacent
  arrow still opens the export options.
- Added a "Check and prepare now" action to cache settings that rescans saved plots and refreshes
  the ones whose cache is missing or out of date without waiting for the idle delay.
- The import dialog keeps Cancel and Import visible while reviewing long source lists.

## 0.10.0 - 2026-07-19

- Idle preparation no longer re-runs work for plots that are already cached, and builds its queue
  from per-plot prepared markers so saving one plot no longer walks every saved plot.
- Cached analysis results are no longer invalidated by transient source availability changes;
  source-offline and source-changed badges are refreshed from current status at display time.
- Editing a cell's name, archived state, or mass/capacity/area overrides now invalidates and
  requeues only the affected analyses' cached plots.
- Analysis compute activity now distinguishes cells read from cache from the ones re-parsed from
  source, names the analysis in the entry, and summarizes the real work performed.
- Cache settings explain each category with inline help, and the largest-item list supports
  multi-selection (Shift/Ctrl-click) for bulk cleanup.
- Reduced repeated cache-size scanning and per-idle re-fingerprinting through an incremental size
  total and a cheap change probe.

## 0.9.0 - 2026-07-18

- Added configurable scientific and analysis cache budgets, storage inventory, largest-item
  inspection, and safe cleanup controls that protect source-backed data when originals are offline.
- Added low-priority idle preparation of saved analysis results, plot artifacts, and thumbnails,
  with visible activity progress and automatic pause/resume when the user returns.
- Source updates now invalidate and queue only affected analyses, deduplicate repeated refreshes,
  reject obsolete background generations, and yield to plots prepared directly by the user.
- Successfully replaced source files now remove their obsolete Parquet cache after the new cache is
  durable; failed replacements preserve the previous cache for recovery.

## 0.8.0 - 2026-07-18

- Added a fully branded CellXplorer installer and uninstaller with a compact guided flow,
  installation progress, desktop and startup choices, and explicit protection of the user's
  scientific database during uninstall.
- Cell and Analysis Databases now reopen immediately from compact, database-validated startup
  summaries while the backend verifies current records in the background.
- Improved repeated desktop launches by refreshing cells, analyses, replicate groups, and folders
  together, retaining all four summaries consistently, and safely flushing them during quick
  close/reopen cycles.
- Greatly reduced Cell Database list-query overhead by replacing per-cell relationship traversal
  with bounded aggregate loading and keeping scientific cache work outside the page-load path.
- Hardened SQLite startup concurrency with one-time WAL configuration, foreign-key enforcement,
  lock waiting, and retries for transient sidecar or database failures.
- Added a thematic agent knowledge base covering architecture, data ownership, state persistence,
  performance constraints, verification, releases, and Windows packaging.

## 0.7.0 - 2026-07-17

- Saved analysis plots now load more quickly through reusable plot-artifact and thumbnail
  caching, with better cache indexing and cleanup.
- Interactive analysis plots are more responsive on large datasets, using WebGL when supported,
  preserving zoom state, improving hover details, and keeping important extrema visible while
  reducing the number of points drawn.
- Portable analysis reports now have a smoother open-in-CellXplorer workflow, including desktop
  deep links and local report-path inspection.
- Portable imports better preserve original source-file paths and provide safer, clearer source
  reconciliation when matching files by checksum or comparing possible file versions.
- Analysis selections now expose more complete cell and replicate-group information, while
  scientific metadata summaries are loaded more efficiently.
- Added a filename-template editor with clearer token-based editing and preview behavior for
  exported plots and tables.
- Improved desktop integration for portable reports and related Tauri deep-link handling.

## 0.6.0 - 2026-07-17

- Added forward-only database schema revisions with compatibility checks, automatic pre-migration
  backups, migration diagnostics, and clear refusal of databases created by newer app versions.
- Added portable single-HTML analysis reports with selectable saved plots, CSV export, metadata,
  optional gzip-compressed Neware source files, and round-trip import into CellXplorer.
- Portable reports now retain full interactive Plotly figures in normal browsers and faithful
  pre-rendered Plotly SVGs in restricted previews such as Microsoft Teams.
- Added source reconciliation during portable import, including exact-checksum reuse, explicit
  handling of possible older/newer files, analysis renaming, and cell links in the destination
  folder.
- Added a full-width folder-tree destination picker with inline folder creation for portable
  imports, plus rename, move, copy, delete, and drag-and-drop actions for analyses in Projects.
- Embedded report sources can now be downloaded individually from a header dialog or together as
  a ZIP organized into one folder per cell.

## 0.5.0 - 2026-07-16

- Added a unified file and folder import browser with quick-access locations, pinned folders,
  recursive Neware-file discovery, multi-selection tools, per-file previews, and the ability to
  append files from additional locations without losing import work.
- Added editable scientific cell metadata, including electrode-area and active-material presets,
  custom values, and automatic nominal-capacity calculation from material mass.
- Added complete replicate editing and improved cell, folder, and analysis lifecycle handling,
  including non-recycled analysis identities, safer duplication names, and stale-cache cleanup.
- Expanded protocol-aware analysis with selectable protocol segments, charge-CV duration and
  capacity metrics, derivative plots, and configurable styling for low-replicate-count points.
- Added a clean New plot workflow, reusable plot-style presets, custom categorical and sequential
  color palettes, and independent coulombic-efficiency palette and series styling.
- Added token-assisted export filenames for plot and tabular downloads while preserving free-form
  editing, together with improved axis spacing, tick controls, aspect-ratio handling, and export
  fidelity.
- Added Settings pages for scientific metadata presets, plot presets, color palettes, and default
  export filename templates.

## 0.4.0 - 2026-07-15

- Added dedicated coulombic-efficiency overlay controls for per-series colors, line styles,
  markers, marker sizes, and opacity.
- Packaged desktop builds now choose an available local backend port instead of assuming that
  development port `8642` is free.
- The packaged frontend now discovers the actual desktop backend endpoint automatically.
- Downloads fall back to the native Save As dialog or the browser download when settings are
  temporarily unavailable.
- Added packaging-focused backend tests and updated the desktop packaging guidance.

## 2026-07-06

### Improved cell database and imports (`6a1eb73`)

- Refined the cell database toolbar and its everyday controls.
- Imports now run in the background, keeping the application responsive while files are processed.
- Added clearer import results and error handling.

### Faster Neware parsing and previews (`ef9c9d3`)

- Neware files are parsed faster, especially when importing or opening previews.
- Improved cache handling so previously processed data can be reused more efficiently.
- Reduced waiting time for calculated cell data.

## 2026-07-07

### Reworked analysis workspace (`10aea7d`)

- Added a dedicated analysis index for finding, creating, and managing analyses.
- Reworked the analysis editor with clearer analysis settings and more comparison options.
- Improved saved analysis recipes and calculation handling for more consistent results.
- Added support for viewing more battery metrics and analysis results in one workspace.

## 2026-07-09

### Windows desktop app (`bd8297c`)

- Added an installable Windows desktop version of CellXplorer.
- Bundled the frontend and local backend into one desktop application.
- Added desktop icons and installer support.

## 2026-07-13

### Expanded analysis and desktop workflows (`a238f78`)

- Added richer cell detail views and improved library workflows.
- Added protocol information and more useful cell metadata in the interface.
- Expanded project and analysis navigation.
- Added clearer explanations and controls for analysis plots.
- Added activity tracking for important background operations.

## 0.1.1 - 2026-07-13

- Added richer analysis plot legend controls, including outside or inside placement, side selection,
  custom dragged positions, orientation, and horizontal entry sizing.
- Added plotted-data export to CSV and Excel.
- Added decimal-separator and CSV-delimiter preferences for exported data.
- Increased default plot export quality to 300 PPI with larger default image dimensions.

## 0.2.0 - 2026-07-14

- Added a Settings workspace with persistent download-location preferences for browser and
  Windows desktop use.
- Added visible background-job progress, detailed source-check status, and activity history with
  start and finish times.
- Made source checks run in parallel and kept cells synchronized when their files change.
- Improved large cell-library loading by calculating cache-derived totals in the background.
- Refined application scaling, segmented controls, header alignment, and analysis export behavior.

## 0.3.0 - 2026-07-14

- Added background diagnostics, runtime session tracking, and a persistent activity view.
- Added automatic source monitoring with configurable schedules, lightweight metadata scans, and
  retries for files that are still being written.
- Added clear Active, Complete, and Source changing states in the cell database.
