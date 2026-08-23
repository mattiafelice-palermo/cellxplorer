# Spec 050 supporting asset: performance lessons for cross-family optimization

Status: **Supporting asset — not an implementable child spec**  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)  
Branch: `feature/runtime-performance-optimization`  
Purpose: provide the next cross-family performance child with the practical lessons established by 050.1–050.15. This asset does not itself authorize code changes.

## Why this exists

The withdrawn 050.8 / current `050.P7` cross-family design was written before the later Time/Capacity work established several important performance facts. Do **not** restore or cherry-pick the old 050.8 implementation as the starting architecture. Re-inspect the current production paths for Cycles, Steps, DCIR, Chargeability and Rate Capability, measure them, then apply only the lessons below that fit each family.

The central lesson from Spec 050 is:

> Optimize the real production boundary in order: remove unnecessary work, reduce the amount of data moved, reuse authoritative request-local state, and only then parallelize independent work. Microbenchmarks do not decide architecture; complete-route measurements and scientific parity do.

## Lessons that proved durable

### 1. Exact result-cache hits are the first performance path to protect

A previously computed analysis should reopen without raw reads, scientific recomputation, worker dispatch or source-file access. The Time/Capacity direct stored-body path became extremely cheap once it stopped reparsing/re-encoding large cached payloads.

For another family, first measure its exact persisted cache-hit route. If cache-hit overhead is material, optimize that path before accelerating cache misses. Do not introduce workers or selective raw access on an exact hit.

### 2. Resolve relational/request state once in the owner

Repeated ORM/source resolution can become visible at multi-Cell scale. The successful Time/Capacity architecture resolves Cell selection, source chains, parser identities, scalar metadata and cache/stitch planning in the owning request context, then reuses immutable facts.

For cross-family work:

- keep SQLite/SQLAlchemy in the owner process;
- preload existing relationships rather than walking them N+1;
- derive reusable immutable per-Cell/per-source descriptors once per request;
- do not create a new persistent RAM metadata cache merely to avoid request-local work.

### 3. Read only the rows and columns the consumer actually needs

Cycle-addressable Parquet row groups and request-specific column projection produced large gains because the engine stopped materializing irrelevant raw data. The same principle may apply to protocol-derived families, but only when their scientific context can be proven from a reduced read.

For Steps/DCIR/Chargeability/Rate Capability, selective access is a candidate, not an assumption. Measure whether the current family still reads full raw sources on cache misses. If it does, determine the smallest exact logical rows/columns required by that family's existing algorithm.

A reduced path must fail closed to the existing complete path whenever adjacency, execution completeness, reference capacity, continuation order, protocol context or other required semantics cannot be proven from bounded metadata.

### 4. Eliminate work from the consumer contract before optimizing the implementation

The largest Time/Capacity gains came from proving that some transforms or arrays were not consumed for a given display mode, then not computing/materializing them at all. Optimizing an unnecessary calculation is inferior to removing it.

For every family, identify each expensive stage and its actual downstream consumer. Examples to inspect include:

- protocol reconstruction repeated per source/series;
- raw sorting/filtering repeated after a planner already guarantees order/selection;
- quantities calculated even when the selected plot does not use them;
- repeated conversion of NumPy/pandas values into Python objects that are later discarded;
- provenance fields expanded per point although a compact lookup table would preserve the same meaning.

Any omission must be narrow and explicitly guarded by the consumer contract. Full export and alternate analysis modes remain authoritative.

### 5. Compact data before IPC/serialization, not after

050.15 showed that repeated per-point provenance strings were expensive and unnecessary. The compact `sources[] + source_index[]` representation reduced broad ordinary Time response size by roughly 72–74% while preserving provenance meaning.

If another family returns repeated filenames, hashes, positions, labels or other large per-point/per-row strings, test dictionary/table-plus-index representations. Build the compact shape directly; do not first construct the expanded payload and then compress it.

