# 070 — User-scope installation and unattended application updates

Status: Implemented; Astra Medium review and preflight passed.
Branch: `codex/alpha-analysis-improvements`.
Review document: [070 review](reviews/070-user-scope-updates-review.md).

## Goal and locked constraints

Fresh installations default to current-user scope in a writable local application
folder, supporting passive signed updates without repeated elevation. Retain an
explicit all-users installation path, whose updates legitimately need UAC.
Windows permission policy cannot be bypassed by quiet installer flags. No new
privileged service, permanent elevation, relaxed Program Files ACLs or disabled
UAC. Preserve Stable/Beta/Alpha identity, update signing and data roots.

## Existing installations

Inspect installer/registry discovery before changing scope. An update must keep
the existing installation's scope and directory, not silently create a duplicate
per-user installation. Existing all-users installations continue to elevate.
If safe automatic migration cannot be validated, document an explicit one-time
reinstallation/migration path rather than deploy an unverified migration. Data
roots stay untouched; uninstall must preserve data as today. Clearly report this
limit in the implementation report: default changes alone do not remove UAC
from already installed machine-scope copies.

## Integration and acceptance

Check NSIS multiuser mode/defaults, branded setup page, registry discovery,
shortcuts/deep links/startup, installation-owned process shutdown, same-scope
update/restart and uninstall for all channels. Frontend remains standard user.
Add contract regressions and compile the installer where available. A disposable
native install/update matrix is required for claiming actual UAC-free update
acceptance; browser/static tests cannot prove it. If bundled/signing assets or
native controls are unavailable, complete safe implementation and report that
specific acceptance gap. Astra Medium review, preflight, commit/push checkpoint.
No version bump, release/tag or changes to the user's real installed application.

## Implementation and evidence

Fresh setup now uses currentUser/asInvoker and LocalAppData. Fresh user folder
choice is retained with local normalization, writability and direct-path checks;
existing paths are locked. Explicit All users requests legitimate elevation.
Runtime scope discovery cross-checks both registry views, manufacturer/uninstall
paths and product/binary/channel identity. Legacy machine copies preserve their
scope and exact directory. Flags are selectors, never arbitrary elevated paths.
Elevated per-user actions are declined. Machine uninstall/startup actions avoid
the administrator account's profile/HKCU state and preserve scientific data.
Matching installation registry records are removed in both views independently
of data deletion. Temporary current uninstallers inherit scope and `/UPDATE`.

Windows update handoff uses the existing Tauri signature-verified download and
channel/version checks. A unique staged file is compared to verified bytes under
a read-only deny-write/delete lock and launched with checked ShellExecuteEx
before backend shutdown. UAC cancellation/immediate failure keeps the new client
open with retryable verified state. Scope/executable equivalence and bounded
command/restart arguments are validated. Restart uses original-user RunAsUser
and a trusted installed argument-decoding helper.

- Focused Python contracts: **29 passed**, including actual PowerShell quoting
  roundtrip through Windows CommandLineToArgvW without launching the application.
- Rust installation policy tests: **4 passed**; cargo check and the full **59-test**
  Rust suite also passed.
- Stable/Beta/Alpha production NSIS template compiler fixtures: **all compiled**.
- Actual silent NSIS policy checks: normalization of a nonexistent folder,
  quoted/unquoted registry equivalence, original-user hive inspection, matching
  both-view uninstall registration cleanup and six fail-closed cases passed
  using unique disposable HKCU fixture keys. The sandbox initially denied fixture
  registry writes; the same checks passed with approved access and cleanup.
- Logs: `tmp/070-focused-tests.log`, `tmp/070-rust-tests.log`,
  `tmp/070-nsis-policy-pass.log`. Compiler setup fixtures have placeholder payloads
  and were not executed. No real installation or scientific data was changed.
- Astra Medium final review: **PASS**. Canonical preflight: **4/4 stages passed**
  (`tmp/070-preflight.log`, 118.11 seconds). The final decoding helper was also
  exercised with empty/single/multiple Unicode argument arrays without launching
  the app (`tmp/070-restart-helper-pass.log`).

## Explicit acceptance gaps and transition limits

Native computer controls are unavailable. The signed disposable install/update
matrix and branded installer visual acceptance remain deferred. Compile/static/
policy tests are not evidence of actual UAC-free signed updates or restart token
behavior. Matrix requirements are listed in `docs/windows-packaging.md`.

Default changes do not remove UAC from existing machine installations. No
automatic migration is attempted: uninstall with data preserved, then reinstall
normally for current-user scope. Already released clients still exit via their
old plugin before installer self-elevation, so first-update UAC cancellation may
close the app; the checked handoff applies after installing this new client.
Normal user updates avoid installer elevation when prerequisites are available;
machine-owned WebView2 repair may still need approval. No version, release,
signing key, channel endpoint or data-root change is part of this spec.
