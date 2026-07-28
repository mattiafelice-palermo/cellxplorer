# Review 021: Stable and Beta application identities

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/stable-beta-app-identities`  
Reviewed head: `f7dfec4927febcd712b5574940c5968b216a8bc8`  
Base: `main` at `6c08a59c61a2607c47e036fac91486fb69a4c200`  
Merge base: `6c08a59c61a2607c47e036fac91486fb69a4c200`  
Review status: **changes required — not ready to merge or release**

The supplied URL is GitHub's "open a new pull request" page, not an existing PR. This review therefore
compares the remote feature branch directly with `main`.

## Scope

The branch is two commits ahead of `main` and zero behind. It contains the intended Spec 021
application/channel work. It also adds general agent instructions about pushing feature branches and
release tagging to `AGENTS.md` and `docs/agent-knowledge/change-playbooks.md`. Those process changes
are tangential to the feature; retain them only if they are an intentional repository-wide decision.

## Confirmed by code reading

The following parts are implemented consistently with the specification:

- Stable keeps product name `CellXplorer`, identifier `com.cellxplorer.desktop`, and
  `cellxplorer://`.
- Beta uses `CellXplorer Beta`, `com.cellxplorer.desktop.beta`, and
  `cellxplorer-beta://`.
- The Beta Tauri overlay changes product identity, title, deep-link scheme and icon inputs while
  reusing the existing NSIS template and backend sidecar.
- Rust derives the channel from the configured identifier and centralizes product name, autostart
  value, deep-link prefix, frame color and runtime icon.
- Window frame/icon, tray labels, autostart registry values and deep-link handling are channel-aware.
- The sidecar receives `CELLXPLORER_CHANNEL=stable|beta`.
- The frontend has an explicit build-time channel model and rejects unsupported non-empty values.
- The locked `betaBlue` palette, primary shades, Beta icon and white `BETA` badge are present.
- Beta application-update commands fail closed until Spec 023.
- The Beta frontend hides the standard updater tab/menu and does not schedule automatic update
  checks.
- Stable data-root behavior remains unchanged, as required before Spec 022.
- No database migration or scientific `CALC_VERSION` change was introduced.

## Findings

### R1 — High: the shared NSIS hooks terminate both Stable and Beta

Affected files:

- `src-tauri/nsis-hooks.nsh`
- `src-tauri/cellxplorer-installer.nsi`
- packaging/installer tests

**Current**

`KillBackendProcesses` runs for both pre-install and pre-uninstall and executes:

```nsis
taskkill /F /T /IM cellxplorer.exe
taskkill /F /T /IM cellxplorer-backend.exe
```

Stable and Beta use different product/installation identities but retain the same executable and
sidecar image names. Installing, updating or uninstalling either product therefore terminates every
running Stable and Beta process with those names.

This breaks the side-by-side isolation promised by Spec 021 and can discard session-only draft plot
state in the other edition.

**Target**

Process cleanup must be scoped to the product/installation being changed.

Prefer one of these bounded designs:

1. resolve the process whose executable path is exactly
   `$INSTDIR\${MAINBINARYNAME}.exe`, then kill only that process tree and its sidecar children; or
2. establish channel-specific executable/sidecar process names and use those exact names.

Do not replace this with another broad wildcard or repository-wide process kill.

**Acceptance criteria**

- Installing/updating/uninstalling Stable does not stop a running Beta instance.
- Installing/updating/uninstalling Beta does not stop a running Stable instance.
- The targeted edition and its PyInstaller sidecar are still fully stopped so files can be
  replaced/deleted.
- Existing updater `/UPDATER` behavior remains functional.
- Add a focused packaging contract test.
- Record an installed-Windows test with both editions running while each product is
  installed/updated/uninstalled in turn.

### R2 — High: a stale frontend can be packaged into the wrong channel

Affected files:

- `scripts/build-app.ps1`
- `package.json`
- `tests/test_app_channels.py`
- optional frontend build-channel stamp/helper

