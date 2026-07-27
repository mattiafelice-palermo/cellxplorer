# Windows packaging

This repository can be packaged as a native Windows app with Tauri:

1. Build the React frontend into `frontend/dist`.
2. Build the Python backend into a sidecar executable named `cellxplorer-backend.exe`.
3. Let Tauri bundle both into an installer.

User data must stay outside the install directory. The current backend already stores data under
`CELLXPLORER_DATA` or the user's `.cellxplorer` folder. The SQLite database is protected by
explicit packaged schema migrations and automatic pre-migration backups. See
`docs/database-migrations.md`.

## Required local tools

- Node.js and npm
- Rust toolchain (`rustc` and `cargo`)
- Tauri CLI (`@tauri-apps/cli`)
- PyInstaller
- Windows installer toolchain required by Tauri for MSI/NSIS

## Recommended build command

From the repository root, run:

```powershell
.\scripts\build-app.cmd -Channel stable
.\scripts\build-app.cmd -Channel beta
```

`-Channel` defaults to `stable`. Each channel builds its own frontend (`VITE_CELLXPLORER_CHANNEL`)
and writes a fail-closed stamp at `frontend/dist/.cellxplorer-channel.json`. Packaging rejects a
stale or mismatched stamp, so a Stable-built `frontend/dist` cannot be bundled into Beta and vice
versa.

This performs the complete frontend, backend sidecar, and NSIS build. See
`docs/local-development.md` for incremental options and the expected output path.

### Stable and Beta identities (Spec 021)

| Property | Stable | Beta |
|---|---|---|
| Product name | CellXplorer | CellXplorer Beta |
| Identifier | `com.cellxplorer.desktop` | `com.cellxplorer.desktop.beta` |
| Deep link | `cellxplorer://` | `cellxplorer-beta://` |
| Default install folder | `Program Files\CellXplorer` | `Program Files\CellXplorer Beta` |
| Updater | Stable GitHub feed | disabled until Spec 023 |

Both editions share the backend sidecar binary and NSIS template. NSIS pre-install/uninstall hooks
kill only processes whose executable path is under the installation directory being changed — never
by shared image name alone.

**Data root:** both editions still use the same default `%USERPROFILE%\.cellxplorer` until Spec
022. Do not install intermediate Beta builds against real user data; use disposable
`CELLXPLORER_DATA` or a test account.

**Release:** do not tag or publish an intermediate Beta product until Specs 022–023 complete the
release train.

Beta icons are generated deterministically:

```powershell
pip install -r scripts\requirements-dev.txt
python scripts\build_beta_icons.py
```

Committed outputs live under `frontend/public/app-icon-beta.png` and `src-tauri/icons-beta/`.
Stable icons under `src-tauri/icons/` must remain unchanged.

Expected outputs:

- `src-tauri/target/release/bundle/nsis/CellXplorer_<version>_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/CellXplorer Beta_<version>_x64-setup.exe`

The Stable app icon is sourced from `frontend/public/app-icon.png`. The Tauri bundle uses
`src-tauri/icons/icon.ico` (Stable) or `src-tauri/icons-beta/icon.ico` (Beta overlay). The runtime
window/taskbar icon is set from the matching `icon-256.rgba` in `src-tauri/src/main.rs`.

## Manual build sequence

Prefer `.\scripts\build-app.ps1 -Channel stable|beta`. When building manually:

```powershell
npm.cmd install

python scripts\build_frontend_channel.py stable
# or: python scripts\build_frontend_channel.py beta

npm.cmd run build:backend
New-Item -ItemType Directory -Force src-tauri\binaries
Copy-Item dist\cellxplorer-backend.exe src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe -Force

python scripts\frontend_channel.py verify --channel stable
npm.cmd run tauri:build:stable
```

Direct `tauri:build:beta` verifies the frontend stamp before packaging.

The backend build includes `backend/app/assets/plotly.min.js`. This offline runtime is embedded
once in each portable HTML analysis so serialized Plotly figures remain interactive without an
internet connection.

## Agent build note

When running the frontend build from a managed Codex sandbox, Vite/esbuild can fail while resolving
`frontend/vite.config.ts` with errors like:

```text
Cannot read directory "../../..": Access is denied.
Could not resolve "...\frontend\vite.config.ts"
```

This is a sandbox path-resolution issue, not a project build failure. Rerun the same frontend build
command with elevated sandbox permission, then continue with the normal packaging sequence.

Expected output, once the toolchain is installed:

- Stable: `src-tauri/target/release/bundle/nsis/CellXplorer_<version>_x64-setup.exe`
- Beta: `src-tauri/target/release/bundle/nsis/CellXplorer Beta_<version>_x64-setup.exe`

The Stable app icon is sourced from `frontend/public/app-icon.png`.
The Tauri bundle uses channel-specific icons under `src-tauri/icons/` (Stable) or
`src-tauri/icons-beta/` (Beta overlay), and the runtime window/taskbar icon uses the matching
`icon-256.rgba`. Regenerate Beta assets with `python scripts\build_beta_icons.py` after changing
the Stable source icon; Stable committed assets must remain byte-for-byte unchanged unless
intentionally replaced.

## Branded NSIS installer

