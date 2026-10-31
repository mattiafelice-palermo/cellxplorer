# 080 — Local signed installer updates

Status: Implementation and local verification complete; Alpha.15 release gates pending.
Branch: `codex/local-signed-installer`.

## User request

Before publishing Alpha 0.28.0-alpha.15, add an option in Settings to select a
manual installer and pass it through the automatic updater as if downloaded.

## Contract

- Settings → App updates offers a local Windows installer and matching updater
  `.sig` selection, native verification, then the existing explicit install action.
  It is a real installation test, not a harmless simulation or fabricated download.
- Copy/read the actual file bytes with a bounded size. Verify the unchanged embedded
  updater key using the same minisign implementation as network downloads.
  Missing/incorrect signatures and altered bytes fail without changing pending
  update state, closing the app, or launching software.
- Read ProductName and ProductVersion from the verified installer's Windows version
  resources, with protected staging. Require the running channel, valid exact
  channel SemVer and no downgrade. Same-version reinstall is explicitly allowed.
  File names and user-entered version labels are never trusted identity.
- Verification stages immutable bytes in the shared pending-update state. An
  explicit Install action uses `install_app_update` and its existing recovery,
  READY/COMMIT/ACK/exit authorization, payload locks, registry/scope checks, UAC,
  retry, restart arguments and data-preservation path. No parallel installer route.
- Concurrent discovery/download/preparation cannot replace a protected handoff;
  stale checks cannot replace a local candidate. A local candidate stays labelled
  local, including errors/retry. Never fabricate network progress or call the remote
  downloader for it. Cancelling file selection changes nothing.
- Browser mode explains that native verification is unavailable. No unsigned,
  test-key, arbitrary-key, lower-version or cross-channel override is provided.
- Signed build-only CI retains an installer-plus-signature bundle for local tests.
  It does not publish a release or change any channel feed.

## Verification

Native signature/tamper/channel/version/resource/state race regressions; frontend
production-flow and presentation tests; typecheck/build; light/dark and enlarged
UI checks; full canonical no-cache preflight; signed hosted build/native matrix.
Live UAC actions require user interaction and must be reported separately from
hosted UAC-disabled checks. No actual library reset is part of this feature.

Local evidence (2026-10-31):

- Canonical no-cache preflight passed all 4/4 stages and all 211 backend/frontend
  test files/modules in 163.00 seconds, using four workers and a short temporary
  directory. Typecheck and production bundle both passed.
- Full locked native suite passed 91/91. Local state tests cover stale checks,
  competing download/install/revision changes, wrong-version consumption, explicit
  discard and restoration of the original local bytes after failed preparation.
- Six read-only signed NSIS fixtures passed: valid renamed installer, same-version
  reinstall, downgrade rejection, cross-channel rejection, altered bytes and absent
  signature. Fresh fixture keys are not accepted by the production command.
- Four production-coordinator frontend tests pass, with development mocks disabled:
  verify does not install; explicit local installation uses the standard command
  without downloading; verification failures preserve state; discard resumes normal
  discovery. The 113 focused installer/updater/release Python tests also pass.
- Built-in browser checks verify the Windows-only disabled state and honest real-
  installation warning, light/dark appearance and 70/100/160 percent UI zoom.
  At 160 percent the final verification control measured 258.19 × 57.60 pixels
  and remained reachable by ordinary page scrolling; no horizontal overflow.
  Temporary appearance/zoom changes were restored and the test tab was closed.
- Browser testing does not execute the native file dialog or a real installation.
  Actual installed-client UAC approval/cancellation remains unverified. The user
  explicitly requested publication after the remaining automated/local checks;
  signed hosted installer/native gates remain mandatory, not waived.

## Release

Include this in the still-unpublished Alpha.15 scope and structured changelog.
Existing Alpha.11 cannot gain the option before being upgraded. Supersede the
earlier build-only rehearsal with a candidate from the final integrated commit.
