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
- `downloads-history.json` is a disposable, atomically written registry of exported files
  (`services/download_registry.py`): UX metadata only, never scientific data.

## Global search and shortcuts

`components/CommandPalette.tsx` (Ctrl+K) searches cells, analyses, saved plots, replicate groups,
and folders entirely client-side: it reads the startup-persisted `["cells",""]`,
`["analyses",""]`, `["replicate-groups"]`, and `["tree"]` queries from the React Query cache, so it
never issues a request. Ranking uses `src/fuzzySearch.ts`, a local scorer tuned for
delimiter-heavy names (`ME_20260512_LFP_LPMoL_611_FM+CYFC_25C`): exact/prefix/substring beat
word-boundary hits, which beat scattered subsequences. Do not swap in a generic fuzzy library
without re-checking that typing `611` still ranks the `_611_` cell first.

Results navigate through one-shot URL parameters, each consumed and stripped by its page:
`/?cell=<id>` and `/?replicate=<id>` (LibraryPage), `/analyses/<id>?tab=<key>&plot=<id>`
(AnalysisPage restores the saved plot and its tab), and `/projects?folder=<id>` (ProjectsPage
selects the folder and expands its ancestor chain). Saved plots are searchable because
`analysis_dict` includes a compact `saved_plots` array (id, name, tab) in the list summary; keep
that field small — the full spec must not be sent to the index.

Application shortcuts live in one keydown listener in `App.tsx`: Ctrl+K toggles the palette,
Ctrl+B collapses the navbar, and Ctrl +/-/0 plus Ctrl+wheel control UI zoom. Ctrl+A is
deliberately never bound so "select all" keeps working in every input.

## Downloads and exports

Every export (plot PNG/PDF/SVG, CSV/XLSX data, portable HTML, diagnostics) funnels through
`frontend/src/downloads.ts` `saveDownload`. It honors the `download_mode` setting — `folder`
(auto-saved server-side via `POST /api/downloads`, which records the entry) or `ask` (native
Tauri save dialog, then `POST /api/downloads/history` to record the chosen path) — and on the
plain web build falls back to a browser download recorded without an actionable path. After a
successful save it dispatches a `cellxplorer:download` window event carrying the entry.
`components/DownloadsButton.tsx` (header, beside Activity) listens for that event to auto-open its
popover, and lists history from `GET /api/downloads/history`. File actions are desktop-only:
`open_download` / `reveal_download` Tauri commands (main.rs; reveal uses `explorer /select`), and
delete goes through `DELETE /api/downloads/history/{id}?delete_file=…`. The web build shows history
but hides open/reveal/delete-file. Any new export path must call `saveDownload` to appear here.

Original Neware files normally remain at their source paths. The database stores their provenance,
checksums, parser state, and relationships. An installer upgrade or normal uninstall must not
delete the data directory. Destructive removal is an explicit, separately confirmed choice.

The database has a stable instance UUID stored in `AppSetting`. Frontend startup snapshots are
accepted only when both this UUID and the schema revision match, preventing cached summaries from
one database being shown for another.

## Loading states

Almost every read is served from cache in well under 250ms. A progress indicator shown for that long
is worse than none: the appear/disappear registers as a flicker, and a spinner *means* "this is
slow". `useDelayedFlag` in `AnalysisPage.tsx` gates them — nothing for the first 250ms, then a
400ms floor once shown, because without the floor a 300ms load merely flashes at a new threshold.

Hold the container's height whether or not the indicator is showing, so a fast result lands without
reflow. Note that a route can carry more than one indicator: the page-level spinner that fires while
the analysis record itself loads is separate from each plot's, and it is usually the most visible.

## Domain ownership

`SourceFile -> Test -> Cell` is the scientific hierarchy. Replicate groups and folders hold
references to cells rather than copies of scientific data. Analyses own one shared sample set;
saved plots own configuration and per-view visibility.

Backend services own parsing and deterministic scientific calculations. React components own
editing state and visualization state. Server-state copies in React Query are disposable views of
backend records, never an alternative source of truth.

For schema and cache-version rules, see `docs/database-migrations.md` and the core data rules in
`AGENTS.md`.
