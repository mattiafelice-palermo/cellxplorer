# Spec 020: Native Windows update notification and direct manual-check modal

Status: **implemented**.

Repository: `mattiafelice-palermo/cellxplorer`  
Base: current `main` (inspected at `47b5f1a2a9a9ee20f4d3452d2da59505fb69951a`)  
Target branch: `feature/windows-update-notification`  
Dependencies: completed Specs 017–019 and the current working signed-update flow  
Review document: `docs/specs/reviews/020-windows-update-notification-and-manual-modal-review.md`

## 1. Goal

Refine update discovery so the feedback matches how the check was initiated:

1. An **automatic background check** that finds a new version shows a genuine native Windows
   notification outside the CellXplorer interface.
2. Clicking that Windows notification restores/focuses the already-running CellXplorer window and
   opens the existing update modal for that release.
3. A **manual** click on **Check for updates** never shows an intermediate bottom-right in-app
   toaster. When a new version is found, it opens the existing update modal directly.

Do not redesign the update modal, updater download/install pipeline, release workflow, or background
check scheduler.

## 2. Locked product decisions

These decisions came directly from the user and must not be changed by the implementing agent.

### 2.1 Source-specific behavior

| Discovery path | Update found | No update | Check failure |
|---|---|---|---|
| User selects **Check for updates** | Open the existing update modal immediately | Open the existing up-to-date result modal | Open the existing check-error modal |
| Automatic background check | Keep the teal power-menu badge and, when enabled, show one native Windows notification per version | Stay silent | Stay silent and record a debug event |
| User selects an already-known **Update to vX.Y.Z** menu item | Open the existing update modal | Not applicable | Not applicable |

There must be no bottom-right Mantine **View update** notification in any update-discovery path.
Mantine notifications may remain for unrelated app feedback and the existing development-only mock
completion message.

### 2.2 Windows notification interaction

The update notification is a native operating-system notification, not a CellXplorer overlay.

Notification content:

```text
Title: CellXplorer update available
Body: Version X.Y.Z is ready. Click to view the update.
```

When the user clicks the notification:

1. activate the existing CellXplorer process;
2. unminimize, show and focus the existing `main` window;
3. open the existing update modal for that version;
4. do **not** begin downloading or installing automatically.

The whole notification surface should be clickable. Do not require a separate notification action
button to reach the modal.

### 2.3 Running-process boundary

This feature works while CellXplorer is running normally, minimized, or hidden in the tray. Closing
the main window already leaves that process running.

If the user explicitly chooses **Quit**, no CellXplorer process remains to perform periodic checks or
raise a new notification. Do not add:

- a Windows service;
- a scheduled task;
- a second background executable;
- notification-driven cold startup after explicit quit.

### 2.4 Notification preference

Keep the existing local preference and storage shape:

```ts
{
  intervalValue: number;
  intervalUnit: "seconds" | "minutes" | "hours" | "days";
  notificationsEnabled: boolean;
}
```

Rename only the user-facing wording to make the platform behavior explicit:

```text
Show Windows update notification
Show a Windows notification when an automatic check finds a new version.
The power-menu update badge remains available when this is disabled.
```

When disabled:

- automatic checks continue;
- the teal power-menu badge continues;
- manual checks continue to open their result modal;
- no Windows update notification is created.

### 2.5 Once-per-version rule

Reuse the existing `cellxplorer-update-notified-version` persistence rule.

- An automatic discovery shows at most one Windows notification for a given version.
- Record the version only after the Windows notification was successfully created.
- A manual check that directly opens the update modal counts as the user having seen that version;
  record it so a later automatic check does not show a redundant Windows notification for the same
  release.
- A newer version may notify normally.
- Permission denial or notification creation failure must not remove the update badge or the pending
  update state.

### 2.6 No fallback in-app discovery toaster

If Windows notifications are denied, disabled by the OS, unsupported, or fail to display:

- keep the teal badge;
- record a safe debug event;
- do not reintroduce the Mantine **View update** toaster as a fallback;
- do not treat notification failure as updater-check failure.

