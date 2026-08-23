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
ready/error state, and only the active source may request an ordinary per-source capacity preview.
Preview requests carry the inspection hash plus size/`mtime_ns`; matching fingerprints reuse that
verified hash, while a changed fingerprint is rehashed and rejected with a structured source-changed
response when the content differs. The frontend cache key is the content hash, so switching back to
a ready source or reopening identical content does not parse it again. The continued-chain combined
preview is prepared automatically once the continued editor has at least two sources: the existing
inspection worker polls in the background, then one abortable combined-preview request reads the
already prepared ordered per-source caches through backend stitch semantics. The workspace defaults
to a display-only stitched interpretation that reads raw caches and infers contiguous
charge/discharge cycles; the explicit Source chain interpretation keeps the authoritative per-source
cycle mapping. Both interpretations return bounded display data without creating a second scientific
cache, and the selected voltage/capacity quantity is a request/display choice rather than a change
to scientific cache meaning. Voltage preview uses raw elapsed-time rows and remains available when
cycle summaries are unavailable; raw-data inspection is gated by raw-row availability, not by the
canonical cycle-analysis capability flag. Registration
commits Cells first and returns a separate background cache-job handoff; missing scientific caches
remain `parsing` until the existing cache worker marks them ready or reports a post-registration
source error. The third-modal loaded-file panel is a fixed-row viewport window with bounded
overscan; do not restore a full `drafts.map(...)` render for large imports. Preview requests are
session-scoped and abortable, so closing the modal must clear disposable drafts and invalidate late
responses. The actual
`/api/imports/cells` submission returns `202` after atomically claiming its durable
`ImportSubmission` token; registration then uses its own `SessionLocal` worker transaction, while
cache preparation is a separate post-commit job and activity lifecycle. Separate-cell registration
does not run continuation timing or cache-dependent validation, and even a warm scientific cache
is handed to the post-commit worker rather than read inside the registration transaction. Cache
results are applied with `as_completed()` and committed per source; batches of 25 or fewer use the
serial path, while larger batches use at most four workers and at most half the logical CPUs.

Folder tracking for a continued Cell is also scheduler-owned. `source_monitor._run_scheduler()`
runs the bounded folder-watch pass only after the global source check and only when automation is
not paused and no source-check or background job is still running; do not add a per-Cell watcher
thread or a second scheduler. Each watch keeps its scan and candidate state in the database, so
stability, malformed-source, ordering, and continuation-review failures survive restart. At watch
creation, matching files already present but not selected are persisted as visible `ignored`
baseline candidates; only a file first observed after creation enters automatic attachment, while a
user can explicitly retry a baseline candidate. A stable candidate is still inspected through the
normal import-inspection path and attached through the existing continuation lifecycle; the watcher
must not create a parallel registration or cache identity. Settings previews may enumerate matching
paths, but they must not hash, parse, or attach files.

The inspection response carries an identity proof only — `hash`, `size`, `mtime_ns` — never the
parsed header. The header is ~56 KB per file, so returning it cost ~58 MB to the browser and another
~58 MB back on submit for a 1,000-file import, for data the server already held. Inspection stores
every header it reads in `import_inspection`'s cache under the same `(hash, size, mtime_ns)` key and
registration reads it from there; registration still accepts a header in the payload so a modal
opened before the upgrade keeps working. That cache is bounded at `_HEADER_CACHE_LIMIT` (1024), so a
larger batch reopens the evicted files' headers at ~6 ms each. Do not try to pool that fallback:
header parsing is GIL-bound, and measurement puts a four-thread pool at 0.94x and a four-process
pool at 0.57x of serial.

BioLogic MPR inspection follows the same bounded boundary: `read_mpr_header()` and
`read_gcpl_header_metadata()` walk module declarations and column metadata without constructing
the record-sized NumPy array. Full structured decoding belongs only to cache preparation/full parse.
The MPR reader has no inner process pool; large import batches use the existing outer bounded worker
policy. Keep header/full-parse timings descriptive and test the separation with synthetic files, not
by turning header inspection into a second full parse.

