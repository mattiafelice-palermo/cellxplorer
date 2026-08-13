# CellXplorer Architecture

Repository: `mattiafelice-palermo/cellxplorer`  
Context last synchronized: 2026-08-13  
Verified against: `main` at `562c2edff1277fef71789244c95e3b17abc586fa` (`0.22.0-beta.5`)

This is a compact orientation document. The authoritative technical sources are `AGENTS.md`,
`docs/agent-knowledge/`, the current code and tests.

## Product

CellXplorer is a local-first Windows application for battery scientists. It imports, organizes,
inspects, analyses and exports Neware cycling data from binary `.nda` and `.ndax` files and from
structured Neware `.xlsx` exports.

Major user workflows include:

- importing cells and preserving source provenance;
- organizing cells through folders and replicate groups;
- source-status checking and conservative source updates;
- cycle, time/capacity, DCIR, chargeability and rate-capability analysis;
- saved analyses, saved plots, thumbnails and draft plot sessions;
- data and image export;
- portable, interactive single-HTML analysis reports;
- background cache preparation and maintenance.

## Runtime layers

### Frontend

- React, TypeScript, Vite and Mantine under `frontend/src`.
- React Query owns disposable frontend views of backend state.
- Frontend components own editing state, visualization state, mounted workspace state and export
  presentation.
- Frontend code must not become an alternative source of truth for backend records or scientific
  calculations.

Key surfaces:

- `frontend/src/pages/LibraryPage.tsx`: cells and replicate groups;
- `frontend/src/pages/ProjectsPage.tsx`: folder tree and previews;
- `frontend/src/pages/AnalysisPage.tsx`: analysis editor and saved plots;
- `frontend/src/api.ts`: typed API client;
- `frontend/src/components/CacheWarmupCoordinator.tsx`: idle plot preparation.

### Backend

- FastAPI and SQLAlchemy under `backend/app`.
- Owns persistence, source lifecycle, parsing, deterministic scientific calculations, analysis
  computation, invalidation and portable-report generation.
- `backend/app/services/parsing.py` owns supported-source dispatch and the direct NewareNDA
  integration. Structured Neware `.xlsx` workbooks are owned by
  `backend/app/services/neware_excel.py`; scientific code downstream of parsing stays
  format-neutral.

Key modules:

- `models.py`: relational schema;
- `routers/`: API endpoints;
- `services/parsing.py`: supported-source dispatch and NewareNDA integration;
- `services/neware_excel.py`: structured Neware Excel recognition and raw mapping;
- `services/cache.py` and `calc.py`: parsed/per-cycle cache generation;
- `services/analysis_engine.py`: analysis computation;
- `services/cache_maintenance.py`: cache budgets, cleanup and warmup queue;
- `services/portable_analysis.py`: portable HTML export/import;
- `migrations/`: packaged forward-only database revisions.

### Desktop shell

- Tauri under `src-tauri`.
- Launches a bundled PyInstaller Python backend sidecar from `packaging/backend_entry.py`.
- Uses a loopback endpoint selected at runtime; frontend desktop requests must not assume the
  development port.
- Windows build and installer behavior is documented in `docs/windows-packaging.md`,
  `docs/tauri-packaging-lessons.md` and `docs/local-development.md`.

## Persistent data

The normal user data root is `%USERPROFILE%\.cellxplorer`.

- `cellxplorer.db`: canonical SQLite relational state;
- `cache/`: regenerable parsed and derived Parquet data;
- `imports/`: app-managed imported files when used;
- `logs/`: runtime diagnostics;
- `backups/`: migration/recovery support;
- `downloads-history.json`: disposable export-history metadata, not scientific data.

The database is canonical. Parquet and analysis artifacts are caches. Normal upgrades and uninstall
must not delete user data.

SQLite uses WAL mode so reads can coexist with background writes. Long parsing, checksum and cache
operations must remain outside request transactions.

## Scientific data model

The canonical hierarchy is:

```text
SourceFile → Test → Cell
```

- `SourceFile` stores path, checksum, parser/source status and provenance.
- `Test` represents a cycling procedure and can own an ordered sequence of source files.
- `Cell` is the primary scientific object selected and analysed by users.
- Replicate groups reference cells; they do not copy scientific data.
- Folders organize references to cells, replicate groups and analyses.
- Analyses own one shared sample set.
- Saved plots own plot configuration and per-plot visibility, not independent sample membership.

