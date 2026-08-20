# Spec 050: runtime performance optimization

Status: **Plan — extensible parent; Children 050.1-050.3 authored, implement sequentially**  
Type: **runtime performance / analysis responsiveness**  
Branch: `feature/runtime-performance-optimization`  
Repository baseline: `main` at `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Review document: [`reviews/050-runtime-performance-optimization-review.md`](reviews/050-runtime-performance-optimization-review.md)

## Purpose of this parent

This parent is the long-lived performance workstream for user-visible runtime costs discovered while
using CellXplorer normally. It begins with the Analysis editor because a Time/Capacity range edit
exposed several unnecessary recomputation paths, but it is intentionally **not limited to
Time/Capacity**. Additional children may be added when another concrete slow boundary is measured and
understood.

The parent must therefore be updated as later children are agreed. Do not treat the current child
list as the final scope of Spec 050.

The governing rule is:

> Optimize a verified expensive boundary without changing scientific meaning, provenance,
> determinism, persistence semantics, or export fidelity.

A child is implementable only after its performance problem has been traced to current code and its
target behavior is explicit. Do not make speculative cache, concurrency, or data-layout changes
under this parent merely because they might be faster.

## Initial user-observed problem

On a prepared analysis, Time/Capacity is generally responsive, but changing the displayed cycle
range from a small range such as `1-3` to `1-20` can take on the order of tens of seconds before the
new plot appears. The user expectation is closer to battery-cycler viewers such as Neware BTSDA:
once an experiment has been opened/prepared, moving between a few cycles, broader ranges, neighboring
cycles and the all-cycle view should behave primarily as navigation through already-available data,
not as a complete scientific recomputation of unrelated records.

Inspection of the branch identified two classes of work.

## A. Unnecessary query/cache lifecycle work — Child 050.1

These are bounded issues:

1. a plot-setting edit marks the analysis dirty; after the 1.8 s autosave, the editor persists the
   spec and then invalidates the analysis scientific-query family, allowing already-running or
   already-valid scientific requests to be refreshed even though persistence itself did not change
   source data;
2. the live Time/Capacity React Query does not pass React Query's abort signal into the existing
   abort-capable `post()` helper;
3. a Time/Capacity query-key change no longer retains a scientifically compatible previous result
   while the new result is prepared, so latency becomes a blank/loading transition instead of an
   in-place update;
4. the backend analysis result key fingerprints the entire `spec.computation` object, so changing a
   configuration owned by one analysis family can invalidate another family's cached result even
   when the latter computation does not read that field.

These are lifecycle/cache-identity defects. They can be fixed without redesigning Time/Capacity raw
storage or scientific calculations.

## B. Structural Time/Capacity raw-data access cost — Children 050.2 and 050.3

### Verified current request path

On a Time/Capacity cache miss, `analysis_engine.compute_time_capacity()` currently calls
`stitch.stitch_raw()` for each selected Cell. `stitch_raw()` loads each contributing raw Parquet
cache through `cache.load_raw()`, which materializes the complete Parquet source into pandas.

The current order is broadly:

```text
resolve sources
-> read every raw source in full
-> discover source-local cycle labels from all raw rows
-> copy/map every source to dense global cycles
-> concatenate complete source chain
-> scan complete data for voltage availability/source descriptors
-> only then apply requested cycle range
-> scientific transforms
-> downsample to display point budget
-> serialize
```

Therefore a request for one/few cycles still pays approximately the I/O, pandas materialization,
copy/mapping and concatenation cost of the complete experiment.

### Investigation result: current Parquet is not a cycle-addressable contract

`cache._write_atomic()` currently writes:

```python
df.to_parquet(tmp, index=False)
```

with no explicit row-group organization or source-cycle index. `load_raw_columns()` can project
columns but cannot promise that irrelevant rows/cycles are physically skipped. The implementation
must inspect actual row-group metadata under the pinned PyArrow version rather than assume predicate
pushdown alone fixes the problem.

Representative repository code already discusses raw sources on the order of hundreds of thousands
of rows, so repeatedly materializing whole raw DataFrames is the wrong architecture for interactive
range navigation even if individual vectorized calculations are optimized.

### Investigation result: dense global cycle mapping does not intrinsically require raw records

The continuation contract established by Spec 034.1 is compact:

```text
ordered source chain
+ exact observed source-local cycle labels
-> dense global cycle mapping
```

For example:

```text
source A labels [1, 2, 4] -> global [1, 2, 3]
source B labels [7, 9]    -> global [4, 5]
```

No missing local label is invented. A missing middle source fails closed. Those rules need the exact
observed cycle-label lists and ordered source identities; they do not inherently require voltage,
current or every other raw record merely to establish global numbering.

### Investigation result: full-source capability facts can be prepared once

Spec 040.4 deliberately makes auxiliary voltage-channel availability full-source and data-driven so
options do not flicker as cycle filters change. The current implementation scans complete stitched
raw frames to establish those facts.

That does not require a full scan on every request. While a complete validated source frame is
already present at cache-build/conversion time, a tiny source index can persist bounded facts such
as:

- exact observed source-local cycles;
- cycle-to-raw-row-group membership;
- full-source finite availability for primary/working/counter voltage columns;
- bounded timestamp start/end facts used by source descriptors.

Header metadata remains the owner of voltage role/reference meaning.

### Investigation result: do not start with a whole-cell RAM cache

A large source already represents tens of MiB of dense numeric arrays before pandas/string/index
and temporary copy overhead. Current stitching copies source frames and concatenates them, so a
multi-cell whole-raw resident cache can easily multiply memory use.

The structural solution is therefore:

```text
cycle-addressable persistent raw cache
-> tiny source index
-> selective detail reads
-> optional bounded RAM acceleration only if later measurements justify it
```

not:

```text
load every selected Cell's complete raw data into RAM and keep it there
```

### Investigation result: separate storage and scientific-consumer changes

The work is split deliberately:

- **050.2** owns persistent raw physical layout/index, safe existing-cache conversion, selective
  source-local cycle reading, cache maintenance and storage-level profiling/parity;
- **050.3** owns Time/Capacity global stitch planning, selective source reads, scientific parity,
  provenance, full-source capability use, exports and end-to-end request profiling.

A third Time/Capacity child is **reserved, not authored**. 050.4 is created only if post-050.3
measurements prove a distinct remaining problem such as all-cycle detail cost, repeated neighboring
I/O, serialization, or frontend Plotly rendering.

## Target interaction model

The end-state direction for Time/Capacity is:

| Interaction | Intended work |
|---|---|
| Plotly pan/zoom within already rendered data | frontend only |
| Move from one narrow cycle range to another | read relevant prepared raw detail only |
| Select a later single cycle | read only its relevant source/detail groups |
| Cross a continuation boundary | read detail from the contributing sources only |
| Change style/legend | frontend only |
| Change derivative settings | bounded calculation on selected complete cycles |
| Full-resolution selected-range export | exact selected raw detail, no display approximation |
| Full-resolution all-cycle export | all exact raw detail; expensive work is acceptable |
| All-cycle interactive overview | evaluate after 050.3; 050.4 only if measurements justify it |

The key product rule is:

> Selecting cycles should behave like selecting a view into prepared scientific records, not like
> rereading and recomputing the complete experiment first.

## Current source anchors

### Frontend analysis lifecycle

```text
frontend/src/features/analyses/editor/AnalysisEditor.tsx
    updateSpec()
    autosaveSignature
    autosave effect / PUT /api/analyses/{id}