Structured Neware Excel parsing uses a reader ladder in `backend/app/services/neware_excel.py`:
`fastexcel` performs the primary full-width columnar read, pandas' `calamine` engine is the
validated middle fallback, and the existing read-only openpyxl path is the compatibility fallback.
All three paths resolve the same explicit header aliases, reject ambiguous or malformed rows, and
produce the same canonical frame and step-summary validation; the parser revision must change when
those semantics change. `backend/requirements.txt` pins both native readers so the packaged sidecar
does not silently drift. Keep a synthetic exact-frame parity test for each available fallback and
benchmark at least one representative large workbook when changing this ladder. On the supplied
301k-row export, the measured calamine path was ~24 s versus ~85 s for openpyxl, while fastexcel is
the faster primary path; this is still parsing work and belongs outside the registration transaction.

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

Since Spec 040.4, the compact response's `voltage_v` array (still that key regardless of the
selected channel — see `docs/agent-knowledge/canonical-cycling-data.md`) holds whichever canonical
voltage column `computation.time_capacity.voltage_channel` selects
(`voltage`/`working_potential`/`counter_potential`). This is a scientific input exactly like
`x_axis`, so `voltage_channel` must be in the frontend query signature too — omitting it would
reuse a cached primary-voltage response after the user switched to an electrode potential.
The frontend keeps that full `dataSignature` as the fetch/cache identity and carries a second
`timeCapacityCompatibilitySignature` in the React Query key. Only cycle-window and point-density
changes reuse the previous result as placeholder data; changing selection, protocol filtering,
coordinate/unit/display meaning, normalization, voltage channel, or derivative semantics clears
the old visible result until the new response arrives. Both live and saved Time/Capacity POSTs
consume React Query's abort signal, while backend synchronous work remains outside the browser
cancellation guarantee. A retained placeholder is display-only: plot/image/vector export stays
disabled until the current query resolves, while the separate data-export path requests and validates
full-resolution data for the current identity.

Spec 050.1 also makes `analysis_cache._scientific_spec(spec, kind)` an explicit dependency
projection. Cycles owns its generic calculation/filter/aggregation settings, Time/Capacity owns
its dedicated settings plus the generic cycle-range fallback and protocol filtering, Steps owns
its series and shared protocol targets, DCIR owns its private segments and series, and
Chargeability/Rate capability own their respective recognition settings. Shared selection and
the documented protocol-filter/segment inputs remain in the families that actually consume them;
presentation-only fields and unrelated computation blocks do not. `ANALYSIS_CACHE_VERSION` is
bumped for this identity-generation change; `CALC_VERSION` and response schema versions remain
unchanged. Unknown result kinds fail closed instead of falling back to a broad whole-spec hash.

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
An ordinary editor autosave is a persistence update, not a scientific invalidation: its returned
`AnalysisFull` is written directly to `['analysis', analysisId]` and `['analyses']` is invalidated
for compact index metadata. Source/cell/scientific mutations continue to use the broad scoped
invalidation helper. Saved-plot create/update/delete paths retain their explicit artifact,
thumbnail, prepared-marker, and preview lifecycle rather than depending on autosave side effects.
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

Spec 050.2 keeps the parser-versioned `raw__p<parser>.parquet` file as the one canonical raw
dataset and gives newly written/prepared files a separate physical access sidecar:
`raw_index__p<parser>__l<layout>.json`. `cache.RAW_CACHE_LAYOUT_VERSION` describes only that
row-group/index format; it is independent of `CANONICAL_RAW_VERSION`, parser identity,
`CALC_VERSION`, and analysis-result generations. The sidecar records exact observed source-local
cycle labels, row-group membership (including cycles spanning multiple groups), raw schema/shape
metadata, finite full-source availability for each canonical voltage quantity, and bounded timestamp
start/end facts. For ordinary consecutive Time refinement, the sidecar also stores per-cycle raw
start times and cumulative reset offsets so an indexed later-cycle read can retain the canonical
Time origin without loading preceding rows. It never stores source paths. `cache.load_raw_cycles()` returns exact requested
cycle rows after filtering the selected groups and exposes deterministic group/row/column
diagnostics; a missing or invalid sidecar is a layout fallback, not a scientifically missing raw
cache. Existing `load_raw()` and `load_raw_columns()` remain the compatibility readers.

