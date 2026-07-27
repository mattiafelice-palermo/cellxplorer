# Review 020: Native Windows update notification and direct manual-check modal

Branch: `feature/windows-update-notification`  
Reviewed head: `db253031e6fa572205c01fbcbc6324a73135ba12`  
Base and merge base: `main` at `47b5f1a2a9a9ee20f4d3452d2da59505fb69951a`  
Branch scope: one implementation commit, 27 changed files  
Status: **changes required — not ready to merge or release as 0.16.0**

## Assessment

The source-specific UI behavior is implemented in the intended place. Manual checks now route directly
to the existing update modal, automatic discovery preserves the badge, the old Mantine **View update**
toaster is removed, the local preference shape is unchanged, and the new Tauri command restores the
existing main window without restarting the app or backend.

The core Windows-notification activation path does not work with the exact
`@tauri-apps/plugin-notification` implementation resolved by this branch. The plugin replaces
`window.Notification` with a minimal function that starts an asynchronous IPC call and returns no
real notification handle. It does not implement `onclick`, `onclose`, `onerror`, `close()`, `tag`, or
`data` on the returned object. The branch treats that value as a real DOM `Notification`, so clicking
the Windows toast cannot reach `onActivate`, and a later notification attempt calls a nonexistent
`close()` method.

The branch must not merge until notification display and click activation are owned by an API that
actually exposes Windows activation, and the installed-app matrix has been performed.

## Confirmed correct by code reading

- The branch is based directly on current `main`; no cumulative or unrelated branch scope was found.
- Manual update discovery resolves to `open-modal`, writes the version as seen, and does not call the
  native notification adapter.
- Automatic discovery resolves to notification, badge-only or silent according to source,
  preference and previously notified version.
- Manual no-update and manual check-error behavior remain routed to the existing modal.
- The old Mantine **View update** discovery toaster is removed; Mantine notifications remain only for
  unrelated feedback.
- The existing update modal, reducer, check/download/install commands and lifecycle sequencing are
  reused.
- `show_main_window_for_update` operates on the existing `main` window and does not spawn, restart or
  stop the backend.
- `tauri-plugin-notification` is initialized and the capability adds only
  `notification:default`.
- Settings wording identifies the notification as a Windows notification while retaining the
  existing localStorage preference shape.
- Documentation, maintained-tree mapping, changelog and the intended minor version bump were updated.
- No database, migration, Parquet, cache or scientific-calculation behavior was changed.

## Findings

### R1 — Critical: the Windows toast click path is built on an inert notification object

**Affected files**

- `frontend/src/updateNotifications.ts`
- `frontend/src/components/AppUpdateCoordinator.tsx`
- `src-tauri/src/main.rs`
- `src-tauri/Cargo.toml`
- focused updater tests

### Current

`showWindowsUpdateNotification()` does this:

```ts
const notification = new Notification(...);
activeUpdateNotification = notification;
notification.onclick = ...;
notification.onclose = ...;
notification.onerror = ...;
return "shown";
```

That matches the browser DOM type at compile time, but not the Tauri runtime implementation.

In the exact official plugin tag used by the branch,
`notification-v2.3.3/plugins/notification/guest-js/init.ts` replaces
`window.Notification` with a function that:

1. calls `void sendNotification(...)`;
2. returns no notification handle;
3. defines only the static `permission` and `requestPermission` members.

The injected constructor does not provide instance event delivery or `close()`. Its desktop Rust path
(`plugins/notification/src/desktop.rs`) sends the toast through `notify-rust`, spawns the display
operation and discards the returned notification handle. It does not emit body-click activation back
to JavaScript.

Consequences:

- clicking the Windows toast cannot invoke `notification.onclick`;
- the window is not restored and the update modal is not opened from the toast;
- `activeUpdateNotification.close()` throws on the next notification attempt;
- `notification.close()` would throw before `onActivate` even if the handler were invoked manually;
- `onclose` and `onerror` never clear the retained object;
- the plugin's desktop data model ignores the DOM `tag` and `data` options, so the requested
  replacement tag and payload are not carried through;
- the adapter reports `"shown"` before the asynchronous native IPC/display result is known, so the
  coordinator can persist the version as notified even when display failed.

This is the feature's primary acceptance path, not a cosmetic issue.

### Target

Do not use the plugin-injected `window.Notification` value as a click-capable object.

