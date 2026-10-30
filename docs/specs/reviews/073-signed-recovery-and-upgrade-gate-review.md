# Spec 073 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-29.
Branch: `codex/signed-recovery-bootstrap`.
Verdict: **PASS for the final approved amendment.** Astra Medium found no remaining actionable code blockers. Hosted native install acceptance remains mandatory before integration.

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
- Added ACK and post-ACK exit authorization; pre-E cancellation aborts. The
  user-approved final-E settlement contract below supersedes the initial
  immediate post-E disconnect check. Ownership lasts through OS termination.
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

User-approved amendment (2026-10-29): final E becomes irreversible
installation authorization; after observing a post-E disconnect, allow exactly
one non-resetting 100-ms wait on the authenticated origin handle. Install only if
the process signals, otherwise permanently abort the session. This accepts an
exit inside that observed-disconnect window; it is not unchanged immediate
cancellation semantics and does not prove the disconnect was caused by exit.
Pre-E cancellation stays strict. Rust commit now completes C/ACK only, with E
sent by the calling thread after final peer validation and directly before
backend/app shutdown. Failed E retains retry state and the backend; successful
E has no restore-to-operational branch. Local native17 fixtures passed, including
an observed disconnect followed by exit inside the settlement window and a later
exit after permanent expiry. The diagnostic compile-time fixture hook is absent
from production installers. Focused updater/gate/workflow tests passed (131).
Final Astra Medium code review passed with no actionable blockers; reviewer also
ran 19 updater-configuration tests and checked the diff independently. Full Rust73,
three-channel NSIS compilation/policy, six repeated positive/observed-settlement
cases and canonical no-cache preflight (4/4, 201 files/modules, four workers,
133.84 seconds) passed. Hosted native matrix acceptance remains pending. No merge,
tag, new release or feed change has been performed at this checkpoint.

The seventh rehearsal, 40963830659, passed all 17 native recovery cases including
both settlement branches, the real Rust probe, Rust73 and cryptographic candidate/
predecessor verification. Worker initialization then stopped before installations:
Windows PowerShell Add-Type tried the inherited controller TEMP and was denied.
The focused correction establishes each scope's validated non-reparse scratch
TEMP/TMP before credentialed launch and revalidates it before helper loading in
the worker. The late duplicate initialization is removed. Root ACL inheritance
is retained; controller provenance remains outside that root. Focused105 tests
passed, including actual Windows PowerShell compilation with poisoned inherited
TEMP and idempotent initialization. No installer policy or isolation check changed.
Astra Medium re-review passed with no actionable blockers; both new tests passed
independently. Canonical no-cache preflight passed all four stages and all 201
files/modules with four workers (114.21 seconds). Next hosted run remains required.

The eighth rehearsal, 40965854406, passed recovery and artifact checks but still
rejected a runneradmin AppData path before installations; the old shared assertion
did not identify which resolution stage failed. The follow-up logs only selected
SID/profile/path values at each validation stage and adds an early profile-only
CI probe using the exact same credential mode, TEMP initialization and profile
code. It cannot accept draft provenance or native installation cases; the later
full gate is unchanged and mandatory. No resolver or containment check was changed
without evidence. Focused107 tests passed, including profile-only return before
plan loading/install execution and early/full-gate separation checks.
Astra Medium approved the diagnostic-only change; 80 selected tests passed
independently. Canonical no-cache preflight passed 4/4 stages and 201 files/modules
with four workers (120.59 seconds). Hosted profile diagnosis remains required.

The ninth rehearsal's early probe, 40968016266, established the stage precisely:
the native token block and assigned process environment both named the correct
fresh worker, while subsequent parent .NET DoNotVerify resolved runneradmin's
AppData. The correction runs that same default Windows resolver in a fresh
same-token PowerShell child inheriting the validated environment, as an installer
will. The child checks SID/profile and both paths before any Create, revalidates
afterward, and returns typed JSON; the parent bounds execution to 30 seconds and
rechecks identity/containment. No fake paths, resolver fallback, user hive edits
or weakened isolation are introduced. Local probes use no-Create mode in both
PowerShell runtimes; the wrong-SID case fails before folder creation. Hosted
profile/bootstrap and full install matrix still require acceptance.
Astra Medium final review passed; four selected tests including both-shell
read-only resolution and wrong-SID rejection passed independently. Canonical
no-cache preflight passed 4/4 stages and 201 files/modules with four workers
(136.04 seconds). No local profiles/folders or installations were created by probes.

