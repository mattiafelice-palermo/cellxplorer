# Spec 017: Secure Tauri updater foundation

Status: **implemented** (review follow-ups R1–R5 addressed on `feature/updater-017-019`).

Repository: `mattiafelice-palermo/cellxplorer`  
Target branch: `feature/updater-017-019` (shared with Specs 018 and 019; merge once when all three are complete)  
Base: current `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`  
Dependency: none  
Review document: `docs/specs/reviews/017-secure-tauri-updater-foundation-review.md`

## 1. Goal

Add the secure desktop-update substrate needed by the later CellXplorer update UI and release workflow:

- the Tauri shell can check a signed HTTPS update manifest;
- Tauri builds signed NSIS updater artifacts;
- a pending update is held by Rust, not by the Python backend;
- Rust exposes narrow commands to check, download with progress and install;
- the bundled Python backend is stopped through Tauri's Windows `on_before_exit` hook immediately before installer launch;
- no source code, private signing material or user database is exposed or modified.

This specification is deliberately **desktop infrastructure only**. It does not add the notification badge, power-menu entry, update modal or GitHub release workflow. Those are Specs 018 and 019.

## 2. Locked decisions

### 2.1 Use Tauri's official updater plugin in Rust

Use the Tauri 2 updater plugin rather than a custom HTTP downloader or version-comparison implementation.

Add the Rust dependency:

```text
tauri-plugin-updater
```

Use a current Tauri-2-compatible version, pinned to at least the current minor line used by the release workflow. The plugin must be **at least 2.10.0**, because the release workflow in Spec 019 may emit installer-specific platform keys in `latest.json`.

Do **not** expose the generic updater plugin API directly to the webview. CellXplorer needs a controlled Rust lifecycle hook for its PyInstaller sidecar, so implement narrow application commands around the Rust API.

Consequences:

- no `@tauri-apps/plugin-updater` npm dependency is required;
- no `updater:default` frontend capability is required;
- custom CellXplorer commands remain the only webview entry points;
- update ownership remains in the Tauri shell, not FastAPI.

### 2.2 Signed updates are mandatory

Generate a Tauri updater key pair with the Tauri CLI.

- Commit only the **public key content** in `src-tauri/tauri.conf.json`.
- Never commit the private key, its password, a `.env` containing either, or a GitHub token.
- Store the private key in a secure developer backup and later in GitHub Actions secrets.
- Add/update `.gitignore` patterns if the generated key filename could otherwise be committed.

The implementation must stop and report the required manual key-generation step if no real public key is available. A placeholder key is not an acceptable completed implementation.

Tauri updater signatures are not Windows Authenticode signatures. Windows code signing and SmartScreen reputation are separate and out of scope for these three specs.

### 2.3 Static stable-release endpoint

Configure the production endpoint as:

```text
https://github.com/mattiafelice-palermo/cellxplorer/releases/latest/download/latest.json
```

Production must keep HTTPS enforcement enabled. Do not enable any dangerous insecure transport, invalid-certificate or invalid-hostname option.

The repository is private at the time this spec was written. Before the first live updater release, the repository must be made public or the same release assets must be published to another public HTTPS host. Never place GitHub credentials inside the installed application.

### 2.4 Build Tauri 2 updater artifacts

Set:

```json
"bundle": {
  "createUpdaterArtifacts": true
}
```

Do not use `"v1Compatible"`: CellXplorer has no existing Tauri 1 updater population to migrate.

For Windows, the expected updater files are the existing NSIS setup executable and its adjacent `.sig` signature.

### 2.5 Launch the branded installer with normal UI

Configure:

```json
"plugins": {
  "updater": {
    "windows": {
      "installMode": "basicUi"
    }
  }
}
```

This is a locked product decision. After the in-app download finishes, the existing branded NSIS installer must open and require the user to finish the installation. Do not use silent or passive installation in this feature.

The current custom NSIS template parses `/UPDATE`, but current Tauri updater versions pass a managed `/UPDATER` flag to the NSIS installer. Update `.onInit` so `/UPDATER` also sets the existing `UpdateMode = 1`. Keep `/UPDATE` as a backward-compatible alias unless testing proves it is obsolete.

The updater path must continue to:

- skip ordinary install/reinstall choice pages that are inappropriate during an in-app update;
- preserve `%USERPROFILE%\.cellxplorer`;
- retain the existing branded installer/progress/finish surfaces required by `basicUi`;
- avoid silently changing desktop/startup preferences during an update.

