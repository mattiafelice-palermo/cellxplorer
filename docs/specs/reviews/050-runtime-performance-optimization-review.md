# Review: Spec 050 — runtime performance optimization

Status: **Final review clean — ready to merge**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Final conclusion

**Ready to merge.** The cumulative Parent 050 review is clean after the final 050.24 R2 correction and user interaction confirmation.

The merge base remains exactly `1dc3525ec42571504ed6d9bdb9a0668d35df309b`. Immediately before this final review update, the feature branch was **232 commits ahead and 0 behind** that base; the additional commits since the earlier final review are reviewer/workflow closure plus the focused 050.24 R2 correction. No new unrelated implementation scope was introduced.

All scheduled numeric children through **050.24** are review-clean. Numeric 050.8 remains intentionally withdrawn/reserved. Planning-only proto-children remain non-implementable future work and do not block closure.

## Final 050.24 correction

The earlier Parent 050 closure was reopened after the user reported that adaptive Time/Capacity zoom stopped working following the reviewer-requested stacked-mode R1 fix. The regression boundary was isolated to that correction tranche.

Commit `a776af586ca90cb049cf178384185c06a2ff6d86` restores the known-good ordinary flat adaptive-zoom lifecycle while preserving the valid stacked-mode protection:

- ordinary eligible flat relayout again schedules through the baseline `timeCapacityRefinementCanSchedule(active, spec)` path;
- redundant render-time eligibility-ref gates around normal scheduling/acceptance were removed;
- `TimeCapacityRefinementLifecycle` now owns ephemeral request generation, requested/displayed viewport metadata, stacked invalidation and response acceptance;
- compatible refined LoD remains visible while a deeper replacement is pending;
- stale rapid-zoom responses remain generation-gated;
- `stacked: false → true` invalidates transient refinement/reveal state and rejects late pre-toggle responses;
- returning to flat does not resurrect stale refinement and allows a fresh adaptive request;
- transient refinement remains separate from scientific/query/cache/export identity.

The user then exercised the current application and explicitly confirmed on 2026-08-23 that **adaptive zoom is working**. This closes the manual interaction gate that remained after automated/code review because the previous regression had escaped the suite.

## Cumulative architecture and scientific contract

The accepted Spec 050 implementation remains coherent:

1. **Query/cache/index ownership.** Per-family scientific cache identity is explicit; indexed cycle/step-addressable Parquet sidecars are validated and fail safely; request paths do not rebuild expensive caches.
2. **Time/Capacity.** Indexed selective reads, dependency-aware preparation, profiling, compact transport and adaptive refinement remain separated from full-resolution scientific/export authority.
3. **Cross-family serial optimization.** Rate Capability, DCIR, Chargeability, Steps and Cycles retain their accepted request-local/vectorized optimizations and parity evidence.
4. **Bounded multiprocessing.** Cycles, Steps, DCIR and Rate Capability use the one existing four-worker application pool at the accepted promotion threshold; Chargeability remains serial; P8 remains rejected.

Scientific calculations remain backend-owned. Source ordering/provenance, deterministic merge order, replicate-group identity, NaN semantics, protocol guards, exact-hit bypass and fail-closed cache behavior remain intact. Workers receive no SQLAlchemy session, ORM object, original source path, raw header or Pandas DataFrame. Scientific/merge exceptions remain visible; infrastructure-only worker failures retain serial fallback.

No relational migration was added or edited. `CALC_VERSION` remains unchanged because Spec 050 did not change scientific meaning. Adaptive Time/Capacity refinement is still ephemeral and never becomes persisted scientific/export authority.

## Retained performance decisions

Accepted six-Cell serial-route results remain:

| Family | 050.17 baseline | Accepted optimized serial route | Approx. reduction |
| --- | ---: | ---: | ---: |
| Rate Capability | 1267.82 ms | 158.77 ms | 87.5% |
| DCIR | 404.74 ms | ~147.36 ms unprofiled | ~63.6% |
| Chargeability | 195.51 ms | 83.17 ms | 57.5% |
| Steps | 193.85 ms | 132.69 ms | 31.5% |
| Cycles | 170.99 ms | 103.18 ms | 39.7% |

The accepted 050.23 P4 threshold remains four unique Cells. Reported four-Cell P4 gains versus serial remain: Cycles **21.9 ms / 19.0%**, DCIR **63.5 ms / 41.2%**, Rate Capability **79.5 ms / 32.9%**, and Steps **60.7 ms / 42.7%**. Chargeability remains serial. P8 remains rejected on both latency and resident-RSS gates.

For Time/Capacity, the accepted 050.14 production evidence reduced the representative six-Cell broad Time route from roughly **4.42 s** early in Spec 050 to roughly **127 ms**, and 050.15 reduced broad ordinary Time response size by about **72–74%**. The final 050.24 lifecycle corrections do not alter those backend scientific/performance decisions.

## Verification record

Final 050.24 R2 handoff reported:

- focused frontend tests: **PASS (37)**;
- production refinement lifecycle regression: **PASS**;
- TypeScript/Vite production build: **PASS**;
- canonical `python scripts\preflight.py`: **PASS (4/4; all 153 backend/frontend modules)**;
- implementer browser adaptive-zoom check: **NOT RUN**.

Reviewer verification was repository/code/evidence inspection; I did not independently execute those automated commands. The user supplied the required real application confirmation that adaptive zoom works on the R2 build.

Earlier review-clean child records continue to carry their focused parity/golden/profiling evidence, including 050.22 Cycles NaN regression coverage and the 050.23 S1/P4/P8 parity and RSS matrix.

## Findings

**None.** R1 and R2 in 050.24 are resolved. No remaining concrete scientific, provenance, deterministic-order, cache/version, migration, export, worker-lifecycle or user-visible correctness defect is open.

## Merge readiness

**The feature branch is ready to merge to `main`.**