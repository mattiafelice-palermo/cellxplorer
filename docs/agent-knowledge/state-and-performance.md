# State, caching, and performance

## SQLite concurrency

CellXplorer uses SQLite in WAL mode so readers can coexist with background writes. WAL is a
persistent, database-wide setting and must be enabled once during database initialization. Do not
run `PRAGMA journal_mode=WAL` in SQLAlchemy's per-connection hook: simultaneous startup requests
can then contend for the journal-mode lock and fail randomly.

Each connection enables foreign keys and a finite SQLite busy timeout. The timeout allows brief
background writes to finish instead of immediately surfacing `database is locked`. Keep long
parsing, checksum, and cache-rebuild work outside request transactions.

Regression coverage for these rules is in `tests/test_db_configuration.py`.

## Database list endpoints

Opening the Cell Database or Analysis Database should only read compact relational summaries. It
must not inspect source files, read Parquet caches, import the scientific stack, or recompute
capacity totals. `/api/cells` uses aggregate SQL and bulk metadata loading; avoid restoring
per-cell ORM traversal or serializer queries that create N+1 behavior.

Missing legacy capacity summaries may be backfilled after startup. Until ready, the UI should mark
those values as pending rather than block the whole list. Benchmark cold and warm list requests
when changing summary fields, and test semantic parity between list and detail responses.

Import source discovery is a separate synchronous request boundary: `POST /api/imports/list-sources`
must enumerate selected folders and return the candidate paths before the file-selection modal can
open. `backend/app/routers/files.py` uses one recursive `os.scandir` traversal and `DirEntry.stat`
metadata for this path; it must not parse Neware files, hash them, or rebuild scientific caches.
The first import modal and the folder-selection modal both use fixed-row viewport windows, so large
imports do not mount every file row during selection. When measuring this workflow, separate the
backend scan time from the second-modal render time and test both flat and nested local folders.

The second-to-third import-modal transition is a separate identity-inspection boundary. Its
`inspect-paths` endpoint uses at most four filesystem worker threads for independent hash/header
reads, restores the caller's path order before building the response, and never shares a
SQLAlchemy session with workers. Existing `SourceFile` identity rows are loaded once into an
eager, immutable match snapshot; matching then runs in memory rather than performing a full-table
query for every candidate. Each worker captures size and `mtime_ns` before and after inspection
and rejects a moving source. The inspection response carries the verified fingerprint and header
metadata so final registration can reuse the header only when the same fingerprint still matches;
final checksum and transactional duplicate checks remain mandatory. Folder layout should not
materially affect this boundary because it receives file paths after discovery.

Inspection is a per-file terminal boundary: source-level parser, metadata, or filesystem errors are
returned as failure outcomes for that path while other selected sources continue to the review
modal. The endpoint returns readable previews in `files` and `{path, filename, error}` entries in
`failures`, marks failed background-job items as excluded, and completes the inspection job after
every outcome has been accounted for. The UI keeps failed rows searchable, marks them with the
reported error, and removes them from selection and folder counts. Exceptions from the worker
executor itself still fail the request because they indicate infrastructure failure rather than a
bad source file.

The final import editor keeps preview work lazy: each staged draft owns an explicit idle/loading/
ready/error state, and only the active source may request a capacity preview. Preview requests carry
the inspection hash plus size/`mtime_ns`; matching fingerprints reuse that verified hash, while a
changed fingerprint is rehashed and rejected with a structured source-changed response when the
content differs. The frontend cache key is the content hash, so switching back to a ready source or
reopening identical content does not parse it again. Registration commits Cells first and returns a
separate background cache-job handoff; missing scientific caches remain `parsing` until the existing
cache worker marks them ready or reports a post-registration source error. The third-modal loaded-
file panel is a fixed-row viewport window with bounded overscan; do not restore a full
`drafts.map(...)` render for large imports. Preview requests are session-scoped and abortable, so
closing the modal must clear disposable drafts and invalidate late responses. The actual
`/api/imports/cells` submission returns `202` after atomically claiming its durable
`ImportSubmission` token; registration then uses its own `SessionLocal` worker transaction, while
cache preparation is a separate post-commit job and activity lifecycle. Separate-cell registration
does not run continuation timing or cache-dependent validation, and even a warm scientific cache
is handed to the post-commit worker rather than read inside the registration transaction. Cache
results are applied with `as_completed()` and committed per source; batches of 25 or fewer use the
serial path, while larger batches use at most four workers and at most half the logical CPUs.