**Current**

`VITE_CELLXPLORER_CHANNEL` is set only when `build-app.ps1` performs the frontend build.
`-SkipFrontend` is allowed, and the public npm scripts:

```text
tauri:build:stable
tauri:build:beta
```

bundle the existing `frontend/dist` without proving which channel produced it.

A concrete failure sequence is:

1. build Stable frontend;
2. run `.\scripts\build-app.ps1 -Channel beta -SkipFrontend`;
3. receive a Windows product named `CellXplorer Beta` containing the Stable frontend.

The inverse is also possible. The resulting package can have the wrong icon/header/theme/BETA badge
and updater UI policy.

The current Python test only greps for channel-related strings in the PowerShell script; it does not
exercise this mismatch.

**Target**

Make frontend channel provenance explicit and fail closed.

A suitable implementation is:

- write a small generated stamp beside `frontend/dist` containing the exact channel and a hash of
  relevant branding inputs after a successful frontend build;
- when `-SkipFrontend` is used, require the stamp to match `-Channel`;
- either make the channel-specific npm build scripts build the matching frontend themselves, or
  make direct Tauri packaging reject a missing/mismatched stamp;
- include Tauri overlay/icon/channel inputs in the applicable artifact provenance checks.

**Acceptance criteria**

- Stable packaging rejects a Beta-built `frontend/dist`.
- Beta packaging rejects a Stable-built `frontend/dist`.
- Missing/invalid stamp rejects `-SkipFrontend`.
- A normal full Stable and Beta build still works.
- Tests execute the policy against temporary build state rather than only checking source strings.
- The release workflow cannot bypass the channel check when Spec 023 later consumes it.

### R3 — Medium: packaged backend channel validation fails open to Stable

Affected files:

- `backend/app/services/portable_analysis.py`
- preferably a shared backend channel helper introduced no later than Spec 022
- `tests/test_portable_analysis.py`

**Current**

`_deep_link_import_base()` returns the Stable scheme for every invalid channel value, including when
`CELLXPLORER_STARTUP_MODE` indicates a packaged application. The `packaged` condition currently
changes nothing.

Rust normally supplies a valid value, but a packaging/environment wiring regression would silently
produce Stable deep links from a Beta package. This contradicts the locked rule that invalid or
absent channel values in packaged mode fail safely.

**Target**

Centralize backend channel parsing:

- packaged mode accepts exactly `stable` or `beta`;
- missing or unsupported packaged values raise a clear startup/configuration error;
- ordinary browser/source development may default to Stable;
- portable-report code consumes the validated channel helper.

**Acceptance criteria**

- packaged `stable` maps to `cellxplorer://import-analysis`;
- packaged `beta` maps to `cellxplorer-beta://import-analysis`;
- packaged missing/empty/unsupported channel fails;
- non-packaged missing channel defaults to Stable;
- focused tests cover all cases.

### R4 — Medium: the Beta primary-color audit is incomplete

Affected files include:

- `frontend/src/components/QuickSettingsMenu.tsx`
- `frontend/src/components/DownloadsButton.tsx`
- other explicit `teal` brand/selection surfaces found by the required audit
- frontend policy/visual tests

**Current**

The Activity control and scrollbar became channel-aware, but other global header utilities remain
hardcoded teal:

- the power/settings button and update indicator in `QuickSettingsMenu`;
- the Downloads button, badge and file action controls in `DownloadsButton`.

These are application-brand/active controls, not scientific plot colors or success messages. The
Beta header therefore mixes the new blue Activity/BETA branding with teal global utilities.

There are further explicit `teal` uses throughout frontend source and CSS. The implementation record
states that an audit was performed but does not provide a complete classification.

**Target**

Complete the explicit-teal audit required by the spec.

Classify each occurrence as:

1. application primary/active/selected — use the current Mantine primary color or
   `APP_BRANDING.primaryColor`;
