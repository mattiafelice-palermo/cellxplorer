# Spec 050: runtime performance optimization

Status: **Active — 050.16 cross-family analysis performance modernization**
Type: **runtime performance / analysis responsiveness**  
Branch: `feature/runtime-performance-optimization`  
Repository baseline / merge base: `main` at `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Review document: [`reviews/050-runtime-performance-optimization-review.md`](reviews/050-runtime-performance-optimization-review.md)

## Goal

Make normal Analysis interaction feel immediate by removing measured unnecessary work while preserving scientific meaning, provenance, determinism, persistence semantics and export fidelity.

Spec 050 is an extensible performance workstream. Add a child only after a concrete slow boundary has been measured and traced to current code. Do not introduce speculative caches, concurrency, native code or rendering changes merely because they might be faster.

> Measure the current boundary, remove the dominant unnecessary cost, preserve the scientific contract, then measure again because the bottleneck may have moved.

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

Useful historical evidence:

- before 050.6, the controlled six-Cell All/Time case was about **4.42 s** and phase/capacity reconstruction dominated post-read work;
- after 050.6, the same broad six-Cell Time case was about **0.54 s**, while six-Cell All/capacity was about **0.72 s**;
- after 050.7, broad one-Cell dQ/dV and dV/dQ derivative stages were about **156-158 ms**, down roughly 61-64%;
- broad derivatives still produced hundreds of finite cycle/phase segments, leaving backend compute and frontend trace count as separate performance boundaries.

These timings explain the roadmap but are not proof of the current bottleneck. Later children re-profile the current branch.

## 050.8 withdrawn; numeric ID reserved

Numeric child **050.8 is withdrawn from active workflow by explicit user/spec-author decision on 2026-08-22**. The identifier remains historically reserved and must never be reused.

The former cross-family indexed-detail topic was retained as planning proto-child [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md). It is now superseded by the fresh current-code 050.16 design; the old prototype remains historical evidence only.

A prior 050.8 implementation exists at commit `f76acebf6f8dcf9b2d1a214c9a40e4c0911afc89` and on `backup/spec-0508-demotion-20260822`. It is intentionally absent from the active feature branch. Do not blindly cherry-pick it.

## Completed numeric workstream: cross-Cell execution

The user's real workload can include roughly **10 large Cells** in one Time/Capacity plot. After 050.6/050.7 removed major unnecessary transforms, the next question was how the necessary remaining independent per-Cell work should execute.

The original broad `050.P3` was split on 2026-08-22 into three narrower proto decisions (`050.P3`, `050.P5`, `050.P6`). By explicit user decision those were promoted into three sequential numeric children so each performance contribution was independently attributable and reviewable.

### 050.9 — Current-path profiling and Python concurrency benchmark

File: [`050.9-current-path-profiling-and-python-concurrency-benchmark.md`](050.9-current-path-profiling-and-python-concurrency-benchmark.md)  
Promoted from: **050.P3**

**Review-clean; completed.** Measured the post-050.7 production path and isolated read/thread/whole-Cell execution behavior.

### 050.10 — Rust/Rayon kernel benchmark

File: [`050.10-rust-rayon-kernel-benchmark.md`](050.10-rust-rayon-kernel-benchmark.md)  
Promoted from: **050.P5**  
Depends on: **050.9 review-clean**

**Review-clean; completed.** Measured equivalent Python/sequential-Rust/bounded-Rayon kernels and lifecycle/transfer costs without wiring production Rust.

### 050.11 — Execution-strategy composition and decision

File: [`050.11-execution-strategy-composition-and-decision.md`](050.11-execution-strategy-composition-and-decision.md)  
Promoted from: **050.P6**  
Depends on: **050.9 and 050.10 review-clean**

**Review-clean; completed.** Composed only evidence-backed mechanisms and selected the architecture subsequently productionized by 050.12-050.14.

## Completed production and presentation children

### 050.12 — ordinary Time/Capacity warm-interaction latency

File: [`050.12-ordinary-time-capacity-latency.md`](050.12-ordinary-time-capacity-latency.md)

**Review-clean; completed.** Established the reconciled warm-route latency boundary and profiling evidence for ordinary Time/Capacity work.

### 050.13 — ordinary Time/Capacity optimization ablation and composition

File: [`050.13-ordinary-time-capacity-optimization-ablation-and-composition.md`](050.13-ordinary-time-capacity-optimization-ablation-and-composition.md)

**Review-clean; completed.** Re-tested candidate mechanisms against the integrated route and identified the production-worthy owner/process/density path.

### 050.14 — ordinary Time/Capacity production integration

File: [`050.14-ordinary-time-capacity-production-integration.md`](050.14-ordinary-time-capacity-production-integration.md)

**Review-clean; completed.** Productionized request-local owner reuse, indexed selective reads, bounded four-worker process execution with serial fallback, deterministic merge, cache-hit bypass and scientific/provenance parity.

### 050.15 — ordinary Time overview transport and adaptive zoom

File: [`050.15-time-overview-transport-and-adaptive-zoom.md`](050.15-time-overview-transport-and-adaptive-zoom.md)

**Review-clean; completed.** Compacted ordinary Time provenance, retained overview density multiplier 12 because browser validation was not run, and added ephemeral indexed adaptive refinement for eligible ordinary non-stacked consecutive Time while retaining four production workers. Capacity optimization remains deferred.

## Active child: 050.16 — cross-family analysis performance modernization

File: [`050.16-cross-family-analysis-performance-modernization.md`](050.16-cross-family-analysis-performance-modernization.md)

Apply the proven Spec 050 lessons to **Steps, DCIR, Chargeability and Rate Capability**, with Cycles as the prepared/cache-native control. The child starts from the current production code, not the withdrawn 050.8 prototype. It first adds direct exact-cache-hit serving and request-local owner-state reuse, then conditionally adds step-addressable selective raw access only where current profiling proves it worthwhile. Remaining cross-Cell process work is measured only after those simpler wins; 050.16 must not create a second resident process pool or destabilize the proven Time/Capacity executor merely for architectural symmetry.

## Planning-only proto-children

Proto-children are non-implementable and excluded from workflow state until explicitly promoted.

- `050.P2` — progressive Time/Capacity series streaming. The earlier experiment was rolled back; do not revive it implicitly.
- [`050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md`](050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md) — the bounded on-demand ordinary Time refinement portion was promoted and implemented by 050.15; fixed higher-density, client-reservoir, Plotly-timing and other unimplemented variants remain planning-only.
- [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md) — historical planning artifact superseded by 050.16; do not promote or restore the old 050.8 implementation.

Proto IDs P1/P2/P3/P4/P5/P6/P7 are historically reserved as applicable and must not be reused even after promotion/demotion/removal.

## Locked engineering constraints

1. Preserve scientific calculations, provenance, deterministic order, continuation semantics and export fidelity.
2. Exact persisted result-cache hits remain direct fast paths; do not dispatch workers/native kernels for a hit.
3. Keep SQLite/ORM state in the owning Python/request context. Never share live SQLAlchemy sessions with workers/processes/native code.
4. Prefer cross-Cell parallelism before parallelizing inside one scientific formula because Cells are naturally independent until deterministic merge.
5. Bound worker counts; never default automatically to all logical CPUs.
6. Record/bound nested PyArrow, NumPy/BLAS and other native threading so oversubscription is visible.
7. Do not add a whole-Cell RAM cache or speculative prefetch merely for performance.
8. Do not pickle complete DataFrames merely to gain process parallelism.
9. Display-only downsampling/refinement never becomes the scientific/full-resolution export source.
10. Never modify, reset or discard unrelated branch work.

## Cache, migration and version policy

- No relational migration is implied by performance-only children unless an explicit later spec says otherwise.
- No `CALC_VERSION` bump is implied by a performance-only reimplementation with unchanged scientific meaning.
- Physical raw-layout/index identity remains separate from scientific result identity.
- Per-family result schema versions change only when a persisted response payload shape changes.
- Benchmark instrumentation must stay out of ordinary scientific cache identity/payloads except existing explicitly namespaced profiling.
- Never edit a released migration.

## Verification policy

Each numeric child is one review checkpoint. Use focused checks during implementation and one canonical:

```text
python scripts\preflight.py
```

at final handoff. Do not repeat successful full suites for confidence. Performance comparisons must use identical scientific inputs/settings and report median plus range/tail where meaningful. Browser/manual measurements are required only for user-visible claims; backend-only evidence must be labelled backend-only.

The final Parent 050 review must compare the complete branch against the correct merge base, enumerate every implemented numeric child and measured boundary, confirm required scientific regression evidence, reconcile cache/version/build consequences, record manual checks actually run, and state explicitly whether the branch is ready to merge.

## Project-context maintenance

Planning, promotion or demotion alone does not establish a durable merged architecture. Update durable repository knowledge only when an implemented/reviewed child establishes a cross-cutting invariant future agents need.