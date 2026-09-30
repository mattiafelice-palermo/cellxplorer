# 060 — Indexed source search

Status: Implemented; independent Astra review, browser checks, preflight and frozen-backend smoke passed.

Review document: [060 review](reviews/060-indexed-source-search-review.md).

## User goal

Users often know a file name or experiment detail but do not remember which nested folder holds
the file. Let them search quickly across roots they explicitly choose, then preview and stage the
result through CellXplorer's existing import workflow.

## Locked scope and assumptions

- Users explicitly configure one or more search roots. CellXplorer does not crawl the whole disk
  by default.
- Index Neware `.ndax`, BioLogic `.mpr`, and **recognized structured Neware `.xlsx`** sources.
  This does not add support for arbitrary Excel workbooks. Neware `.nda` is outside this feature's
  search scope unless the user later expands it.
- Root search is a discovery aid. Choosing a result stages its existing path; it does not copy,
  import, attach, or register the file by itself.
- Search should be subsecond once a root has been indexed. Initial network traversal and the plot
  preview for a cold source are separate workloads and must not be represented as subsecond search.
- Reuse existing format recognition, header readers, selection gestures, preview components,
  duplicate checks, and import steps wherever possible.
- The mockups are illustrative, not final pixel specifications. They were based on the live
  CellXplorer Cell Database, Step 1 file picker, and Settings screens on 2026-09-27. See
  [060-indexed-source-search-mockups.html](060-indexed-source-search-mockups.html).

## Entry point and user flow

1. The user opens **Load cells** or another existing workflow that opens the shared filesystem
   picker.
2. Step 1 has two scopes: **This folder** and **Search indexed locations**. The existing folder
   search remains scoped to the current folder. The indexed scope searches only enabled roots.
3. On first use, indexed search explains that no roots are configured and offers **Add a search
   location**. The user can also add the current folder as a root from the picker.
4. The user types a query, optionally narrows by root, format, supplier, or protocol/technique, and
   sees local-index results while background refresh continues independently.
5. Clicking a result previews it in the existing preview pane. The established picker gestures add
   it to the staged sources list; the search row itself does not silently import anything.
6. The staged path appears in **Selected sources** and can be removed there. **Continue** follows
   the existing file-versus-folder and wizard-step policy. Search results are individual files, so
   they follow the individual-file path; search must not add a special wizard branch.
7. Preview, inspection, format warnings, duplicate detection, confirmation, and import all use the
   existing pipelines. Final checksum validation remains authoritative.

### Search result interaction

- A normal click focuses a result and loads its preview, matching the current picker behavior.
- Existing Space/Ctrl-click, Shift-range, double-click, and focused-list Ctrl+A behavior controls
  staging, subject to the import browser's current selection policy and input-field safeguards.
- Keyboard focus is visible. Result rows expose filename, root-relative location, extension, file
  size, modified date, available metadata, and an explicit status such as **Indexing metadata**,
  **Metadata unavailable**, **Already in Cell Database**, or **Available**.
- Search and filter changes never clear already staged paths. Staged identity is the normalized
  full path; adding the same path twice is idempotent.
- Registered-path knowledge may be shown from the local Cell Database. Do not hash every network
  file just to label search results. Existing checksum-based duplicate validation still runs at
  selection/import boundaries.

## Search behavior

- Search file name, basename, normalized path, and the approved metadata fields described below.
- Match case-insensitively; rank exact and prefix filename matches above path and metadata matches.
- Provide filters for enabled root, file type, supplier, and technique/protocol where metadata is
  available. Clearly distinguish source-reported metadata from CellXplorer-derived scientific
  values.
- Use a short input debounce (approximately 120 ms), local index queries only, and paged or
  virtualized results. Typing must not issue filesystem or network-share reads per keystroke.
- Keep filename/path results available while metadata enrichment is pending. Metadata filters may
  show that enrichment is still in progress and must not imply that an empty result means a root is
  fully indexed.