Measure complete-route impact and response bytes. A smaller payload is useful only if the consumer remains simple and scientific/export semantics are unchanged.

### 6. Parallelize only naturally independent work, with persistent bounded workers

Whole-Cell Python work was the successful concurrency boundary for broad Time/Capacity. Persistent processes avoided the GIL and ultimately cut the representative multi-Cell production route dramatically. Threads and several finer-grained concurrency experiments did not provide comparable complete-route gains.

If a protocol-derived family has several independent Cells/series and profiling shows substantial CPU-bound per-Cell work after serial simplification, reuse the existing worker architecture or its patterns rather than inventing a second executor.

Rules:

- persistent bounded processes, not one process spawn per request;
- immutable descriptors/results across IPC, never live ORM objects or full owner DataFrames;
- deterministic parent merge in requested series/Cell order;
- serial fallback for small workloads, pool warmup/failure and unsupported cases;
- exact cache hits bypass workers;
- measure RSS and IPC bytes;
- do not assume more workers are better: 6/8 workers did not justify replacing the four-worker production bound for Time/Capacity.

### 7. A microbenchmark win is not a production win

Several 050.13 candidates looked attractive in isolation and became neutral or slower when integrated. Dense cycle mapping was the clearest example: an apparent microbenchmark improvement reversed into a production-path regression.

Therefore every candidate must have two labels:

- **isolated boundary effect**;
- **complete-route effect**.

Promotion requires a stable complete-route gain. Do not compose candidates merely because their isolated percentages appear additive; measure the actual composed stack.

### 8. Do not make a candidate pay the cost it is supposed to remove

Early ablations produced misleading results by re-sorting data to prove that sorting could be skipped, scanning complete columns to prove filtering could be skipped, or constructing an expanded payload before deleting/compacting it.

When testing an optimization, model its intended production invariant. If a planner can authoritatively say `already_sorted` or `exact_selection`, pass that invariant forward; do not rediscover it with an equally expensive verification step on every request.

### 9. Native code is not automatically faster

Rust/Rayon was useful only for a narrow derivative numerical kernel in benchmark work and did not justify production adoption for ordinary Time/Capacity. NumPy/PyArrow already execute many operations in optimized native code; replacing their coarse array operations with a custom native implementation can add boundary/IPC/setup cost without reducing the dominant Python work.

For the cross-family child:

- do not start with Rust/PyO3/Rayon;
- first remove unnecessary Python/pandas work and measure the remaining dominant stage;
- test native code only if a coarse, stable numerical boundary remains genuinely dominant after those changes.

### 10. Display-density optimization is presentation-only and family-specific

Adaptive density and adaptive zoom made sense for Time because very large raw traces were reduced for interactive display while full export remained exact. Do not impose the same mechanism on Cycles/Steps/DCIR/Chargeability/Rate Capability unless a family actually returns enough points for display density to be material.

If display reduction is used:

- it must never become the scientific/full-export source;
- preserve extrema/events relevant to the plot;
- measure visible quality as well as timing;
- zoom refinement must remain bounded/ephemeral and stale-safe.

### 11. Synthetic fixtures accelerate iteration; real data decides promotion

S25 was useful because it preserved the same execution regime while making repeated experiments fast. But production architecture decisions were validated against the real saved `Performance analysis` workloads.

For other families, build the smallest deterministic fixture that still exercises the actual expensive path. Use it for rapid ablation, then promote only after a representative real or golden corpus confirms the gain and scientific parity.

### 12. Keep performance verification fast and single-pass

Repeated full suites wasted substantial development time without adding useful evidence. The accepted workflow is:

- focused tests for the changed boundary;
- short representative benchmark, normally three warm repetitions during iteration;
- do not rerun a passing command for confidence;
- rerun only after a failure and record why;
- one canonical `python scripts\preflight.py` at final handoff;
- broad real matrices only when required for a promotion/final decision.