The deliberate raw writer uses 4,096-row Parquet groups. This was selected under the pinned
`pyarrow 24.0.0` runtime from the approved `cycles_time_steps.ndax` regression source (71,190
rows, 193 observed cycles): the legacy writer produced one group; 4,096/8,192/16,384-row
prototypes produced 18/9/5 groups. The 4,096 layout physically selected 4,096 rows for one
cycle, 12,288 for the first 20 cycles, 57,344 for a 150-cycle range, and 71,190 for all cycles,
with about 0.3% file-size growth. Write timings varied across profiling runs, so the target was
chosen for the bounded structural read reduction rather than a single wall-clock result. It is
not a scientific constant or a cache-key input. `scripts/profile_raw_cache_layout.py` repeats the
baseline/candidate comparison.

Legacy raw caches are converted from Parquet bytes alone by the existing background scientific
preparation path. Conversion stages and parity-checks a temporary candidate, removes any old
sidecar before atomically replacing raw bytes, and publishes the validated sidecar last; a failure
leaves the old raw file readable and falls back to full reads. The existing per-hash cleanup
protection covers conversion, and sidecars/temporary artifacts stay inside the checksum directory
so scientific inventory, budget, LRU touches, and deletion remain authoritative. Offline sources
may be converted without their original path, while layout-only failures do not change
`SourceFile` lifecycle, parser, cycle, or capacity-summary fields. Normal startup only selects
compact raw-layout candidates for the already existing bounded background preparation worker; it
does not rewrite Parquet on a list/request path.

Spec 050.3 consumes that sidecar through `time_capacity_path.py`. Time/Capacity first builds the
dense global continuation map from each ordered source's observed-cycle list, then resolves the
requested global cycles before reading raw records. The indexed path calls `cache.load_raw_cycles`
only for contributing sources, projects the canonical fields used by the existing scientific
helpers, removes row-group spillover before transforms, and obtains full-source voltage
availability and descriptor timestamp bounds from index facts. It retains `stitch_raw()` as a
whole-Cell fallback for valid legacy/unusable layouts; a missing raw cache remains fail-closed and
never becomes a legacy fallback. The optional `compute_time_capacity(...,
access_diagnostics=...)` hook is test/profiler-only and is not part of the response payload. The
request path probes the raw-layout consistency boundary without waiting for background conversion;
when that boundary is busy, it uses the canonical legacy reader, and indexed row reads use the
same non-waiting boundary so a conversion that starts after planning falls back safely as well.
Range endpoints are clamped to the known dense global-cycle bounds before a request tuple is
materialized, so stale extreme saved endpoints cannot create work proportional to their numeric
distance from the Cell's actual cycles.

Spec 050.4 adds a local-only observation boundary around the live Time/Capacity card. Profiling is
disabled by default and is enabled for a session through
`window.cellxplorerPerformance.timeCapacity.enable()`; the helper retains at most 100 completed
records and exposes `reset()`, `records()`, and `exportJson()`. A record is closed only after the
current non-placeholder result has produced trace/layout props and the `react-plotly.js`
`onInitialized`/`onUpdate` callback completes. React Query data-signature changes supersede the
previous identity, so late HTTP or Plotly callbacks cannot close a newer record. The backend
accepts the profiling flag without adding it to the scientific cache key and returns a namespaced
`profiling` block only for that request; ordinary responses and persisted result bodies remain
unchanged. The block aggregates the existing 050.3 stage, row-group, selected-row, and returned-
point diagnostics without source paths, hashes, raw rows, or full specs. This boundary separates
backend compute/serialization and HTTP time from browser preparation and Plotly completion; it is
an instrumentation contract, not evidence that another optimization child is needed. The exported
record keeps `selection_count` as selection-entry count, `resolved_cell_count` as the unique
resolved Cell/unit count, and `trace_count` as the separate Plotly trace count. A result served from
the current React Query memory cache is marked `response_source: "react_query_memory"`, has zero
HTTP time, and does not inherit backend cache/access/timing facts from the older response; only a
real server response is marked `response_source: "http"`.
The profiling response path serializes a miss's scientific body once, appends the small profiling
object, and patches self-referential timing/byte numbers in the final bytes; a persisted hit uses
the existing body-splice path. Profiling therefore does not repeatedly encode a large result and
misclassify that extra work as HTTP or frontend time.