The inspection response carries an identity proof only — `hash`, `size`, `mtime_ns` — never the
parsed header. The header is ~56 KB per file, so returning it cost ~58 MB to the browser and another
~58 MB back on submit for a 1,000-file import, for data the server already held. Inspection stores
every header it reads in `import_inspection`'s cache under the same `(hash, size, mtime_ns)` key and
registration reads it from there; registration still accepts a header in the payload so a modal
opened before the upgrade keeps working. That cache is bounded at `_HEADER_CACHE_LIMIT` (1024), so a
larger batch reopens the evicted files' headers at ~6 ms each. Do not try to pool that fallback:
header parsing is GIL-bound, and measurement puts a four-thread pool at 0.94x and a four-process
pool at 0.57x of serial.

Registration does **not** re-hash a submitted source. `_prepare_import_source_file` reuses the
inspected hash whenever size and `mtime_ns` still match, and a real 200-file registration performs
zero hash computations and zero header reads. The always-hashing
`_source_identity_snapshot_or_error` is reached only through `_validate_staged_source_snapshots` on
the continuation-attach path. Measured shares of the pre-commit path for 1,000 files: `scandir`
discovery 0.01 s, inspection hashing 0.89 s and header reads 1.60 s at four workers, Stage A ~1.4 s.

Cell deletion is a set operation, not a loop. `delete_cells_from_library` clears each dependent
table with one chunked statement for the whole batch and collects empty replicate groups **once** at
the end; `delete_empty_replicate_groups` uses a single aggregate query rather than a `COUNT` per
group. The per-cell form issued ~55,000 statements and took 8.7 s to delete 1,000 cells, almost
entirely because it re-scanned every replicate group for every cell; batching brought that to ~3,100
statements and 0.45 s. `delete_cell_from_library` delegates to the batch path so the single-cell and
multi-cell endpoints cannot diverge. Cells, sources, and replicate groups are still removed through
the ORM rather than bulk statements, because callers and tests hold those objects and must see them
leave the session. The residual per-cell reads are SQLAlchemy cascade loads on delete; they are not
worth removing with `passive_deletes` given the risk on a deletion path.

Cache removal for deleted sources happens **after** the relational commit and never blocks it. Above
`CACHE_CLEANUP_BACKGROUND_THRESHOLD` sources it becomes a `cache_cleanup` background job, because
1,000 sources is roughly 11 GB of Parquet; at or below it the work stays on the request so the
response can report the bytes reclaimed. Removal is I/O bound — stat every file, then unlink the
tree — so the job uses a four-thread pool, measured at 2.2x over serial on NTFS with little gain
beyond that. Threads rather than processes: the work never holds the GIL. Cleanup stays best-effort
in both paths; an orphaned cache is reclaimable by the normal cleanup action and must never make a
committed Cell deletion look like it failed. Offline or changed sources keep their cache because it
may be the only locally readable copy of that data.

Parsed file headers belong to `SourceFile.header_meta` as one JSON document per source, never
expanded into `CellMetadata` rows. `CellMetadata` is for Cell-level facts only: the curated header
summary, user entries, and `override.*` values. This is a hard performance boundary, not a
preference. A representative NDAX header carries ~977 fields, so flattening it onto the Cell put
~993,000 ORM inserts inside the registration transaction for a 1,000-file import: measured at 395 s
and 3.5 GB of peak Python memory, against 15 s and ~100 MB without it. Because imported Cells cannot
appear until that transaction commits, the expansion alone was what made a large import look frozen
with an empty Cell Database. Removing it took the real registration path from 20.16 s to 0.31 s for
200 cells. The ownership split is also the scientifically correct one: a continued Cell's sources
have their own start times, channels, protocols, and software versions, so a single merged header
misdescribes the Cell. Read a complete header through the per-source on-demand endpoint rather than
folding it into Cell detail, which would cost ~57 KB per source on every open.