Because the installer is `perMachine`, Windows may request administrator approval. Do not change the installation scope in this spec.

### 2.6 Use Tauri's Windows `on_before_exit` hook

Windows installers require the running app to exit. The official updater provides `UpdaterBuilder::on_before_exit` specifically for work that must happen immediately before the installer runs and Tauri exits.

Every pending `Update` stored by CellXplorer must be created through:

```text
app.updater_builder().on_before_exit(...).build()?.check().await?
```

The hook must:

1. set `LifecycleState.quitting` to `true`;
2. call the existing `stop_backend(&app)` process-tree cleanup;
3. return without scheduling the normal `restart_app` relaunch.

Do not stop the sidecar during check or download. The hook runs only at installation time, and
only after the updater has already committed to exiting.

Do not substitute a frontend `prepare` command for this hook. A separate command can stop the
backend too early. Pre-hook install errors can still return to the frontend with the backend
alive; once `on_before_exit` has run on Windows, Tauri exits regardless of whether
`ShellExecuteW` successfully opened the installer, so there is no post-hook recovery path.

### 2.7 Split check, download and install in Rust

Use a managed pending-update state following Tauri's documented command/channel pattern.

Suggested module and state:

```rust
mod app_updates { ... }

struct PendingAppUpdate {
    update: Option<tauri_plugin_updater::Update>,
    downloaded_bytes: Option<Vec<u8>>,
    downloading: bool,
}
```

Wrap it in a mutex managed by Tauri. Do not hold a standard mutex guard across an `.await`.

Expose three commands:

```text
check_app_update
download_app_update
install_app_update
```

#### `check_app_update`

- Build the updater with the configured endpoint/public key and the `on_before_exit` hook.
- Check SemVer through Tauri's default comparator; do not allow downgrades.
- Replace any older pending state.
- Return `null` when no update exists.
- When available, return only safe display metadata:

```json
{
  "version": "0.15.0",
  "current_version": "0.14.3",
  "notes": "...",
  "published_at": "2026-07-27T...Z"
}
```

Do not return the download URL, signature, raw manifest or local paths to the frontend.

#### `download_app_update`

Inputs:

- expected version;
- a Tauri IPC `Channel` for progress events.

Behavior:

- reject when no matching pending update exists;
- reject overlapping downloads;
- call `Update::download`, which downloads and verifies the signature before returning bytes;
- emit structured events:

```json
{ "event": "started", "data": { "content_length": 123 } }
{ "event": "progress", "data": { "chunk_length": 456 } }
{ "event": "finished" }
```

- store the verified bytes together with the matching `Update` for the install command;
- on failure, clear the `downloading` flag and preserve a retryable pending update;
- do not install or stop the backend.

#### `install_app_update`

Input: expected version.

Behavior:

- reject when no matching update/verified bytes exist;
- take the pending update and bytes exactly once;
- call `Update::install(bytes)`;
- on Windows success, Tauri runs the `on_before_exit` hook, stops the sidecar, launches NSIS and exits;
- if `install()` returns an error before exit, restore enough pending state for a controlled retry or restart and return a safe error.

Do not call `AppHandle::restart()` or the normal `restart_app` flow on successful update installation.

### 2.8 No database or cache changes

This work must not:

- add a database migration;
- read or rewrite scientific data;
- invalidate Parquet or analysis caches;
- change `CALC_VERSION`;
- delete `%USERPROFILE%\.cellxplorer` during upgrade.

## 3. Current implementation anchors

Read before editing:

- `AGENTS.md`
- `docs/agent-knowledge/README.md`
- `docs/agent-knowledge/architecture.md`
- `docs/agent-knowledge/change-playbooks.md`, especially **Release and Windows package**
- `docs/windows-packaging.md`
- `docs/tauri-packaging-lessons.md`
- `src-tauri/Cargo.toml`
  - Tauri 2 and the existing dialog/deep-link/fs/single-instance/shell plugins;
  - no updater plugin yet.
- `src-tauri/tauri.conf.json`
  - NSIS-only bundle;
  - custom `cellxplorer-installer.nsi`;
  - `perMachine` installation;
  - no updater configuration yet.
- `src-tauri/capabilities/default.json`
  - updater capability should remain absent when only custom commands are exposed.
