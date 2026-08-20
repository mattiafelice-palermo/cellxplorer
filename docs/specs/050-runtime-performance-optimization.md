# Spec 050: runtime performance optimization

Status: **Plan — extensible parent; Child 050.1 ready to implement**  
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
range from a small range such as `1–3` to `1–20` can take on the order of tens of seconds before the
new plot appears. The user expectation is that this kind of interaction should feel close to
instantaneous once source caches exist.

Inspection of the baseline identified two different classes of cost.

### A. Unnecessary query/cache lifecycle work

These are bounded issues and form Child 050.1:

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

### B. Time/Capacity raw-data access cost

The deeper Time/Capacity path is a separate problem. On a cache miss,
`analysis_engine.compute_time_capacity()` currently calls `stitch.stitch_raw()` for each selected
Cell. `stitch_raw()` loads each contributing raw Parquet cache through `cache.load_raw()`, which
materializes the complete Parquet file into pandas. Global cycle filtering occurs only after the
full source chain has been loaded, cycle-mapped, concatenated, inspected, and copied. The response is
then reduced to the configured display point budget.

That means a request for a narrow cycle window can still pay approximately the I/O and pandas cost
of the complete experiment.

This is the planned subject of the next Time/Capacity child, but **its design is deliberately not
locked by this parent yet**. Before authoring that child, inspect and discuss at least:

- how global cycle numbers can be resolved to source-local cycle/row ranges without first loading
  complete raw frames;
- which canonical raw columns are required for voltage/current, capacity coordinates, protocol
  masking, auxiliary voltage availability, derivatives, provenance, and source-boundary markers;
- whether Parquet predicate/row-group pushdown is sufficient with the current raw-cache layout or a
  lightweight source-cycle index is justified;
- continued-Cell semantics, including dense global cycles, missing-middle-source fail-closed
  behavior, source provenance, and boundaries;
- the interaction between narrow interactive reads and full-resolution CSV/XLSX export;
- measured I/O, pandas materialization, stitching, derivative, downsampling, serialization, and
  Plotly costs on representative long files.

Do not implement a guessed partial-read architecture before that investigation is complete.

## Current source anchors

### Frontend analysis lifecycle

```text
frontend/src/features/analyses/editor/AnalysisEditor.tsx
    updateSpec()
    autosaveSignature
    autosave effect / PUT /api/analyses/{id}
    TimeCapacity plot composition

frontend/src/features/analyses/workspace/analysisQueryCache.ts
    ANALYSIS_QUERY_ROOTS
    invalidateAnalysisQueries()
    refreshAnalysisQueries()

frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx
    TimeCapacityPlotCardView
    dataSignature
    useQuery(["time-capacity", ...])

frontend/src/api.ts
    request()
    post(..., { signal }) support
```

### Backend analysis/cache boundary

```text
backend/app/services/analysis_cache.py
    _scientific_spec()
    result_key()
    saved_plot_data_signature()
    time_capacity_data_signature()
    ANALYSIS_CACHE_VERSION
    RESULT_SCHEMA_VERSIONS

backend/app/services/analysis_engine.py
    compute()
    compute_steps()
    compute_time_capacity()

backend/app/services/dcir.py
backend/app/services/chargeability.py
backend/app/services/rate_capability.py
backend/app/services/stitch.py
backend/app/services/cache.py
```

### Existing focused coverage

```text
frontend/tests/analysisQueryCache.test.ts
tests/test_analysis_cache.py
tests/test_analysis_engine.py
tests/test_dcir.py
tests/test_chargeability.py
tests/test_rate_capability.py
```

## Parent-level locked decisions

1. **Scientific outputs are invariant unless a later child explicitly states otherwise.** Runtime
   optimization alone never justifies changing formulas, cycle mapping, protocol matching,
   tolerances, units, source provenance, hidden-data semantics, or export contents.
