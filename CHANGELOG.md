# Changelog

This changelog is based on the git history after the initial CellXplorer baseline
(`81b79a1`). Technical-only changes and test updates are summarized in terms of their
user-facing impact.

## 0.19.0-beta002 - 2026-08-05

- Show the real plot as a live preview in the series appearance editor, list the series for the tab you are on, and apply per-series styling on time and capacity plots.

## 0.19.0-beta001 - 2026-08-05

- Add a per-series appearance editor: style each line individually with colour, dashes, markers, shadow and legend name, or apply rules to many series at once, with a live preview.

## 0.18.0-beta005 - 2026-08-04

- Keep the import review toolbar in place and scroll the file list and cell details independently, with more compact file cards.

## 0.18.0-beta004 - 2026-08-04

- Give the three import steps one consistent layout: step navigation always in a sticky footer, and progress and warnings no longer push the content you are reading.

## 0.18.0-beta003 - 2026-08-03

- Stop background cache preparation when the imported cells are deleted, and always report a final state instead of leaving progress frozen.

## 0.18.0-beta002 - 2026-08-03

- Stop sending each file's full header to the browser and back during import, removing about 58 MB of traffic in each direction for a large batch.

## 0.18.0-beta001 - 2026-08-03

- Delete large cell selections in a fraction of the time and reclaim their cached cycling data in the background. Move the select-all-matching prompt above the table so it is visible.

## 0.17.0-beta028 - 2026-08-03

- Show imported Cells in the database as soon as registration commits, and store each file header once on its source instead of copying it onto the Cell.

## 0.17.0-beta027 - 2026-08-03

- Fix background import handoff visibility and remove caches for deleted online sources.

## 0.17.0-beta026 - 2026-08-02

- Use inspected import data for fast Cell registration and expose the committed state before cache preparation finishes.

## 0.17.0-beta025 - 2026-08-02

- Keep background import attached until Cells are committed.

## 0.17.0-beta024 - 2026-08-02

- Show background import progress and early Cell visibility.

## 0.17.0-beta023 - 2026-08-02

- Fix duplicate import names and retryable failed imports.

## 0.17.0-beta022 - 2026-08-02

- Make Spec 035.8 import registration restart-safe and incrementally observable.

## 0.17.0-beta021 - 2026-08-02

- Fix Spec 035.8 import modal regressions.

## 0.17.0-beta020 - 2026-08-02

- Fix import progress polling during job startup.

## 0.17.0-beta019 - 2026-08-02

- Adaptive import inspection progress and dark-theme contrast.

## 0.17.0-beta018 - 2026-08-02

- Lazy import previews and background cache handoff.

## 0.17.0-beta017 - 2026-08-02

- Speed up large Neware imports with direct header parsing and process-based inspection.

## 0.17.0-beta016 - 2026-08-01

### Bug fixes

- Speed up large import inspection with bounded concurrency and batch identity matching.

## 0.17.0-beta015 - 2026-08-01

### Bug fixes

- Improve responsiveness when selecting large imports across nested folders.

## 0.17.0-beta014 - 2026-08-01

### New features

- Import interrupted or restarted Neware files as one Cell with an ordered source chain, instead of treating each file as a separate Cell.
- Add, reorder, and detach continuations from Cell details, with compatibility warnings and explicit confirmation for risky changes.
- Cycles and Time/capacity analyses, exports, and thumbnails work across multi-source Cells with source-boundary provenance.
- Scheduled source monitoring checks only each Cell's tracked final source; manual integrity operations still inspect the full chain.
- Portable analysis export/import preserves the Cell source order and separate original files.

### Bug fixes

- Steps, DCIR, chargeability, and rate capability fail closed for multi-source selections until cross-source protocol mapping exists, preventing misleading partial results.

## 0.17.0 - 2026-07-31

### New features

- CellXplorer opens much faster after install or an update. The backend runs from the installed app folder instead of unpacking a large bundle on every launch, and everyday screens such as your library and project folders appear sooner while heavy scientific libraries load in the background.
- Redesigned Projects view with cycle count, specific capacity, and plot previews in aligned columns; collapsible Analyses and Samples sections; and richer multi-select (including Shift+Up/Down range selection).
- Create a new analysis from selected samples in Projects, place multiple cells as a replicate group from the Cell Database, and start from an empty analysis when you only need a shell.
- Import and compute cycling data faster (~2.6× on real libraries) with improved per-cycle processing.
- Improved protocol segment editor with sticky controls, protocol-aware filters, and show-neighbours expansion.
- Smarter source-file monitoring with weekly schedules, configurable retry delays, and a schedule preview in Settings.
- Clearer in-app update experience: native notifications, readable release notes in the update dialog, and specific guidance when a check fails.
- Optional CellXplorer Beta installs separately with its own library, for users who opt in under App updates.
- After updating from 0.16.x, existing libraries may rebuild scientific caches once. This is expected and improves speed and correctness going forward.