## 3. Current implementation anchors

Read these before editing. Use grep-able anchors rather than assuming line numbers remain current.

### 3.1 Update coordinator

`frontend/src/components/AppUpdateCoordinator.tsx`

Relevant anchors:

- `function AppUpdateProvider`
- `const applyRelease = useCallback(...)`
- `const performCheck = useCallback(...)`
- `const openUpdateModal = useCallback(...)`
- `const handleMenuClick = useCallback(...)`
- `checkFeedbackSource`
- `checkInFlight`
- `stateRef`
- `modalOpenRef`

Current behavior to replace:

```tsx
notifications.show({
  title: `CellXplorer v${merged.version} is available.`,
  message: <Button ...>View update</Button>,
  ...
});
```

`applyRelease()` currently uses that in-app notification for both automatic and manual discovery.
Preserve the existing check coalescing, epoch protection, download sequencing, up-to-date modal and
error modal.

### 3.2 Update policy and Tauri wrappers

`frontend/src/appUpdater.ts`

Relevant anchors:

- `AppUpdatePreferences`
- `DEFAULT_APP_UPDATE_PREFERENCES`
- `shouldNotifyForVersion`
- `readNotifiedVersion`
- `writeNotifiedVersion`
- `getCurrentRelease`
- `checkAppUpdateTauri`
- `downloadAppUpdateTauri`
- `installAppUpdateTauri`
- `restartAppTauri`

Do not move update checking, downloading or installation into the notification layer. The existing
Rust updater commands remain authoritative.

### 3.3 Existing update modal

`frontend/src/components/AppUpdateModal.tsx`

Reuse the existing modal and all existing states:

- available release;
- up-to-date result;
- check error;
- download progress;
- download retry;
- installer launch;
- install-error restart.

Do not create a second update modal or a notification-specific modal.

### 3.4 Update settings

`frontend/src/pages/SettingsPage.tsx`

Relevant anchors:

- `savedUpdatePreferences`
- `updatePreferences`
- `saveUpdatePreferences`
- `<Tabs.Panel value="updates">`
- current label `Show update notification`

Keep localStorage ownership and the existing preferences-changed event. This work does not add a
backend setting or database migration.

### 3.5 Tauri window lifecycle

`src-tauri/src/main.rs`

Relevant anchors:

- `fn show_main_window(app: &AppHandle)`
- `tauri_plugin_single_instance::init`
- tray `"open" => show_main_window(app)`
- `WindowEvent::CloseRequested`
- the `tauri::generate_handler!` list
- the desktop plugin initialization chain

`show_main_window()` already unminimizes, shows and focuses the `main` webview window. Reuse that
logic; do not launch another process or route through `restart_app`.

### 3.6 Dependency and capability files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `frontend/package.json`
- `frontend/package-lock.json`
- `src-tauri/capabilities/default.json`
- generated Tauri schemas under `src-tauri/gen/schemas/`

The current project does not include the official notification plugin.

### 3.7 Existing tests

- `frontend/tests/appUpdater.test.ts`
- `tests/test_updater_configuration.py`

Extend these focused suites. Do not add a React testing framework solely for this feature.

## 4. Technical design

### 4.1 Use the official Tauri notification plugin

Add compatible Tauri 2 notification dependencies:

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-notification = "2"
```

```json
// frontend/package.json
"@tauri-apps/plugin-notification": "^2.x"
```

Use the exact compatible version resolved by npm/Cargo and commit both lockfile changes.

Initialize it in the existing Tauri plugin chain:

```rust
.plugin(tauri_plugin_notification::init())
```

Grant only:

```json
"notification:default"
```

in `src-tauri/capabilities/default.json`. Do not add unrelated window, shell, process, filesystem or
updater permissions.

Official references:

- `https://v2.tauri.app/plugin/notification/`
- `https://v2.tauri.app/reference/javascript/notification/`

Windows notifications must be verified in an **installed** application. Tauri documents that a dev
build may show PowerShell branding/name instead of CellXplorer.

