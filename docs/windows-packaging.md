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
.\scripts\build-app.cmd -Channel alpha
```

`-Channel` defaults to `stable`. Each channel builds its own frontend (`VITE_CELLXPLORER_CHANNEL`)
and writes a fail-closed stamp at `frontend/dist/.cellxplorer-channel.json`. Packaging rejects a
stale or mismatched stamp, so a build from one channel cannot be bundled into another.

This performs the complete frontend, backend sidecar, and NSIS build. See
`docs/local-development.md` for incremental options and the expected output path.

### Stable, Beta, and Alpha identities (Specs 021/053.1/053.2)

| Property | Stable | Beta | Alpha |
|---|---|---|---|
| Product name | CellXplorer | CellXplorer Beta | CellXplorer Alpha |
| Identifier | `com.cellxplorer.desktop` | `com.cellxplorer.desktop.beta` | `com.cellxplorer.desktop.alpha` |
| Deep link | `cellxplorer://` | `cellxplorer-beta://` | `cellxplorer-alpha://` |
| Default install folder | `Program Files\CellXplorer` | `Program Files\CellXplorer Beta` | `Program Files\CellXplorer Alpha` |
| Updater | `release-channels/stable/latest.json` | `release-channels/beta/latest.json` | `release-channels/alpha/latest.json` |

All three editions share the backend sidecar binary and NSIS template. NSIS pre-install/uninstall hooks
kill only processes whose executable path is under the installation directory being changed — never
by shared image name alone. After the last matching process disappears, the helper requires five
consecutive quiet checks before NSIS overwrites binaries; this covers the short Windows image-release
race without killing the other channel.

**Data root:** Stable defaults to `%USERPROFILE%\.cellxplorer`; Beta defaults to
`%USERPROFILE%\.cellxplorer-beta`; Alpha defaults to `%USERPROFILE%\.cellxplorer-alpha`.
`CELLXPLORER_DATA` overrides any root exactly for tests and development. Do not install intermediate
Beta or Alpha builds against real user data; use disposable `CELLXPLORER_DATA` or a test account.

Alpha starts empty and has no Stable/Beta data-copy or synchronization path. Its updater uses the
dedicated Alpha endpoint and shared standard update state; only exact dotted
`MAJOR.MINOR.PATCH-alpha.N` versions are accepted.

**Release:** Stable, Beta, and Alpha publish to separate SemVer tag families. Beta and Alpha GitHub
releases are prereleases. Verified updater manifests are copied to the `release-channels` branch
(`stable/latest.json`, `beta/latest.json`, `alpha/latest.json`) after draft verification. The first
Stable release after Spec 023 still ships `latest.json` on the GitHub release for legacy bootstrap
clients.

Beta icons are generated deterministically:

```powershell
pip install -r scripts\requirements-dev.txt
python scripts\build_beta_icons.py
```

Committed outputs live under `frontend/public/app-icon-beta.png` and `src-tauri/icons-beta/`.
Large Beta frames contain a high-contrast `BETA` badge; 16/24/32 px ICO frames use a separately
rendered `B` badge. Stable icons under `src-tauri/icons/` must remain unchanged.

Alpha icons are generated with `python scripts\build_alpha_icons.py`; committed outputs live under
`frontend/public/app-icon-alpha.png` and `src-tauri/icons-alpha/`. Large Alpha frames contain a
high-contrast `ALPHA` badge; 16/24/32 px ICO frames use a separately rendered `A` badge.

Expected outputs:

- `src-tauri/target/release/bundle/nsis/CellXplorer_<version>_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/CellXplorer.Beta_<version>_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/CellXplorer.Alpha_<version>_x64-setup.exe`

Tauri derives Beta and Alpha's intermediate filenames from their spaced product names. The
repository build script matches that exact product-specific output and then normalizes only the
freshly built installer (and signature, when present) to the dotted channel artifact name above.
It never selects an arbitrary newest installer.

The Stable app icon is sourced from `frontend/public/app-icon.png`. The Tauri bundle uses
`src-tauri/icons/icon.ico` (Stable), `src-tauri/icons-beta/icon.ico` (Beta overlay), or
`src-tauri/icons-alpha/icon.ico` (Alpha overlay). The runtime window/taskbar icon is set from the
matching `icon-256.rgba` in `src-tauri/src/main.rs`.

## Manual build sequence

Prefer `.\scripts\build-app.ps1 -Channel stable|beta|alpha`. When building manually:

```powershell
npm.cmd install

python scripts\build_frontend_channel.py stable
# or: python scripts\build_frontend_channel.py beta
# or: python scripts\build_frontend_channel.py alpha

npm.cmd run build:backend
New-Item -ItemType Directory -Force src-tauri\binaries
Copy-Item dist\cellxplorer-backend.exe src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe -Force

python scripts\frontend_channel.py verify --channel stable
npm.cmd run tauri:build:stable
```

