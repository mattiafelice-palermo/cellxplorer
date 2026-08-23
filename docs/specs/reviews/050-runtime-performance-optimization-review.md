# Review: Spec 050 — runtime performance optimization

Status: **Final review clean — ready to merge**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Final conclusion

**Ready to merge.** A fresh cumulative review of the current feature branch found no remaining material defect that prejudices scientific values, deterministic ordering, source/provenance identity, cache correctness, export fidelity, data integrity, worker ownership, or the validity of the production performance decisions made by Spec 050.

The verified comparison remains based on `main` at `1dc3525ec42571504ed6d9bdb9a0668d35df309b`. At final review the feature branch is **225 commits ahead and 0 behind** that base. The cumulative changed-file set is consistent with Spec 050: analysis/cache/runtime services, focused frontend Analysis runtime paths, profiling/test tooling, documentation, and workflow state. No production migration file is changed. Numeric 050.8 remains intentionally withdrawn/reserved; planning-only `050.P2`, `050.P4`, and `050.P7` remain non-production artifacts.

All implemented numeric children through **050.24** are review-clean. The final child fixes the user-observed Time/Capacity repeated-zoom coarse fallback and the review-found stacked-mode lifecycle edge without changing scientific or cache identity.

## Cumulative implementation scope

The accepted workstream is coherent across four layers:

1. **Query/cache ownership and indexed data access (050.1–050.7).** Analysis cache identity was narrowed to explicit per-family scientific dependencies; raw Parquet gained a validated cycle/step-addressable physical sidecar; Time/Capacity adopted bounded indexed selective reads and dependency-aware transform preparation; opt-in profiling was added without entering ordinary cache identity.
2. **Time/Capacity execution and presentation (050.9–050.15, 050.24).** Measurement/ablation selected the production Python architecture: owner-side request resolution, one application-owned bounded process pool, compact ordinary Time payloads, and ephemeral adaptive refinement. Display refinement remains separate from full-resolution scientific/export data. 050.24 now preserves the best compatible LoD while a deeper refinement is pending and invalidates transient refinement when client rendering becomes ineligible, including stacked mode.
3. **Cross-family serial optimization (050.16–050.22).** Steps, DCIR, Chargeability and Rate Capability gained direct stored-body exact hits and request-local owner reuse. Family-specific measured bottlenecks were then optimized while preserving scientific parity; Cycles received the same profiling/optimization closure.
4. **Cross-family bounded process promotion (050.23).** Cycles, Steps, DCIR and Rate Capability use the existing four-worker application pool at four or more unique Cells. Chargeability remains serial. P8 was rejected. No second permanent pool was introduced.

## Performance decisions retained

The final family-specific serial routes substantially reduce the locked 050.17 six-Cell forced-miss baselines before cross-family multiprocessing is considered:

| Family | 050.17 six-Cell baseline | Accepted optimized serial route | Approx. reduction |
| --- | ---: | ---: | ---: |
| Rate Capability | 1267.82 ms | 158.77 ms | 87.5% |
| DCIR | 404.74 ms | ~147.36 ms unprofiled | ~63.6% |
| Chargeability | 195.51 ms | 83.17 ms | 57.5% |
| Steps | 193.85 ms | 132.69 ms | 31.5% |
| Cycles | 170.99 ms | 103.18 ms | 39.7% |

The subsequent 050.23 production P4 matrix remains valid after its R1–R5 correction tranche. At the four-Cell promotion threshold, complete-route P4 improvement versus serial was:

- Cycles: **21.9 ms / 19.0%**;
- DCIR: **63.5 ms / 41.2%**;
- Rate Capability: **79.5 ms / 32.9%**;
- Steps: **60.7 ms / 42.7%**.

Chargeability did not satisfy the multiprocessing value gate and remains serial. P8 did not satisfy the required P8-vs-P4 latency gate and also exceeded the corrected parent-plus-distinct-worker 1.5× resident-RSS gate, so production remains one four-worker pool.

For Time/Capacity, the accepted 050.14 production evidence reduced the representative six-Cell broad Time route from roughly **4.42 s** early in Spec 050 to roughly **127 ms**. 050.15 compact transport reduced broad ordinary Time response size by about **72–74%** while adaptive refinement remained an indexed, non-persistent display path. 050.24 does not alter the backend scientific route or those benchmark decisions.

## Scientific, provenance and deterministic-result contract

The cumulative current code preserves the required scientific ownership boundaries:

- scientific calculations remain in backend services;
- source ordering remains Cell -> ordered SourceFiles;
- worker merges restore deterministic owner order and owner-wide provenance/version badges;
- replicate-group selection context is preserved across Rate Capability worker splitting;
- Cycles retention NaN semantics were corrected during 050.22 review to retain prior Pandas `skipna` behavior;
- protocol-derived family filtering/recognition remains owner-side/request-local and fail-closed;
- worker processes receive no SQLAlchemy session, ORM object, original source path, raw header or Pandas DataFrame;
- workers read only canonical cache artifacts, and Cycles process dispatch requires the exact ready parser/calc cycle cache;
- scientific/merge exceptions remain visible; only pool-not-ready, timeout or broken-process infrastructure falls back to serial execution.

No unresolved parity finding remains in any numeric child review.