### 4.2 Add a small native-notification adapter

Create:

```text
frontend/src/updateNotifications.ts
```

This file owns only native update-notification permission, construction, lifetime and click
activation. Do not put update checking or modal state in it.

Suggested public surface:

```ts
export type UpdateNotificationResult =
  | "shown"
  | "permission-denied"
  | "unsupported"
  | "failed";

export async function showWindowsUpdateNotification(options: {
  release: AppUpdateRelease;
  onActivate: (version: string) => void | Promise<void>;
}): Promise<UpdateNotificationResult>;
```

Implementation requirements:

1. Return `unsupported` outside the installed Tauri app or when the Notification API is unavailable.
2. Use `isPermissionGranted()` and, when necessary, `requestPermission()` from
   `@tauri-apps/plugin-notification`.
3. If permission is not granted, return `permission-denied` without throwing.
4. Create one native notification with a stable tag such as:

   ```text
   cellxplorer-app-update
   ```

   so a newer update replaces an older active update notification rather than stacking indefinitely.
5. Store the release version in the notification `data` payload.
6. Set `onclick` on the actual `Notification` object. On click:
   - prevent the browser default where appropriate;
   - close the notification;
   - call `onActivate(version)`.
7. Retain the live `Notification` object until it closes, errors or is clicked. Do not create it as an
   unreferenced temporary object whose handler can be lost.
8. Normalize exceptions into the returned result or a safe error passed to the coordinator's debug
   event. Never expose stack traces or internal paths to the user.

Important: the plugin helper `sendNotification()` returns `void`. Do **not** use it alone and then
assume notification clicks can be observed. Use the Web Notification object directly after the
plugin permission check, or an equivalent official API that returns a click-capable object in the
actual installed dependency version.

Do not use `onAction()` as the sole Windows click mechanism unless the exact installed plugin version
is proven in a packaged Windows build to emit body-click activation. The implementation must satisfy
the packaged click acceptance test, not merely compile against a cross-platform API.

### 4.3 Add one narrow window-activation command

Expose a new command with an unambiguous name, for example:

```rust
#[tauri::command]
fn show_main_window_for_update(app: AppHandle) -> Result<(), String>
```

It must reuse the existing `show_main_window` behavior:

1. obtain the existing `main` webview window;
2. unminimize it;
3. show it;
4. focus it;
5. return a safe error if the window is unexpectedly unavailable.

Register it in `tauri::generate_handler!`.

Do not:

- spawn CellXplorer;
- call `restart_app`;
- stop/restart the backend;
- create another webview window;
- expose broad generic window permissions to the frontend.

Add a corresponding wrapper in `frontend/src/updateNotifications.ts` or `appUpdater.ts`, for example:

```ts
export async function showMainWindowForUpdateTauri(): Promise<void>
```

### 4.4 Register click behavior once

The notification `onclick` callback must route into `AppUpdateProvider`; do not register one global
listener per automatic check.

When activated:

1. call `show_main_window_for_update` first;
2. re-read the current update state from `stateRef`;
3. if the current state contains the same release in `available`, `downloading`, `launching`, or an
   update error state, open the existing modal for that current state;
4. if the process no longer has that matching release, perform one **manual** re-check after focusing
   the app; the manual result rules below then open the modal directly;
5. never start download/install from the notification click.

Do not trust arbitrary notification data. Accept only the fixed CellXplorer update tag/kind and a
non-empty version string created by this adapter.

### 4.5 Make `applyRelease` explicitly source-aware

Refactor `applyRelease()` without disturbing the established reducer/check-race protections.

#### Manual effective source

When `feedbackSource === "manual"` and `merged` is a release:

1. dispatch the existing successful check state;
2. set `upToDateModal` to false;
3. write `merged.version` to `cellxplorer-update-notified-version`;
4. open the existing update modal immediately;
5. do not call the native notification adapter;
6. do not show a Mantine notification.

