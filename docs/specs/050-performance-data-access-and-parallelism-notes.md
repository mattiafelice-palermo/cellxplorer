# Spec 050 performance data-access and parallelism notes

Status: **Design / decision note — not an implementable child**  
Parent: [`050-runtime-performance-optimization.md`](050-runtime-performance-optimization.md)  
Branch: `feature/runtime-performance-optimization`

## Purpose

Record the performance conclusions established during Spec 050 and clarify where raw point-level electrochemical data are scientifically required, where only selected executions are required, and where prepared summary data are sufficient.

This note also records the current evidence and decision criteria for any later cross-Cell parallel-execution work. It does **not** authorize a concurrency implementation by itself and does not replace the active numeric child specification.

## 1. Governing distinction: full selected trace vs full experiment

A scientific calculation may require every point in a voltage/current/time trace without requiring every point in the complete source file.

For example, a Time/Capacity request for cycles 1–20 needs the exact ordered raw records for those selected cycles, but it should not materialize cycles 21–500. Spec 050.2/050.3 established the indexed Parquet path that makes this distinction physical: selected cycles are mapped to bounded row groups and filtered exactly after loading.

Accordingly, use these three classes:

1. **Point-level selected trace required** — every relevant V/I/time/capacity point in the selected scientific region matters.
2. **Selected raw executions required** — raw detail is required only for protocol-selected steps/runs/occurrences and their exact context.
3. **Prepared summary data sufficient** — the interactive quantity should not require raw record-sized data after its prepared cache exists.

The first class is the only natural candidate for broad cross-Cell parallel point-level processing. The second class should first be optimized by reading less. The third class should remain on prepared/result caches.

## 2. Analysis family / quantity classification

| Analysis family | Quantity / view | Raw-detail requirement | Required source extent |
| --- | --- | --- | --- |
| Time / Capacity | Voltage vs time | Point-level selected trace | Every record in selected cycles/phases only |
| Time / Capacity | Current vs time | Point-level selected trace | Every record in selected cycles/phases only |
| Time / Capacity | Current density vs time | Point-level selected trace | Same current trace; area scaling is scalar |
| Time / Capacity | C-rate vs time | Point-level selected trace | Same current trace plus nominal capacity |
| Time / Capacity | Voltage vs capacity | Point-level selected trace | Every selected record plus exact capacity coordinate |
| Time / Capacity | Current vs capacity | Point-level selected trace | Every selected record plus exact capacity coordinate |
| Time / Capacity | dQ/dV | Point-level selected trace, derivative-sensitive | Complete ordered V/Q points for selected eligible charge/discharge runs |
| Time / Capacity | dV/dQ | Point-level selected trace, derivative-sensitive | Complete ordered V/Q points for selected eligible charge/discharge runs |
| Steps | Time | Selected executions | Configured step/block executions only |
| Steps | CV charge time | Selected executions | Configured CV executions only |
| Steps | Mean voltage | Selected executions | All voltage points within selected block executions, not the whole experiment |
| Steps | Capacity | Selected executions | Selected block executions only |
| Steps | Block duration | Selected executions | Selected block boundaries/executions only |
| DCIR | Absolute DCIR | Selected executions with context | Configured rest/pulse records and exact adjacency/completeness context only |
| DCIR | DCIR change % | Selected executions with context | Same selected rest/pulse context |
| Chargeability | Current vs time | Selected executions | Matched chargeability measurement execution only |
| Chargeability | C-rate vs time | Selected executions | Same matched execution plus scalar nominal capacity |
| Chargeability | Current/C-rate vs SoC | Selected executions | Matched measurement execution plus reference/preparation execution where current science requires it |
| Chargeability | Current/C-rate vs capacity | Selected executions | Matched measurement execution plus required reference context |
| Rate Capability | Capacity vs C-rate | Selected executions | Protocol-paired charge/discharge executions only |
| Rate Capability | Specific/areal capacity vs C-rate | Selected executions | Same plus scalar mass/area metadata |
| Rate Capability | Retention vs C-rate | Prepared from selected execution outputs | No whole-source trace after points are extracted |
| Rate Capability | Charge/discharge comparison / asymmetry | Prepared from selected execution outputs | No whole-source trace after points are extracted |
| Cycles | Capacity | Prepared summary | Versioned per-cycle cache |
| Cycles | Energy | Prepared summary | Versioned per-cycle cache |
| Cycles | Mean voltage | Prepared summary | Versioned per-cycle cache |
| Cycles | Coulombic efficiency | Prepared summary | Versioned per-cycle cache |
| Cycles | Voltaic efficiency | Prepared summary | Versioned per-cycle cache |
| Cycles | Polarization | Prepared summary | Versioned per-cycle cache |
| Cycles | Capacity retention / SoH | Prepared summary | Versioned per-cycle cache |
| Cycles | Capacity-loss and other cycle-derived scalar quantities | Prepared summary | Versioned per-cycle cache |

