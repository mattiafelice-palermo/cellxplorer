# 077 — Verified build optimizations

Status: Feature implementation checkpoint; hosted comparison and conditional release pending.
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

Hosted run IDs, exact commits, cache state, per-step timing, full native outcomes,
and conditional merge/publication decision will be recorded here after runs end.

Local feature checkpoint: canonical `python scripts/preflight.py --no-cache`
passed **4/4**, with four workers, in **166.29 s**. All 106 backend modules and
102 frontend test files passed (the local checkout includes an unrelated,
untracked converter test, which is not part of this change). Focused packaging,
workflow and native-gate regressions passed 128 tests; preflight cache regressions
passed 23 tests. All 102 icon imports/source hashes and 306 upstream SVG render
comparisons passed. Installer/account execution remains hosted-only.