- Aim for a **p95 under 500 ms** from settled input to visible results on a warmed 100,000-file
  catalog on a supported Windows machine. Benchmark larger catalogs separately. The measured
  interval excludes initial root scanning, metadata enrichment, and selected-file plot preview.

## Roots and Settings

Add a **File search** tab to the existing Settings tabs, matching current Settings layout and
controls. It owns the following configuration and operations:

| Control | Behavior and default |
|---|---|
| Search roots | Add, enable/disable, rescan, and remove explicitly selected folders. Accept local paths, mapped drives, and UNC paths visible to the backend process. |
| Indexed formats | Neware `.ndax`, BioLogic `.mpr`, recognized Neware `.xlsx`; all enabled by default and individually disableable. No `.nda` or arbitrary workbook indexing in this spec. |
| Search source metadata | On by default. Off leaves filename/path search available and skips header enrichment. |
| Automatic refresh | When indexed search is opened and a root's last successful scan is over 24 hours old, queue a background refresh. The user can choose manual-only or a longer interval. Do not refresh on every keystroke. |
| Refresh now | Queue an explicit scan for one root or all enabled roots. Search remains available during the scan. |
| Pause/resume | Pause and resume background scanning without losing completed index entries. |
| Root status | Show scanning/paused/ready/offline/needs-attention state, counts, last successful scan, and a concise recoverable error. |
| Remove root | Remove its catalog entries and configuration only. Never delete or move source files. |
| Rebuild search index | Clear and recreate only the derived search catalog while preserving root preferences and all source files. |

Settings can be opened from **Settings → File search** or through **Manage search locations** in
the indexed-search empty state and root selector. Do not add this file catalog to Ctrl+K: that
palette searches CellXplorer database objects, not arbitrary source paths.

## Indexing lifecycle

### Initial scan

- Adding a root queues a background scan. The picker and application remain usable; startup and
  settings reads never wait for recursive traversal.
- Walk folders without following symlink/junction/reparse-point loops. Respect the Windows user's
  existing access. Record inaccessible paths as recoverable scan findings instead of failing the
  whole root.
- Candidate discovery records only paths with the configured extensions plus the filesystem
  facts needed for freshness. For `.xlsx`, keep candidates in a pending-format state until the
  existing lightweight Neware format recognition classifies them.
- Metadata enrichment uses the existing shared header-read/format-recognition path with a bounded
  worker count. It must not parse full cycle rows, calculate capacity/CE, build plot traces, or
  compute whole-file checksums for every discovered file.
- Known Neware `.xlsx` conversion/read failures retain the app's clear warning-and-attempt behavior
  when the format is recognized. Arbitrary workbooks remain unsupported. An enrichment error must
  not be presented as a successful metadata match.
- Persist progress and completion per root. Shutdown stops workers cleanly; an interrupted scan
  resumes or is safely re-queued on the next launch.

### Refresh and stale data

- Version 1 uses explicit and interval-triggered recursive refresh; it does not depend on
  `FileSystemWatcher`/SMB notifications for correctness.
- A successful refresh reconciles discovered paths with prior entries and uses path, size, and
  modification time to skip unchanged metadata work. A file whose facts changed is re-enriched.
- An offline, denied, or interrupted scan is **not** an empty successful scan. Preserve the last
  good index, mark it stale/offline, and retry only on user action or the configured schedule.
- When a result is previewed or continued to import, revalidate that the path still exists and is
  readable. A stale/missing result gets a clear inline state and refresh action.
- Overlapping/nested roots must not duplicate results. Normalize paths using Windows semantics,
  retain the owning root for display/status, and deduplicate by canonical path.

## Metadata and privacy boundary

- Store only path/name, extension, size, modified time, format-validation state, freshness state,
  and a versioned whitelist of metadata that `read_header_metadata()` can provide cheaply and
  reliably (for example supplier, technique/protocol, and source-reported dates or values when
  present).