The tenth early probe, 40968857805, confirmed fresh-shell AppData correctness and
then rejected the machine account's filtered token. The controller now launches
only that dedicated machine worker through a unique highest-privilege scheduled
task, propagates its real child exit status, requires this run's start time and
terminal successful task result within a fixed bound, and cleans up exactly its
own registered task. The task receives only checked non-secret CI/scratch context;
credentials are provided only to registration, never arguments/files/environment.
The standard-user worker retains its separate non-admin credentialed launch.
No UAC policy is changed and this does not establish interactive UAC acceptance.
Mocked task lifecycle tests cover success, exit failure, launch failure and wrong
account rejection without creating any local task or account.
Astra Medium caught and confirmed closure of a cleanup edge case: nested finally
now attempts exact-task unregistration even if status lookup or stop fails.
All six mocked lifecycle scenarios and 109 focused tests passed. Final Astra
re-review passed, as did canonical no-cache preflight (4/4 stages, 201 files/
modules, four workers, 154.81 seconds). Hosted token/matrix acceptance is pending.

The eleventh rehearsal, 40970176834, passed both real token/profile probes and
all build, recovery and signature checks. Actual machine installation reached
the byte-equality assertion. The gate had hashed Tauri's restored unbundled EXE;
the [pinned 2.11.4 bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs)
explicitly patches UNK to NSS for NSIS and restores the unpatched build afterward.
The correction computes the whole expected NSIS binary from the trusted local
build using exactly that pinned transformation, rejects changed versions/ambiguous
markers/Authenticode configuration, and retains the raw build digest separately.
Installed bytes are not normalized or used to set their own expected reference.
Per-case logs now include prior, expected and actual hashes, size and directory.
Focused111 tests passed, including exact transformation and fail-closed cases.
Astra Medium final review passed; five focused reconstruction/plan/identity tests
passed independently. Canonical no-cache preflight passed 4/4 stages and 201
files/modules with four workers (117.23 seconds). Hosted byte equality and all
remaining matrix cases are still required before merge.

## Independent preflight blocker - scope approval required

Rehearsals [40972964960](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/40972964960)
and the unchanged-commit rerun [40973776655](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/40973776655)
both stopped in `tests.test_import_search_live`: `BatchSpool.get()` received a
Windows PermissionError reading its atomically renamed temporary JSON file.
Different watcher cases reached the same reader error; installer/gate unit tests
passed. The native matrix therefore has not yet accepted the corrected NSIS hash.
Local individual cases passed; a full watcher module run hit a different native
root-replacement timing failure, which also passed individually. No watcher test,
timeout or application transport implementation has been altered for this work.

`backend/app/services/import_search_transport.py` currently performs an immediate
read/unlink without transient-access handling. The precise external holder of the
Windows file lock has not been established. A proposed separate narrow correction
would retry transient access only within the existing caller timeout, retain
unconsumed batches and surface persistent permission errors, with focused tests.
User approval is required before changing that unrelated production service; do
not silently weaken tests or keep rerunning unchanged failures until green.
No merge, new release, tag or update-feed publication has occurred.

## Authorized spool-access correction - 2026-10-30

The user approved this separate narrow transport fix, Astra Medium review, full
verification and merge only on success, explicitly prohibiting release publication.
`BatchSpool.get()` now retries read/unlink PermissionError within the existing
single caller deadline. It parses once, acknowledges before returning, retains
FIFO/unconsumed files on failure, and raises the persistent original access error.
Malformed JSON and unrelated I/O failures are not retried. Producer behavior and
timeouts are unchanged. Six deterministic controlled-clock tests passed, covering
transient read/unlink, persistent errors and later recovery, FIFO, shared timeout
including initial empty polling, zero timeout and invalid JSON/other I/O behavior.
Astra Medium final review passed with no actionable blockers; the six new tests
and existing partial-frame regression passed independently. All 50 focused
transport/import/native-watcher tests passed. Canonical no-cache preflight passed
all four stages with four workers (198.39 seconds). Hosted acceptance remains
required before merge; release publication remains explicitly prohibited.