Implement one narrow Rust-owned Windows notification path that can observe the default/body click.
An acceptable design is:

1. add a command such as `show_update_notification(version)`;
2. display the native toast through a Windows-capable API that returns an activation handle;
3. retain/wait on that handle off the UI thread;
4. on default/body activation:
   - call the existing `show_main_window` logic;
   - emit one narrow Tauri event such as `app-update-notification-activated` with the validated
     version;
5. register one frontend listener in `AppUpdateProvider`;
6. on the event, re-read current update state and open the existing modal, or perform the existing
   manual re-check when the release is no longer current;
7. return success from the display command only after the notification was actually accepted for
   display.

A direct `notify-rust` dependency with its Windows-supported notification handle/default-action
response is one possible implementation. A direct Windows toast API is also acceptable. Whichever
path is chosen must be proven in the installed NSIS build. Do not invent a browser listener around
the existing plugin facade.

The official notification plugin may remain for permission/display support only if the final design
has a separate, proven Windows activation channel. Remove unused JS/plugin dependencies and
permissions if the replacement no longer needs them.

Keep these invariants:

- no second CellXplorer process;
- no app/backend restart;
- no auto-download;
- one listener, not one listener per check;
- native-notification failure does not clear the update badge or pending updater state.

### Acceptance criteria

- Clicking the notification body while CellXplorer is visible opens the existing update modal.
- Clicking while minimized restores, focuses and opens the modal.
- Clicking while hidden in the tray shows, focuses and opens the modal.
- Activation never starts download or install.
- The notification API returns a real success/failure result; a failed display does not write
  `cellxplorer-update-notified-version`.
- A second notification attempt does not throw.
- A newer version can replace or supersede the previous update notification without leaving stale
  activation state.
- The implementation has no assignment of lifecycle handlers to the plugin-injected
  `window.Notification` facade unless a test proves the exact runtime object supplies them.
- Focused tests cover the Rust event/command contract and the single frontend activation listener.
- The installed Windows body-click matrix passes and is recorded.

---

### R2 — Medium: activation validation accepts partial or synthetic identity

**Affected files**

- `frontend/src/appUpdater.ts`
- `frontend/src/updateNotifications.ts`
- `frontend/tests/appUpdater.test.ts`
- the replacement Rust/frontend activation event from R1

### Current

The specification requires activation to accept only the fixed CellXplorer update tag/kind plus a
non-empty version.

`isValidUpdateNotificationActivation()` instead accepts either the correct tag **or** the correct
kind. Its tests explicitly expect tag-only and kind-only payloads to pass.

The adapter also does not read `kind` from notification data. It supplies
`UPDATE_NOTIFICATION_KIND` as a hardcoded argument to the validator and falls back to the captured
release version when notification data is absent. Therefore the validator is not validating the
actual notification/event identity.

This is currently masked by R1 because no desktop click event arrives, but it becomes relevant as
soon as a working Rust activation event is added.

### Target

Define one exact activation payload, for example:

```ts
{
  kind: "cellxplorer-app-update";
  tag: "cellxplorer-app-update";
  version: string;
}
```

Require:

- exact `kind`;
- exact `tag`;
- trimmed, non-empty version;
- version supplied by the event/notification state, not silently substituted by a captured fallback.

Rust must emit that fixed identity itself. The frontend must reject malformed or unrelated events
without focusing, opening the modal or starting a re-check.

### Acceptance criteria

- Exact tag + kind + non-empty version passes.
- Missing tag fails.
- Missing kind fails.
- Wrong tag or kind fails.
- Empty/non-string version fails.
- Rejected events cause no modal, focus, re-check, download or install action.
- Tests no longer declare tag-only or kind-only payloads valid.

---

### R3 — High: the mandatory installed-Windows verification and implementation record are absent

**Affected files**

- `docs/specs/020-windows-update-notification-and-manual-modal.md`
- `docs/specs/reviews/020-windows-update-notification-and-manual-modal-review.md`
- implementation/test records for the branch

### Current

The specification is marked **implemented**, but:

- its acceptance checklist remains unchecked;
- it contains no implementation/verification record;
- the separate review file did not exist when reviewed;
- the commit message reports behavior but no test commands or results;
- no GitHub status checks or workflow runs are attached to
  `db253031e6fa572205c01fbcbc6324a73135ba12`;
- no installed Windows version, test versions or body-click observations are recorded.