- `src-tauri/src/main.rs`
  - `BackendChild`;
  - `LifecycleState`;
  - `stop_backend`;
  - `quit_application`;
  - `restart_app`;
  - plugin initialization and `tauri::generate_handler!`.
- `src-tauri/cellxplorer-installer.nsi`
  - current `/UPDATE` parsing and `UpdateMode` behavior;
  - add compatibility with Tauri's managed `/UPDATER` flag;
  - user-data-preserving upgrade behavior.
- `scripts/build-app.ps1`
- `scripts/check_versions.py`

Official references:

- Tauri updater guide and command/channel example: `https://v2.tauri.app/plugin/updater/`
- Rust `Update` API (`download` returns verified bytes; `install` consumes them): `https://docs.rs/tauri-plugin-updater/latest/tauri_plugin_updater/struct.Update.html`
- Windows code-signing distinction: `https://v2.tauri.app/distribute/sign/windows/`

## 4. Target implementation

### 4.1 Tauri configuration

Update `src-tauri/tauri.conf.json` with:

- `bundle.createUpdaterArtifacts: true`;
- updater `pubkey` containing the complete generated public key text, not a path;
- the GitHub `latest.json` endpoint from §2.3;
- `windows.installMode: "basicUi"`.

Do not hardcode the current application version in updater logic. Tauri compares the manifest's SemVer against the package version.

### 4.2 Plugin initialization

Initialize the updater plugin alongside the existing desktop plugins in `src-tauri/src/main.rs`.

Keep plugin initialization compatible with the current single-process setup and dynamic backend port. The updater must not delay normal startup or wait for a network response during `setup()`.

Manage `PendingAppUpdate` during setup and register the three commands in the existing handler list.

### 4.3 Least-privilege capability

Because the webview calls CellXplorer's custom commands rather than generic updater plugin commands, do not add `updater:default` or direct download/install permissions to `src-tauri/capabilities/default.json`.

If implementation evidence proves the plugin requires a capability even for Rust-only use, add only the minimum required permission and document why. Do not grant unrelated shell/process scopes.

### 4.4 Command errors and serialization

Return stable, user-safe error strings or a small serializable error enum. Do not expose:

- private key material;
- signature text;
- release raw JSON;
- filesystem paths to temporary updater bytes;
- internal Rust backtraces.

Log detailed errors through the existing desktop diagnostic path where available.

### 4.5 Configuration verification test

Add a focused, read-only test such as:

```text
tests/test_updater_configuration.py
```

It should parse repository files and fail clearly when updater release prerequisites drift. Cover at least:

- `createUpdaterArtifacts` is `true`;
- updater endpoint is the expected HTTPS GitHub release URL;
- insecure transport/certificate/hostname exceptions are not enabled;
- `installMode` is `basicUi`;
- committed public key is non-empty and not a placeholder/path;
- Rust updater dependency exists and is at least 2.10;
- custom commands and pending-update state are registered;
- direct updater frontend permission is not broadly granted;
- the custom NSIS template maps both `/UPDATER` and the existing `/UPDATE` alias to `UpdateMode` and preserves user data.

Do not make the test depend on private keys or network access.

### 4.6 Rust-focused tests

Extract pure state-transition helpers where useful and add tests for:

- replacing/clearing a pending update;
- rejecting expected-version mismatch;
- rejecting concurrent download;
- retryable state after download failure;
- install requires verified bytes;
- one-time take semantics;
- exit preparation sets quitting and is idempotent at the policy level.

Do not attempt to run a real installer or kill the developer's real backend from unit tests.

### 4.7 Documentation

Update:

- `docs/windows-packaging.md` with updater artifacts, Rust command ownership, key handling and the bootstrap-release limitation;
- `docs/agent-knowledge/architecture.md` with updater ownership in the Tauri shell and the `on_before_exit` sidecar cleanup boundary;
- `docs/agent-knowledge/change-playbooks.md` with updater signing/release checks;
- `AGENTS.md` maintained tree if new tracked source/test/config files make it inaccurate;
- `docs/specs/README.md` index for Spec 017.

Do not create `docs/project-context/` unless the user separately approves that repository directory.

## 5. Files expected to change

Likely minimum:

```text
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/tauri.conf.json
src-tauri/src/main.rs
# or a focused new Rust module under src-tauri/src/
src-tauri/cellxplorer-installer.nsi
tests/test_updater_configuration.py
docs/windows-packaging.md
docs/agent-knowledge/architecture.md
docs/agent-knowledge/change-playbooks.md
docs/specs/README.md
docs/specs/017-secure-tauri-updater-foundation.md
```

`.gitignore` only if needed for the generated private-key filename.

Modify only the minimum updater-argument/update-mode logic in the NSIS template. Do not redesign the installer pages in this spec.

## 6. Error and safety behavior

- Missing or malformed `latest.json` is a check error, not an application startup failure.
- Signature mismatch must prevent verified bytes from being stored or installed.
- A release URL is untrusted until `Update::download` verifies the signed artifact.
- The private signing key must never be logged.
- No update action may touch the CellXplorer data root.
- Download failure keeps the current app/backend usable and the update retryable.
- An install error returned to the frontend must occur without intentionally stopping the backend; sidecar cleanup belongs only to `on_before_exit` on the successful Windows launch path.

## 7. Verification

### Automated

Run:

```powershell
python -m unittest tests.test_updater_configuration -v
python scripts\preflight.py
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
```

Record exact results.

### Packaged artifact check

With a disposable local updater key supplied through environment variables:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="<secure path or key content>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password>"
.\scripts\build-app.cmd
```

Confirm the NSIS output directory contains:

- `CellXplorer_<version>_x64-setup.exe`;
- the matching `.sig` file.

This is packaging verification, not a live update test. Do not publish these local artifacts.

Because the NSIS template changes, also launch the built setup executable with `/UPDATER` in a disposable Windows environment and verify that it enters the update/basic-UI path without showing the ordinary reinstall-choice page. Cancel before modifying any non-disposable installation. Do not test destructive uninstall options against real user data.

### Manual source inspection

Confirm:

- the private key is absent from `git status`, Git history and logs;
- all pending updates are built with the `on_before_exit` sidecar cleanup hook;
- check/download do not stop the backend;
- no database path or cache path is involved.

## 8. Out of scope

- power-button badge and menu entry;
- update modal and progress UI;
- automatic polling schedule;
- GitHub release creation/upload;
- beta/update channels;
- automatic rollback;
- Windows Authenticode signing;
- macOS/Linux packaging;
- silent installation;
- changing the installer from per-machine to per-user;
- version or changelog bump for the final updater release.

The combined updater feature receives one minor release bump in Spec 019. Do not publish or tag Spec 017 independently.

## 9. Implementation order

1. Copy this spec into `docs/specs/` and add its index entry.
2. Generate and securely store the updater key pair; commit only the public key.
3. Add the compatible Rust updater dependency and lockfile changes.
4. Configure updater artifacts, endpoint, public key and `basicUi` mode.
5. Initialize the plugin and add the pending-update Rust command module.
6. Implement `on_before_exit` lifecycle cleanup for every checked update.
7. Add configuration and Rust policy tests.
8. Update packaging/architecture documentation.
9. Run focused tests, preflight, Cargo tests/check and the signed local artifact check.
10. Record what was actually verified; do not claim a live update succeeded in this branch.

## 10. Acceptance checklist

- [ ] Tauri updater plugin is installed and initialized without blocking startup.
- [ ] Production endpoint is HTTPS and points to the stable GitHub `latest.json` asset.
- [ ] A real public updater key is committed; no private key or password is committed.
- [ ] Tauri builds the NSIS setup executable and matching `.sig` artifact.
- [ ] Windows updater mode is `basicUi`.
- [ ] Only narrow custom updater commands are exposed to the frontend.
- [ ] A checked update is stored in managed Rust state with safe metadata returned to the UI.
- [ ] Download uses a progress channel and stores only signature-verified bytes.
- [ ] Install requires matching verified bytes and cannot be executed twice.
- [ ] Every pending update carries an `on_before_exit` hook that idempotently stops the Python process tree.
- [ ] Check/download never stop the backend; successful Windows install launch does.
- [ ] Existing normal quit/restart behavior is unchanged.
- [ ] The branded NSIS template recognizes Tauri's `/UPDATER` flag, keeps `/UPDATE` compatibility and preserves user data/preferences.
- [ ] User database, caches and source files are unaffected.
- [ ] The `/UPDATER` installer path is visually smoke-tested in a disposable environment.
- [ ] Focused tests, preflight, Cargo tests/check and packaging results are recorded truthfully.
