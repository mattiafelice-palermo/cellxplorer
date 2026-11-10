# 109 — Alpha startup tour ordering and Alpha .2 release

Status: Implementation verified and merged; Alpha .2 publication in progress.
Branch: `codex/alpha-startup-tour`.

User requests publication of the completed CP fixes (107/108), and What’s New
after the Alpha library picker on first startup. Release `0.29.0-alpha.2` without
changing the version core. No worktrees, real-profile changes or local installation.

The bootstrap coordinator reports its actual blocking UI state to App. The tour
waits through choice, recovery, copying, restart and foreground preparation; it
may open after preparation finishes or the user explicitly continues in background.
Keep backend completion checks and the general dialog guard. Renew the tour's
channel-scoped introduction ID once for this release, preserving seen state after
dismissal, manual replay and the approved four-card design.

Verify production coordinator regressions, bootstrap regressions, browser startup
order with disposable/mock state, canonical preflight and clean-Windows gates.
Then merge, bump only Alpha prerelease sequence, publish through the signed/native
release workflow, and independently verify public signature/feed and unchanged
Stable/Beta blobs. Never replace a published tag or touch real libraries.

## Verification

Production coordinator tests cover the actual gate callback, completed backend
with blocked UI, choice/error/loading, closing dialog transitions, single opening,
persisted dismissal and Alpha-only renewal. Existing picker confirmation and
four-card regressions pass. Browser verification with the actual bootstrap
component and disposable mock state confirms the gate stays blocked through
choice, replacement confirmation and restart. Automatic opening is covered by
the coordinator tests, not a real installed-app browser session.

Canonical four-worker local preflight passes 241/242 modules/files plus version,
type and bundle stages; only the established Windows port-owner assertion fails
locally. No test or safety assertion was skipped. An initial 16-worker run also
had an import-search timeout; it passes at four-worker concurrency.
[Exact-branch clean-Windows preflight 42907911728](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42907911728)
passes on `d4d8ca52`, including the native launcher test.