The existing tests cover source-selection policy and static plugin wiring. They do not instantiate the
actual injected notification facade or prove native body-click activation. That gap allowed R1 to
compile and pass policy tests.

### Target

After R1 and R2:

1. add focused contract tests for the actual notification command/event boundary;
2. run and record every command required by Spec 020;
3. build and install the signed NSIS package;
4. execute the complete installed-Windows matrix;
5. update the spec status/checklist and append an `R* implementation record` to this review file with
   only the checks actually completed.

### Acceptance criteria

Record exact results for:

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

Also record:

- Windows version;
- installed CellXplorer source and target versions;
- visible, minimized and tray-hidden notification checks;
- body-click focus/modal result in all three states;
- no automatic download;
- same-version deduplication;
- newer-version replacement;
- notification-disabled behavior;
- OS-disabled/Focus Assist failure behavior;
- explicit-Quit boundary;
- confirmation that the old Mantine **View update** toaster never appears.

Do not mark the checklist complete or merge based on browser mocks, type checking or the mere
appearance of a toast.

## R* implementation record

### R1 — Rust-owned Windows activation path

**Status:** code complete; installed body-click matrix still required before merge.

Replaced the inert plugin-injected `window.Notification` path with:

- `src-tauri/src/update_notifications.rs` command `show_update_notification`
- direct `notify-rust` Windows toast that returns only after `show()` succeeds
- background `wait_for_response` for body/`Default` activation
- focus via existing main-window helper + emit `app-update-notification-activated`
- one frontend listener in `AppUpdateProvider` (`listenForUpdateNotificationActivation`)
- removed unused `tauri-plugin-notification` / `@tauri-apps/plugin-notification` /
  `notification:default`

Stale activation is suppressed with a generation counter when a newer toast supersedes an older one.

### R2 — Strict activation identity

**Status:** done in code/tests.

Activation requires exact `kind`, exact `tag`, and a trimmed non-empty `version` from the event
payload. Tag-only and kind-only payloads fail. Rejected events do not open the modal or start a
re-check.

### R3 — Verification and record

**Status:** local automated commands recorded below; installed Windows matrix **not** performed.

Automated commands (this follow-up commit):

```text
node --test frontend\tests\appUpdater.test.ts
→ 29 pass, 0 fail

python -m unittest tests.test_updater_configuration -v
→ 11 pass, 0 fail

cargo test --manifest-path src-tauri\Cargo.toml update_notifications
→ update_notifications unit tests pass; full crate tests include app_updates suite

cargo check --manifest-path src-tauri\Cargo.toml
→ ok

cd frontend && npx tsc --noEmit && npm.cmd run build
→ ok (also covered by preflight)

python scripts\preflight.py --no-cache
→ PREFLIGHT PASSED (5/5 stages)
```

Installed Windows matrix: **not performed**. Do not merge or publish `0.16.0` until that matrix is
executed and recorded here with Windows version, installed CellXplorer versions, and per-state
body-click observations.

## Follow-up order

1. R1 — replace the inert JS notification-object path with a real Windows activation channel.
2. R2 — make activation identity strict and event-derived.
3. R3 — add contract tests and perform the complete local/installed verification.
4. Re-review the branch before merge.

## Merge readiness

**Not ready to merge.**

R1/R2 code and local automated verification are in progress on this branch. Do not merge or publish
`0.16.0` until the installed Windows notification body-click matrix is performed and recorded.

## Verification record

### Implementer reported

- Initial implementation commit:
  `db253031e6fa572205c01fbcbc6324a73135ba12`
- Review follow-ups R1–R2 implemented on this branch; R3 local commands recorded in the R*
  implementation record above. Installed Windows matrix not performed.

### Reviewer independently performed

- Confirmed repository `mattiafelice-palermo/cellxplorer`.
- Confirmed branch `feature/windows-update-notification`.
- Confirmed base and merge base are current `main` at
  `47b5f1a2a9a9ee20f4d3452d2da59505fb69951a`.
- Confirmed the branch is one commit ahead and not behind.
- Read the complete Spec 020 and all material implementation files, dependency/capability changes and
  focused tests.
- Inspected the exact official `notification-v2.3.3` guest-JS injection and desktop Rust source used
  by the branch.
- Confirmed no commit status checks or workflow runs are attached to the reviewed head.
- Did not run repository commands, build/install an NSIS package or perform Windows notification
  clicks in the reviewer environment.