- Do not index file contents, raw cycling rows, every cycle, preview traces, or extracted workbook
  cell text. Do not infer that a field is searchable for every format if only some adapters expose
  it.
- Source paths and metadata remain local to the CellXplorer data root. Do not send them to telemetry
  or a hosted service. Avoid writing absolute paths into routine logs; diagnostics should redact or
  shorten them where feasible.
- Network access uses the running backend's Windows identity and existing share permissions.
  CellXplorer does not store network credentials or elevate privileges.
- File roots are paths visible to the backend process. In the normal desktop/local-web workflow,
  the backend runs on the same Windows computer. A remote browser must not be led to believe this
  indexes that browser machine's local drives.

## Persistence and external dependencies

- Store root preferences through the existing `app_settings` settings mechanism; avoid a
  scientific-library schema migration for this feature.
- Store the derived catalog in a separate, versioned, rebuildable SQLite file beneath the active
  channel's cache/data root, not in Cell/SourceFile scientific tables. The catalog is disposable;
  losing it must not affect imported cells or their caches.
- Stable, Beta, and Alpha keep their existing separate data roots, so settings and catalog remain
  channel-isolated. The web-development app and installed channel also have distinct roots and
  indexes.
- Prefer Python's existing SQLite runtime and full-text support when available in the packaged
  build. Verify FTS5 in the bundled runtime; provide a portable fallback rather than silently
  adding an external database service.
- No Everything installation, Windows service, admin privilege, installer change, or separate
  user dependency is required. The normal CellXplorer installer carries the background service
  code. First indexing begins only after a user adds a root.
