# Cellxplorer

Single-user, local web app for organizing, analyzing, comparing and
revisiting battery-cycling data. Built per [SPEC.md](spec.md) around the
open-source **NewareNDA** parser for Neware sources and an independently
authored BioLogic GCPL-family `.mpr` reader. CellXplorer imports Neware
`.nda`, `.ndax`, and structured Neware Excel `.xlsx` exports plus recognized
BioLogic `.mpr` sources through the same Cell/source workflow. The current
verified MPR layout is metadata-readable but remains explicitly metadata-only
until an independently verified full-cycle identity is available, so it does
not create canonical cycling caches or capacity previews yet. Arbitrary Excel
workbooks, `.mpt` files, and unsupported MPR techniques are not supported.

## Run on Windows

The easiest way to launch the development web app is:

```powershell
.\scripts\start-webapp.cmd
```

This starts the backend and Vite frontend together, opens the app in your browser, and stops both
processes when you press `Ctrl+C`. The default URLs are `http://127.0.0.1:5173` for the frontend
and `http://127.0.0.1:8642` for the backend API.

To build the installable Windows application:

```powershell
.\scripts\build-app.cmd
```

The installer is created under `src-tauri\target\release\bundle\nsis`.

See [`docs/local-development.md`](docs/local-development.md) for options, troubleshooting, and
the manual fallback.

## Stable and Beta editions

CellXplorer is available as two separate Windows applications:

- **CellXplorer** receives Stable updates and stores data under
  `%USERPROFILE%\.cellxplorer`.
- **CellXplorer Beta** is an opt-in preview application with separate Windows identity,
  installation, updater, and `%USERPROFILE%\.cellxplorer-beta` data root.

Stable can notify you when a Beta preview is available and, after explicit confirmation, launch
the separate Beta installer. Installing Beta does not replace Stable or its library. Once Beta is
installed, it updates itself from the Beta channel; Stable never updates the installed Beta copy.
On Beta's first launch you choose whether to copy a safe snapshot of the Stable library or start
empty. The two libraries remain independent afterward.

## Manual run

```bash
pip install -r backend/requirements.txt   # Python 3.12+
python run.py                             # → http://127.0.0.1:8642
```

The frontend is prebuilt in `frontend/dist` and served by FastAPI. To rebuild it manually:
`cd frontend && npm.cmd run build`.

Optional demo dataset (synthetic cells, clearly named `DEMO-*`):

```bash
python backend/seed_demo.py
```

Stable app state lives in `%USERPROFILE%\.cellxplorer`; Beta app state lives in
`%USERPROFILE%\.cellxplorer-beta`. `CELLXPLORER_DATA` overrides either root for development and
tests. Each root contains `cellxplorer.db` (SQLite) and `cache/` (Parquet, keyed by file hash +
parser/calc versions). Raw cycler files stay wherever they are — referenced by content hash,
never copied, except app-managed imports selected for the explicit Stable-to-Beta snapshot.

The SQLite schema is explicitly versioned. Existing databases are backed up
under `backups/` and migrated before normal background services start; newer,
unknown, or damaged databases open in read-only compatibility mode.

Analyses can be exported as a single portable HTML report. It opens without
CellXplorer, supports CSV and optional original-file extraction, and can be
imported back with its cell records, source links or embedded originals, saved plots, settings,
and provenance. Regenerable Parquet caches are deliberately not duplicated in the report.
See [`docs/portable-analysis-html.md`](docs/portable-analysis-html.md).

## Architecture in one paragraph

There is one canonical library whose scientific object is the physical **Cell**. A Cell owns one
ordered chain of original `SourceFile` records, allowing interrupted and restarted cycler runs to
be viewed continuously without modifying the original files. The existing `Test`/`TestFile` tables
remain internal compatibility storage for that chain; normal Cells use one internal Test row, and
Test is not a user-facing grouping or analysis concept. Everything else references Cells: folders
and projects organize them, replicate groups are thin ordered sets, and analyses are persistent
recipes with explicit frozen selections and pinned provenance. Aggregation is computed at render
time. Nothing recomputes silently—moved, changed, offline, or version-stale sources surface as
explicit status and recompute actions.

## Layout

- `backend/app/models.py` — relational schema, including the internal source-chain compatibility rows
- `backend/app/services/` — `parsing.py` (central dispatch and the only NewareNDA import),
  `biologic_mpr.py`/`biologic_gcpl.py` (independent BioLogic MPR/GCPL adapter;
  current production MPR path is metadata-only until cycle identity is verified),
  `cache.py` (versioned Parquet), `calc.py` (per-cycle derivations),
  `stitch.py` (multi-source Cell chains), `scanner.py` (background scans/relink),
  `analysis_engine.py` (analysis compute engine)
- `backend/app/routers/` — REST API (`/api/...`)
- `frontend/src/pages/` — Inbox, Library, Projects, Analysis editor, and settings