### Bug fixes

- Stop C-rate (rate capability) recognition from starting when the plot is hidden or has no samples selected — this removes unexpected background jobs and Activity noise.
- Fix analysis tab switching after saving a draft plot when you had unsaved work on another tab.
- Fix destructive confirmations so the impact preview no longer flashes a second loading dialog.
- Fix Cell Database row selection, name preview clicks, and dark-mode selected-row contrast.
- Fix same-folder drag-and-drop accidentally removing cells and replicate groups.
- Improve installer updates: wait for running app processes to close, repair uninstaller refresh, and clearer shutdown before NSIS applies an update.

## 0.17.0-beta013 - 2026-07-30

- Prevent hidden or empty C-rate workspaces from starting rate-sweep recognition.

## 0.17.0-beta012 - 2026-07-30

- Explain update-check failures with specific recovery guidance and preserve compact Beta successor compatibility.

## 0.17.0-beta011 - 2026-07-30

### New features

- CellXplorer Beta opens noticeably faster, especially right after install or an update. The backend no longer unpacks a large temporary bundle on every launch — it runs directly from the installed app folder.
- Everyday screens such as your library and project folders appear sooner. Heavy scientific libraries now load in the background and only when a feature actually needs them.

## 0.17.0-beta.10 - 2026-07-29

### New features

- Speed up per-cycle import compute (~2.6× on real libraries) with faster CV-cycle aggregation and status matching.
- Speed up Beta scientific preparation after copying a Stable library with parallel foreground workers until you continue in background.
- Create a new analysis from selected samples in Projects, with an empty-analysis option in the split menu.
- Extend Projects and Cell Database selection with Shift+Up/Down and folder-scoped range rules.
- Place multiple selected cells as a replicate group from the Cell Database, with folder review before commit.
- Render updater release-note headings and bold text in the update modal.
- Ship Beta builds on Python 3.14 so the packaged backend uses the faster zlib-ng runtime.

### Bug fixes

- Fix Cell Database row selection, name preview clicks, and dark-mode selected-row contrast.
- Fix destructive confirmation so impact preflight no longer flashes a second loading modal.

## 0.17.0-beta.9 - 2026-07-29

### Bug fixes

- Fix analysis tab switch after saving a draft plot when changing tabs with unsaved work.
- Fix deferred destructive confirmations when the impact preview modal closes first.

## 0.17.0-beta.8 - 2026-07-29

- Gate Beta startup on scientific cache preparation until it finishes or you continue in background.
- Show clearer setup progress while validating a copied Stable library.
- Block normal library interaction until the one-time preparation gate is resolved.

## 0.17.0-beta.7 - 2026-07-29

- Fix Beta update-channel publication so in-app updates discover new Beta releases automatically.
- Prepare scientific caches after copying a Stable library into Beta, with progress in Settings.
- Preserve offline-source scientific caches during category cleanup.
- Add manual scientific preparation and cache rebuild controls in Settings.

## 0.17.0-beta.6 - 2026-07-29

- - Fix same-folder drag-and-drop removing cells and replicate groups instead of doing nothing.
- - Add collapsible Analyses and Samples sections in the project folder tree.
- - Show cycle count, specific capacity, and plot previews in aligned project explorer columns.
- - Align metric column headers and dividers through section splits; separate the Folders toolbar from the tree.
- - Restore Expand all and Collapse all, with root-folder options in each chevron menu.
- - Add weekly source-monitor schedules, retry delay units, and a schedule preview in Settings.

## 0.17.0-beta.5 - 2026-07-28

- Protocol segment editor: sticky controls, protocol-aware filters, and show-neighbours expansion.
- Repair NSIS upgrades with a fresh uninstaller and clearer pre-install process shutdown.
- Track install instances and gate Beta startup until library bootstrap is resolved.

## 0.17.0-beta.4 - 2026-07-28

- Run NSIS pre-install shutdown through the bundled PowerShell script instead of inline -Command.

## 0.17.0-beta.3 - 2026-07-28

- Wait for install-directory processes and backend locks to clear before NSIS updates.
- Let Beta reuse or replace an existing library with explicit version acknowledgment.

## 0.17.0-beta.2 - 2026-07-28

- Use parent-process-aware relaunch for manual restart and Beta library copy apply.
- Make Beta NSIS and app chrome channel-specific, and regenerate size-specific Beta icons.

## 0.17.0-beta.1 - 2026-07-28

- Add separate Stable and Beta application identities, isolated Beta data, channel-specific signed updates, and explicit Stable-owned Beta installation.

