# 077 — Verified build optimizations

Status: Live-search IPC publication fix under verification; prior CI evidence retained. Merge/release remain conditional on fresh passing gates and performance acceptance.
Branch: `codex/verified-ci-optimizations`.

## User decision and scope

Bring only the demonstrated Rust, Tabler and sidecar optimizations and native
timing markers out of the isolated experiment. Keep four preflight workers and
all checks. Benchmark signed GitHub CI before merging. Merge and publish the
next Alpha only if correctness is equivalent and hosted timing is favourable.
Do not include rejected scheduling, native-thread caps, eight-worker defaults,
fixture batching, reduced test populations, or shortened integration waits.

User follow-up: investigate and fix the relay-fixture failure without weakening
checks or deadlines, repeat the warm CI comparison, and merge/release the next
Alpha only if every gate passes and the improvement holds. This authorizes the
bounded fixture follow-up below, not changes to production recovery consent.

## Implementation

- Explicit release `lto = "off"`; retain optimization level 3, incremental
  policy, runtime/security features, panic policy and assertion/overflow defaults.
- Replace the two full Tabler packages with the pinned MIT-licensed subset of
  102 used icon modules. Preserve source bytes, factory, source hashes, upstream
  SVG references and fail-closed import/hash/render checks. Include vendored
  assets and parity scripts in the corresponding preflight cache fingerprints.
- Exclude only Setuptools/Distutils builder modules from the frozen sidecar.
  Keep them installed in the builder, runtime dependency pins and the complete
  scientific/ASGI/Excel/Tk module set. Strengthen payload rejection tests.
- Worker-measured JSON timing markers for native setup, assertions, baseline
  operations, uninstall and worker totals. Preserve exceptions and all native
  cases, deadlines, credentials boundaries and mandatory joins.

Local fresh comparisons demonstrated Rust+NSIS 87.0s to 64.6s; npm installation
about 71s to 33.9s; sidecar fresh analysis/build mean 47.7s to 35.5s. All 182 native
sidecar files and 1,242 runtime module names were preserved. These are diagnostic
local results, not a claim about GitHub CI. Original logs remain outside Git in
the isolated `C:/Temp/cxci-20261031-64428d17` workspace.

## Hosted acceptance and publication gates

1. Canonical no-cache local preflight with four workers, focused regressions and
   subset parity pass. Do not run actual installers/accounts on the user's PC.
2. Commit/push the feature checkpoint. Keep Alpha .12 during the like-for-like
   comparison; this is intermediate work, not a completed release commit.
3. Prepare the new effective Rust cache generation for the changed release
   profile using an explicitly requested, branch-scoped workflow-dispatch seed.
   Release stays restore-only; cache compilation never substitutes for tests.
4. Measure fresh signed build-only `main` controls and candidate runs with warm
   matching graphs, four test workers, comparable toolchains/cache conditions,
   full fallback preflight, frozen scientific parity, all Rust/helper/recovery
   checks and all eight native cases. Record cold preparation separately.
5. Retain existing checks and demonstrate a repeatable positive full-job
   improvement in paired warm comparisons; do not infer success by adding overlapping stages or
   subtracting fallback. If evidence is mixed, stay on the feature branch.
6. Only after acceptance, bump to the next verified Alpha version and add exact
   user-facing notes, run preflight, commit/push, and merge. Wait for exact-SHA
   main verification/cache preparation before the user-authorized release tag.
7. Wait for all release gates and independently verify public installer bytes,
   embedded-key signature, manifest/notes/feed, prerelease and unchanged protected
   Stable/Beta channel blobs. Never replace published assets or tags.

The workflow-dispatch cache seed is a documented diagnostic option. It writes
only the dispatch ref's cache; it cannot publish a release or bypass a gate.

User clarification (2026-10-31): accept a repeatable positive full-job improvement,
with every gate passing and all results reported. The earlier 10% cutoff was
introduced by the agent and is superseded, not a user requirement. Historical
comparisons below retain the criterion used at the time; failed jobs still cannot
qualify as timing samples or passing release evidence.

## Evidence

Local feature checkpoint: canonical `python scripts/preflight.py --no-cache`
passed **4/4**, with four workers, in **166.29 s**. All 106 backend modules and
102 frontend test files passed (the local checkout includes an unrelated,
untracked converter test, which is not part of this change). Focused packaging,
workflow and native-gate regressions passed 128 tests; preflight cache regressions
passed 23 tests. All 102 icon imports/source hashes and 306 upstream SVG render
comparisons passed. Installer/account execution remains hosted-only.

### Initial hosted comparison (before relay-fixture fix)