Spec 050.6 adds an optional, regenerable Time/Capacity derived sidecar owned by
`backend/app/services/cache.py` and the dependency-free
`backend/app/services/time_capacity_derived.py`. Each source-local row stores only
`record_index`, `cycle`, a stable `phase_code` (`0` rest, `1` charge, `2` discharge), and the exact
`phase_capacity_mah` vector. Its versioned index binds the payload to the source parser identity,
current `CALC_VERSION`, `CANONICAL_RAW_VERSION`, `RAW_CACHE_LAYOUT_VERSION`, raw shape fingerprint,
row/group counts, and physical schema/fingerprint; raw replacement invalidates every matching
prepared generation before publishing new raw bytes. Preparation uses the already validated raw
Parquet (or the in-memory frame at a normal cache build), is protected by the existing checksum
cleanup boundary, and is also reachable through the existing scientific-preparation worker for
offline current raw caches. A deliberately cleaned raw cache is not recreated only for this
optimization.

The indexed Time/Capacity path selects the same source-local cycle groups for raw and, when the
request consumes prepared values, derived reads. It accepts prepared values only after all
contributing sources pass metadata and row identity/order validation; a missing, stale, corrupt,
busy, or partially available sidecar returns immediately to the exact request-side phase/capacity
helpers for the whole Cell/unit. Prepared reads use a non-waiting raw-layout boundary, touch both
payload and index on success, and add no ordinary response fields. `TimeCapacityTransformNeeds`
is the dependency contract: compact Time-axis Voltage/Current skips phase-capacity, specific, and
areal arrays and intentionally does not open the phase-only sidecar; it computes phase from the
already-selected raw rows and reports `derived_access: not_needed`. Compact capacity and derivative
requests read only the exact prepared vectors they consume; full/non-compact responses retain all
existing arrays. The shared phase/capacity owner is important: cache preparation and fallback cannot
drift scientifically. During a write-behind publication, the owner skips only its own pending-thread
join so it can publish the in-memory sidecar; external readers still wait for the complete raw,
cycle, index and derived publication boundary. Focused parity and golden tests are the evidence
boundary; profiler output must keep raw/prepared group counts and phase/capacity source facts
separate from wall-clock claims.

Spec 050.7 keeps derivative science in `analysis_engine._derivative_curve()` unchanged while
removing two repeat costs: explicit-CV status is classified once for the selected frame through
`calc.status_matches()`, and contiguous `(cycle, segment, phase)` boundaries are computed once
before the exact per-run numerical kernels. The bounded derivative profile therefore reports a
separate `status_classification` stage alongside scan, prepare, rolling, gradient, ratio, and
postprocess. Any later derivative optimization must preserve the status mask's row-local behavior,
the exact run counters, committed golden digests, and the existing frontend trace-count evidence;
the derivative arrays are not a persisted cache or a new scientific version boundary.

Spec 050.11 composition evidence keeps the production path unchanged and selects **C — sequential
Rust kernel** as the only later architecture candidate. On the verified fixture plus real saved
Performance-analysis batch, a resident one-worker Rust boundary reduced broad 1/6/10-Cell dQ/dV
complete-backend time versus the current Python derivative path by 55.61%. Moving that same
composition to four Rayon workers added only 0.46% at the complete boundary, while a two-thread
indexed-read pool added 0.56% and the combined read/Rayon candidate improved over Rayon-only by
1.74%; pre-native transformation, native-buffer materialization and remaining Python assembly
dominated. Serialization was measured separately and excluded from every backend-wall comparison.
Normal Time/Capacity remained faster on the current Python/NumPy path by 3.49%, and small controls
did not justify unconditional dispatch. The corrected composition path performs one scientific
pre-native preparation pass, one native-buffer materialization pass and one coarse Rust request
per candidate while preserving exact output/order parity. Any 050.12+ implementation must
therefore gate a resident sequential native derivative path narrowly, retain the Python fallback
and exact output/order parity, and must not infer a production benefit for read threads, whole-Cell
Python threads, multi-worker Rayon, persistent Python processes, cache layout, or frontend/Plotly
behavior from the benchmark. The reproducible composition harness is
[`scripts/profile_time_capacity_composition.py`](../../scripts/profile_time_capacity_composition.py)
and its decision record is [`050.11-execution-strategy-composition-and-decision.md`](../specs/050.11-execution-strategy-composition-and-decision.md).

