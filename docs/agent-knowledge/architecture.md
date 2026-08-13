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

## Stable and Beta application channels (Spec 021)

The same source tree builds two Windows products from channel-specific configuration:

| Property | Stable | Beta |
|---|---|---|
| Product name | CellXplorer | CellXplorer Beta |
| Tauri identifier | `com.cellxplorer.desktop` | `com.cellxplorer.desktop.beta` |
| Deep link | `cellxplorer://` | `cellxplorer-beta://` |
| Frontend build env | `VITE_CELLXPLORER_CHANNEL=stable` | `VITE_CELLXPLORER_CHANNEL=beta` |
| Mantine primary | `teal` | `betaBlue` |

Build either channel with `.\scripts\build-app.ps1 -Channel stable|beta`. Each frontend build writes
`frontend/dist/.cellxplorer-channel.json`; packaging verifies the stamp so a Stable-built dist cannot
be bundled into Beta and vice versa. The PyInstaller sidecar is shared; Rust passes
`CELLXPLORER_CHANNEL` to it. Packaged backend startup requires a valid channel and fails closed on
missing or unsupported values.

Both editions use separate default data roots after Spec 022: Stable `%USERPROFILE%\.cellxplorer`,
Beta `%USERPROFILE%\.cellxplorer-beta`. `CELLXPLORER_DATA` overrides both exactly for tests and
development. Rust passes the resolved root to the sidecar as `CELLXPLORER_DATA`.

Stable self-updates read `release-channels/stable/latest.json`; Beta self-updates read
`release-channels/beta/latest.json`. Stable may optionally notify about and install the separate
Beta product through dedicated Rust commands and `BetaInstallCoordinator`; it never updates an
installed Beta copy. Standard self-update state and Stable-owned first-Beta-install state are
different Tauri managed types (`PendingAppUpdate` and the `PendingBetaInstall` newtype), so they
cannot collide or clear one another. Rust validates exact channel SemVer before accepting a pending
update: Stable is `MAJOR.MINOR.PATCH`; Beta accepts legacy `MAJOR.MINOR.PATCH-beta.N` and compact
`MAJOR.MINOR.PATCH-betaNNN`, with no other prerelease or build metadata. Once a Beta line publishes
a compact version, keep that form for the rest of the same core version: SemVer orders `beta.12`
below `beta011`, while `beta012` correctly follows `beta011`.

NSIS pre-install/uninstall hooks kill only processes whose executable path is under the installation
directory being changed — never by shared image name alone — so Stable and Beta can run side by side.

See `docs/windows-packaging.md` for the full identity matrix and build commands.

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
(the AnalysisPage route adapter passes the id to AnalysisEditor, which restores the saved plot and
its tab), and `/projects?folder=<id>` (ProjectsPage
selects the folder and expands its ancestor chain). Saved plots are searchable because
`analysis_dict` includes a compact `saved_plots` array (id, name, tab) in the list summary; keep
that field small — the full spec must not be sent to the index.

Application shortcuts live in one keydown listener in `App.tsx`: Ctrl+K toggles the palette,
Ctrl+B collapses the navbar, and Ctrl +/-/0 plus Ctrl+wheel control UI zoom. Ctrl+A is
deliberately never bound so "select all" keeps working in every input.

## App shell utilities

The header strip hosts Activity, Downloads, a quick-settings menu (`QuickSettingsMenu.tsx`), and
Debug. Quick settings covers reload interface and desktop-only restart. Manual restart and Beta
bootstrap apply both launch the internal `--relaunch-after-pid <pid>` helper from
`src-tauri/src/relaunch.rs` before stopping the backend. The helper runs before Tauri and
`tauri_plugin_single_instance`, waits on the exact old Windows process handle, and launches a clean
ordinary process only after teardown completes. Never replace it with a fixed sleep or
`AppHandle::restart()`, which can race the single-instance lock. Quick settings also owns Appearance
(Auto/Light/Dark via Mantine `defaultColorScheme="auto"`) and pause of background automation.

