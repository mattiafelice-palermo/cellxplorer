# CellXplorer agent guide

## What this repository is

CellXplorer is a local-first Windows application for battery scientists to import, organize,
inspect, and analyze Neware `.nda`/`.ndax` cycling data. The UI is React + Mantine, the API is
FastAPI + SQLAlchemy, and the desktop installer is a Tauri shell that launches a bundled Python
backend sidecar.

Read `README.md` for the short overview, `spec.md` for the original domain model, and the files in
`docs/` for parser and Windows packaging notes. The current code and tests take precedence where
the original specification is stale.

## Agent knowledge base

Read `docs/agent-knowledge/README.md` before substantial work. It indexes the stable architectural
knowledge, performance invariants, and change playbooks that are easy to miss by reading one module
in isolation. The detailed migration, portable-report, parser, and packaging manuals remain in
their existing files under `docs/` and are linked from that index.

Before creating or changing any frontend surface, read
`docs/agent-knowledge/visual-style-guide.md`. It is the canonical contract for colors, typography,
spacing, control sizes, dark-mode behavior, plot presentation, feedback states, and accessibility.
An explicit user decision or a design decision marked locked in an active spec may override it;
otherwise new UI must follow it.

When work reveals a durable fact that would save a future agent meaningful investigation, update
the relevant knowledge document in the same change. Record architectural constraints, ownership
boundaries, proven failure modes, and verification techniques. Do not turn the knowledge base into
a chronological work log, copy chat transcripts into it, or document guesses that have not been
confirmed by code or tests.

## Branch workflow

Implement features **sequentially**, one branch at a time:

1. Before starting a new feature, check whether a feature branch is already open. If one exists,
   finish it (preflight, merge to `main`) before creating another branch.
2. Create a dedicated branch from current `main` before implementing a new feature or spec.
   Do not build feature work directly on `main`.
3. Use a short, descriptive name such as `feature/cell-table-pagination`.
4. When a spec or review follow-up batch is **complete**, commit the work on the feature branch,
   run preflight, and **push to `origin`**. Reviewers and other agents cannot read local-only
   changes. Use `git push -u origin HEAD` the first time on a branch, then `git push` on later
   commits. Do not finish a completed spec without pushing unless the user explicitly asks you
   not to.
5. Run `python scripts\preflight.py` on the branch before merging (and as part of step 4 when
   landing a completed spec).
6. Merge to `main` when the feature is complete. GitHub preflight runs automatically on `main`;
   feature-branch pushes do not trigger it.

This keeps overlapping edits out of the same files and reduces merge conflicts.

## Feature specs and reviews

Implementation plans live in `docs/specs/`; review follow-ups live in `docs/specs/reviews/`.
See [`docs/specs/README.md`](docs/specs/README.md) for the full lifecycle.

When the user provides a spec or review (typically from `%USERPROFILE%\\Downloads` or as a chat
attachment), **copy it into the repository immediately** — do not implement from the Downloads
path alone:

| Kind | Copy to |
|---|---|
| New or updated spec | `docs/specs/NNN-<name>.md` |
| Review / follow-up tasks | `docs/specs/reviews/NNN-<name>-review.md` |

Normalize Windows duplicate suffixes such as `(1)` to the canonical filename, update the spec index
in `docs/specs/README.md`, and add `Review document:` cross-links in the related spec. The
repository copy is the source of truth from then on.

When implementation for a numbered spec (or a review follow-up tranche named in the review doc)
is complete and preflight passes, **commit and push the feature branch to `origin` in the same
session**. The remote branch is what reviewers read; do not leave finished spec work uncommitted
or unpushed.

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

Stable user state defaults to `%USERPROFILE%\.cellxplorer`; Beta user state defaults to
`%USERPROFILE%\.cellxplorer-beta`. `CELLXPLORER_DATA` overrides either root exactly:

- `cellxplorer.db`: canonical SQLite database
- `cache/`: versioned Parquet caches
- `imports/`: app-managed imported-file storage when used

Never clear, replace, seed, or migrate the user's real database unless the user explicitly asks.
Tests set `CELLXPLORER_DATA` to `.test-cellxplorer`, which is ignored by Git.

Production databases are versioned through the packaged migration registry under
`backend/app/migrations/`. Any persistent schema change needs a new forward-only revision and
focused data-preservation tests. Never edit a released migration. `Base.metadata.create_all()` is
still used by isolated tests and the `0001` historical baseline, not as a substitute for future
production migrations. See `docs/database-migrations.md`.

## Important locations