Inspection strategy is adaptive at the second-to-third modal boundary: batches of 25 or fewer files
stay serial to avoid Windows process-pool startup overhead; larger batches inspect one first file as
a reusable timing sample, then use the bounded process pool for the remaining files. The inspection
job exposes `sampling`, `starting_workers`, `reading`, and `finalizing` phases. Raw file completion
stops at 90% so in-memory identity matching and response construction remain visible instead of
appearing stuck after all file reads finish. The estimate is approximate and uses the sample rate
and selected worker count; it is not a second benchmark pass.

The backfill must not assume that a per-cycle Parquet cache already exists. If a summary is
incomplete and the current cache is missing, it verifies the source against the stored checksum,
rebuilds the scientific cache at current parser/calculation versions, and then persists the
summary. A missing, changed, or unreadable source is a genuine per-source failure; absence of a
regenerable cache by itself is not.

The Projects explorer gets cell metrics from `/api/tree`. Keep that endpoint relational and
bounded too: cycle/capacity summaries and active-mass metadata are loaded in bulk for the complete
cell set, never through per-cell relationship traversal. Its capacity column is maximum specific
discharge capacity (mAh/g), resolved with the Cell Database precedence
`override → legacy metadata → source file`; raw mAh is tooltip context. Folder rows deliberately
have no scientific rollup because summing cycles across unrelated cells and choosing one subtree
capacity is not a meaningful sample statistic.

## Frontend startup summaries

`frontend/src/startupQueryPersistence.ts` persists only compact navigation summaries:

- cells with an empty search,
- analyses with an empty search,
- replicate groups,
- the folder tree.

Raw cycling data, analysis-compute results, previews, searched result variants, and cell details are
intentionally excluded. The snapshot is namespaced by database UUID and schema revision.

These four summary queries use infinite in-session `gcTime`. This is deliberate: React Query's
normal garbage collection once caused whichever page had not been visited recently to disappear
from the next startup snapshot. Once the backend reports ready, all four summaries are refreshed
together and the snapshot is flushed. A `pagehide` flush protects quick close/reopen cycles.

During background verification, cached rows remain visible. Connectivity failures and HTTP 5xx,
408, 425, and 429 responses are transient and retried. Permanent client errors are surfaced. A
pending or failed analysis query must never be represented as a genuine empty database.

Tests live in `frontend/tests/startupQueryPersistence.test.ts` and
`frontend/tests/apiRetryPolicy.test.ts`.

## Analysis plots and artifacts

Interactive plots may use WebGL for responsiveness, but saved thumbnails and portable-report
fallbacks are persisted artifacts. Updating a saved plot must invalidate and regenerate every
artifact derived from that plot's final figure and styling signature. Do not regenerate thumbnails
during every report export when the valid saved artifact already exists.

Plot cards that remember their rendered size for export settings must guard the `setPlotSize`
update by comparing width and height with the current state. Plotly's `onUpdate` fires again after
React rerenders; storing an equivalent new size object on every callback creates an update loop
that becomes visible when opening or closing the style panel resizes the plot. Follow the guarded
`rememberPlotDiv` pattern used by the Cycles and Time/Capacity cards.

The Analysis Database and Projects explorer render saved-plot counts and hover previews through
the same `frontend/src/features/analyses/database/AnalysisPlotSummary.tsx` component. It uses the dedicated 4:3
`variant=preview` asset, not the wide saved-row thumbnail. Keep preview presentation and cache
lookup behavior there rather than rebuilding a second hover card in another page.