### Practical parallelism candidate set

If later profiling justifies cross-Cell execution parallelism, the initial target set should be narrow:

- Time/Capacity Voltage/Current vs Time;
- Time/Capacity Voltage/Current vs Capacity;
- Time/Capacity dQ/dV;
- Time/Capacity dV/dQ;
- especially broad multi-Cell selections and derivative views.

Do not parallelize Steps, DCIR, Chargeability or Rate Capability merely because their current legacy implementation may load too much raw data. Spec 050.8 first removes unnecessary full-source materialization for those families. Their correct optimization principle is **plan the exact executions first, then read only those rows**.

## 3. What the existing profiling established

### 3.1 The original normal Time/Capacity slowdown was not primarily Parquet I/O

The user-supplied installed-app profile reviewed in 050.4 showed that the indexed 050.3 reader was already behaving as designed. For the representative one-Cell source it read:

- 3/20 row groups for cycles 1–20;
- 11/20 for cycles 1–150;
- 20/20 for All.

At the same time, the aggregate `continuous_time_phase_capacity` post-read transform grew materially:

| Scenario | Backend total | `continuous_time_phase_capacity` |
| --- | ---: | ---: |
| 1 Cell, 1–20 | 197 ms | ~53 ms |
| 1 Cell, 1–150 | 370 ms | ~198 ms |
| 1 Cell, All | 635 ms | ~418 ms |
| 5 Cells, All | ~3.00 s | ~1.98 s |
| 6 Cells, All | ~4.38 s | ~2.62 s |

Therefore the dominant normal-view candidate at that point was **post-read transformation**, not raw Parquet access.

050.5 decomposed that transform and identified `_phase_capacity()` as the dominant normal Time/Capacity post-read operation. It also established that compact Voltage/Current + Time requests were calculating phase-capacity/specific/areal vectors that the request did not consume.

### 3.2 050.6 materially reduced normal transform work

050.6 introduced dependency-aware calculation and an optional exact prepared phase/capacity sidecar only where measurement showed it helped.

Representative corrected medians included:

| Scenario | Forced fallback | Current prepared/dependency-aware path |
| --- | ---: | ---: |
| 1 Cell, All, Time axis | 92.0 ms | 90.2 ms |
| 6 Cells, All, Time axis | 533.0 ms | 543.1 ms |
| 1 Cell, All, capacity axis | 202.5 ms | 117.7 ms |
| 6 Cells, All, capacity axis | 1,218.8 ms | 718.6 ms |

For compact Time-axis Voltage/Current, the correct optimization was to skip unused phase-capacity work rather than open another sidecar. For capacity-axis and derivative/full paths, validated prepared phase/capacity reuse remains useful.

These measurements also demonstrate why a new optimization should not be selected from architecture intuition alone: additional I/O can be slower than cheap recomputation.

### 3.3 Derivative computation was a separate measured CPU/postprocessing hotspot

050.5 localized derivative cost. Before 050.7, broad dQ/dV derivative processing was dominated by repeated post-gradient status/CV masking, percentile/span rejection, absolute-discharge handling and output assignment; rolling smoothing was the next-largest bucket.

050.7 then removed repeated control/string-processing work while preserving the numerical algorithm. Same-machine medians improved by roughly 61–64%:

| Scenario | Before | After |
| --- | ---: | ---: |
| dQ/dV 1–3 | 10.8 ms | 4.2 ms |
| dQ/dV 1–20 | 50.5 ms | 19.6 ms |
| dQ/dV All | 434.4 ms | 155.9 ms |
| dV/dQ All | 420.9 ms | 157.7 ms |

The All-cycle golden case still processed 71,190 selected rows, 908 contiguous runs, 454 eligible runs and 405 output/frontend traces. Derivative work is therefore a legitimate point-level computation workload, but its previous dominant repeated overhead has already been substantially reduced.

### 3.4 What is not yet established

The profiling above establishes the historical bottlenecks that motivated 050.6 and 050.7. It does **not** prove that the current post-050.7/post-050.8 branch is now CPU-bound, I/O-bound, serialization-bound, or Plotly-bound for every multi-Cell scenario.