- `backend/app/models.py`: SQLAlchemy schema
- `backend/app/routers/`: `/api` endpoints
- `backend/app/services/parsing.py`: the only direct NewareNDA integration
- `backend/app/services/cache.py` and `calc.py`: cache and per-cycle derivations
- `backend/app/services/cache_maintenance.py`: cache budgets, inventory, cleanup, and warmup queue
- `backend/app/services/analysis_engine.py`: analysis computation
- `backend/app/services/portable_analysis.py`: versioned single-HTML analysis export/import
- `frontend/src/pages/LibraryPage.tsx`: cell and replicate databases
- `frontend/src/pages/ProjectsPage.tsx`: folder tree and previews
- `frontend/src/pages/AnalysisPage.tsx`: analysis editor and saved plots
- `frontend/src/components/CacheWarmupCoordinator.tsx`: idle saved-plot cache preparation
- `frontend/src/api.ts`: typed frontend API client
- `packaging/`, `src-tauri/`, and `docs/windows-packaging.md`: Windows desktop packaging
- `docs/portable-analysis-html.md`: portable report format, security, and round-trip rules

## Maintained repository tree

This is the source-oriented repository map. It intentionally excludes generated dependencies and
outputs such as `node_modules/`, `frontend/dist/`, `build/`, `dist/`, `src-tauri/target/`,
`tmp/`, Python bytecode, and test application data.

