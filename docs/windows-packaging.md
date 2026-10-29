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
| Fresh default folder | `%LOCALAPPDATA%\CellXplorer` | `%LOCALAPPDATA%\CellXplorer Beta` | `%LOCALAPPDATA%\CellXplorer Alpha` |
| Updater | `release-channels/stable/latest.json` | `release-channels/beta/latest.json` | `release-channels/alpha/latest.json` |

All three editions share the backend sidecar binary and NSIS template. NSIS pre-install/uninstall hooks
kill only processes whose executable path is under the installation directory being changed — never
by shared image name alone. After the last matching process disappears, the helper requires five
consecutive quiet checks before NSIS overwrites binaries; this covers the short Windows image-release
race without killing the other channel.

### Installation scope and updates (Spec 070)

The shared NSIS configuration uses `currentUser` and an `asInvoker` manifest.
Fresh setup defaults to the original user's LocalAppData folder. Fresh user
copies may choose a direct local writable folder; junction/short-name alias
paths are rejected before installation. Existing registered destinations are
locked. The explicit All users action requests Windows approval and uses a
fixed Program Files product folder for a fresh machine installation.

`installation_scope.nsh` discovers both registry views. It cross-checks quoted
Uninstall `InstallLocation`, manufacturer path, binary, product and optional
channel/scope metadata. Conflicting, incomplete or ambiguous registrations stop
the action. A unique legacy HKLM installation retains its machine scope and
exact directory and legitimately elevates. An update never falls back to a
fresh user copy. Command-line scope/directory options select and verify the
registry identity; they cannot authorize an arbitrary elevated destination.

NSIS stores its installer-language preference in the HKCU manufacturer product
key, including for machine installs, so that key can exist without an install
location. The updater treats a missing default value as absent only when there
is no matching Uninstall registration. If an Uninstall record exists, a missing
manufacturer location remains an incomplete installation and is rejected;
wrong value types, registry access errors, malformed paths, and conflicting
records also remain fail-closed.

Old keep-data uninstallers may leave a manufacturer path: it is ignored only
when neither application nor uninstaller exists and the Uninstall record is
absent. New uninstallers remove matching installation registration in both
views independently of scientific-data deletion.

Elevated current-user setup/uninstall is declined: alternate administrator
credentials cannot identify the original user's HKCU or profile. Machine
installation/removal preserves user data and avoids writing/deleting the
elevated account's startup entry. Manage startup from the normal application.
Normal user uninstall retains the existing explicit data-deletion choice;
all updates preserve data, startup choices and shortcuts. Temporary current
uninstaller launches inherit validated scope and `/UPDATE`, with `_?=` last.

On Windows, `installation_scope.rs` identifies the running executable against
the registered destination (resolving filesystem aliases for equivalence) and
launches only the bytes returned by Tauri's unchanged signature-verifying
download. A unique staged file is re-read and compared while locked against
write/delete sharing. Checked `ShellExecuteExW` uses `open` for user scope and
`runas` for machine scope before stopping the backend. Declining UAC or an
immediate launch failure returns a retryable error while this new client stays
open. Successful process launch means handoff, not completed installation.
Restart arguments are bounded hex-encoded JSON and decoded by the installed
trusted helper under `RunAsUser`; they cannot become installer scope options.
NSIS's 1024-unit command limit is checked before handoff.

**Transition limit:** already released clients still use their old updater,
which exits before the new installer self-elevates. The first update from such
a client can therefore close the application on UAC cancellation. The checked
handoff applies after the new client is installed. Existing machine copies
continue to need UAC; to change scope, uninstall while keeping data and then
run fresh setup normally. No automatic scope migration is performed. Normal
future user updates avoid installer elevation when prerequisites are ready;
repairing a machine-owned WebView2 prerequisite can still require approval.

**Verification limit:** compiler fixtures and isolated policy checks do not
prove native signed install/update behavior. The pending disposable matrix must
cover all channels, standard/admin users, alternate credentials, user/machine
fresh install, old-client to new-installer transition, new-client signed update,
UAC cancellation, exact directory retention, restart arguments/token, shortcuts,
startup, keep-data uninstall/reinstall and WebView2 repair. Native computer
controls are unavailable in this task; no real installed application or user
database was changed. Compiler fixtures deliberately use a placeholder payload
and must never be installed.

Focused checks:

```powershell
python -m unittest tests.test_installer_scope tests.test_updater_configuration tests.test_installation_process_scope
cargo test --offline --manifest-path src-tauri/Cargo.toml installation_scope::tests
python scripts/check_installer_scope.py --run-policy-tests
```