## 0.16.2-beta.1 - 2026-07-27

- Beta release to exercise in-app beta update filtering and the signed updater path.

## 0.16.1 - 2026-07-27

- Show last and next automatic update-check times under App updates settings.

## 0.16.0 - 2026-07-27

- Use native Windows notifications for automatically discovered application updates and open manual update results directly.
- Add a Receive beta versions setting; when off, updates whose version contains "beta" are ignored for automatic and manual checks.

## 0.15.5 - 2026-07-27

- Added an App updates settings tab with configurable automatic-check intervals in seconds, minutes, hours, or days.
- Added an enabled-by-default update discovery toaster toggle; disabling it keeps automatic checks and the power-menu badge active.

## 0.15.4 - 2026-07-27

- Added scripts/bump_version.py to synchronize version declarations and prepend CHANGELOG sections.
- Packaged-backend startup tests now drive the ASGI lifespan directly instead of requiring httpx.

## 0.15.3 - 2026-07-27

- Fixed a critical packaged-install regression where the Python backend could not start:
  recent dependency releases removed `add_event_handler`, so the sidecar crashed during import
  before the UI could connect.
- Moved backend startup/shutdown to FastAPI lifespan and pinned exact Python dependencies so
  CI builds match tested versions.

## 0.15.2 - 2026-07-27

- Restored the chevron on the power-menu button so it reads as a menu control again.
- Manual update checks now open a clear modal with the installed version when the check fails
  or the app is already up to date, instead of a hard-to-see corner notification.
- Fixed GitHub release verification so draft asset metadata is saved as raw API JSON (avoids a
  PowerShell `ConvertTo-Json` failure that blocked publishing).

## 0.15.1 - 2026-07-27

- Published the first GitHub Release with signed updater artifacts and `latest.json`, so
  installed builds can discover and apply updates from the power menu.

## 0.15.0 - 2026-07-27

- Added signed in-app updates from the power menu: automatic checks, update badge,
  release-notes modal, download progress, and branded NSIS installer launch.
- Added automated GitHub release publishing for Windows tags, including signed updater
  artifacts and `latest.json` generation.
- Renamed the power-menu **Automatic updates** section to **Background automation** so
  source monitoring is not confused with application releases.

## 0.14.3 - 2026-07-26

- Draft plots now save through **Save as** in the plot toolbar instead of a separate button on
  the draft card; **Update** remains for edited saved plots.
- Fixed the Cell Library **Check and update** chevron so the **Check only** menu opens reliably.

## 0.14.2 - 2026-07-26

- Fixed the Cycles plot **Reindex remaining cycles** toggle so it immediately closes gaps,
  renumbers the visible cycles, and resets zoom when diagnostic cycles are hidden.

## 0.14.1 - 2026-07-26

- Polished the Cell Database table: fixed column widths across pages, debounced search,
  a two-row sticky toolbar, icon-only row actions, and the same cell hover summary used in
  analyses.
- Reworked the header quick-settings control into a larger power button and moved Debug into
  that menu.
- On Windows, background source checks, cache rebuilds, imports, and other automation now run
  at below-normal process priority so they compete less with the UI.
- Default plot style presets no longer pin empty axes when their saved manual ranges do not
  overlap the plotted data; those axes fall back to Plotly auto-scaling instead.
- Added a canonical visual style guide for future frontend work.

## 0.14.0 - 2026-07-26

- Added a Chargeability analysis tab that finds voltage-controlled charge events from protocol
  meaning (SoC window, current ceiling, and voltage mode) rather than fixed step numbers, then
  plots matched raw curves with SoC, time, current, and capacity axes.
- Added a C-rate (rate-capability) analysis tab that recognizes charge- and discharge-rate sweeps,
  validates executed voltage cutoffs, normalizes retention to a shared reference rate across
  selected cells, and reports charge/discharge asymmetry when both families are present.
- Automatic recognition for C-rate and Chargeability now shows realistic progress, and a read-only
  protocol-structure viewer can highlight the steps that were detected.
- Redesigned Place in folders into a two-pane additive picker with a collapsible folder tree and a
  clear impact summary of what will be filed where.
- Cell Database and Projects folder/replicate workflows gained clearer place-in-folders and
  group/ungroup/explode paths, including converting selections between cells and replicate groups
  without duplicating scientific data.
- Before removing cells or exploding/ungrouping replicates, CellXplorer previews the impact on
  analyses and saved plots. Exploding or deleting a replicate group also strips that group from
  analysis samples so selections do not keep dangling references.
- Unsaved analysis plots are session drafts: cold open restores a saved plot or an empty workspace,
  “Unsaved plot” appears only after New, and leaving a dirty draft prompts Save or Discard.