Each saved plot has two lightweight, legend-free image derivatives stored in the same cache record:
a compact wide thumbnail for saved-plot rows and portable-report selection, plus a separately
laid-out 4:3 preview for analysis-database hover panels. Do not make a 4:3 preview by fitting the
wide portable SVG into a 4:3 canvas; Plotly must first re-layout the figure at 4:3 or the result is
only a letterboxed wide plot. The renderer writes WebP when the browser supports it and falls back
to PNG. A cache record is prepared only when both derivatives exist. A thumbnail-rendering change
must bump both
`SAVED_PLOT_THUMBNAIL_RENDER_VERSION` in
`frontend/src/features/analyses/editor/policies/analysisPlotPolicy.ts` and
`THUMBNAIL_CACHE_VERSION` in `backend/app/services/analysis_cache.py`. Prepared markers record the
backend version, so the idle coordinator requeues obsolete thumbnails while reusing an existing
full plot artifact whenever possible. The coordinator's cheap analysis probe must include that
renderer version; otherwise a previously completed all-ready scan can suppress the migration.
Likewise, a thumbnail embedded in an older full artifact is not proof that the dedicated current-
version thumbnail exists: rebuild from the cached SVG and complete warmup only after the versioned
thumbnail cache has been written.

Time/capacity views limit each displayed trace to a bounded number of representative points. CSV
exports and scientific calculations must not silently inherit display-only downsampling. Portable
reports keep serialized Plotly figures for interactive browsers and frozen SVG fallbacks for
restricted viewers. See `docs/portable-analysis-html.md`.

Compact time/capacity responses are specific to the selected X-axis and display mode: the backend
ships `display_x` plus only the raw X array needed for that request. Therefore the frontend query
signature must include every setting that changes those values, including `x_axis`, `time_unit`,
`display_mode`, and an electrode-area override. Excluding one while changing only the displayed
axis title produces a convincing but scientifically wrong stale plot. Areal capacity resolves the
cell's `electrode_area_cm2` metadata unless the analysis supplies a positive override; keep both
the metadata value and override in the scientific/cache inputs.

## Analysis workspace tabs

- The process-level mounted-analysis registry can outlive the `/analyses/*` route, but its React
  editor instances cannot. `AnalysisWorkspaceContent` must therefore initialize from only the
  currently visible analysis (or none on the database home), then remount restored hidden tabs in
  idle slices. Initializing directly from the global registry makes navigation back to the Analysis
  Database synchronously reconstruct every remembered editor before the home table can paint.

`frontend/src/features/analyses/workspace/AnalysisWorkspaceTabs.tsx` persists open analysis IDs,
labels, order, routes, and a bounded newest-first closed-tab history in local storage. Reordering
changes that persisted order. `frontend/src/features/analyses/workspace/analysisWorkspace.ts` keeps
editor drafts and the set of analyses visited during the current process in memory. React Query
remains the owner of fetched server data and computed-result caching.

The performance setting has two policies. `keep-mounted` is the default: analyses actually visited
in this session remain mounted but visually hidden without collapsing their layout, preserving
their Plotly/WebGL dimensions and state for fast switching. After a reload, the active editor paints
first and the analyses represented by restored open tabs are remounted one at a time during browser
idle periods. This repopulates their React and Plotly state without creating a simultaneous startup
spike. `unmount` keeps only the active editor mounted to reduce RAM and graphics-memory use. Never
persist editor drafts or mounted DOM state across app restarts.

Switching through the workspace tab strip is a context switch and preserves the in-memory draft.
Reveal the selected mounted view before synchronizing the React Router URL or refreshing stale
queries; doing route work in the click's first paint produces a perceptible 200-300 ms dead period
on large editors. Tab reordering uses explicit pointer tracking across the whole tab surface (apart
from the close button) rather than native HTML drag-and-drop, which is unreliable in Windows
WebView.

The tab families inside one analysis deliberately use a lightweight controlled header separate
from the expensive panel container. The header acknowledges selection in its own render, then
commits the panel switch after that paint. Do not recombine their state into one Mantine `Tabs`
root: building the next Plotly/settings panel otherwise delays the selected-tab underline. Keep
inactive panels unmounted except for the explicitly retained time/capacity view; mounting every
hidden Plotly panel previously caused freezes and unnecessary graphics-memory use.
Steps, DCIR, Chargeability, Rate Capability, and Time/Capacity own dedicated scientific queries.
The generic cycle query must stay disabled while any of those tabs is active; otherwise a
saved-plot change starts an unrelated cycle computation beside the visible request. Their query
observers should retain previous data during a key change, and a delayed loading indicator should
appear only when no plot is available.
Within a newly mounted analysis family, the live plot has request priority. Saved rows may look up
and display already-cached thumbnails immediately, but missing saved-plot computations are admitted
sequentially during idle time only after the live plot is ready. Do not prefetch every thumbnail
ahead of the live compute: on a cold cache that makes the visible plot wait behind work the user did
not ask to see yet.
Closing a tab or leaving the analysis workspace uses the normal unsaved-change flow. Open tab
identities survive reload/restart, but unsaved editor drafts intentionally do not. Tests for the
storage parser live in `frontend/tests/analysisWorkspace.test.ts`.