Controls use `9ff61b9b7237ec43d68ab22ee4f79a4f8caf63cb`; candidate runs use the
unchanged implementation checkpoint `543a8afa798e6fcf6268acbbe9f5a6ecf95d5fdc`.
Every run is signed Alpha build-only at version `.12`, with four preflight
workers and the mandatory fallback preflight, frozen-science, helper, Rust,
recovery-policy, native-case and background-join gates retained.

| Role | GitHub run | Full build-job time | Outcome |
| --- | --- | ---: | --- |
| Warm main control 1 | [41159251360](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41159251360) | 785 s | Passed |
| Warm main control 2 | [41159800931](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41159800931) | 733 s | Passed |
| Candidate, warm Rust / cold npm | [41160492348](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41160492348) | 734 s | Passed; preparation observation, not a fully warm timing sample |
| Fully warm candidate 1 | [41160494247](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41160494247) | 691 s | Failed recovery-policy gate; not an accepted timing sample |
| Fully warm candidate 2 | [41161429042](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41161429042) | 673 s | Passed; same checkpoint; all gates including recovery policy and eight native cases passed |

The controls' full-job median is **759 s (12m39s)**. Queue time is excluded;
overlapping stages and native worker phases are never added or subtracted to
construct this median. Only one fully warm candidate passed every gate, so an
accepted paired warm candidate median has **not** been established. The 673 s
successful warm result is **11m13s**, 86 s / 11.3% below the controls' median;
this is a single-run diagnostic comparison, not acceptance of the predeclared
repeated-median criterion. Neither the failed run nor the cold-npm run is silently
substituted for a second valid warm sample.

Cold dependency preparation was separate:
[41159762115](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41159762115)
passed both clean Windows preflight (105 backend modules plus 102 frontend test
files; 207 tasks; 198.17 s preflight wall time) and the branch-scoped release/test
Rust cache seed (487 s full preparation job). The effective Rust cache generation
is `cellxplorer-windows-release-and-test-v3-lto-off`; the first candidate restored
its exact compiled graph. Its separate combined npm key had not yet been warmed,
so the already-planned next warm run was supplemented by one final warm repeat.
The two controls restored exact v2 Rust caches. Release runners use the same
Rust 1.99.1 and Python 3.14.9 toolchains.

All 206 control task identities remain in the candidate's 207-task passing
inventory; the only added task file is `frontend/tests/tablerSubset.test.ts`.
Actual frozen Neware NDAX/Excel and BioLogic raw/cycle parity, NumPy/Arrow,
Parquet/zstd, CSV, Tcl/picker import, timezone and portable assets passed. The
first candidate emitted 40 successful native timing completions, including all
eight setup cases; the mandatory native matrix passed in all three candidate runs.

### Initial recovery-policy failure and publication hold

Run `41160494247` failed `Verify installation registry and NSIS policy` in
`scripts/check_update_recovery.py:237`: **Relay did not retain a live checked
child**. Cleanup then reported WinError 32 because `recovery-policy.exe` remained
locked. The mandatory background join propagated the failure. The 73 Rust shell
tests, signature-vector test, NSIS scope fixtures, scientific checks and all
eight native install/reinstall cases passed; the failed policy gate nevertheless
makes the overall run unacceptable. Its elapsed time cannot count as a speedup.
The final, already-queued unchanged repeat passed that policy gate and every
remaining gate. This demonstrates an intermittent observed result, not an
established root cause or permission to ignore the failed safety assertion.

At the initial checkpoint, the relay fixture and production NSIS recovery policy
were byte-identical between main and the candidate (Git blobs
`af22639451fb10c6a3949a909507eaadb2ab6e0a` and
`18c3b28502aba752e545e37931fcdc7d25cbf83e`, respectively). That establishes an
unchanged code path, not a proven environmental cause. No deadline, assertion,
population, join or recovery behavior has been altered to obtain a pass.

The feature stays unmerged and Alpha publication is held unless equivalent
correctness and the predeclared fully warm timing criterion are established.
Investigating or changing recovery-fixture behavior is a distinct follow-up from
bringing only the proven optimization batch into the repository.

Final evidence-only checkpoint verification: canonical no-cache local preflight
passed **4/4** again in **117.37 s**, retaining four workers and all 208 local
backend/frontend task files/modules. Live remote verification confirmed main
still at `9ff61b9b` and the README, Stable, Beta and Alpha channel blobs unchanged.
No version bump, merge, release tag or publication was performed.

### Authorized relay-fixture follow-up

