# Spec 050: runtime performance optimization

Status: **Plan — extensible parent; Children 050.1-050.7 review-clean; 050.8 active**
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

### Investigation result: separate storage, scientific-consumer and end-to-end profiling work

The work is split deliberately:

- **050.2** owns persistent raw physical layout/index, safe existing-cache conversion, selective
  source-local cycle reading, cache maintenance and storage-level profiling/parity;
- **050.3** owns Time/Capacity global stitch planning, selective source reads, scientific parity,
  provenance, full-source capability use, exports and backend request profiling;
- **050.4** owns end-to-end profiling of the real interactive Time/Capacity path and the evidence-
  backed decision about whether another optimization child is needed;
- **050.5** owns the follow-up transform/dependency profiling that localizes the remaining backend
  cost without implementing the optimization;
- **050.6** owns the first measured post-profile optimization: skip demonstrably unused compact-view
  transforms and prepare/reuse exact source-local phase/capacity derived rows.

050.3 demonstrated that narrow indexed requests no longer materialize complete raw sources, but its
profiler intentionally exercised a full-detail backend contract and recorded `frontend_profile: not
run`. During Parent 050 final review on 2026-08-21, the user therefore reopened the 050.4 decision:
backend structural improvement alone is not sufficient evidence that the original `1-3 -> 1-20`
user interaction is solved. 050.4 measured the live compact/standard request plus frontend
trace/layout and Plotly completion before any additional optimization was selected.

The user then supplied a 35-interaction installed-app profile. It showed broad/multi-Cell normal
Time/Capacity misses dominated by backend work while exact React Query memory revisits were already
roughly 20-50 ms. Review-clean 050.5 localized the normal backend hotspot to repeated exact
`_phase_capacity()` reconstruction and proved that compact Time-axis Voltage/Current requests also
compute capacity-derived arrays they do not consume. 050.6 therefore implements exact reuse/skip
at that measured boundary before any overview, extra RAM cache or derivative-specific redesign is
considered.

## Target interaction model

The end-state direction for Time/Capacity is:

| Interaction | Intended work |
|---|---|
| Plotly pan/zoom within already rendered data | frontend only |
| Move from one narrow cycle range to another | read relevant prepared raw detail plus exact reusable derived detail only |
| Select a later single cycle | read only its relevant source/detail groups |
| Cross a continuation boundary | read detail from the contributing sources only |
| Change style/legend | frontend only |
| Change derivative settings | bounded calculation on selected complete cycles; derivative-specific optimization remains separate |
| Full-resolution selected-range export | exact selected raw/derived detail, no display approximation |
| Full-resolution all-cycle export | all exact detail; expensive work is acceptable |
| All-cycle interactive overview | first use exact prepared derived rows; consider an approximate overview only if later end-to-end evidence still justifies it |

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

backend/app/services/time_capacity_path.py
    build_time_capacity_stitch_plan()
    requested_global_cycles()
    load_indexed_time_capacity_raw()

