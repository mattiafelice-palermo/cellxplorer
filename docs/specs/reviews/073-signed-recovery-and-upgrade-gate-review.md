# Spec 073 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-29.
Branch: `codex/signed-recovery-bootstrap`.
Verdict: **BLOCKED for final integration.** Earlier checkpoint reviews passed, but hosted rehearsal exposed a confirmed process-exit ordering race. The final-E acceptance amendment below requires user decision before correction and re-review; the native matrix remains unaccepted.

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

The fourth rehearsal passed all recovery/policy checks and cryptographic checks
on the candidate plus all three previous-channel installers. It then stopped
before installation because fresh-account AppData resolution failed containment.
The old diagnostic did not distinguish an empty missing-directory result from
an inherited outside-profile path, so neither is claimed as the proven cause.
Worker initialization now validates the genuine token/ProfileList identity,
resets profile-dependent environment, resolves with `DoNotVerify` and checks
absolute normalized containment before `Create`, then checks containment and
directory existence again. No fabricated AppData path or relaxed isolation gate
is used. Focused tests cover missing, foreign, sibling-prefix, traversal and
relative paths and the initialization order. Hosted rerun remains required.
Astra Medium re-review: **PASS**, no actionable blockers; both new regressions
and all seven folder-boundary cases passed independently. Local focused gate/
workflow tests passed (101 tests).
Canonical no-cache preflight outside the restrictive sandbox passed all four
stages and 201 test files/modules with four workers (116.66 seconds). Sandboxed
attempts exposed temporary-path limits and stalled native startup tests; no
application code or test timeout was changed to accommodate that environment.

The fifth rehearsal made the failure conclusive: `DoNotVerify` resolved
`runneradmin`'s inherited LocalAppData while token/ProfileList correctly named
the fresh worker. No installation ran. The follow-up generates a native
`CreateEnvironmentBlock` for the already-loaded current token with inheritance
disabled, verifies its USERPROFILE and both AppData boundaries, then applies
only validated profile variables before the existing shell-folder checks.
The native block is freed in `finally`; no registry rewrite or fabricated path
is used. A read-only native regression poisons inherited USERPROFILE/APPDATA/
LOCALAPPDATA, verifies Windows returns genuine token values, and checks actual
shell resolution after applying them in both PowerShell 7 and Windows PowerShell
5.1. Identity mismatch and foreign-path cases still fail closed.
Astra Medium final review: **PASS**, no actionable blockers; four focused tests
including both native runtime probes passed independently. All 103 focused gate/
workflow tests and canonical no-cache preflight (4/4 stages, 201 files/modules,
four workers, 118.63 seconds) passed. Next hosted rehearsal remains mandatory.

## Confirmed exit-ordering blocker

The sixth rehearsal, [40957734314](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/40957734314),
passed preflight, signed packaging, Rust73, signature vectors and NSIS policy,
then intermittently failed the positive harmless recovery fixture in phase=exit
with a broken pipe and an unsignaled process object. The new account environment
fix did not reach the install matrix in this run.

This is not dismissed as CLR fixture cleanup: Microsoft's documented
[ExitProcess ordering](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-exitprocess)
closes all process handles before signaling the process object. Therefore the
immediate broken-pipe/Wait(0) check can false-abort an actual production exit.
Astra Medium confirmed the issue and corrected the earlier immediate-check
approval. Existing green runs do not establish reliability of this ordering.

Proposed amendment awaiting explicit user decision: final E becomes irreversible
installation authorization; after observing a post-E disconnect, allow exactly
one non-resetting 100-ms wait on the authenticated origin handle. Install only if
the process signals, otherwise permanently abort the session. This accepts an
exit inside that observed-disconnect window; it is not unchanged immediate
cancellation semantics and does not prove the disconnect was caused by exit.
Pre-E cancellation stays strict. Review final-E placement so cancellable/fallible
preparation precedes it. Tests must cover pre-E cancellation, no-exit disconnect,
inside-window exit and later exit after permanent expiry. No amendment or grace
has been implemented; no merge, tag, new release or feed change was performed.