The bottleneck can move after each optimization. Any concurrency child must therefore profile the current production path again rather than reuse the old percentages as a prediction.

## 4. Parallelism terminology and preferred experiment

### 4.1 Persistent thread pool is the preferred first experiment

A persistent `ThreadPoolExecutor` is still ordinary multithreading; the distinction is lifecycle. The recommended design, if profiling justifies it, is to create a small bounded thread pool once and reuse it rather than repeatedly creating/destroying workers for every plot request.

Why benchmark threads first:

- thread startup/dispatch overhead is small;
- Parquet/PyArrow I/O and decoding may release the GIL;
- NumPy operations commonly execute in native code and may release the GIL;
- no large DataFrame serialization/IPC boundary is required;
- each independent Cell can remain an isolated job and the final result can be merged deterministically in canonical Cell/series order.

Threads are **not** guaranteed to accelerate Python-level pandas/string/grouping code that holds the GIL. They can also lose when several workers compete for the same SSD or when PyArrow/NumPy already use native worker threads internally.

### 4.2 Persistent process pool is the second experiment for a proven Python CPU bottleneck

If current profiling shows substantial GIL-bound Python CPU work after selective reads, benchmark a small process-lifetime `ProcessPoolExecutor` rather than spawning a fresh Python interpreter for each Cell/request.

On Windows the `spawn` initialization cost is then paid when the worker pool is created, not once per plotted series. To keep IPC bounded:

- resolve ORM/SQLAlchemy state in the owning process;
- never pass a live SQLAlchemy `Session` to a worker;
- pass small immutable job descriptors such as source hash/parser version/cache identity/requested cycles/settings/scalar metadata;
- let each worker open the exact required Parquet row groups itself;
- return compact scientific results, not entire source DataFrames;
- merge results deterministically in the caller.

A persistent process pool should not be selected merely because a machine has many cores. It consumes more RAM, has IPC/serialization cost, and can amplify storage contention.

### 4.3 Rust is deferred until a specific hot numerical kernel exists

A PyO3/Rayon extension can be appropriate if profiling eventually identifies a compact, stable, CPU-bound numerical kernel whose inputs/outputs are contiguous arrays and whose Python implementation remains materially expensive after algorithmic cleanup.

It is not the default solution for broad analysis performance. It adds a Rust/PyO3/maturin build and Windows packaging surface and does not solve unnecessary Parquet reads, response serialization, Plotly rendering, cache misses or protocol-planning inefficiency.

## 5. Required benchmark before authorizing parallel execution

After 050.8 has removed avoidable full-source reads in the other families, benchmark current broad multi-Cell Time/Capacity workloads with the same scientific output and prepared-cache state under:

1. sequential execution;
2. persistent pool with 2 threads;
3. persistent pool with 4 threads;
4. persistent pool with 2 processes, only if thread scaling is weak and CPU/GIL evidence justifies it;
5. persistent pool with 4 processes under the same condition.

Record at minimum:

- total backend wall time;
- per-Cell job wall/CPU time;
- Parquet row groups and bytes/rows materialized;
- raw-read/decode time;
- scientific transform time;
- derivative time when applicable;
- result assembly/serialization time;
- peak process RAM;
- CPU utilization;
- thread/process dispatch overhead;
- frontend/Plotly time separately when evaluating user-visible latency.

Control native oversubscription explicitly when benchmarking. PyArrow, NumPy/BLAS or other native libraries may already create internal threads; `4 application threads × N native threads` is not a meaningful comparison unless those internal thread counts are recorded or bounded.

The acceptance decision must be based on **wall-time reduction without scientific/output changes and without pathological RAM/I/O growth**, not on CPU utilization alone.

## 6. Current decision

Do **not** assume that multithreading will solve most remaining performance issues.

The evidence to date says:

- selective raw access solved a major unnecessary-data problem;
- the original normal Time/Capacity bottleneck then became post-read transformation;
- 050.6 substantially reduced that transform cost;
- derivative processing was independently expensive and 050.7 substantially reduced it;
- 050.8 applies the more important `read less first` principle to Steps, DCIR, Chargeability and Rate Capability;
- the dominant cost on the current branch must be re-measured before selecting concurrency.

If multi-Cell Time/Capacity still scales approximately linearly after these changes, a **small persistent thread pool is the first concurrency experiment**. A persistent process pool is the fallback for measured GIL-bound CPU work. Rust remains a later kernel-level option, not a general performance architecture.
