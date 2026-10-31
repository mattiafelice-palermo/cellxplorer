# 080 — Local signed installer updates

Status: Complete; published and publicly verified in Alpha 0.28.0-alpha.15.
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

## Published release evidence — 2026-10-31

- Feature commit `2dca57c0` was pushed, merged to `main` as
  `cd65ee2233bf486ef7f49cda6718a0d24fe9c537`, and tagged `v0.28.0-alpha.15`.
- Exact-commit main CI [41217189503](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41217189503)
  and signed release [41217220435](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41217220435)
  passed. Release acceptance includes scientific-runtime parity, native unit tests,
  three-channel policy, 29 recovery fixtures, six local signed-input fixtures,
  all eight user/machine × default/custom × upgrade/reinstall cases, keep-data
  preservation, other-channel isolation and final draft asset/signature recheck.
- The [published prerelease](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.28.0-alpha.15)
  has the exact installer, matching `.sig` and `latest.json`. Independent public
  downloads returned the expected sizes and asset digests. The installer SHA-256 is
  `4dcb65484a5bb2deb9df82c8cef9805d2dcbe13d5e6ae186e1c64d4992b69574`.
- Both the unchanged updater-key verifier and the production local-installer
  loader accepted the actual public installer/signature, including its embedded
  Alpha product/version and same-version reinstall policy. These checks did not
  execute the installer or mutate a real application/library.
- The canonical public Alpha feed was byte-identical to the release manifest;
  version, URL, signature and structured changelog notes passed the maintained
  manifest verifier. README, Stable and Beta manifest blob identities were unchanged.
  GitHub's normal latest release remains Stable `v0.20.2`.
- Local public-audit evidence is retained under `tmp/080-public-alpha15/`, and
  hosted logs under `tmp/079-alpha15-evidence/41217220435/` (not committed).
  Live interactive installed-client/UAC approval and cancellation remain outside
  the hosted, UAC-disabled acceptance claim.