This also applies when a manual request coalesces with an automatic check already in flight. The
existing `checkFeedbackSource` behavior must continue to make the final result manual.

#### Automatic effective source

When `feedbackSource === "automatic"` and `merged` is a release:

1. dispatch the existing state so the teal badge persists;
2. do not open the modal automatically;
3. if `notificationsEnabled` is false, stop there;
4. if the version was already recorded, stop there;
5. otherwise call `showWindowsUpdateNotification`;
6. write the version only when the result is `shown`;
7. for denied/unsupported/failed results, log a safe debug event and keep the update state/badge.

#### No release or failure

Preserve the current behavior:

- manual no-update opens the up-to-date modal;
- manual check failure opens the check-error modal;
- automatic no-update is silent;
- automatic failure is debug-only.

### 4.6 Remove only the discovery toaster

Remove the `Button` import from `AppUpdateCoordinator.tsx` if it becomes unused. Keep
`@mantine/notifications` only where the coordinator still uses it for unrelated feedback, such as
the development mock completion or restart failure.

Do not globally remove Mantine notifications from CellXplorer.

### 4.7 Settings wording and permission behavior

Update the App updates settings copy exactly as described in §2.4.

Saving the preference must remain immediate localStorage state plus
`cellxplorer-update-preferences-changed` dispatch.

Do not block saving settings merely because Windows notification permission is denied. The
preference expresses the user's desired behavior; actual permission is checked when a notification
is needed. A denied permission should be recorded safely and must not disable update checks.

### 4.8 Development behavior

Ordinary browser/Vite mode must not attempt to send a Windows notification or invoke the new Tauri
command.

Keep the existing update mocks. When running through `tauri dev`, `?mockUpdate=available` may be used
to exercise the automatic-discovery path, but do not treat development branding/icon as final proof.

Do not add a permanent Settings button, debug-menu item, or production command solely to generate a
test notification.

## 5. Data, cache and lifecycle consequences

This feature has no backend or scientific-data consequences.

Do not:

- add a database migration;
- change `CALC_VERSION`;
- read or modify SQLite/Parquet data;
- alter update manifests, signatures or release endpoints;
- change update download/install commands;
- stop the backend during notification display or click;
- add notification records to Downloads history or Activity history.

LocalStorage keys remain unchanged. No local preference migration is needed.

## 6. Files expected to change

Likely minimum:

```text
frontend/package.json
frontend/package-lock.json
frontend/src/updateNotifications.ts
frontend/src/appUpdater.ts                    # only small pure policy/wrapper helpers if needed
frontend/src/components/AppUpdateCoordinator.tsx
frontend/src/pages/SettingsPage.tsx
frontend/tests/appUpdater.test.ts
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/src/main.rs
src-tauri/capabilities/default.json
src-tauri/gen/schemas/*                       # only regenerated notification capability schema changes
tests/test_updater_configuration.py
docs/specs/020-windows-update-notification-and-manual-modal.md
docs/specs/README.md
docs/agent-knowledge/architecture.md
docs/agent-knowledge/change-playbooks.md
docs/windows-packaging.md
AGENTS.md                                      # add updateNotifications.ts if the maintained tree needs it
CHANGELOG.md and maintained version files      # final SemVer step
```

Do not edit unrelated updater release workflow files unless implementation evidence shows this
feature genuinely changes packaging/release inputs. Adding the notification dependency is handled by
the existing Tauri build.

## 7. Tests

### 7.1 Pure frontend policy tests

Extend `frontend/tests/appUpdater.test.ts` with pure helpers as needed. Cover at least:

- manual update discovery selects `open-modal`, never `native-notification`;
- automatic discovery with notifications enabled and unseen version selects
  `native-notification`;
- automatic discovery with notifications disabled selects `badge-only`;
- automatic discovery of an already-recorded version selects `badge-only`;
- a manual result coalesced with an automatic request is treated as manual;
- manual discovery records the version as seen;
- a notification failure does not clear the available state or badge;
- notification activation accepts only the expected update tag/kind and non-empty version;
- activation never transitions to download/install.