The last command compiles the production template for all three channels using
cached NSIS/support files and executes policy-only binaries against unique
disposable HKCU test keys. The filesystem sandbox can deny those fixture writes;
run with approved access when needed. It never executes the compiled setup
fixtures or accesses real installed-product registry keys.

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

## Mandatory release reinstall/upgrade gate

`release.yml` requires `scripts/smoke_installer_upgrade.ps1` before undrafting a
release or updating its public channel pointer. The same gate runs for signed
manual build-only dispatches. Missing signing secrets, prior same-channel releases,
assets, verifier failures, account/token creation failures, timeouts and incomplete
matrix results are blocking failures, never successful skips.

Artifact preparation uses the GitHub Releases API, excluding drafts and selecting
the highest earlier exact same-channel SemVer release. It downloads the previous
setup/signature and the other channels' released setups for side-by-side isolation
checks. For tag publication, the candidate installer and signature are downloaded
from the exact draft release asset IDs; SHA-256 must match the exact locally built
installer and `.sig`. The staged `latest.json` is also read back and matched to the
verified manifest. Build-only uses the exact local signed artifact without a draft.
For publication, release ID/tag and the three candidate asset IDs/names/sizes/
SHA-256 digests are recorded in a separate `RUNNER_TEMP/cx-controller-*` directory.
Its protected ACL grants only the controller SID and SYSTEM, not worker accounts
or inherited Users/Administrators access. It is never inside the worker-writable
native root. Immediately before undraft, `installer_upgrade_gate.py --recheck`
uses fresh controller API credentials to re-fetch that exact draft, reject changed
asset IDs or bytes (including same-name replacements), and verify its installer
signature again. Both publication steps require that recheck to succeed. The feed
uses the controller-only verified manifest readback, not a workspace copy that
native processes could have changed. Manual build-only dispatch has no publication
provenance/recheck and cannot undraft or update a feed.
Every installer is cryptographically verified against the configured updater public
key with the locked, small `scripts/updater_signature_verifier` Cargo package.
Its binary reuses `src-tauri/examples/verify_updater_signature.rs` and invokes
the same `minisign-verify` API as Tauri's
updater, including full payload verification; metadata and key-ID checks alone do
not satisfy the gate. This is not Windows Authenticode verification.

Native installation is refused outside `GITHUB_ACTIONS=true` on a GitHub-hosted
Windows runner. Unique temporary staging and two dedicated disposable Windows
accounts isolate the runner's genuine profile state. The user account must have a
non-elevated standard-user token; the machine account must be an administrator.
Real harmless credentialed child processes first prove zero/nonzero exit-code
handling; process handles are acquired before waiting for workers/installers.
The gate never weakens production's rejection of elevated currentUser installs.
After preparation and before account/probe/installer execution, the controller
removes GH_TOKEN/GITHUB_TOKEN, TAURI_SIGNING*, ACTIONS_RUNTIME_TOKEN,
ACTIONS_ID_TOKEN*/ID_TOKEN* and workflow output/environment-file paths from the
process environment. Credentialed workers repeat stripping defensively. Recheck
receives fresh API credentials in its own later step. Release checkout sets
`persist-credentials: false`, so the token is not saved in Git configuration.
These are minimum same-job safeguards, not a security boundary against malicious
administrator code taking ownership or using privileges; a separately isolated
native-test job remains stronger isolation.
It refuses pre-existing installation registrations, destinations or profile data.
Worker profile/LocalAppData/roaming AppData are resolved under their actual logon
tokens and checked against the Windows ProfileList registry; TEMP/TMP use separate
gate-root children. Verified staged installers are locked read-only before hashing
through that handle and held denying writes/deletes through execution, including
custom-layout seed installs. Accounts are removed at completion; evidence, the
other-channel machine installations and dedicated profiles remain only until the
disposable runner is destroyed.

The selected channel's matrix covers default and custom registered destinations,
candidate `/UPDATE`, same-version reinstall, exact installed executable hashes,
registration version/scope/channel, keep-data uninstall, unchanged data sentinels
for all three channels and unchanged other-channel installed identities. Custom
legacy destinations are fixtures: a real released payload and matching registration
are relocated before updating because production fresh CLI intentionally ignores
`/D`. This does not prove the interactive directory picker. Machine cases include
the language-only HKCU manufacturer-key regression alongside a real HKLM install.
The prior release's declared NSIS scope determines whether an old-user installation
is supported: older machine-only baselines are tested natively in machine scope;
user scope then tests the candidate fresh install/reinstall and reports explicitly
that a prior-user upgrade was unavailable. A selected user-only predecessor is
handled symmetrically with candidate fresh-machine coverage. Neither is reported
as a prior-release upgrade pass. Other-channel identities are real machine-scope
installs shared across the machine-first and standard-user workers. An unrelated
user-only predecessor, or historical `both` installer without a proven unattended
scope-selection contract, blocks preparation with an explicit unsupported-matrix
diagnostic rather than fabricating an installation or reporting a skipped success.

