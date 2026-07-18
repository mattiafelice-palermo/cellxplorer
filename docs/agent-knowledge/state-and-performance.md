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