```text
Cellxplorer/
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py, config.py, db.py, models.py, responses.py
│       ├── assets/                 Bundled browser assets for portable reports
│       ├── migrations/             Forward-only database migration registry and revisions
│       ├── routers/                FastAPI `/api` endpoint modules
│       │   └── automation.py       Pause/resume for background automation
│       └── services/               Parsing, caches, calculations, analysis, imports, jobs
│           ├── analysis_usage.py   Destructive-removal impact preview for analyses/plots
│           ├── automation.py       Durable automation_paused_until helpers
│           ├── chargeability.py    Semantic chargeability matching and curve extraction
│           └── rate_capability.py  Rate-sweep recognition and CC capacity extraction
├── frontend/
│   ├── package.json, vite.config.ts, tsconfig.json, index.html
│   ├── public/                     Static application assets
│   ├── src/
│   │   ├── main.tsx, App.tsx, app.css
│   │   ├── api.ts                  Typed backend client
│   │   ├── components/             Reusable UI and analysis/cell components
│   │   │   ├── ChargeabilityPlotCard.tsx
│   │   │   ├── RateCapabilityPlotCard.tsx
│   │   │   ├── DestructiveImpactModal.tsx
│   │   │   ├── DraftPlotCard.tsx
│   │   │   ├── FolderTree.tsx
│   │   │   ├── PlaceInFoldersModal.tsx
│   │   │   ├── ProtocolStructureViewer.tsx
│   │   │   ├── QuickSettingsMenu.tsx
│   │   │   ├── AppUpdateCoordinator.tsx
│   │   │   ├── AppUpdateModal.tsx
│   │   │   └── RecognitionProgress.tsx
│   │   ├── appChannel.ts           Stable/Beta channel branding (Spec 021)
│   │   ├── appUpdater.ts           App update state, Tauri commands, dev mock (Spec 018)
│   │   ├── updateNotifications.ts  Native Windows update notification adapter (Spec 020)
│   │   ├── analysisDraftPolicy.ts  Per-tab draft vs normal workspace leave/save/discard helpers
│   │   ├── analysisVisibility.ts   Context-aware cell-series visibility
│   │   ├── folderPlacement.ts      Pure placement-picker state (additive folder dialog)
│   │   ├── recognitionProgress.ts  Shared job-token progress polling for recognition tabs
│   │   └── pages/                  Inbox, Library, Projects, Analysis, Settings views
│   └── tests/                      Lightweight TypeScript policy tests
├── tests/                          Python backend and domain tests
│   ├── golden_analysis_support.py  Golden corpus harness, comparator, fixture installer
│   ├── test_golden_approval_checkpoints.py  Fail-closed scientific/privacy approval checks
│   ├── test_golden_analysis.py     Full-source golden analysis regression tests
│   ├── fixtures/
│   │   ├── golden_analysis/        Committed Neware sources + specs + expected JSON (Spec 015)
│   │   └── rate_capability_corpus.json  Synthetic positive/negative protocol families
│   ├── test_analysis_usage.py      Impact preview for cell/group removal
│   ├── test_automation.py          Automation pause endpoint and source-monitor skip
│   ├── test_chargeability.py       Formula matching and raw-curve scientific tests
│   ├── test_rate_capability.py     Sweep, CC-only, and common-rate normalization tests
│   ├── test_rate_capability_corpus.py  End-to-end synthetic detector corpus
│   ├── test_app_channels.py        Stable/Beta identity and build contract tests (Spec 021)
│   ├── test_check_versions_script.py Version declaration consistency checker tests
│   ├── test_bump_version_script.py   Version bump script tests
│   ├── test_updater_configuration.py  Read-only Tauri updater config and wiring checks
│   ├── test_release_notes_script.py Release-note parser tests (Spec 019)
│   ├── test_release_tag_script.py  Exact Stable/Beta tag parser tests
│   ├── test_release_workflow.py    Release/channel workflow contract tests
│   └── test_preflight_script.py    Preflight command unit tests
├── docs/
│   ├── specs/                      Numbered feature specs (`NNN-*.md`) and `reviews/` follow-ups
│   └── agent-knowledge/            Durable architecture and change playbooks
│       ├── chargeability-analysis.md
│       ├── rate-capability-analysis.md
│       ├── scientific-regression-testing.md
│       └── visual-style-guide.md
├── scripts/                        Development and Windows build launchers
│   ├── build_beta_icons.py         Derive Beta icon assets from Stable source art (Spec 021)
│   ├── build_golden_analysis_corpus.py  Export/refresh-expected/verify golden corpus (Spec 015)
│   ├── check_versions.py           Read-only version declaration consistency check
│   ├── bump_version.py             Synchronized SemVer bump + CHANGELOG prepend
│   ├── preflight.py                Canonical local verification command
│   ├── release_notes.py            Extract exact-version notes from CHANGELOG.md (Spec 019)
│   ├── release_tag.py              Exact Stable/Beta SemVer tag validation
│   ├── release_channel_policy.py   Future-Stable Beta release gate (Spec 023)
│   ├── release_channels.py         Manifest-only branch contract gate (Spec 023)
│   ├── verify_updater_manifest.py  Channel-aware latest.json validation
│   └── run_backend_tests.py        Parallel backend unittest runner for preflight
├── .github/workflows/              GitHub Actions CI and release automation
│   ├── preflight.yml               Clean Windows preflight on main pushes
│   └── release.yml                 Signed Stable/Beta publishing on v* tags (Specs 019/023)
├── packaging/                      PyInstaller backend sidecar entry point
├── src-tauri/                      Tauri shell, Rust entry point, icons, NSIS configuration
│   └── src/
│       ├── app_channel.rs          Stable/Beta identity helpers (Spec 021)
│       ├── app_updates.rs          Pending-update state and narrow updater commands (Spec 017)
│       ├── beta_installer.rs       Stable-owned first Beta installation (Spec 023)
│       ├── relaunch.rs             Parent-process-aware desktop relaunch helper
│       └── update_notifications.rs Windows toast display and activation event (Spec 020)
├── run.py                          Runs FastAPI with the built frontend
├── README.md                       Project overview and quick-start commands
├── spec.md                         Original domain specification
├── CHANGELOG.md                    User-facing version history
└── AGENTS.md                       This guide
```

Keep this tree accurate. When a change creates, deletes, moves, renames, or meaningfully
repurposes a tracked source, test, documentation, packaging, or configuration file/folder,
update this section in the same change when the map would otherwise become misleading. Do not add
one-off generated output, caches, build artifacts, or temporary files to the tree.

## Development commands

Use the repository helper scripts for the normal Windows workflows:

```powershell
.\scripts\start-webapp.cmd
.\scripts\build-app.cmd
```

`start-webapp.cmd` starts FastAPI and Vite together, configures the Vite API proxy, opens the
frontend, and cleans up both child processes on `Ctrl+C`. It accepts `-BackendPort`,
`-FrontendPort`, and `-NoBrowser`.

`build-app.cmd` installs npm dependencies when needed, builds the frontend, builds and copies the
PyInstaller sidecar, and creates the NSIS installer. It accepts `-SkipInstall`, `-SkipFrontend`,
`-SkipBackend`, and `-SkipInstaller` for incremental work. See `docs/local-development.md`.

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

After meaningful code changes, run the canonical local preflight:

```powershell
python scripts\preflight.py
```

Report the exact preflight result in your work summary. Do not claim verification passed when
preflight was not run, and do not remove or weaken tests to make preflight green.

Before release, verify every maintained version declaration matches:

```powershell
python scripts\check_versions.py
```

