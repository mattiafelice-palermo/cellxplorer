# Spec 054 — Updater lifecycle hardening

> Repository snapshot used while drafting: `main` at `e396a32f86a4bfd8f4ed9c547096a08bc397d911` (2026-08-26).
> Re-verify anchors against the implementation branch before coding, especially if Spec 053 has merged.

## Status

Parent specification. **Do not implement this file directly.** Implement its numeric children in order.

## Goal

Make CellXplorer's in-app update path behave like an application update rather than a second interactive installation workflow, while preserving strict release-channel isolation.

The user-facing outcome is:

1. updating Stable, Beta, or Alpha never terminates another installed CellXplorer channel;
2. an update initiated from inside CellXplorer downloads, applies, and relaunches without asking the user to walk through the normal installer UI;
3. application data are preserved by default;
4. failures remain understandable and recoverable rather than leaving an ambiguous half-updated state.

This parent deliberately groups process ownership and update UX because they meet at the same Windows installer/updater boundary. The children remain separate so that process-isolation correctness can be established before changing updater install behavior.

## Locked decisions

- Stable, Beta, and Alpha are independent installed applications for lifecycle purposes.
- A channel may stop only processes belonging to **the installation being updated**.
- Never kill CellXplorer processes by a shared executable image name alone.
- The in-app updater must not display the ordinary interactive NSIS wizard.
- Explicit user interaction is still required to **start** an update. "Non-interactive" means no second installer interaction after the user has chosen to update.
- Existing progress UI in CellXplorer remains the primary progress surface.
- Existing updater signature/version validation remains mandatory.
- Existing per-channel data roots remain preserved. Updating an application is not permission to reset or migrate another channel's data.
- Schema migrations, when legitimately required by a new application version, continue to run through the repository's normal forward-only migration mechanism. No released migration may be edited.
- This spec does not introduce a generic rollback framework. A failed update must be retryable or leave the prior installation usable where the underlying updater permits it, but system-wide transactional rollback is out of scope.
- Spec 054 must be implemented against the release-channel model that exists after Spec 053. If 053 is still unmerged when implementation starts, use its branch as a dependency or wait for it to land rather than independently recreating Alpha channel definitions.

## Current implementation context

Relevant anchors on the drafting snapshot:

- `src-tauri/src/app_channel.rs`
  - `AppChannel`
  - `AppChannel::from_identifier`
  - `AppChannel::product_name`
  - `AppChannel::default_data_dir_name`
  - `resolve_data_root`
- `src-tauri/src/main.rs`
  - `BackendChild`
  - `stop_backend`
  - `prepare_exit_for_update`
  - `quit_application`
  - `restart_app`
- `src-tauri/src/app_updates.rs`
  - `PendingAppUpdate`
  - `check_app_update`
  - `download_app_update`
  - `install_app_update`
  - `take_verified_install`
  - `restore_failed_install`
- `src-tauri/nsis-hooks.nsh`
  - `KillInstallationProcesses`
  - `NSIS_HOOK_PREINSTALL`
  - `NSIS_HOOK_PREUNINSTALL`
- `src-tauri/kill_installation_processes.ps1`
  - `Get-InstallationOwnedProcesses`
- `src-tauri/tauri.conf.json`
  - `plugins.updater.windows.installMode`
  - `bundle.windows.nsis`
- channel-specific Tauri configuration introduced/maintained by the release-channel specs
- `frontend/src/appUpdater.ts`
- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/components/AppUpdateModal.tsx`

At this snapshot, the NSIS helper already identifies installation-owned processes by executable path under `$INSTDIR`, which is the correct basic ownership paradigm for Stable/Beta. The work here must preserve that strength and ensure every updater path and every release channel follows the same invariant.

The updater configuration currently uses `"installMode": "basicUi"` for the Windows updater. That is intentionally incompatible with the target UX of child 054.2.

## Child specifications

### 054.1 — Channel-isolated updater shutdown

Establish and verify the lifecycle invariant first:

- installer/updater cleanup is scoped to the target installation;
- the running Tauri instance stops only its own tracked backend process tree;
- Stable/Beta/Alpha can be open concurrently;
- updating one does not close or damage the others.

### 054.2 — Non-interactive automatic update application

After 054.1 is accepted:

- change the in-app update application path to a non-interactive Windows updater mode;
- keep CellXplorer's own download/apply progress and failure surfaces;
- preserve channel data and installation identity;
- verify restart/relaunch behavior.

## Implementation order

1. Merge/resolve Spec 053 release-channel work first.
2. Implement and review 054.1.
3. Only after 054.1 is accepted, implement 054.2.
4. Run packaged Windows verification with multiple channels installed.

## Cross-child invariants

Both children must preserve:

- updater cryptographic verification;
- exact per-channel update endpoint/version policy;
- separate install locations/identifiers/product names;
- separate data roots;
- current backend sidecar ownership;
- current start-menu/desktop shortcut channel identity;
- no expensive work added to frontend request-critical paths;
- no unrelated refactor of application startup or release tooling.

## Parent acceptance criteria

Spec 054 is complete when both numeric children are accepted and packaged verification demonstrates:

- at least two installed channels can run at the same time;
- updating one channel does not terminate the other channel's frontend or backend;
- the update does not show the full installer wizard;
- the user sees meaningful application-level update progress;
- successful update ends with the expected new version running or ready to relaunch according to the locked child behavior;
- failed download/install remains understandable and retryable;
- existing user data remain present after update.

## Out of scope

- changing how releases are published;
- redesigning Stable/Beta/Alpha branding;
- adding a new release channel;
- cross-channel data sharing;
- generic backup/restore infrastructure;
- automatic unattended updates with no user initiation;
- auto-update scheduling/background download policy;
- macOS/Linux packaging behavior unless needed to keep shared code compiling.

## Reviewer focus

The reviewer should treat accidental cross-channel process termination or data mutation as release-blocking. Packaged behavior matters more than dev-mode behavior for this parent.