The old fixture published its checked child's ready marker and then blindly slept
2 seconds before exiting. The controller separately sampled the marker, relay
liveness and file/directory locks. Those are not synchronized: a descheduled
observer can see a genuine marker only after the child and relay have exited.
Controlled execution reproduced the failure condition: at 2.678 s, the marker
existed but the relay had already returned the expected status 7. Three ordinary
observations completed while it was live, in 0.15–0.21 s. The original hosted
failure did not retain enough state to prove its exact scheduling interleaving;
the reproduced race is fixed rather than labeling that run environmental.

The harmless fixture now uses a unique controller-owned manual-reset event. The
checked child takes the production payload/directory locks and publishes its
marker, then awaits explicit release after **both** lock-replacement assertions.
The 10-second readiness and 15-second completion limits are unchanged; late
readiness, premature exit, unlocked payload/directory, wrong child status and
completion timeout still fail. The child also has a bounded 15-second guard using
the existing completion budget, rather than an unbounded hold. The former blind
2-second sleep was an observation window, not a production safety deadline.
Production NSIS/Rust recovery code, consent rules and deadlines are unchanged.

Failure cleanup signals the harmless child and joins the exact owned relay before
temporary-directory cleanup. Cleanup cannot turn a failed assertion or an expired
completion wait into success. Fourteen deterministic unit regressions cover the
controller ordering and negative cases. The mandatory native policy suite keeps
every old case and adds a delayed-observer regression that pauses 2.5 seconds
after readiness, beyond the old sleep but within the unchanged readiness budget.
Eight local relay executions (four delayed) passed all original lock and status
assertions. The full harmless policy suite passed all **18** cases, including the
actual Rust-to-NSIS transport. Actual installers/accounts remain hosted-only.

Fresh signed main controls and fixed-candidate comparisons were repeated
with the existing warm Rust/npm caches and four workers. Earlier failed/cold runs
remain above as evidence and cannot be substituted for this fresh comparison.
The fresh comparison uses **three** warm complete jobs per cohort, chosen before
the first fresh full-job outcome because observed runner/stage variation is large.
Retain all results; the 10% full-job-median criterion is unchanged.
The corrected checkpoint's canonical no-cache local preflight passed **4/4** in
**130.11 s**, with four workers and all 209 local tasks (107 backend modules and
102 frontend files, including the unrelated untracked converter test). No
production recovery file, release workflow gate or application version changed.

### Fresh comparison after the relay-fixture fix

Controls remain at `9ff61b9b7237ec43d68ab22ee4f79a4f8caf63cb`; every corrected
candidate uses `ca20e6d32446df57534a30c08f4979f4a565c1d0`. All six runs restored
exact Rust graphs and warm npm caches, with Rust 1.99.1, Python 3.14.9 and four
preflight workers. All retained gates and the full release-local no-cache fallback
were requested; no failed result is replaced by an earlier or partial pass.

| Role | GitHub run | Full build-job time | Outcome |
| --- | --- | ---: | --- |
| Warm main 1 | [41187957404](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41187957404) | 791 s | Passed every gate |
| Warm main 2 | [41188030122](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41188030122) | 568 s | Passed every gate |
| Warm main 3 | [41188930612](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41188930612) | 725 s | Passed every gate |
| Corrected warm candidate 1 | [41188173841](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41188173841) | 725 s | Passed every gate, including all 18 recovery-policy cases and eight native install/reinstall cases |
| Corrected warm candidate 2 | [41188204818](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41188204818) | 622 s | Passed every gate, including all 18 recovery-policy cases and eight native install/reinstall cases |
| Corrected warm candidate 3 | [41189256127](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41189256127) | 395 s | Failed full fallback preflight in a live-search case; packaging/native gates did not run, so this is not a timing sample |

The fresh controls' median is **725 s (12m05s)**. Only two corrected candidates
passed every gate, so the predeclared three-run warm candidate median has not
been established. Their passing-only median of 673.5 s (11m13.5s) is a diagnostic
observation, **7.1%** below the control median, not a qualifying three-run result
and below the 10% acceptance criterion even before the missing valid sample.
Large run-to-run variation remains visible; the earlier single-run 11.3% gain
was not confirmed by this fresh comparison. No overlapping stages are summed or
subtracted, no fast failed run is counted, and the planned cohort is not extended
until a favourable number appears.

All 206 main task-file identities remain present in each corrected candidate's
208-task inventory. Additions are the icon-parity file and the relay fixture's
14 unit regressions. Both completed corrected workflows passed frozen science,
all existing safety cases and the new native delayed-observer regression. No
relay-policy failure recurred in those two full hosted executions.