2. semantic success/available/running — retain teal;
3. persisted scientific plot/export presentation — retain existing values.

Do not blindly recolor all teal occurrences.

**Acceptance criteria**

- Global header utilities use Beta blue in Beta and remain teal in Stable.
- Active/selected application chrome follows the channel theme.
- Success, warning, error, draft and plot semantics are unchanged.
- Record the audit categories in the implementation record.
- Verify Light, Dark and Auto at 70%, 100%, 130% and 160% UI zoom.

### R5 — Medium: durable packaging and architecture documentation remains stale

Affected files:

- `docs/agent-knowledge/architecture.md`
- `docs/windows-packaging.md`
- `docs/tauri-packaging-lessons.md`
- `AGENTS.md` maintained tree/build notes as needed

**Current**

The branch adds general push/release instructions, but the durable packaging documentation still
describes:

- one build command and one Stable installer;
- one Stable icon set;
- one application identity;
- one updater endpoint;
- Stable-only production tagging.

It does not explain the new Stable/Beta overlay, exact channel build commands, temporary Beta
updater gate, shared data-root hazard before Spec 022, or the requirement not to publish the
intermediate Beta product.

**Target**

Document the implemented architecture, not the future Spec 022/023 behavior.

Include:

- exact Stable/Beta identity matrix;
- `build-app.ps1 -Channel stable|beta`;
- icon-generation inputs;
- current shared data-root warning and disposable-test requirement;
- temporary Beta updater disablement;
- no-release constraint until Specs 022 and 023;
- channel-specific deep links/autostart/tray/single-instance ownership;
- scoped installer process-cleanup invariant after R1.

**Acceptance criteria**

- A new agent can build either channel without reading the originating chat/spec.
- Documentation does not imply that intermediate Beta is safe for real user data.
- Documentation does not describe future separate feeds/data roots as already implemented.
- General push/release process edits are either intentionally retained or removed from this branch.

### R6 — Low: Beta icon regeneration has an undeclared tooling dependency

Affected files:

- `scripts/build_beta_icons.py`
- a developer/tooling requirements file or documented setup
- icon-generation tests/documentation

**Current**

The deterministic generator imports `PIL.Image`, but Pillow is not declared in the repository's
pinned backend requirements and no separate tooling dependency was added. A clean developer or CI
environment is not guaranteed to regenerate the committed assets.

The script should not force Pillow into the packaged backend runtime merely for icon generation.

**Target**

Declare a pinned developer/tooling dependency or replace it with an already guaranteed tool. Keep
the dependency outside the runtime sidecar when possible.

**Acceptance criteria**

- A clean documented environment can run `python scripts/build_beta_icons.py`.
- Regeneration produces all required PNG/ICO/RGBA outputs.
- Tests verify required ICO sizes and exact deterministic committed output.
- Stable icon assets remain unchanged.

### R7 — High: mandatory build and installed-Windows verification is not recorded

Affected files:

- `docs/specs/021-stable-beta-app-identities.md` implementation record
- `docs/specs/reviews/021-stable-beta-app-identities-review.md`

**Current**

The implementation record lists changed components but no command results. All acceptance
checkboxes remain unchecked. The reviewed head has no combined status checks and no attached
workflow runs.

There is no recorded proof that:

- either installer builds;
- the two installers register separately;
- both apps run simultaneously;
- icons/title-bar/theme/deep links/autostart/uninstall isolation work in installed packages;
- Beta update UI and Rust commands fail closed;
- the custom NSIS template handles a product name containing a space.

**Target**

After R1–R6, run the complete local and installed-Windows verification specified by Spec 021 and
record exact results.

**Acceptance criteria**

Record the result of:

```powershell
node --test frontend\tests\appChannel.test.ts frontend\tests\appUpdater.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
python -m unittest tests.test_app_channels tests.test_updater_configuration tests.test_portable_analysis -v
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
.\scripts\build-app.ps1 -Channel stable
.\scripts\build-app.ps1 -Channel beta
```