## Cache, version and migration reconciliation

The cache/version changes are internally consistent with the final architecture:

- `CALC_VERSION` is still **1.6.2**, identical to `main`; no scientific-meaning change in Spec 050 requires a bump.
- `ANALYSIS_CACHE_VERSION` moved from **6 to 7** for the 050.1 per-family scientific dependency projection. This is a cache-key generation change rather than a scientific formula change.
- the Time/Capacity persisted response schema version moved from **4 to 5** for the compact provenance/transport shape introduced by 050.15;
- raw layout/index generation remains a physical Parquet access concern separate from parser identity, `CALC_VERSION`, and scientific result identity;
- exact persisted result-body hits remain above expensive scientific and worker execution paths;
- adaptive Time/Capacity refinement is deliberately non-persistent and never becomes cache/export authority;
- no relational migration file is changed in the cumulative branch comparison, and no released migration was edited.

## Exact-hit and worker lifecycle review

Current route inspection confirms the intended hit/miss ordering. Modern stored-body hits are served directly before family scientific compute/worker dispatch. On misses, request-local owner context is reused by promoted worker decisions and serial fallback. Chargeability remains an explicitly serial family.

`analysis_family_workers.py` defines the production set as `cycles`, `steps`, `dcir`, and `rate_capability`, with threshold 4 and worker count 4. It obtains the executor from `time_capacity_workers._ready_pool(4)` rather than owning another pool. The Time/Capacity worker module itself owns the single application process-pool lifecycle.

This reconciles the final architecture with the 050.14 and 050.23 decisions: one resident application pool, bounded active worker counts, cache-only spawned jobs, and safe serial fallback when infrastructure is unavailable.

## Frontend/runtime integration review

The final Time/Capacity frontend maintains separate identities for canonical query data and transient adaptive refinement. A newly arriving refinement must match both the current overview identity and request generation. An already displayed refinement may remain visible across a deeper compatible zoom without matching the newer pending generation.

050.24 also closes the stacked-mode edge found during review. Refinement eligibility now synchronously gates displayed refined data and the optional reveal; an eligibility transition invalidates pending/displayed state before paint, and the live eligibility ref prevents a late pre-toggle response from being installed. The canonical `currentResult` remains the export source and the stacked fallback source.

The retained 140 ms reveal is presentation-only, reduced-motion safe, interruptible, and does not interpolate or scientifically transform coordinates per frame. Browser/manual rendering checks were not run, so no claim of manual visual validation is made.

## Documentation and branch-scope reconciliation

`docs/agent-knowledge/state-and-performance.md` now records the accepted raw-layout/index ownership, Time/Capacity cache/profiling/refinement contracts, family-specific serial optimization boundaries, and 050.23 shared-worker architecture. Parent 050 now enumerates the workstream through 050.24 and correctly records 050.18–050.23 as completed/review-clean. The remaining top-level `Active` wording in the parent/050.24 implementation-record headers is workflow status text rather than a contradictory architectural statement; the canonical workflow state and this final review are authoritative for closure.

No proto-child is scheduled or required for completion. Rust/Rayon material remains benchmark/tooling evidence under `scripts/`, not production runtime integration.

## Implementer-reported verification

The final 050.24 returned-fix handoff reports:

- focused frontend tests: **PASS (36)**;
- Time/Capacity refinement policy tests: **PASS (11/11)**;
- TypeScript/Vite production build: **PASS**;
- canonical `python scripts\preflight.py`: **PASS (4/4; all 153 backend/frontend modules)**;
- browser/manual checks: **NOT RUN** at the user's explicit request.

Earlier review-clean children additionally record their focused scientific/parity/golden checks and profiler matrices. In particular, 050.23 reports 128 focused tests plus a final S1/P4/P8 matrix with cross-mode scientific/order parity, and 050.22 reports focused Cycles/analysis/stitch/golden/profiler verification after the retention-NaN correction.

## Reviewer-independent verification

Repository/code/evidence inspection only. I did **not** independently execute `python scripts\preflight.py`, the frontend build, focused test suites, golden corpus, performance profilers, S1/P4/P8 matrix, or browser/manual checks.

For this final review I independently inspected the current branch comparison and current production code/evidence including:

- `AGENTS.md`;
- `backend/app/config.py` on branch and `main`;
- `backend/app/services/analysis_cache.py`;
- `backend/app/routers/analyses.py`;
- `backend/app/services/analysis_family_workers.py`;
- `backend/app/services/time_capacity_workers.py`;
- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx`;
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityRefinementPolicy.ts`;
- `frontend/tests/timeCapacityRefinementPolicy.test.ts` and the source-contract coverage in `timeCapacityQueryPolicy.test.ts`;
- `docs/agent-knowledge/state-and-performance.md`;
- the current Parent 050/050.24 specifications and review-clean records for the final cross-family children.

## Findings

**None.** No new concrete cumulative defect, spec deviation, scientific regression risk, cache/version error, migration issue, or benchmark-validity problem was established from the current integrated branch.

## Merge readiness

**The feature branch is ready to merge to `main`.**

This verdict is based on repository/code inspection plus the implementer-reported final preflight and focused verification. Browser/manual validation was not run and is therefore not claimed, but under the active specification it is not a remaining required merge blocker.