`src-tauri/cellxplorer-installer.nsi` is a vendored copy of Tauri's NSIS template with the
CellXplorer installer and uninstaller surfaces built directly in nsDialogs. Tauri is configured to
use it through `bundle.windows.nsis.template` in `src-tauri/tauri.conf.json`. The first visible
installer page is the location step; it includes the three-step progress indicator, desktop and
startup options, and the custom CellXplorer actions. Uninstall preserves `%USERPROFILE%\.cellxplorer`
by default and offers deletion only as an explicit, confirmed destructive choice.

The template is version-coupled to the Tauri CLI. When upgrading Tauri, compare it with the exact
upstream template for the new CLI before carrying the branded sections forward. A template can
compile successfully while stock MUI controls overlap the custom page, so visually smoke-test both
the installer and uninstaller after template or NSIS changes. Never test the destructive uninstall
choice against a real user data directory.

## Desktop startup performance

The packaged backend is a PyInstaller one-file sidecar. A cold launch includes extraction of the
scientific Python runtime before FastAPI can listen. Database migration inspection itself is small
(about 0.1-0.2 seconds on the development database); do not weaken schema compatibility checks to
optimize startup. Expensive pandas, NewareNDA, PyArrow, analysis, and cache modules are loaded lazily
after API startup, and old-cache capacity backfilling starts from the same deferred warm-up thread.

The frontend deliberately mounts its normal route immediately while the database-status query is
pending. Network-only query failures are retried during the short sidecar boot window. The backend
compatibility middleware remains authoritative: if the schema is unsupported, normal API requests
are rejected and the frontend replaces the route with the compatibility screen as soon as status
arrives. This restores the pre-0.6 responsive shell without bypassing migration safety.

MSI is possible, but the default target is NSIS because WiX validation can fail on
machines where the Windows Installer service is not available to the build process.
For this spike, MSI could be emitted manually with WiX `light.exe -sval` after Tauri
generates `src-tauri/target/release/wix/x64/main.wixobj`.

## Tauri updater artifacts

`src-tauri/tauri.conf.json` sets `bundle.createUpdaterArtifacts: true`. A signed release build
produces the normal NSIS setup executable plus an adjacent `.sig` file in
`src-tauri/target/release/bundle/nsis/`. Tauri updater signatures are separate from Windows
Authenticode signing.

The production update manifest endpoint is:

```text
https://github.com/mattiafelice-palermo/cellxplorer/releases/latest/download/latest.json
```

Only the updater **public key** belongs in `tauri.conf.json`. Store the private key outside the
repository (developer backup and later GitHub Actions secrets). Local packaging with updater
signatures requires:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="<secure path or key content>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password when used>"
.\scripts\build-app.cmd
```

The Tauri shell owns update checking, download verification, and installer launch through narrow
Rust commands in `src-tauri/src/app_updates.rs`. The webview must not call the generic updater
plugin API directly. On Windows, the Python sidecar is stopped only through the updater plugin's
`on_before_exit` hook immediately before NSIS launch; check and download must not stop the backend.
Pre-hook install errors can still return to the frontend. After `on_before_exit` runs, Tauri exits
regardless of whether Windows successfully opens the installer, so there is no post-hook recovery
UI.

The branded NSIS template recognizes both Tauri's managed `/UPDATER` flag and the legacy `/UPDATE`
alias. Both enter the existing update mode that skips ordinary reinstall-choice pages while
preserving `%USERPROFILE%\.cellxplorer`.

**Bootstrap limitation:** existing installed builds without the updater cannot receive the first
updater-enabled release automatically. The first updater-capable version must be installed manually;
later releases can use the in-app update flow once public release assets are available.

Automatic update discovery may show a native Windows notification. Verify notification title/body
identity and body-click restore/focus/modal behavior in an **installed** NSIS package. Development
(`tauri dev`) builds may show PowerShell branding/name instead of CellXplorer, so do not treat
dev-only branding as final proof.

## Production GitHub release

Stable releases are published by pushing a SemVer tag:

```powershell
git tag v0.15.0
git push origin v0.15.0
```

The `.github/workflows/release.yml` workflow then:

1. verifies the tag is exact stable SemVer (`vMAJOR.MINOR.PATCH`) and reachable from `main`;
2. refuses to replace an already published non-draft release;
3. fails before publishing when the repository is private;
4. extracts the matching `CHANGELOG.md` section with `scripts/release_notes.py`;
5. runs `python scripts/preflight.py --no-cache`;
6. builds the PyInstaller sidecar through `scripts/build-app.ps1`;
7. stages a **draft** GitHub Release with the pinned `tauri-apps/tauri-action`, signed NSIS
   installer, `.sig`, and workspace-root `latest.json`;
8. validates the draft manifest against release-asset metadata with
   `scripts/verify_updater_manifest.py`;
9. undrafts the release only after verification succeeds.

Required GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Use **Actions → Publish CellXplorer release → Run workflow** for a build-only rehearsal. Manual
dispatch never creates or alters a GitHub Release.

Published versions are immutable. If a stable release is wrong, cut a new patch version rather than
rebuilding the same tag.

The repository must be public before a production tag publish is allowed, so installed applications
can fetch `latest.json` without credentials.

If the updater signing key is lost, existing installed clients cannot trust releases signed with a
new key. Plan key backup before the first bootstrap release and treat rotation as a major,
user-visible migration.

## Current blocker found during the spike

This spike produced an NSIS installer. The MSI path reached WiX linking, but WiX ICE validation
failed because the Windows Installer service was not accessible in the build environment.