Source changes must not make every hidden mounted editor recompute at once. Invalidate all
analysis-related React Query entries without refetching, refresh the visible analysis immediately,
and refetch a stale hidden analysis when its tab is activated. The backend remains responsible for
invalidating affected artifacts and queuing saved-plot warmup.

## Cache tiers, budgets, and background preparation

The cache has two independently budgeted tiers:

- **Scientific cache**: parsed raw and per-cycle Parquet data under the versioned cache root.
  It is keyed by source checksum and can be rebuilt only while the corresponding source file is
  available. Reads update the cache file timestamps; scientific budget cleanup therefore uses
  access-aware LRU rather than creation time.
- **Analysis cache**: computed analysis results and full plot artifacts. These are always
  regenerable from the database plus scientific cache/source data. Saved-plot thumbnails and their
  indexes are deliberately excluded from normal LRU pruning because they are small and provide the
  immediate library/editor experience.

The persisted policy and inventory API live in
`backend/app/services/cache_maintenance.py` and
`backend/app/routers/cache_management.py`. Defaults are 10 GB for scientific data and 1 GB for
analysis data; both can be changed or made unlimited in Settings. Automatic cleanup must never
remove the SQLite database, imported/source files, or a scientific cache whose source is offline.
The UI may allow an explicit, separately confirmed cleanup of an offline scientific item.

A Stable-to-Beta database snapshot deliberately excludes `cache/`. Staging writes the durable
`beta.scientific_preparation` setting into the copied database. After activation, the normal
background backfill uses that marker to prepare every missing current-version scientific cache,
reports file-count progress through the background-job registry, and marks the pass complete.
Before React renders, the Tauri setup gate reads this setting directly from the copied SQLite
database, so normal library content cannot appear interactive before the preparation surface.
The surface remains locked by default for this one-time pass, but the user may explicitly continue
in the background. While the blocking setup surface is open, only this copied-library pass may use
a bounded normal-priority process pool: at most half the logical CPUs and never more than four
files at once. `POST /api/beta-bootstrap/preparation-background` is a one-way drain request. It
stops new pool submissions, lets already-running cache writes finish, then continues the remaining
queue serially on a below-normal-priority thread. Worker processes never own SQLAlchemy sessions;
the coordinator alone commits source metadata and progress. Ordinary startup repair and
Settings-triggered scientific preparation stay serial and below normal from their first item.
An interrupted `pending` or `running` marker is resumable and gates the next launch again.
Ordinary later startups repair incomplete summaries only; they do not recreate a ready cache that
the user intentionally cleaned.

Settings exposes category actions with different safety boundaries:

- **Clean eligible** scientific data removes only orphaned or currently regenerable caches and
  preserves offline/changed or actively written entries.
- **Prepare missing** verifies sources and rebuilds absent current-version scientific caches.
- Deleting a Cell removes its now-unregistered online `SourceFile` rows and their scientific
  caches after the database commit. Offline or changed sources remain registered as detached
  source records so their cache remains available; the original source file is never deleted.
- Thumbnail cleanup removes both image payloads and their lookup indexes atomically from the
  user's perspective; rebuilding them clears prepared markers and reuses the saved-plot warmup.
- A full saved-plot rebuild clears numerical results, plot artifacts, thumbnails, and prepared
  markers before forcing a fresh bounded warmup scan. It does not attempt to enumerate arbitrary
  unsaved plot configurations.

`frontend/src/features/analyses/editor/artifacts/CacheWarmupCoordinator.tsx` performs opportunistic preparation after an
idle delay. It requests one saved plot at a time, renders through the same analysis preview path,
and reports progress as a normal background job. Backend compute work from this path uses reduced
Windows thread priority. Browser/GPU thumbnail work cannot receive OS process priority, so it is
kept serialized and starts only while idle; the optional desktop-only policy restricts work to a
hidden window. Returning to the app prevents another item from starting but does not abandon the
item already in flight.

