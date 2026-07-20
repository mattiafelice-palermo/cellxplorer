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

Time/capacity views limit each displayed trace to a bounded number of representative points. CSV
exports and scientific calculations must not silently inherit display-only downsampling. Portable
reports keep serialized Plotly figures for interactive browsers and frozen SVG fallbacks for
restricted viewers. See `docs/portable-analysis-html.md`.

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

`frontend/src/components/CacheWarmupCoordinator.tsx` performs opportunistic preparation after an
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

Analysis cache keys cover the scientific inputs only. Source `location_status` is deliberately
excluded: results are computed from the cached Parquet, which transient offline/changed flips do
not touch, so a drive reconnect or a still-cycling source file must not invalidate every cached
result for the cell. Availability badges are therefore refreshed at response time from the
database status fields (`analysis_engine.refresh_availability_badges`) whenever a cached result
is served. Warmup tasks must never recompute a plot whose thumbnail or artifact is already
cached; the background compute is gated exactly like the visible preview path.

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
