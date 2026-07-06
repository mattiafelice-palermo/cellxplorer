# Cellxplorer

Single-user, local web app for organizing, analyzing, comparing and
revisiting Neware battery-cycling data. Built per [SPEC.md](spec.md) around
the open-source **NewareNDA** parser (the same library embedded in the
Neware Batch Converter found in this directory).

## Run

```bash
pip install -r backend/requirements.txt   # Python 3.12+
python run.py                             # → http://127.0.0.1:8642
```

The frontend is prebuilt in `frontend/dist` and served by FastAPI. To
rebuild it: `cd frontend && npm install && npm run build`.

Optional demo dataset (synthetic cells, clearly named `DEMO-*`):

```bash
python backend/seed_demo.py
```

All app state lives in `%USERPROFILE%\.cellxplorer` (override with the
`CELLXPLORER_DATA` environment variable): `cellxplorer.db` (SQLite) and
`cache/` (Parquet, keyed by file hash + parser/calc versions). Raw Neware
files stay wherever they are — referenced by content hash, never copied.

## Architecture in one paragraph

There is ONE canonical library (SourceFile → Test → Cell, identity by
content hash). Everything else is references into it: folders/projects form
the single navigation tree (folders never feed data to anything), groups
are thin ordered replicate sets, and analyses are persistent recipes with
explicit frozen selections, per-analysis exclusions, and pinned provenance
(parser/calc versions + file hashes). Aggregation (mean ± SD/SEM/min-max/
percentile with n(cycle) tracking) is computed at render time, never
stored. Nothing recomputes silently — moved files relink by hash, changed/
offline sources and newer parser versions surface as badges with explicit
recompute buttons.

## Layout

- `backend/app/models.py` — the ~15-table schema
- `backend/app/services/` — `parsing.py` (the only NewareNDA import),
  `cache.py` (versioned Parquet), `calc.py` (per-cycle derivations),
  `stitch.py` (multi-file tests), `scanner.py` (background scans/relink),
  `analysis.py` (the compute engine + badges)
- `backend/app/routers/` — REST API (`/api/...`)
- `frontend/src/pages/` — Inbox, Library, Project, Analysis editor,
  Global analysis index, Tags & collections