Keep tests framework-free and deterministic; do not instantiate a real Windows notification in
Node tests.

### 7.2 Configuration tests

Extend `tests/test_updater_configuration.py` to verify:

- `tauri-plugin-notification` exists in `src-tauri/Cargo.toml`;
- `@tauri-apps/plugin-notification` exists in `frontend/package.json`;
- `tauri_plugin_notification::init()` is initialized;
- `notification:default` is granted;
- no unrelated broad permission was added;
- `show_main_window_for_update` exists and is registered;
- updater check/download/install command wiring remains present.

### 7.3 Build and Rust checks

Run and record:

```powershell
node --test frontend\tests\appUpdater.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
python -m unittest tests.test_updater_configuration -v
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
```

Because `frontend/src/**`, frontend dependencies and Rust/Tauri dependencies change, both the
frontend production build and Cargo checks are mandatory.

## 8. Manual verification

### 8.1 Browser/development checks

Using existing mock/update test paths, verify:

- manual update result opens the update modal directly;
- no bottom-right **View update** toaster appears;
- manual up-to-date and check-error modals still work;
- automatic discovery keeps the teal badge without opening the modal;
- disabling update notifications does not disable the badge;
- Light, Dark and Auto remain unchanged;
- keyboard access to the power menu is unchanged.

### 8.2 Installed Windows checks — mandatory

Build and install a signed NSIS package. Native notification identity/click behavior must be tested in
an installed app because development may use PowerShell branding.

Verify all of the following against a real newer signed release:

1. CellXplorer is visible; automatic check finds the update; a Windows notification appears.
2. CellXplorer is hidden in the tray; automatic check finds the update; the Windows notification
   appears outside the app.
3. Click the notification body:
   - the existing main window is shown;
   - a minimized window is restored;
   - the window receives focus;
   - the existing update modal opens for the correct version.
4. Clicking the notification does not start download or installation.
5. A second automatic check for the same version does not create another notification.
6. A manual **Check for updates** for that version opens the modal directly and does not show a
   Windows or Mantine discovery notification.
7. Disable **Show Windows update notification**:
   - automatic discovery still produces the teal badge;
   - no Windows notification appears;
   - the menu/modal path remains functional.
8. Hide and reopen through the tray to confirm the existing tray lifecycle is unchanged.
9. With Windows notifications disabled for CellXplorer or Focus Assist active, the app does not
   crash and the badge remains available.
10. Explicitly quit CellXplorer and confirm no claim is made that checks continue while the process is
    absent.

Record the Windows version, installed CellXplorer versions used, and exact observed behavior. Do not
claim this matrix passed from a browser-only mock.

## 9. Documentation

Update durable documentation:

- `docs/agent-knowledge/architecture.md`
  - automatic update discovery may emit a Windows notification;
  - click restores/focuses the existing process and opens the modal;
  - no checks occur after explicit quit.
- `docs/agent-knowledge/change-playbooks.md`
  - the update notification preference controls native Windows notifications only;
  - manual checks open the modal directly;
  - installed-app notification verification is required.
- `docs/windows-packaging.md`
  - installed-build notification identity/click test;
  - dev builds may show PowerShell branding.
- `docs/specs/README.md`
  - add Spec 020 to the index.
- `AGENTS.md`
  - add `frontend/src/updateNotifications.ts` to the maintained tree if created.

Do not rewrite Specs 017–019. This specification is the incremental source of truth for the new
presentation behavior.

## 10. Version and changelog

This is a backward-compatible user-facing feature. After implementation and verification, use the
repository's canonical version workflow to choose the next minor version from current `main`:

```powershell
python scripts\bump_version.py --minor --notes "Use native Windows notifications for automatically discovered application updates and open manual update results directly."
```

At the inspected `0.15.5` baseline, the expected version is `0.16.0`. If `main` has moved, do not
force that number; use the next correct minor version.

Run version consistency and preflight again after the bump.

## 11. Out of scope

