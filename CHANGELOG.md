# Changelog

This changelog is based on the git history after the initial CellXplorer baseline
(`81b79a1`). Technical-only changes and test updates are summarized in terms of their
user-facing impact.

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