- Everything remains a possible optional future filename-index provider, not a v1 dependency.
  Its folder indexing supports network shares without admin/service setup, but uses folder scans
  that can take minutes; it can miss change bursts. Everything Server business/enterprise hosting
  requires a site license. See [Folder Indexing](https://www.voidtools.com/support/everything/folder_indexing/)
  and [Everything Server](https://www.voidtools.com/support/everything/everything_server/).

## Suggested implementation boundaries

- Frontend picker: extend the shared
  [`ImportFilesystemPickerModal`](../../frontend/src/components/ImportFilesystemPickerModal.tsx)
  with a scope mode and result adapter; reuse `ImportSourcePreview`, staged-source controls, and
  existing continuation/individual-file routing.
- Settings: add a File search tab in
  [`SettingsPage.tsx`](../../frontend/src/pages/SettingsPage.tsx), using the existing settings API
  and query-cache conventions.
- Backend: add an `import_search_index` service for root catalog lifecycle, bounded background
  scans, freshness, and local search; add an API router for settings, root actions, job state, and
  paged results. Keep ordinary one-folder browse API behavior unchanged.
- Metadata: reuse `import_file_hints` and `parsing.read_header_metadata()` where their bounded
  contracts fit; evolve shared code rather than adding a second divergent format detector.
- Startup: register a non-blocking, lifecycle-owned worker after the API becomes available. Do not
  eagerly scan configured roots before first serve.
- No source file is copied, relocated, or modified by indexing or search.

## Verification and acceptance

1. **Search performance:** benchmark local and UNC roots at representative sizes; report root-scan
   time separately from warmed query and browser-render time. Meet the search target above without
   issuing a network request per query keystroke.
2. **Index correctness:** cover nested/overlapping roots, path case normalization, changed files,
   removed files, interrupted scans, unavailable roots, permission failures, and reindexing.
3. **Format boundary:** verify `.ndax`, `.mpr`, and recognized Neware `.xlsx` are discoverable;
   arbitrary `.xlsx`, `.nda`, and unrelated formats are not returned as importable. Preserve the
   known-Neware conversion warning behavior.
4. **Selection and preview:** verify click-to-preview, keyboard/mouse staging, duplicate staged
   path handling, preview reuse, selected-source removal, and existing import modal navigation.
5. **Scientific integrity:** final import uses existing identity/checksum and parser gates; search
   indexing never creates Cells, SourceFiles, scientific caches, or capacity/CE summaries.
6. **Privacy and Windows:** test under ordinary user permissions with a UNC path, unavailable
   mapped drive, and channel-specific data roots. Confirm no credentials are stored and no install
   or service dependency is introduced.
7. **UI:** review dark and light themes, app zoom, long paths, narrow windows, accessible keyboard
   operation, and status/error copy against the visual style guide and the supplied mockups.
8. **Packaging:** build and launch the installed Windows app; confirm background indexing resumes
   safely and its catalog remains isolated across Stable/Beta/Alpha.

## Out of scope

- Full-disk indexing or automatic selection of roots.
- Arbitrary Excel, `.nda`, raw-content search, or indexing file contents.
- Indexing complete scientific datasets, capacities/CE, or plot previews for every file.
- A mandatory Everything/Everything Server installation, custom Windows service, or cloud index.
- Automatically importing, copying, attaching, or deleting search results.

## Implemented design and verification

The v1 provider is self-contained SQLite, rather than Everything. Everything was authorized as
an optional dependency, but its network-folder traversal would still be needed and a separate
header catalog would still be required. The bundled Python runtime provides FTS5 trigram search;
literal substring search is the compatibility fallback. No installer option or external service
is necessary.

The derived catalog is `search-index/catalog.sqlite` beneath the active data root. Root settings
use `AppSetting.import_search`. One cancellable spawned process discovers all candidates before
header enrichment; atomic local spool batches avoid blocking cancellation on partial IPC frames.
Header stalls are timed out and skipped while later files continue. Incomplete/offline scans keep
unseen results. A changed file or failed identity check cannot publish newly extracted metadata.
Queries use only local SQLite and stored registered paths; they do not stat, hash, or parse sources.

The picker pages 100 results and mounts only visible rows plus the focused row. Selection works
across the whole page and persists across filters and scopes. Existing preview and import gates
remain authoritative. Search metadata is limited to barcode, remarks, part number, start time,
and technique, when adapters provide them; capacity and CE are not indexed.

Performance was measured against a synthetic 100,000-file catalog with UNC-shaped paths on this
Windows host. These numbers measure an indexed catalog, not real SMB scan speed:

| Measurement | Result |
|---|---|
| Full HTTP route, 9 rounds per query, concurrent four-row batch writes at 10 Hz | Exact/metadata/no-match medians 32–48 ms; broad medians 219–311 ms; worst observed p95 364 ms |
| Browser input to visible settled results, 9 distinct queries, including 120 ms debounce | 251–488 ms after virtualization; 254–904 ms before |
| Root counts, 100,000 entries | Covering index reduced approximately 900 ms to 45–55 ms; counts are excluded from result requests |

`tests/test_import_search.py` covers local spawned scans, refresh/rename/deletion, unavailable roots,
restart, cancellation, header timeout, overlap, normalized paths, concurrent catalog changes,
format recognition, metadata freshness and derived-catalog recovery. Frontend policy tests cover
cross-scope normalized staging and registered-source availability. `scripts/profile_import_search.py`
provides the catalog benchmark; `scripts/smoke_import_search.py` verifies the frozen backend's
spawned worker, pause/restart, rebuild, incompatible/corrupt catalog recovery, and scientific-library
preservation in disposable data.

Browser acceptance uses disposable application data and verifies metadata search, preview reuse,
registered-source preview, range staging, scope changes, and existing Continue/Back routing.
Light/dark themes and 1100×680 / 1280×720 / 1600×1000 viewports were checked; arrow navigation
reveals its target even with a 56 px list viewport. Escape closes only the active search-settings
dialog and preserves the loader. The rebuilt `0.28.0-alpha.1` frozen-backend smoke passed.
Actual UNC/mapped-drive access and installed Tauri WebView delivery could not be exercised on this
host: no test share was mounted and native application control was unavailable. Synthetic alias
tests and the frozen-backend smoke are separate evidence and do not substitute for those checks.