frontend/src/features/analyses/workspace/analysisQueryCache.ts
    ANALYSIS_QUERY_ROOTS
    invalidateAnalysisQueries()
    refreshAnalysisQueries()

frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx
    TimeCapacityPlotCardView
    dataSignature
    useQuery(["time-capacity", ...])

frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx
    SavedTimeCapacityPreview

frontend/src/api.ts
    request()
    post(..., { signal }) support
```

### Backend analysis/cache boundary

```text
backend/app/services/cache.py
    _write_atomic()
    raw_path()
    build()
    build_write_behind()
    load_raw()
    load_raw_columns()

backend/app/services/cache_maintenance.py
backend/app/services/scientific_preparation.py
backend/app/services/scanner.py

backend/app/services/stitch.py
    CachedSourceRef
    observed_local_cycles()
    build_dense_cycle_map()
    stitch_raw()

backend/app/services/analysis_engine.py
    time_capacity_settings()
    _continuous_time()
    _phase_from_raw()
    _phase_capacity()
    _derivative_curve()
    _time_capacity_display_x()
    _protocol_row_mask()
    source_descriptors()
    compute_time_capacity()

backend/app/services/analysis_cache.py
    _scientific_spec()
    result_key()
    time_capacity_data_signature()
    ANALYSIS_CACHE_VERSION
    RESULT_SCHEMA_VERSIONS