The repeatable `scripts/profile_time_capacity_path.py` matrix on the approved 71,190-row golden
source recorded the following medians under the pinned local runtime (wall time is descriptive,
not a universal threshold):

| request | path | groups | raw rows materialized | selected rows into transforms | returned points | peak traced memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 cycle | legacy | full read | 71,190 | 2,590 | 2,590 | 8.05 MB |
| 1 cycle | indexed | 1/18 | 4,096 | 2,590 | 2,590 | 2.06 MB |
| 20 cycles | legacy | full read | 71,190 | 10,611 | 10,611 | 8.79 MB |
| 20 cycles | indexed | 3/18 | 12,288 | 10,611 | 10,611 | 8.80 MB |
| 150 cycles | legacy | full read | 71,190 | 56,044 | 56,044 | 45.84 MB |
| 150 cycles | indexed | 14/18 | 57,344 | 56,044 | 56,044 | 45.85 MB |
| all cycles | legacy | full read | 71,190 | 71,190 | 71,190 | 61.96 MB |
| all cycles | indexed | 18/18 | 71,190 | 71,190 | 71,190 | 61.97 MB |

Indexed and legacy payload sizes and scientific projections were equal for the matrix. The
one-cycle request also bypassed `load_raw()` entirely and reduced the measured backend median from
0.145 s to 0.115 s; broader requests are dominated by the unchanged scientific transforms and
JSON serialization, so their physical row/group reduction is the durable performance boundary.
The reserved 050.4 child is not justified by this backend evidence: no overview cache, RAM LRU,
prefetch, or frontend rendering optimization belongs in 050.3, and the profiler records that a
browser/Plotly manual profile was not run.

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