- checks or notifications while CellXplorer is explicitly quit;
- Windows services, scheduled tasks or a separate updater process;
- auto-download or auto-install from the notification;
- notification buttons, reply fields, release-note text or progress inside the Windows toast;
- a generic notification framework for source monitoring, imports or analyses;
- changing update frequency defaults;
- changing the teal badge or update modal design;
- changing the signed updater Rust commands;
- changing GitHub release publishing;
- Windows Authenticode signing;
- macOS/Linux notification behavior;
- backend, database, migrations, Parquet or scientific caches.

## 12. Implementation order

1. Copy this specification to `docs/specs/020-windows-update-notification-and-manual-modal.md` and
   add the index entry.
2. Confirm no other feature branch is active; branch from current `main` as
   `feature/windows-update-notification`.
3. Add official notification dependencies, plugin initialization and least-privilege capability.
4. Add and register `show_main_window_for_update` by reusing the existing window helper.
5. Create `frontend/src/updateNotifications.ts` with permission, native notification and click
   activation handling.
6. Make `applyRelease` source-aware: manual → modal; automatic → Windows notification/badge.
7. Remove only the update-discovery Mantine toaster.
8. Update Settings wording without changing preference storage.
9. Add focused frontend and configuration tests.
10. Update architecture, playbook, packaging and maintained-tree documentation.
11. Run TypeScript, frontend build, Rust, focused tests and no-cache preflight.
12. Build/install and execute the mandatory Windows notification matrix.
13. Apply the minor version/changelog bump and rerun version/preflight checks.
14. Record exact verification, including anything not performed.

## 13. Acceptance checklist

- [ ] Automatic discovery uses a native Windows notification, not a Mantine toaster.
- [ ] Manual **Check for updates** opens the existing update modal directly when an update exists.
- [ ] Manual no-update and manual check-error modals remain unchanged.
- [ ] Clicking the Windows notification restores, shows and focuses the existing main window.
- [ ] Notification click opens the existing modal for the correct release.
- [ ] Notification click never downloads or installs automatically.
- [ ] The automatic notification is emitted at most once per version.
- [ ] Manual discovery prevents a later redundant notification for the same version.
- [ ] Notification-disabled/denied/failure states retain the teal badge and updater state.
- [ ] No update discovery path shows the old bottom-right **View update** toaster.
- [ ] The feature works while visible, minimized and hidden in the tray.
- [ ] No claim or mechanism supports checking after explicit quit.
- [ ] Only `notification:default` and one narrow window command are added.
- [ ] Browser mode does not invoke native notification APIs.
- [ ] Existing check/download/install race protections and modal states are preserved.
- [ ] No database, cache, migration, `CALC_VERSION` or scientific-data changes are made.
- [ ] Focused tests, frontend build, Cargo checks and preflight pass.
- [ ] The installed Windows notification body-click flow is manually verified and recorded.
- [ ] Version/changelog declarations are synchronized through the canonical bump script.

## 14. Composer handoff

```text
Implement docs/specs/020-windows-update-notification-and-manual-modal.md.

Read AGENTS.md, docs/agent-knowledge/README.md, architecture.md,
change-playbooks.md, visual-style-guide.md, docs/specs/README.md and Specs 017–019 first.

Create feature/windows-update-notification from current main only after confirming no other feature
branch is active.

Locked behavior:
- manual Check for updates + update found -> open existing modal directly;
- automatic update found -> native Windows notification + teal badge;
- clicking the notification restores/focuses the existing window and opens the modal;
- notification click must never download automatically;
- no Mantine View update discovery toaster;
- no checks after explicit Quit.

Use the official Tauri notification plugin with notification:default. Do not use sendNotification()
alone if it prevents observing body clicks: retain a real Notification object and attach onclick, or
use an equivalent proven API from the installed plugin version. Reuse show_main_window through one
narrow Tauri command; do not spawn or restart the app.

Follow the implementation order and run every verification command in the spec. The installed
Windows notification click matrix is mandatory; do not claim it passed from browser/dev mocks.
Do not modify unrelated work.
```