```

### Existing focused coverage

```text
frontend/tests/analysisQueryCache.test.ts
tests/test_analysis_cache.py
tests/test_analysis_engine.py
tests/test_calc_and_cache.py
tests/test_stitch.py
tests/test_cache_maintenance.py
tests/test_scanner.py
tests/test_golden_analysis.py
```

## Parent-level locked decisions

1. **Scientific outputs are invariant unless a later child explicitly states otherwise.** Runtime
   optimization alone never justifies changing formulas, cycle mapping, protocol matching,
   tolerances, units, source provenance, hidden-data semantics, or export contents.
2. **Prepared source Parquet remains canonical regenerable cache storage.** Do not move scientific
   data into SQLite to make plotting faster.
3. **One canonical raw dataset.** Do not permanently duplicate every full raw source into a second
   Time/Capacity-specific cache. Physical row grouping and tiny sidecars are allowed.
4. **Cycle-addressable raw storage is a physical cache concern, not a scientific-version concern.**
   Introduce a raw-layout version separate from parser identity, `CANONICAL_RAW_VERSION`,
   `CALC_VERSION`, and analysis result schema versions.
5. **Exact observed local labels remain the source of global cycle mapping.** Never infer missing
   cycles or use `max-min+1` offsets.
6. **Missing middle sources still fail closed.** An absent raw cache is scientific incompleteness;
   an absent new layout index beside a valid raw cache is only a performance fallback condition.
7. **Legacy raw caches remain valid.** New layout preparation must be safely convertible from
   existing cache bytes and must never require request-path reparsing/rewrite.
8. **Offline scientific caches receive stricter safety.** They may be the only readable copy; never
   destroy them during conversion or cleanup races.
9. **Full-source data-derived capabilities may be indexed once.** Auxiliary voltage finite-data
   availability must remain truthful and range-independent.
10. **Interactive detail reads load complete selected cycles before scientific transforms.** Never
    downsample or truncate raw rows before phase/capacity/derivative/protocol logic.
11. **Full scientific export remains exact.** Display acceleration cannot silently approximate
    CSV/XLSX/full-resolution outputs.
12. **Do not make whole-cell RAM residency a requirement.** A bounded memory LRU/prefetch is a later
    optimization only if profiling shows persistent disk/detail access remains a bottleneck.
13. **List endpoints remain relational and bounded.** No child may move Parquet/source-file reads or
    scientific-stack imports onto Cell/Analysis database list paths.
14. **Expensive parsing/checksum/cache rebuild/conversion work remains off UI/request critical
    paths** except where an explicit scientific compute genuinely requires an absent canonical
    cache.
15. **Optimize actual dependency scope.** Persisting editor state must not invalidate source-derived
    data by default, and a cache key must not depend on unrelated configuration merely because it is
    convenient to serialize the whole spec.
16. **Do not trade correctness for stale visuals.** Previous-result retention is allowed only when
    scientifically compatible with the pending render.
17. **Cancellation is layered.** Browser fetch abort does not prove synchronous backend pandas work
    stopped; server cooperative cancellation is separate unless a child explicitly includes it.
18. **Cache-key changes are versioned/documented according to existing conventions.**
    `CALC_VERSION` changes only when scientific meaning changes; response-schema versions change
    only when payload shape/meaning changes.
19. **Profile during implementation to choose physical parameters.** The architecture is locked;
    exact row-group target, index encoding and need for a later overview/LRU are evidence-driven.
20. **Measure before and after at the boundary being changed.** Prefer deterministic row-group/
    row/column/request counts plus profiler timings over subjective UI timing alone.
21. **One child, one review checkpoint.** Do not begin the next child until the active child is
    implementation-complete and review-clean.
22. **The parent is intentionally extensible.** A clean 050.1-050.3 does not automatically close
    Parent 050; future unrelated measured runtime children may still be added.
23. Never modify, reset, or discard unrelated branch work.

## Child sequence

### 050.1 — Analysis query and cache lifecycle

File: [`050.1-analysis-query-and-cache-lifecycle.md`](050.1-analysis-query-and-cache-lifecycle.md)

Implement the four bounded optimizations already verified in current code:

- decouple ordinary Analysis autosave from scientific-query invalidation;
- retain a previous Time/Capacity result only across scientifically compatible request changes;
- propagate React Query cancellation to Time/Capacity HTTP requests;
- make backend analysis result identities depend on the active family rather than unrelated
  computation-family settings.

This child must not redesign raw Time/Capacity reads.

### 050.2 — Cycle-addressable raw cache and source index

File: [`050.2-cycle-addressable-raw-cache-and-source-index.md`](050.2-cycle-addressable-raw-cache-and-source-index.md)

Storage-layer child. It must:

- profile the current raw Parquet physical layout and candidate bounded row-group strategies;
- introduce an explicit raw physical-layout/index version separate from scientific versions;
- deliberately write representative long raw caches in bounded row groups while preserving every
  canonical row/value/order semantic;
- publish a tiny exact source-cycle -> row-group index plus full-source voltage/timestamp facts;
- expose a selective source-local cycle + column reader;
- safely convert valid legacy raw caches from cache bytes alone;
- preserve offline-source protection and existing scientific budget/cleanup semantics;
- prove optimized versus legacy raw scientific parity;
- leave `compute_time_capacity()` on its current path until 050.3.

Exact row-group parameters are chosen from implementation profiling, not pre-guessed here.

### 050.3 — Indexed Time/Capacity data path

File: [`050.3-indexed-time-capacity-data-path.md`](050.3-indexed-time-capacity-data-path.md)

Scientific-consumer child. It must:

- build dense global cycle/source plans from 050.2 compact indexes before raw loading;
- map requested global cycles to exact source-local cycles;
- read only contributing source row groups and required columns;
- attach the same global/source provenance to selected complete-cycle rows;
- reuse existing continuous-time, phase/capacity, derivative, protocol-mask and downsample logic;
- obtain full-source voltage availability/source descriptor facts from prepared metadata rather
  than scanning complete raw frames;
- preserve legacy full-read fallback for valid unprepared caches;
- preserve compact plot and full-resolution export semantics;
- prove indexed versus legacy Time/Capacity parity and record end-to-end profiling;
- make an explicit evidence-backed decision whether 050.4 is needed.

### 050.4 — Interactive overview / working-set acceleration — **reserved conditionally; not authored**

Do not create or implement this child merely because the number is reserved.

Author it only after 050.3 profiling identifies a distinct remaining bottleneck. Candidate scopes
may include:

- a precomputed all-cycle/multiresolution overview if full-range detail remains dominant;
- a small bounded recent-cycle backend LRU or neighbor prefetch if repeated nearby selective reads
  remain I/O-bound;
- payload/serialization/frontend Plotly optimization if backend detail access is already fast and
  the browser becomes dominant.

The measured bottleneck must determine the scope. Do not combine all three by default.

If 050.3 achieves the desired interaction without another layer, record 050.4 as **not needed** and
do not create a placeholder implementation spec.

### 050.5+ — additional measured runtime issues

Future children may address other slow application boundaries discovered during normal use or
profiling. Before adding one:

1. reproduce/measure the symptom;
2. trace the current code path;
3. identify the dominant unnecessary/expensive work;
4. decide whether it belongs to this parent rather than an unrelated feature;
5. update this parent and add a self-contained child spec.

## Parent-level cache, migration, and version policy

- No relational database migration is implied by this parent.
- No `CALC_VERSION` bump is implied by performance-only work.
- Physical raw-layout/index versioning is separate from parser/canonical/scientific calculation
  identity and must not by itself invalidate analysis result keys.
- A child that changes analysis cache-key computation must follow the explicit generation/version
  convention in `backend/app/services/analysis_cache.py` and test warm/cold identity behavior.
- A child that changes only data access while returning identical scientific results should not bump
  `CALC_VERSION`; it must instead prove result parity.
- A child that changes persisted analysis-result payload shape must update the corresponding
  per-kind result schema version.
- Do not edit released migrations.

## Parent verification policy

Each child defines its focused tests and measurements. Before each implementer handoff, follow the
repository workflow:

```text
focused tests/checks required by the active child
-> other focused compile/type/diff checks as relevant
-> python scripts\preflight.py
-> handoff to reviewer
```

Do not duplicate the full backend/frontend suites immediately before canonical preflight.

For 050.2 and 050.3, performance evidence must include structural counters (row groups/rows/columns
read) as well as timings. A fast one-off warm run is not sufficient proof that the architectural
cause was removed.

The final Parent 050 review, when the user declares the performance workstream ready to close, must:

- compare the complete branch against its correct `main` merge base;
- enumerate every authored child and its measured/verified performance boundary;
- confirm scientific golden/regression outputs required by affected children remain unchanged;
- confirm cache/migration/version consequences are coherent cumulatively;
- record whether reserved 050.4 was implemented, judged unnecessary, or remains deferred;
- record which browser/manual performance checks were actually run;
- state explicitly whether the branch is ready to merge.

## Project-context maintenance

Planning these children does not itself change a durable merged architecture or workflow fact. Do
not rewrite uploaded Project context merely because this plan exists.

When implemented children establish cycle-addressable raw cache layout or indexed Time/Capacity as a
durable cross-cutting invariant, update the relevant repository knowledge document and assess the
Project context mirrors under `CELLXPLORER_CONTEXT_MAINTENANCE.md` using the live repository as
source of truth.
