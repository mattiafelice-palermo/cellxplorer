# CellXplorer agent guide

## What this repository is

CellXplorer is a local-first Windows application for battery scientists to import, organize,
inspect, and analyze Neware `.nda`/`.ndax` cycling data. The UI is React + Mantine, the API is
FastAPI + SQLAlchemy, and the desktop installer is a Tauri shell that launches a bundled Python
backend sidecar.

Read `README.md` for the short overview, `spec.md` for the original domain model, and the files in
`docs/` for parser and Windows packaging notes. The current code and tests take precedence where
the original specification is stale.

## Core data rules

- `SourceFile -> Test -> Cell` is the canonical scientific hierarchy. A cell is the primary object
  users select and analyze.
- Source files stay at their original paths. The database stores paths and checksums; parsed raw and
  per-cycle data live in regenerable Parquet caches.
- Parser-derived metadata, source paths, checksums, and cycling data are read-only in the UI. Cell
  names and cell notes are user-editable.
- Replicate groups are references to cells. Deleting one cell removes only that membership; a
  non-empty replicate group persists.
- Folders organize references to cells, replicate groups, and analyses. Moving or copying a folder
  reference must not duplicate scientific data.
- An analysis owns one shared sample set. Saved plots store plot configuration and per-plot
  visibility, not independent sample membership. Newly added analysis samples default to visible in
  existing saved plots; removed samples disappear from their thumbnails and restored state.
- Scientific calculations should be deterministic and live in backend services. Bump
  `CALC_VERSION` in `backend/app/config.py` when the meaning of cached derived data changes.

## Persistent user data

By default all user state is under `%USERPROFILE%\.cellxplorer`:

- `cellxplorer.db`: canonical SQLite database
- `cache/`: versioned Parquet caches
- `imports/`: app-managed imported-file storage when used

Never clear, replace, seed, or migrate the user's real database unless the user explicitly asks.
Tests set `CELLXPLORER_DATA` to `.test-cellxplorer`, which is ignored by Git.

`Base.metadata.create_all()` creates new tables but does not add columns to existing SQLite tables.
Any new persistent column needs a backward-compatible migration in
`backend/app/db.py::ensure_runtime_schema`. Released migrations must preserve existing data.

## Important locations

- `backend/app/models.py`: SQLAlchemy schema
- `backend/app/routers/`: `/api` endpoints
- `backend/app/services/parsing.py`: the only direct NewareNDA integration
- `backend/app/services/cache.py` and `calc.py`: cache and per-cycle derivations
- `backend/app/services/analysis_engine.py`: analysis computation
- `frontend/src/pages/LibraryPage.tsx`: cell and replicate databases
- `frontend/src/pages/ProjectsPage.tsx`: folder tree and previews
- `frontend/src/pages/AnalysisPage.tsx`: analysis editor and saved plots
- `frontend/src/api.ts`: typed frontend API client
- `packaging/`, `src-tauri/`, and `docs/windows-packaging.md`: Windows desktop packaging

## Development commands

Run the built frontend through FastAPI:

```powershell
python run.py
```

The app is then available at `http://127.0.0.1:8642`. Frontend source changes require a rebuild:

```powershell
cd frontend
npm.cmd run build
```

Run backend tests from the repository root:

```powershell
python -m unittest discover tests
```

Run the lightweight TypeScript policy tests directly when relevant:

```powershell
node --test frontend\tests\*.test.ts
```

The Vite build may need elevated sandbox permission on Windows because esbuild traverses paths
outside the workspace. This is an execution-environment issue, not necessarily a source failure.

## Implementation conventions

- Preserve the existing quiet, compact Mantine design. Reuse current controls and Tabler icons.
- Use React Query for server state. After a mutation, update or invalidate every affected view
  (cell lists/details, folders, replicates, analyses, and activity when applicable).
- Validate domain constraints in the backend even when the frontend prevents invalid input.
- Log meaningful user mutations through `backend/app/services/activity_log.py`; do not put raw
  cycling data or private note contents into activity details.
- Keep expensive parsing, checksum, and cache rebuilding off the request/UI critical path. Existing
  batch parsing and source checks use background work or multiprocessing patterns worth reusing.
- Metadata display should include all available values and remain collapsed by default.
- Avoid broad refactors in `AnalysisPage.tsx` unless the task requires them; it is large and has
  sensitive saved-plot/autosave behavior. Keep tab-specific logic isolated where possible.
- The worktree may contain user changes. Never reset or discard unrelated modifications.

## Verification expectations

For backend/domain changes, add focused unit tests and run the full Python suite. For frontend
changes, run the TypeScript build and relevant direct tests. For interaction or layout changes,
verify the actual flow in the in-app browser at desktop width. A successful installer build is not
required for ordinary app changes; rebuild it only when requested.

Before packaging, follow `docs/windows-packaging.md` and `docs/tauri-packaging-lessons.md`. The
expected NSIS artifact is under `src-tauri/target/release/bundle/nsis/`.
