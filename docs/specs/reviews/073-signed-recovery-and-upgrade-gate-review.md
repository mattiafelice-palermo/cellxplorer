# Spec 073 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-29.
Branch: `codex/signed-recovery-bootstrap`.
Verdict: **PASS for the implementation checkpoint.** No remaining actionable code-review blockers. Hosted build-only rehearsal remains required before final integration.

## Reviewed scope

Signed recovery transport, stage-byte/path ownership, legitimate scope elevation,
canonical process identity, readiness placement, cancellation/retry concurrency,
native installer gate, cryptographic artifact verification and publication ordering.

## Findings addressed

- Replaced unauthenticated named events with a kernel-PID-authenticated local pipe
  bound to the locked staged installer and live originating executable.
- Moved preparation off the UI thread and readiness after prerequisite preparation,
  before installed-file mutation; rejected pre-section WiX recovery migration.
- Added expected payload channel/version/hash binding, full command-length bounds,
  explicit original-user SID permissions and remote-client rejection.
- Added ACK and post-ACK exit authorization; a disconnected/cancelled attempt
  aborts immediately while the origin remains alive, rather than installing on
  a later exit. Successful client ownership lasts through actual OS termination.
- The relay locks its executable and staging directory, hashes its locked bytes
  before elevation, and supervises the checked elevated child's full lifetime.
- Serialized in-flight preparation and restored verified state/revisions on failure.
- Added controller-held provenance and final draft asset ID/digest/signature recheck;
  removed installer-worker credentials and checkout credential persistence.
- Kept full Rust-suite coverage instead of narrowing execution to fit an outdated
  workflow string assertion. Native worker exit-code checks hold process handles.

## Verification boundary

Local full preflight, Rust, cryptographic vectors, three-channel NSIS compilation,
registry fixtures and harmless native recovery/relay/real-transport cases passed.
The hosted native account/install matrix has not yet run. Candidate `/UPDATE`
coverage does not execute an old installed updater; real UAC/alternate credentials
and end-to-end installed-client update/restart remain separate acceptance.

## Cold-runner follow-up

The first build-only rehearsal stopped in preflight because the signature test
required an offline Cargo cache. The follow-up moves both test and artifact checks
to a minimal locked Cargo package sharing the exact verifier source and pinned
production crypto versions. Fresh empty-cache compilation and valid/tampered
signature checks passed. Astra Medium re-review: **PASS**, no remaining blockers;
six focused reviewer tests passed. Full local preflight passed again after resume
from an unrelated Windows sleep interruption. The native Actions matrix still
requires its next rehearsal; no gate was bypassed or weakened.

The second rehearsal passed canonical preflight, signed packaging, the Rust suite
and NSIS registry checks, then stopped at the harmless positive recovery fixture's
missing post-exit marker. The fixture now marks its managed pipe handle invalid
without closing the kernel handle on success, matching the real Rust client's
OS-lifetime ownership; negative cancellation cases still dispose normally.
Production transport is unchanged. Local native15/real transport and preflight
passed; Astra Medium approved this bounded fixture change. CLR shutdown was a
plausible explanation, not a proven cause; the next hosted run must confirm it.

The third rehearsal passed all 15 native recovery cases, the actual Rust-to-NSIS
probe, full Rust tests, policy compilation and signed packaging on the hosted
runner. Artifact preparation then exposed the direct-Tauri local filename (spaces)
versus uploaded GitHub asset filename (dots). The focused fix preserves both exact
names and their byte/signature binding; Astra Medium review and preparation tests
passed. Full local no-cache preflight passed at the same four-worker CI budget
(201 files/modules). The native install/account matrix remains pending.