Deleting or reorganizing references must not duplicate or silently delete scientific data.

## Parsing and source lifecycle

Original source files normally remain at their registered paths. Parsed raw and per-cycle data are
stored in checksum/version-keyed Parquet caches.

Supported sources are recognized centrally rather than trusted by extension alone. `.nda` and
`.ndax` use the NewareNDA boundary; `.xlsx` is accepted only when it satisfies the structured
Neware export contract, so an arbitrary workbook is rejected rather than parsed as cycling data.
Binary and Excel sources are distinct parser families, which prevents an exact-checksum relink from
silently crossing between them. Import discovery and metadata inspection stay bounded: recognizing a
source and reading its header must not trigger a full parse.

Source updates are conservative:

1. detect source availability/change;
2. avoid adopting files that still appear to be written;
3. parse replacement data;
4. make the new cache durable;
5. update relational state and invalidate only dependent analyses/artifacts;
6. remove the old checksum cache only after replacement parsing succeeds.

A failed replacement parse must preserve recoverability.

## Scientific calculations and cache versioning

- Deterministic scientific calculations live in backend services.
- Cached scientific meaning changes require a `CALC_VERSION` decision.
- Analysis response-schema changes should use per-kind result schema versions where available,
  rather than globally invalidating unrelated analysis families.
- Source checksum, relevant scientific metadata and explicit overrides belong in cache keys.
- Availability badges are status metadata and should not invalidate numerical results when cached
  scientific data are unchanged.

Display-only downsampling must never silently alter CSV exports or scientific calculations.

## List endpoints and performance

Cell and Analysis Database list endpoints must use compact relational summaries.

They must not:

- open source files;
- read Parquet per row;
- import the scientific stack;
- recompute capacities;
- traverse per-cell ORM relationships in an N+1 pattern.

Missing summaries should be backfilled in the background and shown as pending. List and detail
responses must remain semantically consistent.

## Analyses, plots and artifacts

Analyses can expose several scientific families with separate query/cache boundaries. Inactive
families must not start unrelated computation.

Saved plots have versioned derived artifacts, including:

- final interactive Plotly figure data;
- frozen SVG fallback for restricted viewers;
- compact thumbnail;
- separately laid-out 4:3 hover preview.

Artifact writes must be guarded against stale background generations. Changes to thumbnail rendering
require matching frontend and backend renderer/cache-version updates.

Draft plots are session-only and are not persisted, exported or sent to saved-artifact endpoints.

## Portable reports

Portable analysis HTML is a versioned, checksummed and untrusted container.

- Import must never execute embedded JavaScript.
- The interactive Plotly figure and frozen SVG must represent the same final plot.
- CSV data should remain tied to the figure rather than introducing a second numerical cache.
- Embedded source downloads preserve one folder per cell.
- App/report Plotly runtime consistency is a release/tooling concern.

## Background work

Parsing, checksum checks, analysis computation, source-triggered invalidation and thumbnail warmup
use background or multiprocessing patterns.

Background preparation is:

- bounded;
- lower priority where supported;
- resumable rather than treated as an infallible durable queue;
- generation-checked before rendering and before storing;
- scoped to affected analyses rather than globally invalidating everything.

## Startup and compatibility

Backend startup inspects and migrates the database before normal API operations. It creates or reads
a durable database-instance UUID and starts lightweight services. Expensive warmups occur after the
API becomes reachable.

The frontend may appear before the sidecar is ready, so it retries transient connectivity instead of
placing the whole application behind a blocking startup gate. Persisted startup summaries are
accepted only when database UUID and schema revision match.

## Architecture invariants

1. Live branch code and tests override this summary.
2. The database is canonical; caches are regenerable.
3. Released migrations are immutable.
4. Scientific calculations are deterministic and backend-owned.
5. Source provenance is preserved.
6. Organizational references do not duplicate scientific data.
7. List endpoints stay relational and bounded.
8. Expensive work stays off request/UI critical paths.
9. Cache invalidation is dependency-scoped.
10. Exports disclose and preserve the scientific meaning of the rendered data.