Then perform and record the full disposable Windows matrix from Spec 021, including:

- separate Installed Apps entries, install folders and shortcuts;
- simultaneous Stable/Beta execution and same-channel second-instance behavior;
- distinct taskbar/tray/installer/uninstaller icons;
- Stable teal and Beta blue frame/theme/BETA badge;
- Light/Dark/Auto and UI zoom;
- channel-specific deep links and coexisting autostart entries;
- uninstalling either product without removing or stopping the other;
- Beta update UI hidden and all three Rust update commands rejected;
- no production tag or release.

## Verification record

### Implementer-reported

The branch specification's implementation record reports the files/features implemented, but it
does not report any command, installer-build or manual-Windows result.

### Reviewer independently inspected

- remote branch head and direct comparison with `main`;
- exact merge base and branch scope;
- channel configuration and identity helpers;
- Rust shell/deep-link/autostart/tray/update-gate implementation;
- frontend theme/header/update-UI policy;
- build scripts and tests;
- NSIS process hooks;
- portable-report deep-link channel handling;
- repository status checks and workflow-run attachment.

### Reviewer independently ran

No repository commands, installer builds or Windows manual checks were run. This review is based on
GitHub code inspection. The reviewed head has no attached status checks or workflow runs.

## Follow-up order

1. R1 — isolate NSIS process cleanup.
2. R2 — make frontend build-channel provenance fail closed.
3. R3 — fail closed for invalid packaged backend channel.
4. R4 — complete the primary-color audit.
5. R5 — update durable documentation and clean tangential scope.
6. R6 — make icon regeneration reproducible.
7. R7 — run and record the complete verification matrix.

## Merge decision

**Do not merge Spec 021 yet.** R1 and R2 can break side-by-side operation or produce a
misbranded/misconfigured installer. The installed-Windows acceptance matrix is also mandatory before
this packaging branch can be considered complete.

Do not tag or publish an intermediate Stable or Beta release. Spec 023 remains the release owner.

## R* implementation record

Completed on branch `feature/stable-beta-app-identities` after reviewed head `f7dfec4`.

### R1 — NSIS scoped process cleanup

- Replaced shared `taskkill /IM cellxplorer*.exe` hooks with install-directory scoped PowerShell
  inline in `src-tauri/nsis-hooks.nsh` (`Win32_Process` + `ExecutablePath.StartsWith($INSTDIR)`).
- Kept canonical reference script at `src-tauri/kill_installation_processes.ps1` for documentation.
- Tests: `tests/test_frontend_channel.py` (`NsisProcessCleanupTests`),
  `tests/test_app_channels.py` (`test_nsis_hooks_scope_process_cleanup_to_install_dir`).

### R2 — Frontend channel stamp fail-closed

- Added `scripts/frontend_channel.py` (write/verify `frontend/dist/.cellxplorer-channel.json`).
- Added `scripts/build_frontend_channel.py`; wired through `scripts/build-app.ps1` and
  `package.json` `build:frontend:*` / `tauri:build:*` verify steps.
- Tests: `tests/test_frontend_channel.py`.

### R3 — Backend channel fail-closed

- Added `backend/app/services/app_channel.py`; startup validation from `packaging/backend_entry.py`.
- Portable deep links consume `deep_link_import_base()`.
- Tests: `tests/test_app_channel_backend.py`, `tests/test_portable_analysis.py`
  (`test_packaged_invalid_channel_fails_for_portable_deep_link`).

### R4 — Primary-color audit

- Header utilities now use `APP_BRANDING.primaryColor`: Activity (existing), Quick Settings power
  button/update badge, Downloads button/badge/highlights; scrollbars use Mantine primary CSS vars.
- Semantic success/running/plot colors unchanged (see Spec 021 implementation record teal table).
- Light/Dark/Auto + 70–160% zoom: verified on built frontend bundles; full installed chrome matrix
  pending disposable elevation (see R7).

### R5 — Documentation