backend/app/services/time_capacity_profiling.py

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
tests/test_raw_cache_layout.py
tests/test_time_capacity_path.py
tests/test_time_capacity_profiling.py
```

## Parent-level locked decisions

1. **Scientific outputs are invariant unless a later child explicitly states otherwise.** Runtime
   optimization alone never justifies changing formulas, cycle mapping, protocol matching,
   tolerances, units, source provenance, hidden-data semantics, or export contents.
2. **Prepared source Parquet remains canonical regenerable cache storage.** Do not move scientific
   data into SQLite to make plotting faster.
3. **One canonical raw dataset.** Do not permanently duplicate every full raw source into a second
   Time/Capacity-specific cache. Physical row grouping and small regenerable derived sidecars are
   allowed when they store only values actually derived from canonical raw rows.
4. **Cycle-addressable raw storage is a physical cache concern, not a scientific-version concern.**
   Introduce a raw-layout version separate from parser identity, `CANONICAL_RAW_VERSION`,
   `CALC_VERSION`, and analysis result schema versions.
5. **Exact observed local labels remain the source of global cycle mapping.** Never infer missing
   cycles or use `max-min+1` offsets.
6. **Missing middle sources still fail closed.** An absent raw cache is scientific incompleteness;
   an absent performance layout/derived artifact beside a valid raw cache is only a performance
   fallback condition.
7. **Legacy raw caches remain valid.** New layout/prepared-data work must be safely convertible from
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
22. **The parent is intentionally extensible.** A clean earlier child set does not automatically
    require further optimization; later measured runtime children are added only when evidence
    justifies them.
23. **End-to-end claims require end-to-end evidence.** Backend structural profiling may prove an
    architectural cost was removed, but it must not be used alone to claim the user-visible
    interaction is solved when frontend/Plotly time was not measured.
24. **Measurement-only children do not smuggle optimizations.** 050.4/050.5 gathered evidence first;
    their measured follow-ups are separately authored numeric children.
25. **Prepared derived artifacts are regenerable optimization state, not a new raw/source truth.**
    Their identity must include the relevant parser/scientific/representation boundary and validate
    against the canonical raw rows they align to; absence or corruption means exact fallback.
26. **Derivative-specific optimization remains separate from normal prepared-row optimization.**
    050.6 may feed the unchanged derivative algorithm exact prepared phase/capacity, but it must not
    change derivative postprocessing or Plotly trace construction.
27. Never modify, reset, or discard unrelated branch work.

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
- prove indexed versus legacy Time/Capacity parity and record backend profiling;
- hand the unresolved end-to-end interaction question to 050.4.

### 050.4 — End-to-end Time/Capacity profiling and optimization decision gate

File: [`050.4-end-to-end-time-capacity-profiling-and-decision-gate.md`](050.4-end-to-end-time-capacity-profiling-and-decision-gate.md)

Profiling/decision child. It must:

- instrument the real live Time/Capacity interaction contract (`compact=true`, standard precision,
  normal display point budget) without altering ordinary behavior;
- bind timing stages to the current request identity so placeholders, cancelled/superseded requests
  and late Plotly callbacks cannot be misattributed;
- distinguish persisted analysis-result cache hit/miss and indexed/legacy raw access state;
- separate backend/HTTP, frontend result-to-plot preparation, Plotly completion and total
  interaction time;
- keep profiling opt-in, bounded and local with no external telemetry or persistent database;
- profile the representative range/neighbor/broad/all-cycle/cache-hit/multi-cell matrix where the
  runnable environment permits;
- preserve 050.1-050.3 scientific/cache/export behavior and all version identities;
- end with an explicit evidence-backed decision: no further optimization, or a separately authored
  later child scoped to the measured dominant cost.

If neither implementation nor review environment can run the required desktop/browser matrix,
050.4 may become implementation/review-clean after the instrumentation is verified, but Parent 050
must remain blocked in final review until the user supplies the local exported profile needed to
make the optimization decision. Do not replace missing end-to-end evidence with backend-only timing.

### 050.5 — Backend transform profiling and optimization design

File: [`050.5-backend-transform-profiling-and-optimization-design.md`](050.5-backend-transform-profiling-and-optimization-design.md)

Review-clean profiling/design child. It:

- decomposes the remaining normal Time/Capacity transform hotspot;
- proves `_phase_capacity()` dominates broad and multi-Cell normal misses;
- audits actual consumers and identifies capacity-derived work that compact Time-axis normal views
  do not consume;
- verifies true persisted result-cache hits are already fast and the earlier browser HTTP/backend
  gap is not a systematic route-side second;
- localizes dQ/dV backend cost to post-gradient per-segment processing and separately explains the
  hundreds-of-traces frontend scaling;
- recommends exact prepared derived rows for normal Time/Capacity before any overview, and keeps
  derivative-specific optimization independent.

No production optimization is implemented by 050.5.

### 050.6 — Prepared Time/Capacity derived rows

File: [`050.6-prepared-time-capacity-derived-rows.md`](050.6-prepared-time-capacity-derived-rows.md)

Measured optimization child. It must:

- resolve an explicit transform-needs plan so compact Time-axis Voltage/Current skips unconsumed
  phase-capacity/specific/areal work and compact non-Time views skip unconsumed continuous-time work;
- prepare a small versioned source-local artifact containing exact phase and absolute reconstructed
  phase-capacity values plus minimal alignment metadata, never another raw-data copy;
- derive/publish it off the request critical path from already validated canonical raw bytes and
  prepare existing caches through the current scientific-preparation worker;
- selectively read/validate exact prepared values for requested cycles and immediately fall back to
  the current exact calculation when the artifact is missing, stale, corrupt or busy;
- preserve full export, continuation, protocol, provenance and derivative inputs exactly;
- prove prepared-vs-fallback parity and a material same-machine broad-request improvement before
  review handoff.

Derivative postprocessing/Plotly optimization is explicitly out of scope for 050.6.

### 050.7 — derivative postprocessing optimization

File: [`050.7-derivative-postprocessing-optimization.md`](050.7-derivative-postprocessing-optimization.md)

Implemented and review-clean. It removes repeat status classification and contiguous derivative
boundary scans while preserving the exact derivative contract and reports the measured prepared
request improvement.

### 050.8 — progressive Time/Capacity series streaming

File: [`050.8-progressive-time-capacity-series-streaming.md`](050.8-progressive-time-capacity-series-streaming.md)

Promoted from the planning follow-up after the 050.7 review. Active implementation adds a
cache-miss-only NDJSON path that shares the ordinary scientific per-unit loop, keeps exact cache
hits one-shot, and promotes only a terminal complete result to React Query and persistent cache.

### 050.9+ — additional measured runtime issues

Future children may address other slow application boundaries discovered during normal use or
profiling. Before adding one:

1. reproduce/measure the symptom;
2. trace the current code path;
3. identify the dominant unnecessary/expensive work;
4. decide whether it belongs to this parent rather than an unrelated feature;
5. update this parent and add a self-contained child spec.

The currently identified derivative-specific follow-up is not automatically scheduled. After 050.6
is review-clean, use the 050.5 derivative evidence plus any fresh end-to-end measurements to decide
whether a separate numeric derivative/Plotly child is worth implementing.

For a follow-up arising directly from 050.4/050.5, its implementation scope must match the measured
bottleneck. Do not combine backend prepared data, multiresolution overview, payload transport and
Plotly changes by default.

## Parent-level cache, migration, and version policy

- No relational database migration is implied by this parent.
- No `CALC_VERSION` bump is implied by performance-only work.
- Physical raw-layout/index versioning is separate from parser/canonical/scientific calculation
  identity and must not by itself invalidate analysis result keys.
- 050.6 introduces only a dedicated prepared-derived cache representation generation. That
  artifact includes the active parser/scientific identity and validates against the canonical raw
  layout/fingerprint; it does not change scientific result identity or payload schema.
- A child that changes analysis cache-key computation must follow the explicit generation/version
  convention in `backend/app/services/analysis_cache.py` and test warm/cold identity behavior.
- A child that changes only data access while returning identical scientific results should not bump
  `CALC_VERSION`; it must instead prove result parity.
- A child that changes persisted analysis-result payload shape must update the corresponding
  per-kind result schema version.
- Profiling-only diagnostics must stay out of ordinary scientific responses/cache identity; if
  current ownership makes that impossible, redesign the instrumentation rather than silently
  creating a scientific generation change.
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

For 050.4, performance evidence additionally separates the live compact-request backend/HTTP,
frontend preparation, Plotly completion and total user-visible interaction. The user supplied the
required installed-app profile, which justified 050.5.

For 050.5, profiler evidence must localize the remaining backend transforms and distinguish the
normal prepared-row opportunity from derivative-specific work before any implementation child is
authored.

For 050.6, verification must include exact prepared-vs-fallback scientific parity, cache
identity/race/offline behavior, bounded selected-cycle prepared reads, golden digests unchanged, and
same-machine forced-fallback versus prepared timings with structural counters. Do not claim a user-
visible end-to-end improvement solely from those backend timings; request a short installed-app
re-profile later only if the parent decision needs it.

The final Parent 050 review, when the user declares the performance workstream ready to close, must:

- compare the complete branch against its correct `main` merge base;
- enumerate every authored child and its measured/verified performance boundary;
- confirm scientific golden/regression outputs required by affected children remain unchanged;
- confirm cache/migration/version consequences are coherent cumulatively;
- record the 050.4 end-to-end profiling outcome and every resulting 050.5+ decision;
- record which browser/manual performance checks were actually run;
- state explicitly whether the branch is ready to merge.

## Project-context maintenance

Planning these children does not itself change a durable merged architecture or workflow fact. Do
not rewrite uploaded Project context merely because this plan exists.

When implemented children establish cycle-addressable raw cache layout, indexed Time/Capacity or a
prepared derived-cache contract as a durable cross-cutting invariant, update the relevant repository
knowledge document and assess the Project context mirrors under `CELLXPLORER_CONTEXT_MAINTENANCE.md`
using the live repository as source of truth.