2. **Prepared source Parquet remains canonical regenerable cache storage.** Do not move scientific
   data into SQLite to make plotting faster.
3. **List endpoints remain relational and bounded.** No child may move Parquet/source-file reads or
   scientific-stack imports onto Cell/Analysis database list paths.
4. **Expensive parsing/checksum/cache rebuild work remains off UI/request critical paths** except
   where an explicit scientific compute genuinely requires a cache that is absent.
5. **Optimize actual dependency scope.** Persisting editor state must not invalidate source-derived
   data by default, and a cache key must not depend on unrelated configuration merely because it is
   convenient to serialize the whole spec.
6. **Do not trade correctness for stale visuals.** Previous-result retention is allowed only when
   the previous result is scientifically compatible with the new render while replacement data is
   loading. Selection, coordinate meaning, voltage quantity, protocol masking, or derivative meaning
   must never be silently mislabelled.
7. **Cancellation is layered.** Frontend React Query cancellation must abort the browser request when
   possible. That alone does not prove a synchronous FastAPI/pandas computation stopped after it
   entered the backend. Backend cooperative cancellation or in-flight compute deduplication is a
   separate optimization unless a child explicitly includes it.
8. **Cache-key changes are versioned/documented according to existing analysis-cache convention.**
   `CALC_VERSION` changes only when scientific meaning changes; response-schema versions change only
   when payload shape/meaning changes.
9. **Measure before and after at the boundary being changed.** Prefer deterministic request counts,
   cache hit/miss assertions, row/column counts, and profiler timings over a single subjective UI
   timing. Wall-clock measurements are supporting evidence, not the sole regression test.
10. **One child, one review checkpoint.** This is a shared feature branch. Do not begin a later child
    until the active child is implementation-complete and review-clean.
11. **The parent is intentionally extensible.** A clean 050.1 does not make Parent 050 complete or
    merge-ready while the user has reserved further performance investigation. Update this parent
    and add the next child before any cumulative final review.
12. Never modify, reset, or discard unrelated branch work.

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

### 050.2 — Time/Capacity data-access optimization — **reserved, not yet authored**

The next child number is reserved for the deeper Time/Capacity path described above. Its title,
architecture, exact files, cache consequences, benchmarks, and acceptance criteria remain open until
the current raw-cache/stitching behavior has been investigated in more detail with the user.

Do not implement 050.2 from this parent description alone.

### 050.3+ — additional measured runtime issues

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
- A child that changes analysis cache-key computation must follow the explicit generation/version
  convention in `backend/app/services/analysis_cache.py` and test warm/cold identity behavior.
- A child that changes only data access while returning identical scientific results should not bump
  `CALC_VERSION`; it must instead prove result parity.
- A child that changes persisted cache payload shape must update the corresponding result/artifact
  schema version.
- Do not edit released migrations.

## Parent verification policy

Each child defines its focused tests and measurements. Before each implementer handoff, follow the
repository workflow:

```text
focused tests/checks required by the active child
→ other focused compile/type/diff checks as relevant
→ python scripts\preflight.py
→ handoff to reviewer
```

Do not duplicate the full backend/frontend suites immediately before canonical preflight.

The final Parent 050 review, when the user declares the performance workstream ready to close, must:

- compare the complete branch against its correct `main` merge base;
- enumerate every child and its measured/verified performance boundary;
- confirm scientific golden/regression outputs required by affected children remain unchanged;
- confirm cache/migration/version consequences are coherent cumulatively;
- record which browser/manual performance checks were actually run;
- state explicitly whether the branch is ready to merge.

## Project-context maintenance

This planning commit does not itself change a durable merged architecture or workflow fact, so it
does not require replacement ChatGPT Project context files. If a later implemented child changes a
cross-cutting cache ownership/performance invariant, update the appropriate repository knowledge
document and then assess the Project context mirrors under
`CELLXPLORER_CONTEXT_MAINTENANCE.md`.