Direct `tauri:build:beta` and `tauri:build:alpha` verify the frontend stamp before packaging.

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
- Beta: `src-tauri/target/release/bundle/nsis/CellXplorer.Beta_<version>_x64-setup.exe`
- Alpha: `src-tauri/target/release/bundle/nsis/CellXplorer.Alpha_<version>_x64-setup.exe`

The Stable app icon is sourced from `frontend/public/app-icon.png`.
The Tauri bundle uses channel-specific icons under `src-tauri/icons/` (Stable),
`src-tauri/icons-beta/` (Beta overlay), or `src-tauri/icons-alpha/` (Alpha overlay), and the
runtime window/taskbar icon uses the matching `icon-256.rgba`. Regenerate preview assets with
`python scripts\build_beta_icons.py` or `python scripts\build_alpha_icons.py` after changing the
Stable source icon; Stable committed assets must remain byte-for-byte unchanged unless
intentionally replaced.

## Branded NSIS installer

`src-tauri/cellxplorer-installer.nsi` is a vendored copy of Tauri's NSIS template with the
CellXplorer installer and uninstaller surfaces built directly in nsDialogs. Tauri is configured to
use it through `bundle.windows.nsis.template` in `src-tauri/tauri.conf.json`. The first visible
installer page is the location step; it includes the three-step progress indicator, desktop and
startup options, and the custom CellXplorer actions. Uninstall preserves the product's own profile
data root by default (`%USERPROFILE%\.cellxplorer` for Stable, `%USERPROFILE%\.cellxplorer-beta`
for Beta, `%USERPROFILE%\.cellxplorer-alpha` for Alpha) and offers deletion only as an explicit,
confirmed destructive choice. The destructive
path deletes only that product's `CX_PROFILE_DATA_DIR` derived from the exact bundle identifier —
no channel may remove another channel's root.

The template is version-coupled to the Tauri CLI. When upgrading Tauri, compare it with the exact
upstream template for the new CLI before carrying the branded sections forward. A template can
compile successfully while stock MUI controls overlap the custom page, so visually smoke-test both
the installer and uninstaller after template or NSIS changes. Never test the destructive uninstall
choice against a real user data directory.

The template also derives visual brand constants from the exact bundle identifier. Stable uses
RGB `12B886` / COLORREF `0x0086B812`; Beta uses RGB `3678B7` / COLORREF `0x00B77836`; Alpha uses
RGB `7048E8` / COLORREF `0x00E84870`. All branded installer controls must consume these constants,
while unsupported identifiers fail at compile time.

Manual restart and Beta database-copy apply share the parent-process-aware relaunch helper in
`src-tauri/src/relaunch.rs`. It is invoked before backend shutdown and handled before Tauri or the
single-instance plugin initialize. The helper waits for the exact previous PID's Windows process
handle to signal before starting the replacement; fixed-delay relaunches are not safe.

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

Production update manifest endpoints are:

```text
Stable: https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/stable/latest.json
Beta:   https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/beta/latest.json
Alpha:  https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/alpha/latest.json
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

Runtime policy validates exact SemVer before pending state changes: Stable accepts only
`MAJOR.MINOR.PATCH`; Beta accepts legacy `MAJOR.MINOR.PATCH-beta.N` and compact
`MAJOR.MINOR.PATCH-betaNNN`. Do not switch back to dotted prereleases within a core version after a
compact release: SemVer orders `beta.12` below `beta011`, whereas `beta012` follows it correctly.
Alpha accepts only exact dotted `MAJOR.MINOR.PATCH-alpha.N` versions and rejects leading-zero
sequence numbers, other prereleases, and build metadata. All three standard update paths use the
shared `PendingAppUpdate` state; `PendingBetaInstall` remains only for Stable-owned first-Beta
installation.
Stable-owned first Beta installation uses a distinct `PendingBetaInstall` newtype and the Beta
endpoint. It finishes the Stable backend session before launching the verified installer. An
installed Beta is then updated only by the Beta application's standard updater.

The branded NSIS template recognizes both Tauri's managed `/UPDATER` flag and the legacy `/UPDATE`
alias. Both enter the existing update mode that skips ordinary reinstall-choice pages while
preserving the product's profile data root.

**First Stable channel transition:** the first Stable release embedding the channel-branch endpoint
must also remain GitHub's normal latest release and retain `latest.json` as an ordinary release
asset. This proves older Stable clients can fetch
`/releases/latest/download/latest.json`, install the transition build, and move to the new endpoint.

Automatic update discovery may show a native Windows notification. Verify notification title/body
identity and body-click restore/focus/modal behavior in an **installed** NSIS package. Development
(`tauri dev`) builds may show PowerShell branding/name instead of CellXplorer, so do not treat
dev-only branding as final proof.

## Release preflight reuse and Rust cache ownership

The main `preflight.yml` workflow always runs its named Windows preflight for a pushed `main`
commit, including commits that receive a release tag. Before a tagged release publishes, the
release workflow verifies that the exact SHA has a trusted main-push preflight whose named Windows
job completed successfully. A failed canonical job blocks the release; a missing, skipped, or
cancelled result runs the complete local `preflight.py --no-cache` fallback. The fallback passes
the selected channel into Vite and stamps that already-verified `frontend/dist` instead of building
the frontend a second time.

The independent main workflow owns the shared production Rust dependency cache. Release jobs use
the same stable workspace/environment key in restore-only mode, so a cache miss still performs the
normal Cargo/Tauri build and a tag cannot create an unusable tag-scoped cache for a future release.

The main cache-warm compile runs from a clean checkout, where the ignored `frontend/dist` bundle and
`src-tauri/binaries/backend` sidecar do not exist. It supplies an ephemeral Tauri `TAURI_CONFIG`
merge patch that removes only those build-time inputs for the cache-only compile. The release job
continues to use the repository Tauri config, builds or restores the real frontend and sidecar, and
verifies both before packaging; the cache patch never changes shipped application configuration.

When `scripts/build-app.ps1` is invoked with `-SkipFrontend -SkipInstaller` for the exact-reuse
backend-only preparation, it does not require a frontend channel stamp. Installer-producing paths
still perform the normal channel verification.

## Production GitHub release

Stable, Beta, and Alpha releases are published by pushing exact SemVer tags. Alpha uses
`vMAJOR.MINOR.PATCH-alpha.N` and is a GitHub prerelease; Beta remains a prerelease and Stable
remains the normal latest release.

```powershell
git tag v0.15.0
git push origin v0.15.0

git tag v0.16.0-beta.1
git push origin v0.16.0-beta.1

git tag v0.28.0-alpha.1
git push origin v0.28.0-alpha.1
```

The `.github/workflows/release.yml` workflow then:

1. resolves Stable `vMAJOR.MINOR.PATCH`, Beta `vMAJOR.MINOR.PATCH-beta.N`/compact Beta, or Alpha
   `vMAJOR.MINOR.PATCH-alpha.N` and requires the tag commit to be reachable from `main`;
2. for Beta and Alpha, lists all published releases, ignores drafts/malformed/legacy tags, and
   requires each core to be strictly greater than the highest exact Stable tag; Beta and Alpha are
   not ordered against each other;
3. requires the pre-provisioned orphan `release-channels` branch to contain only its README and
   channel manifests. Before the first Alpha release, Alpha may be absent; the first Alpha may
   create only `alpha/latest.json`. Once a published Alpha release exists, all three pointers are
   required. The workflow never initializes the branch from `main`;
4. snapshots every non-target blob SHA, including README, so publication can update only the
   selected pointer;
5. refuses to replace an already published non-draft release and requires a public repository;
6. extracts exact release notes and runs `python scripts/preflight.py --no-cache`;
7. explicitly builds and verifies the selected frontend channel stamp, then builds the sidecar;
8. stages a **draft** GitHub Release with the pinned `tauri-apps/tauri-action`, signed NSIS
   installer, `.sig`, and workspace-root `latest.json`;
9. validates exact channel version/product/asset/signature against release metadata with
   `scripts/verify_updater_manifest.py`, reading the shared public key from the base Tauri config;
10. undrafts as a normal Stable release or true Beta/Alpha prerelease only after verification;
11. updates only the selected channel pointer using its prior SHA, verifies exact bytes through the
    Contents API and public raw endpoint, and proves every non-target blob is unchanged.

Required GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Use **Actions → Publish CellXplorer release → Run workflow** for Stable, Beta, and Alpha build-only
rehearsals. Manual dispatch never creates or alters a GitHub Release or channel pointer. Download
each artifact and record its channel stamp, installer name, icon, and product metadata before release.

Published versions are immutable. If a release is wrong, cut a new patch/Beta sequence rather than
rebuilding the same tag. If pointer publication fails after undraft, the immutable release exists
but clients remain on the previous pointer; repair only the manifest branch with optimistic SHA
protection and re-run verification.

The repository must be public before a production tag publish is allowed, so installed applications
can fetch `latest.json` without credentials.

If the updater signing key is lost, existing installed clients cannot trust releases signed with a
new key. Plan key backup before the first bootstrap release and treat rotation as a major,
user-visible migration.

## Current blocker found during the spike

This spike produced an NSIS installer. The MSI path reached WiX linking, but WiX ICE validation
failed because the Windows Installer service was not accessible in the build environment.
