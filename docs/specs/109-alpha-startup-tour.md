# 109 — Alpha startup tour ordering and Alpha .2 release

Status: Complete; Alpha .2 published and independently verified on 2026-11-10.
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

## Release outcome

Release source and immutable peeled tag: `3c5d66dbcbedec6399395dc2c9477a65b9ff77c0`.
[Exact-main Windows preflight 42908793184](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42908793184)
passed. Fresh release-local preflight has the same single host-native port-owner
failure described above; all remaining tests and version/type/bundle stages pass.
The 6-source, 13-source and four-source CP private baselines pass unchanged.
The independent CP oracle verifies 115,216 rows, all three voltage channels,
1,036.159015 minutes and 12 source-evidenced loop boundaries.

[Signed release workflow 42909689760](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42909689760)
passed frozen/source science, packaged API, installer policy, native
upgrade/reinstall and final asset gates.
[Alpha 0.29.0-alpha.2](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.29.0-alpha.2)
was published at `2026-11-10T22:01:39Z` as a non-draft prerelease.

Independent public download checks matched all three asset sizes/digests and
release notes, validated the manifest, and cryptographically verified the setup
against the unchanged embedded updater public key. Installer SHA-256:
`2417920909d20abbfd83b2c21d7b5a50045366a3440775a530eb1623bda5033e`.
The public raw Alpha feed exactly matches the release manifest. Feed branch
`afed7cec1a1e1a982ac44bbd93b99efe9bda45be` retains the pre-release README,
Stable and Beta blob hashes recorded in Spec 106. No local installation or real
user-library mutation was performed; no published tag was moved.