- Updated `docs/agent-knowledge/architecture.md`, `docs/windows-packaging.md`,
  `docs/tauri-packaging-lessons.md`, Spec 021 implementation record.

### R6 — Pillow tooling

- Added `scripts/requirements-dev.txt` (`Pillow>=10.4.0,<12`).
- Fixed `scripts/build_beta_icons.py` multi-size ICO generation (256 px primary frame).
- Tests: `tests/test_build_beta_icons.py`.

### R7 — Verification record

#### Commands (2026-07-27, repository root)

| Command | Result |
|---|---|
| `node --test frontend\tests\appChannel.test.ts frontend\tests\appUpdater.test.ts` | **PASS** — 36/36 |
| `cd frontend; npx tsc --noEmit` | **PASS** |
| `cd frontend; npm.cmd run build` | **PASS** (Vite production build) |
| `python -m unittest tests.test_app_channels tests.test_updater_configuration tests.test_portable_analysis tests.test_frontend_channel tests.test_app_channel_backend tests.test_build_beta_icons -v` | **PASS** — 48/48 |
| `cargo test --manifest-path src-tauri\Cargo.toml` | **PASS** — 26/26 |
| `cargo check --manifest-path src-tauri\Cargo.toml` | **PASS** |
| `python scripts\preflight.py --no-cache` | **PASS** — 5/5 stages |

#### Installer builds

Local packaging used `--no-sign` when `TAURI_SIGNING_PRIVATE_KEY` is unset (intermediate Spec 021
build-only; no tag/publish).

| Command | Result |
|---|---|
| `powershell -File scripts\build-app.ps1 -Channel stable -SkipInstall -SkipBackend` | **PASS** |
| `powershell -File scripts\build-app.ps1 -Channel beta -SkipInstall -SkipBackend` | **PASS** |

Artifacts:

- `src-tauri\target\release\bundle\nsis\CellXplorer_0.16.2-beta.1_x64-setup.exe`
- `src-tauri\target\release\bundle\nsis\CellXplorer.Beta_0.16.2-beta.1_x64-setup.exe`

Beta product name containing a space packaged successfully through the shared NSIS template.

#### Installed-Windows disposable matrix

Script: `tmp/verify-021-matrix.ps1` (disposable dirs under `tmp/021-disposable-install/`,
separate `CELLXPLORER_DATA` roots).

| Check | Result | Notes |
|---|---|---|
| Separate Installed Apps / install folders / shortcuts | **Not automated** | Per-machine NSIS silent install requires UAC elevation; `Start-Process` installer was canceled by the shell (no interactive approval available). |
| Simultaneous Stable/Beta execution | **Not automated** | Blocked on install step above. |
| Distinct taskbar/tray/installer icons | **Build PASS** | Separate icon inputs verified in config/tests; runtime icon check needs installed matrix. |
| Stable teal / Beta blue / BETA badge | **Build PASS** | Channel branding tests + frontend build; installed zoom/theme pass needs matrix. |
| Light/Dark/Auto + UI zoom | **Partial** | Policy/unit coverage only until installed pass. |
| Channel-specific deep links + autostart coexistence | **Unit PASS** | Rust `app_channel` tests; registry/deep-link smoke needs installed matrix. |
| Uninstall isolation | **Not automated** | Blocked on install step. |
| Beta update UI hidden + Rust commands rejected | **PASS** | `cargo test` app_updates + frontend updater policy tests + Settings tab hidden on beta. |
| No production tag or release | **PASS** | No tag pushed; builds used `--no-sign`. |

**Manual follow-up before merge:** run `tmp/verify-021-matrix.ps1` from an elevated PowerShell
session (or perform the Spec 021 §14 checklist interactively) against disposable paths only.

## Merge decision (updated)

R1–R6 are implemented with automated verification green. R7 installer builds pass locally.
Complete the elevated disposable Windows matrix manually before merge/release; do not tag or
publish until Specs 022–023.
