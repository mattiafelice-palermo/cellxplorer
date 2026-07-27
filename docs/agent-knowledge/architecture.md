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

## App shell utilities

The header strip hosts Activity, Downloads, a quick-settings menu (`QuickSettingsMenu.tsx`), and
Debug. Quick settings covers reload interface, desktop-only restart (`restart_app` in
`src-tauri/src/main.rs`: schedule a delayed relaunch, then `stop_backend` and `app.exit` —
never `AppHandle::restart()`, which races `tauri_plugin_single_instance`), Appearance
(Auto/Light/Dark via Mantine `defaultColorScheme="auto"`), and pause of background automation.

Chrome surfaces that need a subtle raised/hover fill must use
`light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))` (or the teal
equivalent for selection). Numbered Mantine shades such as `gray.0` / `teal.0` do **not**
flip with the colour scheme.

Pause is durable in `app_settings.automation_paused_until` (`services/automation.py`,
`GET|POST /api/automation/pause`). It stops *starting* scheduled source-monitor work and gates
`CacheWarmupCoordinator`; user-triggered checks and imports keep working. Expiry is implicit from
the timestamp — do not clear it with a timer. Dark mode themes chrome only; Plotly surfaces stay
light because plot colours are persisted scientific presentation data.

Production builds suppress the browser context menu except on text inputs and
`[data-native-menu]`; `import.meta.env.DEV` keeps Inspect Element available.

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

## Destructive removal vs analyses

Before cell delete or replicate explode/ungroup, the UI calls `POST /api/analyses/usage`
(`services/analysis_usage.py`) and shows `DestructiveImpactModal`. Analyses left with no
samples are never auto-deleted; the user may opt in via an unchecked checkbox, after which
empty ids are recomputed and deleted.

Cell delete still leaves dangling cell refs as `missing_refs` at resolve time. Replicate
explode/ungroup/delete **does** strip those `replicate_group` entries (and related
exclusions/hidden ids) from analysis specs via `strip_replicate_groups_from_analyses`, so the
editor is not left showing a dead replicate the user already acknowledged in the modal.

Project-tree replicate conversions are backend transactions, not frontend request chains.
`POST /api/replicate-groups` accepts `folder_ids` plus exact `remove_folder_cells` references so
creating, filing, and replacing the selected cell references commit together.
`POST /api/replicate-groups/explode` derives group members server-side, replaces every folder
reference to each group with its cells, strips the group from analyses, and deletes the group in
one commit. Keep these workflows atomic when their UI changes.

## Draft plots

Drafts are **session-only**. They live in the open analysis editor (including keep-mounted
navigate-away) and are never written to the server. Closing the analysis tab, or opening
another plot while a draft is active, prompts **Save** or **Discard**. Killing the app loses
the draft. Server PUTs use `buildStablePersistSpec` so unsaved draft/edited-plot view settings
are not persisted; `selection.entries` (membership) still are. Any legacy `draft_plots` /
`draft_plot` fields are stripped on load and on persist. Portable export also strips them.

Plot sessions are **per family tab**. Opening an analysis or switching to a plot tab uses
`resolveColdOpenWorkspace`: keep a live draft on that tab if one exists; else open a saved
plot on that tab (preferring the last one opened there); else show the empty “No plot yet”
surface. A draft titled “Unsaved plot” appears only after **New**. Never show another tab’s
saved plot under that label. Switching tabs while a draft or dirty saved plot is active
prompts save/discard. **New** lives in `PlotHeader` (right of export). Draft card thumbnails
reuse the saved-plot preview renderer under ids `__draft__:<tab>`, stay in the React Query
memory cache only (`isDraftPreviewPlotId` skips artifact lookup/store), and must not enter
the idle warmup queue or the server plot-artifact API (those endpoints 404 for non-saved
ids and previously retry-stormed until the frontend died).

## Domain ownership

`SourceFile -> Test -> Cell` is the scientific hierarchy. Replicate groups and folders hold
references to cells rather than copies of scientific data. Analyses own one shared sample set;
saved plots own configuration and per-view visibility.

Backend services own parsing and deterministic scientific calculations. React components own
editing state and visualization state. Server-state copies in React Query are disposable views of
backend records, never an alternative source of truth.

## Desktop updates

Signed application updates are owned by the Tauri shell, not FastAPI. Rust holds the pending update
object and verified installer bytes in `src-tauri/src/app_updates.rs` and exposes three narrow
commands: `check_app_update`, `download_app_update`, and `install_app_update`. The frontend must
not call the generic updater plugin API or store manifest URLs, signatures, or raw installer bytes.

Automatic background discovery may emit one native Windows notification per new version when the
user preference is enabled. Display and body-click activation are owned by Rust
(`src-tauri/src/update_notifications.rs` via `notify-rust`); the frontend listens once for
`app-update-notification-activated` and opens the existing update modal. Clicking that notification
restores and focuses the existing `main` window, then opens the modal. It never starts download or
install. Manual **Check for updates** opens the modal directly and never shows a discovery toaster.
Closing the main window to the tray keeps the process alive for later checks; an explicit **Quit**
ends the process, so no further checks or notifications occur afterward.

Every checked update is built with the updater plugin's Windows `on_before_exit` hook, which sets
the shell quitting flag and runs the existing PyInstaller sidecar process-tree cleanup through
`prepare_exit_for_update` in `src-tauri/src/main.rs`. Check and download never stop the backend.
Pre-hook install errors can return to the frontend with the backend still alive. Once
`on_before_exit` runs on Windows, Tauri exits the process regardless of whether `ShellExecuteW`
successfully opened the installer — there is no post-hook frontend recovery path. User database,
caches, and source files are not touched by update infrastructure.

For packaging artifacts, signing keys, and the bootstrap-release limitation, see
`docs/windows-packaging.md`.

For schema and cache-version rules, see `docs/database-migrations.md` and the core data rules in
`AGENTS.md`.
