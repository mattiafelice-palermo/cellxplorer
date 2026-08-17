# Spec 048 implementation review — Test and release runtime optimization

Status: **FEATURE COMPLETE — cumulative review clean; ready for user merge decision**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Final reviewed branch head: `59a50271c03d5257a79165f5b9e48f0bf5a9dea6`  
Hosted 048.2 evidence commit: `7a048b2db67a127c59410c9ebd47efba43666ad1`

## Final decision

**REVIEW CLEAN — Parent Spec 048 and children 048.1/048.2 are complete.**

A fresh cumulative review was performed against the original merge base after all child reviews. R1-R10 are resolved. The final R10 patch is documentation/status-only and accurately closes the parent/child/index records without rewriting historical evidence.

The branch is ready to merge from the reviewer perspective. The merge decision remains with the user; this review does not merge, tag, or release the branch.

## Confirmed cumulative implementation

- Exact repository: `mattiafelice-palermo/cellxplorer`.
- Exact branch: `feature/test-fixture-runtime-optimization`.
- Correct merge base/current `main`: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`.
- Cumulative branch scope is coherent and contains no unrelated feature implementation.
- Golden scientific source/manifest semantics remain unchanged.
- No backend test-result caching, changed-test selection, sampling, loosened scientific tolerances, or removed assertions were introduced.
- Temporary benchmark/rehearsal workflows used to collect hosted evidence were removed before final handoff.

## Child 048 — fixture/test-runtime work

Accepted retained changes:

- Fast Neware replaces repeated long-file parameter work with compact deterministic parity while retaining a committed real-source smoke and direct cycle/decoder semantics.
- Beta bootstrap reuses immutable schema construction input while every test keeps private writable state.
- Neware Excel remains unchanged after profiling showed no justified broad fixture shortcut.
- Portable-analysis removes repeated equivalent valid-report construction while retaining malformed-container failure semantics.
- The timing-history scheduler was rejected by clean hosted evidence and fully removed.
- The attempted suite partition topology was rejected after aggregate regression and fully reverted.
- Vite 8/Rolldown remains retained after compatibility checks and material direct-build improvement.

## Child 048.1 — release/CI runtime

Accepted retained changes:

- release may reuse a trusted exact-SHA canonical Windows preflight under fail-closed workflow/job/SHA/origin rules;
- failed canonical evidence blocks release, while missing/cancelled/skipped evidence falls back to the complete release-local no-cache preflight;
- release restores a main-owned production-profile Rust cache without relying on tag-scoped cache saves;
- independent dependency installs and exact-reuse release inputs use native GitHub Actions parallelism;
- fallback preflight does not build the selected-channel frontend twice;
- frontend stamp verification, packaged-backend smoke, Tauri packaging, signing/updater validation, draft publication, and channel-pointer mutation remain ordered and fail-closed;
- hosted rehearsal `31975338254` showed a cold release-profile Cargo build at 427.81 s and a warm exact-cache-hit build at 138.97 s, with the corrected release-input path passing.

## Child 048.2 — exhaustive test profiling / runner architecture

Hosted run `31980485650`, job `95246290112`, supplied the authoritative clean Windows evidence:

- backend profile: 70 modules / 1,199 cases;
- frontend profile: 60 files / 571 cases;
- six counterbalanced backend runs: `A,B,C,C,B,A`;
- Architecture A median: **53.153 s**;
- Architecture B median: **108.201 s**;
- Architecture C median: **59.157 s**;
- B and C both completed reverse-module-order runs with the full population and no failures.

The evidence therefore supports retaining Architecture A, the existing fresh-process-per-module runner. Reducing repeated interpreter/import work did not improve complete-suite wall time on the four-logical-CPU hosted Windows runner.

The profiler's corrected true-body concentration is approximately **31.60% / 52.34% / 65.03%** for the top 10/25/50 cases by body time. The material-contributor audit covers the hosted top-ten backend modules (72.950 s summed module wall; 52.546 s body, about 72% of total backend body time) and records the expensive operation, behavior-vs-setup classification, optimization considered, and accept/reject rationale for each.

Representative reviewer spot checks support those decisions: migration tests intentionally construct distinct schema/database states; golden checkpoint tests already share immutable expensive setup at class scope; mixed-parser integration deliberately performs real binary+Excel ingest/cache construction with private mutable state. No concrete correctness-preserving redundant setup remained that justified another test rewrite.

## Verification record

### Implementer-reported final 048.2 follow-up

- focused R8/R9 suite: **PASS**, 41 tests in 2.537 s;
- `python scripts/check_versions.py`: **PASS**;
- `python -m compileall -q backend tests scripts`: **PASS**;
- golden verification: **PASS**, 8/8;
- `git diff --check`: **PASS**;
- `python scripts/preflight.py --no-cache`: **PASS**, 56.43 s;
- `python scripts/preflight.py`: **PASS**, 48.77 s;
- R10 documentation closure: `git diff --check` **PASS**; only the requested four status/index documents changed.

Earlier child-specific verification and hosted evidence remain recorded in the specifications/coordination history.

### Reviewer-independent

I independently inspected through the GitHub connector:

- the full feature branch against the verified merge base;
- child 048 implementation and retained/reverted experiments;
- final 048.1 release/preflight workflows, helper behavior, tests, and accepted hosted rehearsal evidence;
- 048.2 profiler, A/B/C benchmark harness, isolation tests, raw hosted artifact `9272359471`, and complete test populations;
- R8 arithmetic/ranking correction and divergent-ranking regression test;
- R9 material-contributor audit plus representative actual slow-test modules;
- R10 commit `c689103930dc529fe8f85266045cc3dc2a53d649`, confirming it changes only Parent 048, 048.1, 048.2, and `docs/specs/README.md` status/index text.

I did **not** independently execute local repository commands in this Chat + GitHub reviewer session. Hosted Actions/raw-artifact evidence was independently inspected where stated.

## Findings

- **R1 — RESOLVED:** timing-history scheduler reverted after clean CI rejection.
- **R2 — RESOLVED:** regressing partition topology reverted.
- **R3 — RESOLVED:** compatible Vite 8/Rolldown migration retained.
- **R4 — RESOLVED:** backend-only sidecar path no longer races frontend stamp.
- **R5 — RESOLVED:** exact-SHA release decision uses the named canonical job.
- **R6 — RESOLVED:** main dependency installs use native parallel steps.
- **R7 — RESOLVED:** hosted Rust-cache/release-input evidence obtained.
- **R8 — RESOLVED:** body-time concentration now uses a body-ranked population with regression coverage.
- **R9 — RESOLVED:** material slow-test contributors have an auditable per-contributor investigation.
- **R10 — RESOLVED:** parent/child/index closure documentation now accurately says implemented/review-clean and lists 048.2.

## Merge readiness

**READY TO MERGE.**

All Parent 048 repository-side findings are resolved, all children are review-clean, the cumulative review is clean, and durable status documentation is closed. No manual/browser validation is required for this tooling/CI-only parent. The user retains the final merge/release decision.