Before building packages, the workflow requires an early profile-only probe of
the same fresh credentialed worker initialization.
It logs only selected identity/path diagnostics, performs no installations, and
cannot produce native-gate or draft-provenance acceptance. The full install gate
remains mandatory even when this early check passes. It then requires
`cargo test --locked --manifest-path src-tauri/Cargo.toml` (including real
disposable registry-reader and recovery regressions), the
three-channel NSIS compiler/policy harness, and `python
scripts/check_update_recovery.py`. The latter executes the production NSIS recovery
include with harmless payloads and checks the kernel-authenticated named-pipe
READY/COMMIT/ACK/exit-authorization protocol, origin/process validation,
timeout/cancellation and waiting for origin exit before writes. Its parent fixture
is not the old installed application's updater. The same check also runs the
actual Rust launcher against a harmless NSIS fixture, exercises checked relay
child lifetime and file/directory locks, and rejects mismatched payload hashes.
The relay hashes its locked executable before elevation and retains independent
locks until its checked elevated child exits; client timeout alone cannot release
the relay's pathname protection.

Final E is irreversible installation authorization, sent only after C/ACK and
all retryable preparation, immediately before backend/app shutdown. Windows
closes process handles before signaling its process object, so an observed
post-E pipe break allows exactly one non-resetting 100-ms wait on the authenticated
origin process. Writes require that process to signal; expiry permanently aborts
the session. Pre-E cancellation is unchanged. Native fixtures explicitly cover
exit inside the settlement window and rejection after expiry; their diagnostic
compile-time hook is absent from shipped installers.

The installed application hash is compared to the exact NSIS-packaged build,
not the restored unbundled executable left in `target/release` by Tauri CLI.
For pinned CLI 2.11.4 the gate models its single bundle-marker patch, preserving
full-byte equality and recording the unbundled digest separately. Unknown CLI
versions, ambiguous markers or Authenticode configuration fail closed pending a
reviewed reference strategy. Installer signatures and staged asset bindings remain
independently mandatory; observed installed bytes never establish their own target.

**Coverage boundary:** hosted Windows is elevated and UAC-disabled. The native
matrix invokes the candidate installer `/UPDATE` path; it does **not** execute the
prior installed Rust updater's reader/launcher or prove its pre-launch behavior.
Actual OLD-client interactive update, UAC approval/cancellation/alternate credentials,
and end-to-end installed-client recovery handshake remain unproven and require a
separate disposable interactive Windows acceptance run. Extracting old source into
a harness would be additional regression evidence, not execution of the released
client. The sentinel is not a scientific database migration or application-startup
test. These limitations must remain in release acceptance reporting even when CI
passes. Never run the native installation script against a developer's profile.

Local non-installing checks:

```powershell
python -m unittest tests.test_release_workflow tests.test_installer_upgrade_gate -v
cargo test --locked --manifest-path src-tauri/Cargo.toml installation_scope
python scripts/check_installer_scope.py --run-policy-tests
python scripts/check_update_recovery.py
```

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
10. runs the full Rust and NSIS policy/transport checks, then the mandatory native
    upgrade/reinstall matrix against the exact signature-verified staged candidate;
11. re-downloads the same draft installer, signature and manifest, rejecting changed asset IDs
    or digests, and cryptographically verifies the candidate again using controller provenance;
12. undrafts as a normal Stable release or true Beta/Alpha prerelease only after both gates pass;
13. updates only the selected channel pointer through an atomic non-force Git-data-API ref move
    based on the captured branch tip, verifies exact bytes through the Contents API and public raw
    endpoint, and proves every non-target blob is unchanged.

Before the first production Alpha tag, obtain explicit release-preparation authorization and make a
separate focused manifest-only commit on the orphan `release-channels` branch that updates its
`README.md` to document Stable, Beta, and Alpha. This preparation is pending and is not performed
by the Alpha implementation. The publication workflow treats `README.md` as protected and verifies
that its blob is unchanged during every pointer update.

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
