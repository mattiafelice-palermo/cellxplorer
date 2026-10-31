# 077 — Verified build optimizations

Status: Implementation checkpoint pushed; hosted acceptance is blocked by a recovery-policy fixture failure. No merge or release.
Branch: `codex/verified-ci-optimizations`.

## User decision and scope

Bring only the demonstrated Rust, Tabler and sidecar optimizations and native
timing markers out of the isolated experiment. Keep four preflight workers and
all checks. Benchmark signed GitHub CI before merging. Merge and publish the
next Alpha only if correctness is equivalent and hosted timing is favourable.
Do not include rejected scheduling, native-thread caps, eight-worker defaults,
fixture batching, reduced test populations, or shortened integration waits.

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
5. Retain existing checks and demonstrate at least 10% lower full-job median in
   paired warm comparisons; do not infer success by adding overlapping stages or
   subtracting fallback. If evidence is mixed, stay on the feature branch.
6. Only after acceptance, bump to the next verified Alpha version and add exact
   user-facing notes, run preflight, commit/push, and merge. Wait for exact-SHA
   main verification/cache preparation before the user-authorized release tag.
7. Wait for all release gates and independently verify public installer bytes,
   embedded-key signature, manifest/notes/feed, prerelease and unchanged protected
   Stable/Beta channel blobs. Never replace published assets or tags.

The workflow-dispatch cache seed is a documented diagnostic option. It writes
only the dispatch ref's cache; it cannot publish a release or bypass a gate.

## Evidence

Local feature checkpoint: canonical `python scripts/preflight.py --no-cache`
passed **4/4**, with four workers, in **166.29 s**. All 106 backend modules and
102 frontend test files passed (the local checkout includes an unrelated,
untracked converter test, which is not part of this change). Focused packaging,
workflow and native-gate regressions passed 128 tests; preflight cache regressions
passed 23 tests. All 102 icon imports/source hashes and 306 upstream SVG render
comparisons passed. Installer/account execution remains hosted-only.

### Hosted comparison

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

### Recovery-policy failure and publication hold

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

The relay fixture and production NSIS recovery policy are byte-identical between
main and the candidate (Git blobs `af22639451fb10c6a3949a909507eaadb2ab6e0a` and
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