The third candidate instead failed
`LifecycleTests.test_native_notifications_deep_rename_delete_pause_resume` in
`tests/test_import_search_live.py:426`, waiting for newly created `new.ndax` to
appear in the catalog. The existing **12-second** deadline expired. That test,
`import_search_live.py` and `import_search_watch.py` are unchanged between main
and the candidate (blobs `1728008a90e910b9db2b1283021f9c91afc0c8bc`,
`372c93a639da5c1554ec8e8734e7f28454f8c45d` and
`f618eee6b0abc714a7e42fd0e2a61cdd76ce0dd5`). This establishes an unchanged code
path, not a proven environmental cause or absence of timing interactions.
The exact unmodified case passed once locally in 5.561 s; that diagnostic does
not substitute for the failed CI gate. Its deadline, watcher behavior and test
assertions have not been changed in this follow-up.

**Decision:** retain the relay fix and optimization checkpoint on the pushed
feature branch. Do not merge, bump the version, tag or publish Alpha while full
hosted correctness and the repeated timing criterion remain unproven. The
live-search failure requires separate investigation; it is not ignored or
silently retried into benchmark acceptance. Main and public channels are not
modified by this decision.

Final local verification again passed canonical no-cache preflight **4/4** in
**139.32 s**, with four workers and all 209 local task files/modules. The full
live-search module passed locally too; this does not override its hosted failure.
Live fetch confirmed main remains `9ff61b9b` and all public channel/README blob
identities remain unchanged. Only the feature branch receives this evidence.

### Authorized live-search follow-up

The user authorized investigating/fixing the live-search timeout without relaxing
deadlines/checks, followed by a fresh warm comparison and conditional merge/Alpha.
Thirty unchanged local native lifecycle repetitions passed; the original hosted
interleaving remains unavailable. A concrete producer failure was reproduced
using one actual Windows handle denying delete/rename access to the outgoing IPC
`.tmp` frame. `os.replace` raised sharing violation 32; `scan_changes` treated the
publication error as an unreadable change and entered 30-second recovery. The
unchanged 12-second native lifecycle test then timed out waiting for its catalog
update (reproduced at rename). This fixes a demonstrated failure mechanism rather
than declaring the opaque hosted result environmental.

`BatchSpool.put` now retries only the atomic rename, with one fixed 100-ms budget,
using the same complete temporary frame and sequence number. It never rewrites
or delivers a partial/duplicate frame. Persistent permission errors retain the
original exception and frame; other I/O failures remain immediate. Existing
consumer call budgets, worker watchdogs and the native test's 12-second deadlines
are unchanged. The native fault regression runs every original create/rename/
delete/pause/resume assertion under a real Windows sharing lock in each delta
worker; healthy updates must still avoid a full-root rescan. Failure-only state
diagnostics make a future timeout observable without changing acceptance.

Nine spool unit cases, including the three new publication regressions, passed.
The new native lock regression passed all original assertions in 7.435 s. Fresh
full verification and hosted comparisons follow; prior failed jobs remain in the
evidence and cannot count as speedups or passing release gates.

The exact fault-injection script that failed before the producer fix passed after
it in 9.503 s, with no test/deadline edits. All 38 spool/live-search suite cases
passed, then canonical no-cache preflight passed **4/4** in **127.26 s** (four
workers; all 209 local task files/modules). The three already-verified warm main
controls at unchanged `9ff61b9b` remain the fixed baseline; the corrected source
gets three new full signed candidate runs. Reusing that validated same-SHA,
same-toolchain/cache baseline avoids repeatedly choosing new control samples.

### Relay launch diagnosis after live-search correction

The first corrected signed run `41192065963` passed every gate in 682 seconds.
Run `41192112621` failed the normal relay case: no ready marker, parent still
running, no fixture error marker after 10.003 seconds. This is distinct from the
previous delayed-observer race; no readiness/completion deadline is extended.
The already-dispatched third run `41192915524` completed successfully, but does
not erase the second run's failure or establish an all-passing comparison.

Test-only parent/child phase markers and a failure-only process snapshot now
record where launch stopped. An optional manual preflight job repeats only the
harmless relay on a fresh hosted runner using the checksum-pinned Tauri NSIS
compiler. It performs no actual installation/account changes and is explicitly
not release acceptance. Normal full preflight and the mandatory complete release
policy suite remain unchanged. No production recovery code is modified.

The diagnostic checkpoint's local canonical no-cache preflight passed **4/4** in
**121.36 seconds**, retaining four workers and all 209 local backend/frontend
tasks. Hosted diagnosis remains necessary before a new acceptance cohort.