Warmup is resumable rather than a durable queue: on the next scan, plots whose fingerprint still
matches a completed run are skipped, while changed analyses or missing cache artifacts are offered
again. Any change to the saved-plot fingerprint inputs must be reflected in the coordinator so
stale plots are not treated as prepared.

The queue itself is built server-side from per-plot "prepared" markers
(`analysis_cache.load_prepared_marker`): a marker records the data signature and plot
`modified_at` the plot was last prepared for, written both when an artifact is stored and when a
warmup task completes ready. A plot whose marker still matches is left out of the queue entirely,
so saving one new plot yields a one-item job instead of a pass over every saved plot, and an
all-prepared scan must not spawn an empty job. Markers are wiped by
`invalidate_cell_dependents`, by per-analysis artifact cleanup, and by the visual cache category
cleanups (but not by cleaning computed results, which does not affect plot preparedness).

Treat prepared markers as hints rather than proof that the image payloads exist. Queue discovery
must verify that both the saved-row thumbnail and 4:3 hover preview are physically readable before
skipping a plot. On the frontend, do not publish a newly rendered warmup thumbnail into React Query
or report the task complete until the authorized backend artifact write succeeds. Publishing it
first creates a race where completion retires the warmup token and the following store request is
rejected, leaving a matching marker with no persisted images.

Analysis cache keys cover the scientific inputs only. Source `location_status` is deliberately
excluded: results are computed from the cached Parquet, which transient offline/changed flips do
not touch, so a drive reconnect or a still-cycling source file must not invalidate every cached
result for the cell. Availability badges are therefore refreshed at response time from the
database status fields (`analysis_engine.refresh_availability_badges`) whenever a cached result
is served. Warmup tasks must never recompute a plot whose thumbnail or artifact is already
cached; the background compute is gated exactly like the visible preview path.

When one analysis endpoint changes its cached response schema, bump only that entry in
`analysis_cache.RESULT_SCHEMA_VERSIONS`. The per-kind schema version is part of `result_key`, so
legacy payloads cannot be mistaken for the new result shape without invalidating unrelated cycle
or time/capacity caches. Reserve `ANALYSIS_CACHE_VERSION` for changes that genuinely affect every
analysis result family.

When a source file adopts new bytes, its scientific and numerical analysis keys change naturally
because they include the source checksum. In addition, `cache_maintenance.invalidate_cell_dependents`
must remove visual artifacts and direct thumbnail indexes for every analysis that references the
cell either directly or through a replicate group. It then queues only those saved plots for idle
warmup. Do not invalidate every analysis globally. The same invalidation runs (with
`reason="cell_edit"`) when cell properties that enter the cache key change: name, archived flag,
and the mass/capacity/area overrides. Notes and display-only preset fields must not trigger it.
Editing such a cell property without invalidating would leave saved-plot thumbnails permanently
stale, because the thumbnail index is keyed by the client signature alone.

Two hot paths are intentionally incremental rather than re-scanned per call: the warmup
coordinator's `start()` short-circuits on a cheap analyses probe (count + latest `modified_at`)
before re-fingerprinting every plot, and its job fingerprint uses per-plot `modified_at` so an
analysis autosave that does not touch saved plots cannot spawn a new warmup job. Direct data
changes bypass the probe via `enqueue_analyses`. The analysis-cache budget keeps a running size
total adjusted on every store/unlink; the full directory walk happens only when the total says
the budget overflowed, and the periodic maintenance loop resets the total to self-heal drift. After the replacement source has parsed and its
new Parquet cache is durable, remove the previous source-checksum directory immediately; no
`SourceFile` references it anymore. Preserve that old directory when replacement parsing fails so
recovery remains possible. Old checksum-keyed multi-cell analysis results remain harmless and are
removed by normal LRU cleanup.

