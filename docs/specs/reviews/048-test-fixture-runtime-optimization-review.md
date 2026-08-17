# Spec 048 implementation review — Test and release runtime optimization

Status: **Changes required — documentation closure only (R10)**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed branch head: `b6c6770489efedcebda83fb1d079bb1ff5419ede`  
Hosted 048.2 evidence commit: `7a048b2db67a127c59410c9ebd47efba43666ad1`

## Review scope and result

Children 048, 048.1, and 048.2 are now **code/review clean**. R8 and R9 are resolved. I then performed the required fresh cumulative Parent 048 review against the original merge base rather than relying only on the child reviews.

The cumulative implementation is technically clean and the branch scope is coherent. The only remaining item is durable documentation closure: the parent/child status headers and `docs/specs/README.md` still describe 048 as planned/in progress and do not reflect the completed 048.2 child.

## Confirmed cumulative implementation

- Exact repository: `mattiafelice-palermo/cellxplorer`.
- Exact branch: `feature/test-fixture-runtime-optimization`.
- Correct merge base/current `main`: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`.
- Branch head reviewed: `b6c6770489efedcebda83fb1d079bb1ff5419ede`.
- Branch is 44 commits ahead and 0 behind the merge base.
- Branch scope is limited to the intended Parent 048 work: measured fixture reductions, the accepted Vite/Rolldown migration, preflight/test-runner tooling, release/CI orchestration and Rust-cache work, exhaustive profiling/runner diagnostics, focused tests, and documentation/workflow records.
- No unrelated UI/scientific feature implementation is mixed into the branch.
- Golden scientific source/manifest semantics remain unchanged.
- No backend test-result caching, changed-test selection, test sampling, weakened tolerances, or reduced scientific assertions were introduced.
- The temporary benchmark/rehearsal workflows used for evidence were removed before handoff.

## Child 048 summary

The original fixture/runtime work remains accepted:

- Fast Neware moved repeated parameter coverage to compact deterministic parity while retaining a committed real-source smoke;
- Beta bootstrap reuses an immutable current-schema construction input while each test still receives private writable state;
- Neware Excel was profiled and deliberately left unchanged because serialization/parsing was not the dominant removable cost;
- portable-analysis removed repeated equivalent valid-report construction while preserving malformed-container failure coverage;
- the attempted timing-history scheduler and partition topology were rejected by controlled evidence and fully reverted;
- Vite 8/Rolldown was retained after compatible build/test verification and material direct-build improvement.

## Child 048.1 summary

The release/CI work remains accepted:

- trusted exact-SHA canonical Windows preflight results may be reused under fail-closed trust rules;
- failure blocks release while missing/cancelled/skipped evidence falls back to the complete release-local no-cache preflight;
- the main-owned release-profile Rust cache is restored by release without relying on tag-scoped saves;
- independent pip/npm and release-input work is parallelized with native GitHub Actions semantics;
- fallback preflight does not build the selected-channel frontend twice;
- sidecar/frontend verification, packaged-backend smoke, Tauri packaging, signing/updater verification, draft publication, and channel-pointer mutation remain ordered and fail-closed;
- hosted rehearsal `31975338254` demonstrated a cold 427.81 s release-profile compile followed by a warm exact cache hit at 138.97 s and passed the corrected release-input verification path.

## Child 048.2 summary

The exhaustive profiling/runner investigation is now accepted:

- hosted run `31980485650`, job `95246290112`, covered 70 backend modules / 1,199 backend cases and 60 frontend files / 571 frontend cases;
- all six counterbalanced A/B/C passes completed the same complete backend population;
- Architecture A median: **53.153 s**;
- Architecture B median: **108.201 s**;
- Architecture C median: **59.157 s**;
- B and C both passed reverse-module-order runs but neither materially beat A, so the existing fresh-process-per-module runner correctly remains canonical;
- startup/import probes show meaningful repeated import cost, but the persistent alternatives did not reduce end-to-end wall time on the four-CPU hosted Windows runner;
- the material-contributor audit now covers the top ten backend modules (72.950 s summed module wall, 52.546 s body time / 72.00% of backend body time) and records the dominant operation, behavior-vs-setup classification, concrete optimization considered, and accept/reject rationale for each;
- no further individual optimization was accepted because the inspected cost was required integration/migration/parser/cache/report/lifecycle/isolation behavior rather than demonstrated redundant setup.

## Verification record

### Implementer-reported latest 048.2 follow-up

- focused R8/R9 suite: **PASS**, 41 tests in 2.537 s;
- `python scripts/check_versions.py`: **PASS**;
- `python -m compileall -q backend tests scripts`: **PASS**;
- golden verification: **PASS**, 8/8;
- `git diff --check`: **PASS**;
- `python scripts/preflight.py --no-cache`: **PASS**, 56.43 s; backend/frontend stage 56.15 s, type check 7.32 s, bundle 24.78 s;
- `python scripts/preflight.py`: **PASS**, 48.77 s; backend stage 48.36 s, unchanged frontend policy/type/build stages skipped by the existing conservative cache;
- no A/B/C rerun, appropriately, because R8 was reporting arithmetic only and R9 retained no runner/test optimization.

### Reviewer-independent

I independently inspected through the GitHub connector:

- the full branch comparison against `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`;
- the original Parent 048 goals/locked decisions and implementation record;
- final 048.1 release/CI implementation and previously accepted hosted evidence;
- 048.2 profiler/benchmark implementation and focused tests;
- raw 048.2 hosted artifact `9272359471` and its complete backend/frontend/A/B/C populations;
- R8 fix commit `f930e226c2e90513fabfa218e076146c07858955`;
- the new body-ranked concentration regression test;
- corrected body-time concentration values from the existing raw artifact: about 31.60% / 52.34% / 65.03%;
- R9's top-ten material-contributor audit;
- representative contributor modules including import flow, database migrations, golden approval checkpoints, and mixed-parser integration.

The R9 spot checks support the recorded decisions: migration tests intentionally construct distinct fresh/historical/future/corrupt states; golden checkpoint tests already share their immutable expensive environment at class scope; mixed-parser integration intentionally performs real binary+Excel ingestion/cache construction against private mutable DB/cache state. I did not find a concrete correctness-preserving setup shortcut that the implementer improperly rejected.

I did **not** independently execute repository test commands in this Chat + GitHub reviewer session.

## Findings

### R1 — RESOLVED: timing-history scheduler reverted

### R2 — RESOLVED: partition experiment reverted

### R3 — RESOLVED: Vite 8 / Rolldown migration accepted

### R4 — RESOLVED: backend-only sidecar no longer races frontend stamp

### R5 — RESOLVED: exact-SHA release decision uses the canonical job

### R6 — RESOLVED: main dependency installs use native parallel steps

### R7 — RESOLVED: hosted release/cache runtime evidence obtained

### R8 — RESOLVED: body-time concentration uses a body-ranked population

`profile_test_suite.py` now maintains separate elapsed and body rankings, preserves elapsed ordering for `top_50_cases`, calculates `top_case_concentration` from `body_seconds`, and has a regression test where the rankings deliberately diverge. The implementation record now contains the corrected 31.60% / 52.34% / 65.03% values.

### R9 — RESOLVED: material slow-test contributors are explicitly audited

The implementation record defines a top-ten / >=3.9 s hosted-module-wall selection boundary and documents the required cost classification, concrete optimization considered, and accept/reject rationale for every selected contributor. No speculative test weakening was introduced.

### R10 — Low: close stale Parent 048 status documentation

Affected files:
- `docs/specs/048-test-fixture-runtime-optimization.md`
- `docs/specs/048.1-release-ci-runtime-optimization.md`
- `docs/specs/048.2-full-test-suite-profiling-and-runner-architecture.md`
- `docs/specs/README.md`

**Current**

The cumulative implementation is review-clean, but durable status text is stale:

- Parent 048 still says `Status: Plan`;
- 048.1 still says `Implementation in progress — child 048 review-clean`;
- 048.2 still says `Implemented - awaiting independent review`;
- the spec index says child 048.1 is in progress and does not list child 048.2.

**Target**

Perform the final documentation closure authorized by this cumulative review. Mark Parent 048 and both children as implemented/review-clean, list 048.2 in the index, and make the index summary accurately state that 048/048.1/048.2 and the cumulative Parent 048 review are complete. Do not rewrite historical measurement text or implementation chronology.

**Acceptance criteria**

- Parent 048 header clearly says complete/review-clean;
- 048.1 header clearly says implemented/review-clean;
- 048.2 header clearly says implemented/review-clean;
- `docs/specs/README.md` lists both 048.1 and 048.2 and states the parent/final cumulative review is complete;
- no historical implementation/evidence records are rewritten merely to make them look current;
- patch is documentation/status only;
- `git diff --check` passes.

## Merge readiness

**TECHNICAL/CUMULATIVE REVIEW CLEAN; NOT YET FEATURE_COMPLETE ONLY BECAUSE R10 DOCUMENTATION CLOSURE IS UNCOMMITTED.**

Return the documentation-only R10 patch for a final reviewer verification. If it is limited to the requested closure and accurate, the reviewer can set the workflow to `FEATURE_COMPLETE` and leave the merge decision to the user.
