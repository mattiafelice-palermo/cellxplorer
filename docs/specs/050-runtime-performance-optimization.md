# Spec 050: runtime performance optimization

Status: **Plan — extensible parent; 050.1-050.7 review-clean; 050.9 active; 050.10-050.11 scheduled**  
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

The former cross-family indexed-detail topic is retained only as planning proto-child [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md).

A prior 050.8 implementation exists at commit `f76acebf6f8dcf9b2d1a214c9a40e4c0911afc89` and on `backup/spec-0508-demotion-20260822`. It is intentionally absent from the active feature branch. Treat it as historical prototype evidence, not current implementation. If P7 is later promoted, re-inspect current code and do not blindly cherry-pick it.

## Current priority: cross-Cell execution

The user's real workload can include roughly **10 large Cells** in one Time/Capacity plot. After 050.6/050.7 removed major unnecessary transforms, the next question is how the necessary remaining independent per-Cell work should execute.

The original broad `050.P3` was split on 2026-08-22 into three narrower proto decisions (`050.P3`, `050.P5`, `050.P6`). By explicit user decision to start this work, those are promoted into three sequential numeric children so each performance contribution is independently attributable and reviewable.

### 050.9 — Current-path profiling and Python concurrency benchmark

File: [`050.9-current-path-profiling-and-python-concurrency-benchmark.md`](050.9-current-path-profiling-and-python-concurrency-benchmark.md)  
Promoted from: **050.P3**

**Active child.** Measure the post-050.7 production path, then compare:

- sequential baseline;
- concurrent per-Cell read/decode only, with 2 and 4 threads;
- whole existing per-Cell Python jobs, with 2 and 4 threads.

It does not install a production executor. Its output is current stage decomposition, isolated threading gains, and the compact measured kernel (if any) worth testing in Rust.

### 050.10 — Rust/Rayon kernel benchmark

File: [`050.10-rust-rayon-kernel-benchmark.md`](050.10-rust-rayon-kernel-benchmark.md)  
Promoted from: **050.P5**  
Depends on: **050.9 review-clean**

Isolate:

- current Python implementation of the measured kernel;
- equivalent sequential Rust;
- the same Rust kernel with bounded Rayon 2-way and 4-way execution.

Measure Python/native transfer, copied bytes, cold/warm initialization, memory and scientific parity. A benchmark-only extension is permitted; production Rust wiring is not.

### 050.11 — Execution-strategy composition and decision

File: [`050.11-execution-strategy-composition-and-decision.md`](050.11-execution-strategy-composition-and-decision.md)  
Promoted from: **050.P6**  
Depends on: **050.9 and 050.10 review-clean**

Combine only mechanisms that proved useful independently, classify whether their gains are additive/sub-additive/neutral/negative, optionally benchmark persistent Python processes only when still justified, and choose one production architecture.

050.11 still does not ship the winner. A later 050.12+ child owns production lifecycle/fallback/packaging/tests.

## Planning-only proto-children

Proto-children are non-implementable and excluded from workflow state until explicitly promoted.

- `050.P2` — progressive Time/Capacity series streaming. The earlier experiment was rolled back; do not revive it implicitly.
- [`050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md`](050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md) — keep the sufficient ~4k/Cell overview and investigate higher local detail on zoom, with an approximately 200 ms Plotly-update target for the representative 10-Cell workload.
- [`050.P7-cross-family-indexed-detail-performance.md`](050.P7-cross-family-indexed-detail-performance.md) — demoted former 050.8 cross-family selective-detail work.

Proto IDs P1/P2/P3/P4/P5/P6/P7 are historically reserved as applicable and must not be reused even after promotion/demotion/removal.

Backend execution, adaptive zoom and Plotly trace-count optimization remain separate ownership boundaries. One profiling session may reuse a workload, but a gain in one boundary must not be attributed to another.

## Locked engineering constraints

1. Preserve scientific calculations, provenance, deterministic order, continuation semantics and export fidelity.
2. Exact persisted result-cache hits remain direct fast paths; do not dispatch workers/native kernels for a hit.
3. Keep SQLite/ORM state in the owning Python/request context. Never share live SQLAlchemy sessions with workers/processes/native code.
4. Prefer cross-Cell parallelism before parallelizing inside one scientific formula because Cells are naturally independent until deterministic merge.
5. Bound worker counts. Initial comparisons use 1/2/4 workers; never default automatically to all logical CPUs.
6. Record/bound nested PyArrow, NumPy/BLAS, Rayon and other native threading so oversubscription is visible.
7. Do not add a whole-Cell RAM cache or speculative prefetch as part of execution benchmarks.
8. Do not pickle complete DataFrames merely to gain process parallelism.
9. A Rust boundary, if tested, is coarse and array-oriented; do not port the analysis engine wholesale.
10. Display-only downsampling never becomes the scientific/full-resolution export source.
11. Never modify, reset or discard unrelated branch work.

## Current anchors for 050.9-050.11

Re-inspect before each child because ownership may move:

```text
backend/app/services/analysis_engine.py
    compute_time_capacity()
    _derivative_curve()
backend/app/services/time_capacity_path.py
backend/app/services/time_capacity_profiling.py
scripts/profile_time_capacity_transforms.py
frontend/src/features/analyses/editor/performance/timeCapacityPerformanceProfile.ts
```

Relevant verification includes `tests/test_analysis_engine.py`, `tests/test_time_capacity_path.py`, `tests/test_time_capacity_profiling.py` and the golden analysis corpus when scientific/service code is touched.

## Cache, migration and version policy

- No relational migration is implied by 050.9-050.11.
- No `CALC_VERSION` bump is implied by a performance-only reimplementation with unchanged scientific meaning.
- 050.2 raw physical-layout/index identity remains separate from scientific result identity.
- 050.6 prepared phase/capacity data remains optional and validated against existing raw/scientific identity.
- Benchmark instrumentation must stay out of ordinary scientific cache identity/payloads except existing explicitly namespaced profiling.
- A later production child must document any new runtime dependency/build/packaging consequence before adopting Rust/native code.
- Never edit a released migration.

## Verification policy

Each numeric child is one review checkpoint. Run focused checks required by that child, then canonical:

```text
python scripts\preflight.py
```

Performance comparisons use identical scientific inputs/settings, at least five repetitions where practical, and report median plus range/tail rather than one favorable run. Structural counters, CPU/core use, RAM, I/O and output parity are required where relevant.

Browser/manual measurements are required only for user-visible/Plotly claims. Backend-only evidence must be labelled backend-only.

The final Parent 050 review must compare the complete branch against the correct merge base, enumerate every implemented numeric child and measured boundary, confirm required scientific regression evidence, reconcile cache/version/build consequences, record manual checks actually run, and state explicitly whether the branch is ready to merge.

## Project-context maintenance

Planning, promotion or demotion of these children does not itself establish a durable merged architecture. Do not update external Project context mirrors for this roadmap change. Update durable repository knowledge only when an implemented/reviewed child establishes a cross-cutting invariant future agents need.
