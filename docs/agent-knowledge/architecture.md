# Architecture and lifecycle

## Process layout

CellXplorer has three layers:

1. A React and Mantine frontend in `frontend/src`.
2. A FastAPI and SQLAlchemy backend in `backend/app`.
3. A Tauri Windows shell in `src-tauri` that serves the bundled frontend and launches the frozen
   Python backend sidecar from `packaging/backend_entry.py`.

Browser development can serve the built frontend through `run.py`, or use the separate Vite and
FastAPI processes documented in `docs/local-development.md`. The desktop backend selects an
available loopback port; frontend requests must use the desktop endpoint discovery helpers rather
than assuming port `8642`.

## Startup sequence

Importing `backend/app/main.py` performs database inspection and forward migration before Uvicorn
begins accepting requests. Once compatibility is established, the backend creates or reads a
durable database instance UUID, registers routes, and starts lightweight runtime services.
Scientific libraries and capacity-summary backfilling are warmed in a daemon thread after the API
is listening.

The Tauri frontend can become visible before the PyInstaller sidecar is reachable. The frontend
therefore renders its normal shell immediately, retries connectivity and transient server errors,
and lets the backend compatibility middleware remain authoritative. Do not reintroduce a global
startup gate merely to hide short sidecar startup time.

## Persistent data ownership

Canonical user data lives outside the installation directory, normally under
`%USERPROFILE%\.cellxplorer`:

- `cellxplorer.db` is the canonical relational state.
- `cache/` contains regenerable parsed and derived Parquet data.
- `imports/`, `logs/`, and `backups/` contain app-managed supporting data.

Original Neware files normally remain at their source paths. The database stores their provenance,
checksums, parser state, and relationships. An installer upgrade or normal uninstall must not
delete the data directory. Destructive removal is an explicit, separately confirmed choice.

The database has a stable instance UUID stored in `AppSetting`. Frontend startup snapshots are
accepted only when both this UUID and the schema revision match, preventing cached summaries from
one database being shown for another.

## Domain ownership

`SourceFile -> Test -> Cell` is the scientific hierarchy. Replicate groups and folders hold
references to cells rather than copies of scientific data. Analyses own one shared sample set;
saved plots own configuration and per-view visibility.

Backend services own parsing and deterministic scientific calculations. React components own
editing state and visualization state. Server-state copies in React Query are disposable views of
backend records, never an alternative source of truth.

For schema and cache-version rules, see `docs/database-migrations.md` and the core data rules in
`AGENTS.md`.