- Fixed per-cycle capacity and energy aggregation for Neware’s per-step counter reset. CC+CV
  charges now include the CV portion, which corrects understated charge capacity and coulombic
  efficiencies that could previously exceed 100%.
- Added a header quick-settings menu for reload interface, desktop restart, Appearance
  (Auto/Light/Dark for app chrome; plots stay light), and pausing background automation such as
  source monitoring and idle cache warmup.
- Production builds no longer show the browser context menu except on text inputs and explicitly
  marked native menus.
- Fixed a background warmup deadlock where one failed thumbnail lookup could stall saved-plot
  preview generation for the rest of the session.
- Paginated the Cell Database table (25 / 50 / 100 rows per page) with sticky search/actions and a
  second sticky row for the Cells header plus page controls, so paging stays available while
  scrolling; the replicate section keeps its own sticky action row.

## 0.13.0 - 2026-07-23

- Added a dedicated Steps analysis tab built around explicit cell-and-protocol-segment series.
  Multiple segments from the same cell or comparable segments from different protocols can be
  plotted together against occurrence, cycle, or elapsed time, with independent quantity and
  direction controls.
- Added a dedicated DCIR workflow with private protocol segments, automatic long-rest/short-pulse
  suggestions, charge and discharge resistance calculations, absolute or relative-change views,
  and explicit series for each cell, pulse direction, and current condition.
- Added persistent analysis workspace tabs with reordering, recently closed-tab restoration,
  keyboard navigation, background opening, and a performance setting that trades memory use for
  instant switching between mounted analyses.
- Expanded the Analysis Database with clickable sample and plot summaries. Samples open cell or
  replicate previews, saved plots open directly on the correct analysis tab, and plot hover panels
  use dedicated cached 4:3 previews generated by the idle cache coordinator.
- Fixed Time / capacity axis changes so the plotted values now switch together with the label, and
  added areal capacity in mAh/cm2 using cell metadata or a per-analysis electrode-area override.
- Reworked Analysis samples, Steps series, and DCIR series into compact collapsible panels with
  consistent add/edit flows and clearer per-series labels.
- Hardened analysis cache versioning, thumbnail readiness checks, and background invalidation so
  new result schemas and preview formats are rebuilt without discarding unrelated cached results.

## 0.12.1 - 2026-07-21

- Reworked the Analysis Database into a compact research table with sortable and filterable
  columns, adjustable column widths, configurable visible fields, and multi-selection for bulk
  removal.
- Updated analyses are now identified by a restrained teal dot, subtle row tint, and stronger
  title weight instead of the previous yellow warning treatment.
- Analysis summaries now report the unique cells and replicate groups in each selection, count
  saved plots, and reveal their quantities on hover alongside folder and creation/update dates.
- Loading the analysis list now gathers replicate membership and folder context in bulk, avoiding
  repeated database queries as the library grows.

## 0.12.0 - 2026-07-20

- Added "Hide diagnostic cycles" to the cycles plot. Cycling protocols interleave DCIR pulses and
  rate checks among normal cycles, and those land far above and below the real capacity band, which
  compresses the plot to the point of being unreadable. The toggle identifies them from how long
  each cycle took to charge and discharge — never from capacity itself, so a genuinely degrading
  cell is never hidden — and reports both how many cycles were removed and how many remain. The
  sensitivity is adjustable, and the setting starts switched off.
- Hidden cycles never leave the plot: exports still contain every cycle, so re-importing a report
  restores them even when the original source files are gone. A report exported from a filtered plot
  states so above the chart and lists the affected cycles below it, rather than relying on the
  reader to go looking.
- Opening an analysis whose cache is already built is faster again: a cached result is now handed
  back without being unpacked and repacked on the way out, on top of the lookup work in 0.11.1.
- Repackaging the application takes about a minute instead of about four, and produces an installer
  1.2 MB larger.

## 0.11.1 - 2026-07-20

- Opening an analysis whose cache is already built is now about four times faster for cycle plots
  and closer to seven times faster for time/capacity plots. Several costs were paid on every
  request even when nothing needed recomputing: reading a cell's mass, nominal capacity, or
  electrode area loaded every metadata row for that cell, checking whether the cache was still
  valid walked each cell's files one query at a time, the raw instrument headers were decoded and
  discarded, and large results were serialized twice on the way out.
- A cached plot no longer opens a "Preparing..." entry in Activity or costs an extra request; the
  entry now appears only when real work starts.
- Saved-plot thumbnails that are already cached now appear immediately instead of waiting behind
  the generation of an uncached plot on the same page.
- Loading indicators no longer flash for work that finishes quickly. Opening an analysis, switching
  tabs, and drawing saved-plot previews now hold their space silently and only report progress once
  a load has actually been slow, so a fast result appears without a spinner blinking in front of it.
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