Every source-triggered warmup task carries the analysis modification timestamp and exact scientific
data signature that existed when it was queued. Validate both before rendering and again before
storing a generated artifact. Multiple source changes may leave older generations in the queue;
skip those generations and retain the newest one. If the user opens and successfully prepares a
queued plot first, retire its matching idle work. Deleted analyses/plots are skipped rather than
treated as failures. These rules prevent a slow background render from writing old data under a
new cache identity.

Idle warmup uses a finish-current-then-pause policy. User activity requests a pause, but an active
plot render is allowed to complete atomically. The background job then changes to `paused`, which
removes it from the header progress indicator while retaining its queue and progress. After the
configured idle interval the frontend resumes the same job. Do not cancel an in-flight render or
mark a paused queue as completed.

## Serving a cached analysis result

A cache hit must not pay for the payload twice. Results are stored as an immutable body plus a tiny
badge sidecar (`<key>.meta.json` beside `<key>.json.gz`), and `analysis_cache.splice_result_body`
prepends `cache_status` and `badges` onto the stored bytes without parsing them. `badges` is the
only part of a cached result that must never be replayed as stored: source-availability badges are
rebuilt from current database status on every response by `analysis_engine.availability_badges`.

Rules that keep this correct:

- Entries written before the split have no sidecar. `load_result_body` returns `None` for them so
  the caller falls back to parsing, and `upgrade_result_format` rewrites them. A backfill is
  mandatory for any change to stored cache layout: a warm cache never recomputes, so without one an
  existing install gets no benefit at all.
- Sidecars must be deleted with the body they describe. `_budget_files()` globs only `*.gz`, so
  anything else added beside a cached result is invisible to both pruning and the reported cache
  size and will orphan unless handled explicitly.
- Endpoints returning large payloads should return a `Response` built with `orjson`
  (`app/responses.py:fast_json`). Returning a bare dict makes FastAPI walk the whole structure with
  `jsonable_encoder` and then serialize it again.

## Warm-path costs on an analysis

Verified on a 25-cell database with ~40k metadata rows. When a warm analysis feels slow, check these
before looking anywhere else:

- **Scalar metadata reads.** `cell_active_mass_mg` and friends must never touch
  `cell.metadata_entries`; that loads every metadata row for the cell. Use
  `analysis_engine.load_scalar_metadata` for a selection, or the targeted per-cell query.
- **Relationship walks.** `cell_ordered_hashes` walks `cell.tests -> file_links -> file`, which is
  ~7 lazy queries per cell. `analysis_engine.preload_cell_sources` fetches the chain for a whole
  selection in one round trip with `header_meta` deferred — that column holds raw instrument headers
  and is only read when reconstructing protocols during a real compute.
- **Cache-key construction.** `result_key` runs before any cached bytes are read, so anything
  expensive inside it is paid on every request including hits.

Changing how `result_key` gathers its inputs is unusually unforgiving: a fingerprint that changes
for the same data invalidates every cached result (loud, harmless), but one that stops distinguishing
two different datasets serves a cached result for data it no longer describes (silent, wrong).
Verify any such change by recomputing keys both ways across every analysis and asserting the digests
are byte-identical before trusting it.

## Presentation filters versus computation

`computeSignature` deliberately excludes `presentation`, so anything placed there costs no recompute
and no cache invalidation when toggled. Display-only filters belong there —
`presentation.hide_diagnostic_cycles` is the worked example.

Two rules follow:

- Filter the computed result once, before building traces, rather than at each trace. Capacity,
  coulombic efficiency, the replicate band and the below-minimum-n markers all read the same arrays,
  so filtering upstream makes "every quantity drops the same cycles" true by construction.
- `viewSignature` gates the trace memo. Any presentation field that changes *what is plotted* — not
  just how it looks — must be added there, or the plot will silently not update while the rest of
  the UI reacts normally.

## Measuring before optimizing

Separate these costs when profiling:

- sidecar extraction and Python import time,
- database migration and list-query time,
- Parquet/cache reads and scientific computation,
- JSON transfer and parsing,
- Plotly trace construction and browser rendering,
- thumbnail or export serialization.

A small exported CSV does not imply a cheap interactive plot: browser objects, multiple traces,
hover data, layout calculation, and GPU/DOM work can dominate the compact textual payload.
