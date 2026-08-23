# Spec 050: runtime performance optimization

Status: **Active — 050.24 runtime performance stabilization and cumulative review**
Type: **runtime performance / analysis responsiveness**  
Branch: `feature/runtime-performance-optimization`  
Repository baseline / merge base: `main` at `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Review document: [`reviews/050-runtime-performance-optimization-review.md`](reviews/050-runtime-performance-optimization-review.md)

## Goal

Make normal Analysis interaction feel immediate by removing measured unnecessary work while preserving scientific meaning, provenance, determinism, persistence semantics and export fidelity.

Spec 050 is an extensible performance workstream. Add a child only after a concrete slow boundary has been measured and traced to current code. Do not introduce speculative caches, concurrency, native code or rendering changes merely because they might be faster.

> Measure the current boundary, remove meaningful unnecessary cost, preserve the scientific contract, then measure again because the bottleneck may have moved.

A later user decision strengthens this rule for the post-050.17 family work: each family child must address **all measured elements that can plausibly deliver meaningful end-to-end improvement**, not only the single dominant stage. Micro-optimizations and speculative architecture remain out of scope.

A further user decision on 2026-08-23 adds one final concurrency child after the five family optimizations. 050.23 does not reopen family algorithms; it asks whether the aggregate independent work of **4/8/12/16 Cell** requests justifies using the already-resident Python process infrastructure with four or eight workers.

## Accepted work through 050.7

| Child | Boundary | Accepted outcome |
| --- | --- | --- |
| 050.1 | query/cache lifecycle | family-scoped scientific identity, abort propagation and compatible placeholder behavior without exporting stale placeholder data |
| 050.2 | raw cache layout | cycle-addressable Parquet row groups, validated source index and bounded selective reads |
| 050.3 | Time/Capacity access | exact selected-cycle planning/read path with safe non-waiting fallback and preserved continuation/provenance |
| 050.4 | end-to-end profiling | opt-in installed-app profiling through backend, HTTP, frontend preparation and Plotly completion |
| 050.5 | transform decomposition | localized normal/derivative backend costs without speculative optimization |
| 050.6 | normal transforms | dependency-aware work elimination plus optional prepared phase/capacity rows where measured beneficial |
| 050.7 | derivative postprocessing | removed repeated status/run classification while preserving derivative numerical kernels |

Historical Time/Capacity timings explain the roadmap but are not proof of the current bottleneck. Time/Capacity was then developed further through 050.9-050.15 and is **not** part of the post-050.17 family optimization sequence.

## 050.8 withdrawn; numeric ID reserved

Numeric child **050.8 is withdrawn from active workflow by explicit user/spec-author decision on 2026-08-22**. The identifier remains historically reserved and must never be reused.

The former cross-family indexed-detail topic is retained as planning proto-child [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md). A prior 050.8 implementation exists at commit `f76acebf6f8dcf9b2d1a214c9a40e4c0911afc89` and on `backup/spec-0508-demotion-20260822`; it is intentionally absent from the active feature branch and must not be blindly cherry-picked.

## Completed numeric workstream: cross-Cell execution

### 050.9 — Current-path profiling and Python concurrency benchmark

File: [`050.9-current-path-profiling-and-python-concurrency-benchmark.md`](050.9-current-path-profiling-and-python-concurrency-benchmark.md)

**Review-clean; completed.** Measured the post-050.7 production path and isolated read/thread/whole-Cell execution behavior.

### 050.10 — Rust/Rayon kernel benchmark

File: [`050.10-rust-rayon-kernel-benchmark.md`](050.10-rust-rayon-kernel-benchmark.md)

**Review-clean; completed.** Measured equivalent Python/sequential-Rust/bounded-Rayon kernels and lifecycle/transfer costs without wiring production Rust.

### 050.11 — Execution-strategy composition and decision

File: [`050.11-execution-strategy-composition-and-decision.md`](050.11-execution-strategy-composition-and-decision.md)

**Review-clean; completed.** Composed evidence-backed mechanisms and selected the architecture subsequently productionized by 050.12-050.14.

## Completed Time/Capacity production and presentation children

### 050.12 — ordinary Time/Capacity warm-interaction latency

File: [`050.12-ordinary-time-capacity-latency.md`](050.12-ordinary-time-capacity-latency.md)

**Review-clean; completed.** Established the reconciled warm-route latency boundary and profiling evidence.

### 050.13 — ordinary Time/Capacity optimization ablation and composition

File: [`050.13-ordinary-time-capacity-optimization-ablation-and-composition.md`](050.13-ordinary-time-capacity-optimization-ablation-and-composition.md)

**Review-clean; completed.** Re-tested candidate mechanisms against the integrated route and identified the production-worthy owner/process/density path.

### 050.14 — ordinary Time/Capacity production integration

File: [`050.14-ordinary-time-capacity-production-integration.md`](050.14-ordinary-time-capacity-production-integration.md)

**Review-clean; completed.** Productionized request-local owner reuse, indexed selective reads, bounded four-worker process execution with serial fallback, deterministic merge, cache-hit bypass and scientific/provenance parity.

### 050.15 — ordinary Time overview transport and adaptive zoom

File: [`050.15-time-overview-transport-and-adaptive-zoom.md`](050.15-time-overview-transport-and-adaptive-zoom.md)

**Review-clean; completed.** Compacted ordinary Time provenance and added ephemeral indexed adaptive refinement for eligible ordinary non-stacked consecutive Time while retaining four production workers.

## Completed cross-family modernization and profiling

### 050.16 — cross-family analysis performance modernization

File: [`050.16-cross-family-analysis-performance-modernization.md`](050.16-cross-family-analysis-performance-modernization.md)

**Review-clean; completed.** Extended direct immutable stored-body exact hits and request-local owner-state reuse to Steps, DCIR, Chargeability and Rate Capability. Promoted selective step-addressable raw access for Steps/DCIR where complete-route profiling showed a useful win; retained full raw access for Chargeability/Rate Capability where materialization was not the bottleneck.

### 050.17 — five-family profiling and optimization prioritization

File: [`050.17-analysis-family-performance-profiling-and-prioritization.md`](050.17-analysis-family-performance-profiling-and-prioritization.md)  
Amendment: [`amendments/050.17-five-family-profiling-scope.md`](amendments/050.17-five-family-profiling-scope.md)  
Review: [`reviews/050.17-analysis-family-performance-profiling-and-prioritization-review.md`](reviews/050.17-analysis-family-performance-profiling-and-prioritization-review.md)

**Review-clean; completed.** Established a hierarchy-safe, SQL-aware production-route profiler for the five non-Time/Capacity Analysis families and produced the current optimization map:

| Family | 1-Cell miss p50 | 6-Cell miss p50 | exact-hit p50 | dominant current cost |
| --- | ---: | ---: | ---: | --- |
| Cycles | 35.88 ms | 170.99 ms | 22.45 ms | unresolved scientific residual, 73.50 ms / 43.00% |
| Steps | 41.41 ms | 193.85 ms | 14.17 ms | `step_block_extraction`, 65.49 ms / 33.78% |
| DCIR | 72.39 ms | 404.74 ms | 14.97 ms | `dcir_occurrence_extraction`, 152.16 ms / 37.60% |
| Chargeability | 37.65 ms | 195.51 ms | 17.89 ms | `protocol_reconstruction`, 120.69 ms / 61.70% |
| Rate Capability | 219.61 ms | 1267.82 ms | 14.99 ms | `execution_extraction`, 1091.84 ms / 86.12% |

Rate Capability is further localized to roughly 658 ms phase-row filtering and 225 ms measurement filtering/grouping at six Cells. Cycles remains intentionally profiling-first because its largest direct scientific cost is still unattributed.

Time/Capacity is reference-only and must not be reintroduced into this ranking.

## Active optimization sequence: 050.18-050.23

The user explicitly requested one numeric child per family and directed that each child optimize the **whole meaningful family path**, not only the largest measured stage. After those five serial family optimizations are review-clean, 050.23 performs one controlled cross-family persistent-worker scaling study and integrates only measured winners.

### 050.18 — Rate Capability end-to-end performance optimization

File: [`050.18-rate-capability-end-to-end-performance-optimization.md`](050.18-rate-capability-end-to-end-performance-optimization.md)

**Review-clean; completed.** Removed repeated execution scans and retained the final serial/vectorized/indexed Rate path after complete-route profiling.

### 050.19 — DCIR end-to-end performance optimization

File: [`050.19-dcir-end-to-end-performance-optimization.md`](050.19-dcir-end-to-end-performance-optimization.md)  
Depends on: **050.18 review-clean**

**Review-clean; completed.** Reduced source/series preparation duplication and attributed the remaining direct scientific residual while preserving the optimized serial route.

### 050.20 — Chargeability end-to-end performance optimization

File: [`050.20-chargeability-end-to-end-performance-optimization.md`](050.20-chargeability-end-to-end-performance-optimization.md)  
Depends on: **050.19 review-clean**

**Review-clean; completed.** Added request-local protocol reconstruction reuse and safe indexed candidate/reference raw reads, reducing the six-Cell complete route materially without changing science or exact hits.

### 050.21 — Steps end-to-end performance optimization

File: [`050.21-steps-end-to-end-performance-optimization.md`](050.21-steps-end-to-end-performance-optimization.md)  
Depends on: **050.20 review-clean**

**Review-clean; completed.** Reduced repeated block/group aggregation work while preserving selective-read/CV/assembly semantics.

### 050.22 — Cycles profiling closure and end-to-end performance optimization

File: [`050.22-cycles-profiling-and-end-to-end-performance-optimization.md`](050.22-cycles-profiling-and-end-to-end-performance-optimization.md)  
Depends on: **050.21 review-clean**

**Review-clean; completed.** Closed the direct scientific residual attribution and retained only measured Cycles optimizations.

### 050.23 — cross-family persistent-worker scaling and integration

File: [`050.23-cross-family-persistent-worker-scaling-and-integration.md`](050.23-cross-family-persistent-worker-scaling-and-integration.md)  
Depends on: **050.22 review-clean**

**Review-clean; completed.** Promoted the measured four-worker route for Cycles, DCIR, Rate Capability and Steps at four or more Cells; Chargeability remains serial and P8 remains rejected. Time/Capacity was not re-optimized.

### 050.24 — runtime performance stabilization and cumulative review

File: [`050.24-runtime-performance-stabilization-and-cumulative-review.md`](050.24-runtime-performance-stabilization-and-cumulative-review.md)
Depends on: **050.23 review-clean**

**Active.** Close the known Time/Capacity repeated-zoom refinement flash, then reconcile the integrated branch against the Parent 050 merge base before final review.

## Common post-050.17 optimization rules

Every family child 050.18-050.22 must:

1. capture the family baseline on its implementation head;
2. preserve scientific digest/order/provenance and exact-hit behavior;
3. inventory all stages with realistic material route-level benefit;
4. implement the safest/highest-return tranche first;
5. benchmark the **complete production route**, not only helper microbenchmarks;
6. re-profile after every retained tranche because the bottleneck can move;
7. continue through secondary costs while meaningful gains remain;
8. record rejected experiments so they are not repeated later;
9. avoid concurrency/native code inside the family child unless a correctness/architecture requirement forces it; aggregate multi-Cell concurrency is evaluated systematically by 050.23 after all five serial routes are final;
10. stop before low-value micro-optimization or disproportionate architectural complexity.

As a default investigation heuristic, a stage is worth examining when it is about >=5% of the representative multi-Cell miss or >=10 ms p50, or when repeated related work plausibly combines above that level. This is a decision aid, not a permission to change scientific semantics.

050.23 has its own promotion gates because a modest per-Cell cost can still become material across 8-16 Cells. It must compare complete serial/P4/P8 routes at 4/8/12/16 Cells and must not infer process value from one-Cell latency alone.

## Planning-only proto-children

Proto-children are non-implementable and excluded from workflow state until explicitly promoted.

- `050.P2` — progressive Time/Capacity series streaming; earlier experiment rolled back.
- [`050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md`](050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md) — partially promoted by 050.15; remaining variants are planning-only.
- [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md) — historical artifact superseded by 050.16/050.17.

Proto IDs P1/P2/P3/P4/P5/P6/P7 are historically reserved as applicable and must not be reused.

## Locked engineering constraints

1. Preserve scientific calculations, provenance, deterministic order, continuation semantics and export fidelity.
2. Exact persisted result-cache hits remain direct fast paths; do not dispatch workers/native kernels for a hit.
3. Keep SQLite/ORM state in the owning Python/request context. Never share live SQLAlchemy sessions with workers/processes/native code.
4. Prefer removing repeated work and improving data access/vectorization before concurrency.
5. Bound any worker counts; never default automatically to all logical CPUs.
6. Record/bound nested PyArrow, NumPy/BLAS and other native threading when concurrency is tested.
7. Do not add a whole-Cell RAM cache or speculative prefetch merely for performance.
8. Do not pickle complete DataFrames merely to gain process parallelism.
9. Display-only downsampling/refinement never becomes the scientific/full-resolution export source.
10. Never modify, reset or discard unrelated branch work.
11. Do not alter Time/Capacity scientific/performance behavior in 050.18-050.23. 050.23 may minimally generalize the already-established resident worker lifecycle only when a non-Time family passes its production promotion gate; Time/Capacity must retain its four-active-worker policy and scientific path.
12. 050.23 must not create per-family permanent worker pools. If concurrency is promoted, use one application-level resident pool with bounded family-specific active-worker limits and serial fallback.

## Cache, migration and version policy

- No relational migration is implied by performance-only children unless an explicit later spec says otherwise.
- No `CALC_VERSION` bump is implied by a performance-only reimplementation with unchanged scientific meaning.
- Physical raw-layout/index identity remains separate from scientific result identity.
- Per-family result schema versions change only when a persisted response payload shape changes.
- Benchmark instrumentation must stay out of ordinary scientific cache identity/payloads except explicitly namespaced profiling.
- Never edit a released migration.

## Verification policy

Each numeric child is one review checkpoint. Use focused checks during implementation and one canonical:

```text
python scripts\preflight.py
```

at final handoff. Do not repeat successful full suites for confidence. Performance comparisons must use identical scientific inputs/settings and report median plus range/tail where meaningful. Browser/manual measurements are required only for user-visible claims; backend-only evidence must be labelled backend-only.

The final Parent 050 review must compare the complete branch against the correct merge base, enumerate every implemented numeric child through **050.24** and measured boundary, confirm required scientific regression evidence, reconcile cache/version/build consequences, record manual checks actually run, and state explicitly whether the branch is ready to merge.

## Project-context maintenance

Planning alone does not establish a durable merged architecture. Update durable repository knowledge only when an implemented/reviewed child establishes a cross-cutting invariant future agents need.
