# 073 — Signed recovery bootstrap and mandatory upgrade gate

Status: Complete and accepted for integration: Astra Medium final review, local preflight and full hosted build-only verification passed. No release authorized.
Branch: `codex/signed-recovery-bootstrap`.
Review document: [073 review](reviews/073-signed-recovery-and-upgrade-gate-review.md).

## User-approved scope

Move installation-state interpretation out of the installed updater into the newly
downloaded, signature-verified NSIS payload. Keep the application running until
that payload validates the existing installation and acknowledges readiness.
Use a bounded authenticated READY/COMMIT/ACK/exit-authorization handshake before
shutdown or destructive installer work.
Preserve exact destination, channel, scope, signature checks, legitimate elevation
and scientific data. No arbitrary downloaded repair scripts, privileged service,
UAC bypass, automatic scope migration or changes to real user installations.
Old clients cannot retroactively gain this protocol.

Make disposable Windows reinstall/upgrade smoke tests a mandatory release gate
before undrafting or changing public update feeds. Cover previous-version upgrade,
same-version reinstall, user/machine scope, custom paths, registry leftovers,
data preservation and channel isolation. Distinguish candidate installer execution
from end-to-end old-client updater coverage, and hosted admin/UAC-disabled tests
from genuine standard-user/UAC acceptance. Missing prerequisites fail closed.

Ask GPT-6 Astra Medium to review design and final implementation. Run focused
tests, compile NSIS, run canonical preflight, commit and push the feature branch.
No version bump, release tag or publication is authorized by this implementation
checkpoint. A separate release will deliver these changes to installed clients.

Explicit follow-up authorization (2026-10-30): fix the independent spool-file
PermissionError using bounded retries and regression tests, obtain Astra Medium
review, rerun full GitHub verification and merge only after all gates pass.
Retry read/unlink only within the existing get timeout, retain unconsumed batches,
and preserve persistent permission errors rather than reporting an empty queue.
Do not publish a release.

## Implementation

- Registry-independent client transport keeps the existing signature-verified
  bytes and pins both staged file and directory through launch. Kernel pipe peer
  IDs, canonical image paths, expected channel/version and SHA256 bind the payload.
- New signed NSIS code validates scope/destination, prepares prerequisites, then
  acknowledges readiness before any installed-file changes. It cannot silently
  switch scope or affect another edition. Failed/cancelled preparation restores
  retryable verified state without closing the app/backend.
- The signed relay owns its own file/directory locks and locked-handle SHA256,
  then waits on an actual elevated-child process handle. No remote repair scripts,
  elevated service, signature bypass or changed UAC policy are introduced.
- Release preparation verifies the exact staged assets cryptographically; the
  native matrix uses dedicated disposable OS accounts and verifies scope, exact
  binary, version, channel isolation and keep-data sentinels. Publication/feed
  changes require success and final draft asset identity/byte revalidation.

## Local verification

- Canonical `--no-cache` preflight: 4/4 stages; all 202 local backend/frontend files/modules.
- Rust suite: 73 passed, including real kernel peer identity, delayed connection,
  missing acknowledgement, disposable registry fixtures and busy-state isolation.
- Seventeen harmless native recovery/relay cases passed, including actual Rust-to-NSIS
  transport, invalid identity/version/channel/hash, hung origin, late cancellation,
  file/directory replacement denial and checked child exit propagation. On this
  host Windows also denied directory substitution during the pre-lock delay; that
  case is not reported as an executed successful-substitution/hash-rejection test.
- Stable/Beta/Alpha production templates compiled; isolated NSIS registry policy passed.
- No local CellXplorer installation, real user registration or scientific data changed.

## Acceptance boundaries

Hosted rehearsal 40957734314 exposed a real exit-ordering race: Windows closes
process handles before signaling the process object, so the original immediate
broken-pipe/zero-time process check can reject a genuine exit. Astra Medium
confirmed the issue and withdrew acceptance of that immediate-check behavior.
Explicit user amendment (2026-10-29): final E is irreversible installation authorization;
after observing a subsequent disconnect, allow one non-resetting 100-ms wait on
the authenticated origin process. Proceed only if it signals; otherwise abort
permanently, never accepting a later exit. Pre-E cancellation remains unchanged.
The Rust worker completes C/ACK only; the calling thread validates the final peer
and sends E immediately before infallible backend/app shutdown, without any
restore-to-operational branch after successful E. Native fixtures test both exit
inside the observed-disconnect window and permanent rejection after expiry, plus
unchanged pre-E cancellation. Independent final review and the hosted native
matrix passed. Distribution is a separate release
decision and must report the interactive/UAC acceptance limitations below.

The first build-only rehearsal stopped safely in preflight because the signature
integration test assumed an already-warm offline Cargo cache. The correction uses
a minimal locked verifier package sharing the same source and exact crypto
versions, without desktop/sidecar dependencies. The successful
[build-only rehearsal](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41018569999)
on implementation commit `62ea12ab` passed preflight, signed packaging, all native
recovery/policy checks and all eight Alpha install cases: previous `.9` upgrade
and same-version reinstall, default/custom destinations, under a genuine elevated
machine account and non-admin user account. Exact candidate binary hashes, data
sentinels, keep-data uninstall and Stable/Beta identities were preserved.
It runs candidate installer `/UPDATE`, not the old installed client's Rust updater.
Harmless transport probes are not signed installed-app or interactive UAC tests.
Real UAC cancellation/alternate credentials and whole installed-client update/restart
remain separate disposable interactive acceptance. Historical machine-only releases
cannot be claimed as successful old-user upgrades: candidate fresh-user coverage
is labelled distinctly. Per-user setup already existed before this feature.
Publication-only draft-asset recheck/undraft/feed steps were deliberately skipped
by manual dispatch; they remain mandatory for an explicitly authorized release.