To bump every maintained declaration and prepend a changelog section:

```powershell
python scripts\bump_version.py --patch --notes "Short release note."
python scripts\bump_version.py 0.15.4 --notes-file notes.txt
```

Then run preflight and push the release tag.

## Release workflow

Use this sequence for user-facing Stable or Beta releases unless a spec says otherwise (for
example a coordinated release train that defers tagging until several specs land).

1. Finish and merge feature work to `main`, or confirm `main` already contains the release scope.
2. Bump every maintained version declaration and prepend `CHANGELOG.md`:
   ```powershell
   python scripts\bump_version.py --patch --notes "Short release note."
   python scripts\bump_version.py 0.16.2-beta.1 --notes "Beta release note."
   ```
3. Verify declarations: `python scripts\check_versions.py --expected-version <version>`
4. Before tagging, verify the pre-provisioned orphan `release-channels` branch contains only its
   README and valid channel manifests. The first Beta may create its initially absent pointer;
   Stable must already have a valid pointer. Never initialize the branch from `main`.
5. Run `python scripts\preflight.py --no-cache` and report the exact result.
6. Commit the version bump on `main`, push `main`, then create and push the tag:
   ```powershell
   git tag -a v<version> -m "CellXplorer <version>"
   git push origin main
   git push origin v<version>
   ```
   Tags must pass `python scripts\release_tag.py --tag v<version>`. Stable uses `vX.Y.Z`; Beta
   prereleases use `vX.Y.Z-beta.N`, and their core must be greater than the highest published exact
   Stable tag. The tag commit must be reachable from `main`.
7. Publishing is triggered by `.github/workflows/release.yml` on tag push. Monitor the Actions run;
   if a tag push fails early (for example preflight cancel), fix on `main`, push, delete and
   re-create the tag on the fixed commit, then push the tag again.
8. Confirm GitHub Release assets: channel-specific NSIS installer, matching `.sig`, and
   `latest.json`. Beta tags are true GitHub prereleases; Stable remains GitHub's latest normal
   release. Verify only the selected public raw channel pointer changed.
9. Do not publish the first channel release until both build-only workflow choices and the complete
   disposable installed/update matrix are recorded and the branch is re-reviewed.

Detailed packaging, signing, and updater notes live in
[`docs/agent-knowledge/change-playbooks.md`](docs/agent-knowledge/change-playbooks.md) and
[`docs/windows-packaging.md`](docs/windows-packaging.md).

Run the lightweight TypeScript policy tests directly when relevant:

```powershell
node --test frontend\tests\*.test.ts
```

The Vite build may need elevated sandbox permission on Windows because esbuild traverses paths
outside the workspace. This is an execution-environment issue, not necessarily a source failure.

## Implementation conventions

- Follow `docs/agent-knowledge/visual-style-guide.md` for all frontend work. Preserve the quiet,
  compact Mantine design, and reuse current controls and Tabler icons.
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
- Portable HTML is an untrusted, checksummed container. Import must never execute its JavaScript.
  Each exported plot keeps the serialized Plotly figure for interactive browsers and a frozen SVG
  from that same final figure for restricted previews such as Teams. Keep CSV data in the figure
  rather than adding another numerical cache copy.
- Embedded portable-report sources are downloaded individually or as a ZIP organized with one
  folder per cell. Preserve that hierarchy when multi-source cells are added later.
- The worktree may contain user changes. Never reset or discard unrelated modifications.

## Verification expectations

For backend/domain changes, add focused unit tests and run the full Python suite. For frontend
changes, run the TypeScript build and relevant direct tests. For interaction or layout changes,
verify the actual flow in the in-app browser at desktop width. A successful installer build is not
required for ordinary app changes; rebuild it only when requested.

Before packaging, follow `docs/windows-packaging.md` and `docs/tauri-packaging-lessons.md`. The
expected NSIS artifact is under `src-tauri/target/release/bundle/nsis/`.

## Versioning policy

When committing completed user-facing work, update the application version and `CHANGELOG.md`
without waiting for a separate user request. Follow SemVer pragmatically:

- patch for compatible bug fixes, reliability improvements, and internal-only changes;
- minor for backward-compatible features or meaningful workflow additions;
- major for deliberate compatibility breaks in the database, portable-report format, or public
  behavior that cannot be migrated safely.

Keep the backend, root/frontend package manifests and lockfiles, Tauri configuration, and the
CellXplorer Cargo package entry on the same version. Do not bump versions for intermediate edits
that are not being committed as a completed change.