Since Spec 042, the same ordinary startup backfill also brings forward any parsed source whose
stored `SourceFile.parser_version` is behind `parsing.current_parser_identity_for_extension(sf.ext)`
— unconditionally, independent of `prepare_missing` — because `cache_maintenance.py` never writes
`parser_version`, so a mismatch can only mean an application upgrade changed the expected identity
(039's bundle change and 040.3's per-source identity both did this to the whole library at once),
never a deliberate clean (which leaves `parser_version` at the still-current identity with the
cache files simply absent). `scanner._needs_identity_bring_forward` is the relational, no-file-I/O
predicate; a source already excluded by `location_status != "online"` (proven unreachable/changed by
this backfill's own failed attempt, by `analysis_engine`, or by scan/monitor activity) is left alone
rather than retried every startup. A source pulled in only for this reason keeps its "ready"
`capacity_summary_status` rather than being flipped to "pending": its already-computed totals stay
truthful while only its preview cache rebuilds, and flipping it risked landing on "error" (blanking
a cell's totals) for a permanently unreachable source purely because the rebuild attempt failed.
This only brings a source's own registration forward to a fresh current-identity build; it is
unrelated to — and must never be confused with — the `analysis_engine` reparse gate below, which
protects a saved analysis pinned to an older identity. Both caches coexist under different
identity-keyed filenames (`cache.raw_path`/`cache.cycles_path` never touch another identity's file),
so a preparation pass rebuilding a source's current-identity cache cannot disturb a pinned analysis
still rendering from its own older-identity cache.

One exception is an adapter identity that has been scientifically withdrawn. Before the ordinary
parsed-source work set is selected, startup reconciles persisted BioLogic `bm:gcpl3:r1` and
pre-R8 `bm:gcpl4:r1` rows in one bounded extension-plus-identity query. It does not open source or
cache files, and it includes offline rows. A gcpl3 row becomes current `bm:gcpl8:r1`
metadata-only state, with live cycle and capacity fields cleared. A gcpl4 row becomes current
`bm:gcpl8:r1` only when its stored data header proves the observed 16-ID/53-byte layout; a
withdrawn 15-ID/49-byte or unrecorded/ambiguous layout instead clears the parser identity and
marks the row metadata-only with `requires_reinspection=true`. Old caches remain non-live forensic
material. The same retired/pre-R8 capability check is part of the shared source boundary, which
prevents pinned analysis resolution or any cache-backed scientific consumer from using stale data
if it runs before that startup pass.

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
is served. The persisted canonical-cycling capability gate also applies to saved-artifact and
thumbnail reads/writes, warmup queue discovery, active-task admission, and completion: a source
retired to metadata-only cannot expose old visual bytes or record a prepared marker, including
when retirement races a browser render that was already admitted. These cache-hit guards use the
source's scalar parser identity/status/error state and leave the large deferred header untouched.
Warmup tasks must never
recompute a plot whose thumbnail or artifact is already cached; the background compute is gated
exactly like the visible preview path.

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

Spec 050.16 extends the immutable body/sidecar response path to Steps, DCIR,
Chargeability, and Rate Capability. Modern exact hits still perform the
request-local owner resolution needed to derive the key and current
availability badges, but they do not parse the stored scientific body, call a
family compute service, or read raw Parquet. On misses, the router builds one
request-local `AnalysisRequestContext` and shares its selection units, ordered
source files, parser identities, and scalar metadata with the cache key and
family service; direct service callers retain the resolving fallback.

The raw-layout sidecar may also carry an optional `step_to_row_groups` map.
Steps and DCIR use it only when the current sidecar is valid and ready; missing,
legacy, corrupt, or busy detail metadata falls back immediately to the full
raw reader. Current sidecars pair the map with bounded per-row-group step facts
and a detail fingerprint, and the non-waiting raw-layout lock stays held from
index validation through Parquet row-group filtering. The detail reader
preserves source cycle labels, timestamps, and record-index gaps so protocol
occurrence/block boundaries remain identical.
Chargeability and Rate Capability remain on their existing full raw path when
their measured materialization cost does not justify selective access. These
protocol-derived families continue to fail closed for multi-source Cells.

Spec 050.17 adds the repeatable cross-family measurement boundary used before
selecting another optimization: call the real family route in a disposable golden
fixture, report forced result-cache misses and exact persisted-body hits separately,
and keep nested helper timers out of the sibling-stage reconciliation. Source-distinct
content-identical Cell clones are acceptable for scaling only when their relational
Cell/SourceFile/TestFile rows and cache identities are real. The authoritative child
matrix covers Cycles, Steps, DCIR, Chargeability and Rate Capability; Time/Capacity's
existing opt-in request profile remains reference evidence rather than a new ranking
input. The profiler preserves observed timer parent/child edges plus inclusive and
exclusive elapsed values, and retains bounded SQL counts/timing without query text or
parameters. Rate Capability's `compute(..., profiling=...)` hook is opt-in only and
exposes execution-parent children for measurement grouping, phase-row filtering,
cutoff validation, capacity/current/rate extraction, candidate selection,
invalid-neighbour validation and result assembly without changing scientific results
or ordinary cache identity.

Spec 050.18 keeps Rate Capability serial and request-local. For each loaded raw
source, `rate_capability._ExecutionIndex` owns bounded step, cycle/step and
measurement-group position lookups, the `_ordered()` row rank, and reusable
numeric views for voltage, capacity, and current. Execution extraction consumes
those positions and arrays instead of rebuilding full-frame masks, temporary
measurement DataFrames, or repeated numeric coercions for every protocol pair
and occurrence. The index is not persistent cache state and is never created on
the exact persisted-result hit path. Any change to this boundary must retain
legacy grouping, ordered cycle association, cutoff extrema, NaN handling, and
result order; focused parity tests should compare both the indexed row/value
lookups and the complete scientific projection with the legacy implementation.
Request-local protocol reconstruction reuse is limited to identical immutable
header metadata plus nominal capacity and does not alter protocol semantics or
cache identity.

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