Aim for focused benchmark/test commands below about one minute where practical.

## Approaches that should not be revived by default

The following were measured or explored during Spec 050 and should be considered rejected defaults unless new profiling shows a materially different boundary:

- whole-Cell Python threads for CPU-heavy work;
- read-thread concurrency as a substitute for removing dominant transform/projection work;
- dense cycle-mapping rewrites merely because they benchmark faster in isolation;
- redundant sort/filter-elimination schemes that need full sort/scans to validate themselves on every request;
- alternate NumPy gather/downsample variants without complete-route gain;
- speculative cache write-behind where cache persistence is no longer material;
- a new JSON serializer when serialization is only a few milliseconds;
- production Rust/Rayon for ordinary display preparation;
- unbounded worker counts / automatic all-CPU execution;
- whole-Cell RAM caches or speculative neighbor prefetch without measured need;
- restoring the old 050.8 shared `analysis_detail` implementation wholesale.

## How to approach each remaining analysis family

### Cycles

Treat Cycles primarily as the cache/prepared-data control. Measure exact-hit and cache-miss route cost before touching raw access. Do not force a raw-detail architecture onto Cycles for symmetry.

### Steps

Likely opportunity: current cache-miss computation still materializes stitched raw data before extracting selected protocol blocks. Measure whether protocol targets can authoritatively identify required step executions before raw loading, then test bounded exact detail reads. Preserve block occurrence numbering, source/global cycle ordering, timestamps, quantities and protocol semantics exactly.

### DCIR

Potentially selective, but scientifically sensitive. The reduced read must include every row needed for rest/pulse adjacency, reference, duration and completeness checks. If exact context cannot be proven cheaply, retain the current full raw path. Do not optimize by weakening pulse validation.

### Chargeability

Potential opportunity: semantic protocol matching often identifies measurement/preparation/reference step identities before curve extraction. Any reduced path must preserve reference-capacity derivation, execution grouping, SoC/current normalization, candidate fingerprints and provenance. Profile protocol matching separately from raw extraction so the wrong stage is not optimized.

### Rate Capability

Potential opportunity: protocol reconstruction may identify charge/discharge step pairs before raw detail extraction. Preserve current sweep recognition, CC/CV pairing/completion rules, occurrence grouping and capacity semantics. As with DCIR, fall back to the complete path whenever selective metadata cannot prove the full required context.

## Required decision sequence for the next cross-family child

For each family independently:

1. measure exact persisted cache-hit latency and verify what work still occurs;
2. measure a representative cache miss and decompose owner/ORM, raw read, protocol planning, scientific extraction, payload/serialization and residual time;
3. remove clearly unnecessary/repeated work first;
4. test selective rows/columns only if raw materialization is still material and the family can prove exact required context;
5. test compact payload/provenance only if response construction/bytes are material;
6. test persistent cross-Cell processes only if substantial independent CPU work remains after steps 3–5;
7. measure the composed complete route;
8. keep the existing path when a candidate does not provide a stable meaningful gain.

Do not require one architecture to win for every family. It is acceptable for Steps to benefit from selective raw access while DCIR remains on the complete raw path, or for one family to use process execution while another stays serial.

## Non-negotiable invariants

Performance work must preserve:

- exact scientific results and golden/corpus digests where applicable;
- parser and `CALC_VERSION` semantics unless scientific meaning actually changes;
- source provenance and deterministic order;
- continuation/global/local cycle mapping;
- protocol detection/matching semantics and fail-closed safety;
- exact full-resolution exports and saved-plot scientific identity;
- direct cache-hit behavior;
- local-first SQLite/Parquet architecture;
- no source-file parsing/checksum/cache rebuilding on interactive request paths;
- no unrelated refactor of the Analysis editor or family implementations.

The next numeric child should cite this asset and the current family-specific knowledge documents, but the current code and measurements remain authoritative.