Chrome surfaces that need a subtle raised/hover fill must use
`light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))` (or the primary
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

Supported source dispatch is centralized in `backend/app/services/parsing.py` (Spec 040.2): a small
static registry of `SourceFormatDescriptor`s (`FORMAT_NEWARE_BINARY` = `.nda`/`.ndax`,
`FORMAT_NEWARE_EXCEL` = `.xlsx`) drives one shared extension -> format_id decision table that both
`parse_timeseries` and `read_header_metadata` dispatch through. `.nda`/`.ndax` use the shared
NewareNDA boundary, while structured Neware `.xlsx` files use `backend/app/services/neware_excel.py`.
`parsing.recognize_source(path)` is the content-aware recognition function (Excel additionally
requires `neware_excel.is_supported_workbook`'s bounded header check, so a generic `.xlsx` is never
recognized by extension alone); `parsing.source_parser_descriptor(path)` exposes each format's
`adapter_revision` and `canonical_raw_version` for Spec 040.3's future per-source parser identity —
nothing persists it yet. `parsing.PARSER_VERSION` remains the transitional global parser-bundle
identity every current cache/provenance consumer reads until that child lands. This is a static
registry, not a plugin framework: no dynamic loading, no importlib discovery, no base-class
hierarchy. Excel sources are normalized into the same canonical raw, protocol and versioned raw/cycle
cache contracts, so scientific services remain format-neutral.
The workbook's `record` sheet is the point-level source of truth; optional `step` and `cycle`
summaries validate parser-derived execution and cycle projections rather than replacing them.
Metadata inspection reads bounded workbook surfaces without scanning the large record sheet, and
exports that omit semantic condition expressions remain explicitly non-applicable to
Chargeability recognition.

The import filesystem picker keeps navigation and recursive selection separate. Its quick-access
standard locations come from `backend/app/services/windows_known_folders.py`, which calls the
Unicode Windows Known Folder API for redirected Desktop/Documents/Downloads and falls back to
home-relative names independently when the API is unavailable or one lookup fails. The response
shape and pinned/recent path persistence remain owned by `routers/files.py`.

The database has a stable instance UUID stored in `AppSetting`. Frontend startup snapshots are
accepted only when both this UUID and the schema revision match, preventing cached summaries from
one database being shown for another.

## Analysis frontend ownership

Analysis routes are adapters around feature-owned views. `frontend/src/pages/AnalysisPage.tsx`
reads the route id or explicit embedding override and renders
`frontend/src/features/analyses/editor/AnalysisEditor.tsx`; it owns no editor state or helpers.
`frontend/src/pages/AnalysesIndexPage.tsx` similarly adapts router/search parameters to
`features/analyses/database/AnalysesIndexView.tsx`. Feature modules do not import route pages.

The analysis feature ownership is split by responsibility:

- `features/analyses/database/` owns the analysis collection, table, summaries, and sample preview;
- `features/analyses/editor/AnalysisEditor.tsx` owns the remaining single-analysis controller and
  screen composition;
- `features/analyses/editor/families/` owns family-specific cards and result presentation;
- `features/analyses/editor/plotting/` owns shared plot presentation, exports, runtime, and style;
- `features/analyses/editor/policies/` owns draft, saved-view, visibility, and multi-source rules;
- `features/analyses/editor/artifacts/` owns saved previews, draft cards, artifacts, and warmup;
- `features/analyses/editor/portable/` owns portable-report orchestration and sharing;
- `features/analyses/workspace/` owns tabs, mounted-editor composition, navigation state, and
  analysis query-cache policy.

The workspace embeds `AnalysisEditor` directly, so the stable direction is
`route page -> feature editor` and `workspace -> feature editor`; the editor then composes the
family, policy, plotting, artifact, portable, protocol, recognition, and workspace owners.

## Loading states

Almost every read is served from cache in well under 250ms. A progress indicator shown for that long
is worse than none: the appear/disappear registers as a flicker, and a spinner *means* "this is
slow". `useDelayedFlag` in `features/analyses/editor/AnalysisEditor.tsx` gates them — nothing for
the first 250ms, then a
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

The user-facing scientific hierarchy is:

```text
Cell -> ordered SourceFiles
```

A Cell is the physical scientific object users select and analyse. It owns one ordered chain of
original Neware files. Interruptions, restarts, channel moves, and restarted protocols with removed
or changed steps remain successive sources in that same chain.

The relational schema still contains `Test` and `TestFile` for compatibility:

```text
Cell -> exactly one internal Test row -> ordered TestFile links -> SourceFiles
```

Every Cell has exactly one internal Test row storing the chain. `Test` is not a user-facing
procedure, grouping, selection, analysis, lifecycle, or monitoring concept. Do not expose Test
names, Target Test selectors, per-Test cards, per-Test tails, or per-Test ordering. Do not create a
second Test merely because a continuation protocol differs. A protocol difference is a source
boundary finding only.

Analysis provenance follows the same Cell-level contract: new scientific results carry the Cell ID,
ordered source hashes, positions, and descriptors, never Test IDs or Test counts. The canonical
resolver rejects zero or multiple internal rows before cache-key, compute, staleness, Library, or
tracked-tail work can flatten an invalid hierarchy.

## Protocol-derived analysis safety (Spec 034.8)

Steps, DCIR, Chargeability, and Rate capability use source-local protocol steps and are fail-closed
when any selected Cell has more than one ordered source. The single backend decision lives in
`analysis_engine.protocol_analysis_guard`; it must run before cache reads, recognition, computation,
or background-job creation. Mixed selections fail as a whole with the structured
`multi_source_protocol_mapping_required` 422 response. Cycles and Time / capacity remain the
supported alternatives.

Saved plot artifact and thumbnail routes use the same guard, so an old pre-guard scientific result
cannot be relabeled as a current preview. The idle warmup coordinator skips guarded protocol plots,
and the frontend mirrors the decision from typed `source_count` values in
`multiSourceAnalysisPolicy.ts`. A future reviewed mapping may use
`(source protocol signature, source-local step index) -> semantic operation`; numeric step IDs,
step types, and C-rate alone are not valid mappings.

Normal writes prevent a second Test row and focused backend tests cover that invariant. Lifecycle
mutations reject a Cell that already violates it. Read-only source monitoring may defensively
flatten malformed legacy rows by their stored compatibility order so a damaged Cell still yields
at most one monitored tail; that fallback is never exposed as a second chain or product mode.

Replicate groups and folders hold references to Cells rather than copies of scientific data.
Analyses own one shared sample set; saved plots own configuration and per-view visibility.

Multi-source continuation stitching lives in `backend/app/services/stitch.py` (Spec 034.1). One
canonical helper maps each **observed** source-local cycle label to exactly one dense global cycle
in stable numeric order; it never infers missing local labels from `max - min + 1`. Stitched cycle
and raw frames retain `source_cycle`, `segment`, and `source_hash`. Segment metadata includes
`source_cycle_start`, `source_cycle_end`, `source_cycle_count`, dense global `cycle_start` /
`cycle_end`, and `incomplete_boundary_unknown: true` (no boundary splice inference). Missing ordered
source caches fail closed: later sources are not remapped as a compact continuation after a gap.
Completeness metadata is exposed through `stitch.stitch_metadata(frame)` and `frame.attrs`. Raw
rows keep source record order; never sort globally by timestamp.

Cycles and Time/Capacity consumers enrich those stitched frames with a path-free ordered source
descriptor list: source file ID, filename, 1-based position, local/global ranges, known start/end
timestamps, and whether the source is the tracked tail. A missing source yields an explicit
`continuation_source_missing` badge and no partial scientific series for that Cell. The analysis
cache version covers the additive provenance arrays, and Plotly boundary markers, hover metadata,
thumbnails, image exports, CSV, and Excel all derive from the same source-aware result. Data exports
use source filenames and hashes only; absolute source paths never leave the backend result contract.

Read-only continuation compatibility inspection lives in
`backend/app/services/continuations.py` (Spec 034.2). `POST /api/imports/continuations/inspect`
reuses header/hash work from import preview, enriches timing and local cycle ranges from existing
caches when available, and returns `pending` plus a background cache build when parse caches are
not ready yet. A source is not complete until both raw timing and current cycle evidence are
available; partial, building, or failed enrichment cannot be submitted. Cache preparation is
deduplicated per source hash/parser/calc version, with a retry cooldown after failures. Findings
and suggested order are deterministic; blocking covers identity violations while protocol,
channel, and local cycle differences remain visible but non-blocking.

Spec 034.3 lifecycle mutations inspect the complete proposed Cell source chain. Canonical
frontend/API operations are Cell-level and the backend resolves the single internal Test row.
Existing Test-level routes may remain only as internal wrappers; they must not enable multiple-Test
product behavior. The same complete-chain proposal drives findings, tracked-tail impact, and final
mutation validation. Staged registration rechecks the inspected hash before writes, and request keys
must be non-empty and unique before inspection or cache work.

Scheduled source monitoring checks only the final source in each active Cell chain. Manual integrity
operations may inspect every ordered source. Each running check captures an immutable scope and
execution contract; incompatible requests start separately instead of changing an existing job.
Before scheduled adoption, the source must still be attached to the Cell, still be final, retain its
captured registered hash, and match the checked stable physical signature. Internal Test IDs may
remain in diagnostics but never define or expose a separate tail.

Backend services own parsing and deterministic scientific calculations. React components own
editing state and visualization state. Server-state copies in React Query are disposable views of
backend records, never an alternative source of truth.

## Desktop updates

Signed application updates are owned by the Tauri shell, not FastAPI. Rust holds the pending update
object and verified installer bytes in `src-tauri/src/app_updates.rs` and exposes three narrow
commands: `check_app_update`, `download_app_update`, and `install_app_update`. The frontend must
not call the generic updater plugin API or store manifest URLs, signatures, or raw installer bytes.

The configured identifier selects the self-update channel. Stable and Beta share the updater state
machine but accept only their exact channel version shape before pending state can change. Stable's
separate Beta-discovery commands are Stable-only, use the Rust-owned Beta endpoint and the distinct
`PendingBetaInstall` newtype, and stop offering first installation once the exact Beta uninstall
registration is present.

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

Both Standard self-update and Stable-owned Beta installation finish the backend session immediately
before installer launch. Session-finish failure is debug-logged and follows the existing updater
policy of continuing to the verified installer. Automatic Beta discovery uses the same preference
interval as Standard updates; schedule-change events cancel and recreate its timers rather than
disabling recurrence.

For packaging artifacts, signing keys, and the bootstrap-release limitation, see
`docs/windows-packaging.md`.

For schema and cache-version rules, see `docs/database-migrations.md` and the core data rules in
`AGENTS.md`.
