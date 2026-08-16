# Spec 048: reduce backend test fixture/runtime cost

Status: **Plan**  
Type: **development tooling / test performance**  
Branch: `feature/test-fixture-runtime-optimization`  
Review document: [`reviews/048-test-fixture-runtime-optimization-review.md`](reviews/048-test-fixture-runtime-optimization-review.md)

## Dependency and branch base

This spec is a follow-up to Spec 045 (`faster-local-verification`). Spec 045 provides the shared
backend/frontend test runner and per-module timing used to identify the current slow backend
modules.

This is a **separate feature branch** from Spec 045. The plan was originally authored on the
review-clean Spec 045 head. During reviewer preparation on 2026-08-16, the branch was rebuilt on
the then-current `main` (`02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`) so Spec 045 is not carried
as unrelated cumulative feature scope. Before implementation, confirm the branch still has the
intended current `main` ancestry and do not reintroduce stacked Spec 045 scope.

The spec was originally numbered 046 before Spec 046 was assigned to the Series appearance manager.
It is now Spec 048; Spec 047 is reserved for the Cell loader improvement work.

## Goal

Reduce CellXplorer's local verification wall time by reducing unnecessary work *inside* expensive
backend tests, while preserving the same scientific, parser, persistence, portability, migration,
and failure-detection guarantees.

The governing rule is:

> Use the smallest **semantically complete** fixture that can prove the behavior under test. Keep a
> full real source only where the completeness/real-world integration of that source is itself part
> of the contract.

This is not permission to shorten data blindly. A small fixture must deliberately retain every
cycle/step/status/boundary/dialect/state transition needed by the assertion.

No application behavior should change in this spec.

## Current measured hotspots

Spec 045 identified these among the slowest backend modules:

```text
tests.test_portable_analysis
tests.test_beta_bootstrap
tests.test_fast_neware
tests.test_neware_excel
```

They are slow for different reasons and must not receive the same optimization mechanically.

### `tests/test_fast_neware.py`

`FastNdaxReadTests.test_sample_files_identical` currently forms twelve combinations:

```text
2 source files
× 3 cycle modes: chg / dchg / auto
× 2 software_cycle_number values: True / False
```

Each comparison parses the complete source once through original NewareNDA behavior and once with
CellXplorer's fast paths installed. That is up to **24 complete NDAX parses** for one test method.
The current source names live at the repository root and are git-ignored `.ndax` files, so this
full-file matrix is also conditional on local files being present.

The production fast path in `backend/app/services/fast_neware.py` accelerates two leaf behaviors:

- `_read_ndc_5_filetype_1` — vectorized NDAX record decoding;
- `_generate_cycle_number` — vectorized software cycle numbering.

The cycle-number behavior already has small synthetic status-sequence tests.

### `tests/test_neware_excel.py`

This module already builds compact synthetic workbooks. The core record fixture contains only a
small number of deliberately chosen cycle/step segments, including repeated programmed step
indices, CC/CV charge, discharge, rests, and summary validation cases.

Do **not** assume cycling-data length is its bottleneck. Measure workbook creation/save/load and
repeated dialect/template construction before changing it.

### `tests/test_portable_analysis.py`

The canonical `raw_frame()` is already only two rows. Runtime therefore comes from report/database/
cache/payload/export/import setup rather than a long cycling trace.

Do not shorten this raw frame further merely for speed; profile the actual expensive methods and
operations.

### `tests/test_beta_bootstrap.py`

Many tests repeatedly create SQLite databases through `_create_migrated_database()`, which runs the
production migration path and enables WAL for each newly created Stable/Beta database.

Most Beta bootstrap tests are testing staging/status/copy/manifest behavior, not the migration
engine itself. Repeating the same current-schema construction may therefore be removable setup
cost, provided every test still gets an isolated writable database and migration-specific cases
continue to exercise the real migration states they claim to test.

## Locked decisions

1. **Do not delete, skip, sample, or make backend tests optional.**
2. **Do not weaken assertions, scientific tolerances, expected results, parser equality checks, or
   failure cases to improve timing.**
3. **Do not truncate the committed golden scientific corpus.**
   `tests/fixtures/golden_analysis/sources/` remains the locked full-source corpus described by
   `docs/agent-knowledge/scientific-regression-testing.md`; its source bytes/checksums are unchanged
   by this spec.
4. Keep full-source end-to-end regression where real/full-file integration is part of the test's
   purpose, but do not repeat a full source merely to exercise a small parameter branch that can be
   proven independently with a compact fixture.
5. A replacement compact fixture must be **semantically constructed**, not `rows[:N]` or an
   arbitrary first-N-cycles slice.
6. Every test keeps private mutable state. Shared setup may be reused only as immutable bytes,
   immutable templates, or read-only construction inputs; no test may share a writable SQLite DB,
   workbook object, cache directory, report, or application data root with another test.
7. Preserve deterministic execution and exact failure attribution.
8. Do not change production scientific/parser/database/portable-report behavior merely to make a
   test cheaper. A production optimization discovered while profiling is separate work unless it
   is required to preserve the existing behavior while removing duplicated test-only setup.
9. Do not broaden this into another preflight scheduler/concurrency rewrite. Spec 045 owns the
   shared test orchestration. Inner parallelism may be simplified only when fixture reduction makes
   it unnecessary and the global worker-budget contract remains correct.
10. Correctness is the merge gate. Timing evidence should demonstrate a useful reduction, but this
    spec does not require exhaustive repeated benchmarking or statistical characterization.

## 1. Measure at test-method granularity before editing

The Spec 045 runner reports module durations. Before changing a slow module, identify which test
methods/setup helpers consume its wall time.

For each of the four target modules:

1. record current module wall time;
2. obtain per-test-method/setup timing using the supported Python unittest duration reporting or an
   equivalent local diagnostic runner;
3. identify the dominant operation (file parse, migration, XLSX serialization, portable report
   creation, etc.);
4. write the measurement into the Spec 048 implementation record before claiming an optimization.

Do not permanently add a large profiling framework to the repository merely to obtain this data.
If lightweight reusable duration reporting is useful, keep it bounded and diagnostic-only.

After each optimization, record the changed module's new wall time and the specific setup/test
method affected. One comparable before/after run on the same development machine is sufficient;
repeat only when the measurement is obviously anomalous.

## 2. Fast Neware: replace repeated long-file work with layered parity coverage

### Current anchors

```text
tests/test_fast_neware.py
    SAMPLE_FILES
    _compare_ndax_combination()
    FastCycleNumberTests
    FastNdaxReadTests.compare()
    FastNdaxReadTests.test_sample_files_identical()

backend/app/services/fast_neware.py
    _fast_read_ndc_5_filetype_1()
    _fast_generate_cycle_number()
```

### Target test structure

Split the existing guarantee into three explicit layers.

#### A. Tiny cycle-number semantic tests

Keep the current direct `_ORIG_GEN_CYCLE` vs `_fast_generate_cycle_number` comparisons and preserve
coverage of:

- `chg`;
- `dchg`;
- `auto`;
- CC/CCCV/CP/CR and rest interactions already represented by the current tests;
- SIM/Pause behavior;
- starts-with-discharge behavior;
- no-increment behavior;
- invalid cycle mode.

Add a compact case only if profiling/review shows that a cycle-number branch currently receives
coverage only accidentally through the full-file matrix.

#### B. Compact deterministic binary-decoder parity

Add an independently constructed small NDAX `data.ndc`/container fixture or byte builder that is
large enough to exercise the structural boundaries of `_read_ndc_5_filetype_1`, but contains only
the records needed to prove them.

At minimum, cover:

- more than one 4096-byte page so page slicing is real rather than mocked;
- multiple valid status codes and current ranges/multipliers used by supported files;
- record validity filtering;
- index/cycle/step/status/time/voltage/current/capacity/energy/timestamp decoding;
- exact column order and dtypes;
- unknown status/range fallback behavior;
- partial/trailing-page fallback behavior;
- exact equality with the saved original decoder wherever the original decoder is the reference.

Construct binary bytes independently from the production NumPy structured dtype where practical,
following the same principle as `tests/biologic_mpr_fixture.py`: the test fixture should not merely
serialize data through the implementation it is supposed to verify.

#### C. Bounded end-to-end `.ndax` parity

Retain end-to-end `NewareNDA.read()` comparisons with and without the fast paths installed so the
monkeypatch/orchestration boundary remains tested.

Requirements:

- all six `(cycle_mode, software_cycle_number)` combinations must still be exercised end-to-end;
- those combinations may use a compact deterministic `.ndax` fixture instead of a production-length
  source when the fixture contains the states required by the combination;
- retain at least **one** full committed real-source/full-DataFrame parity smoke check through
  `NewareNDA.read()` to guard against an integration difference that the synthetic container did
  not anticipate;
- the full-source smoke may reuse an existing committed golden `.ndax` source read-only, but it must
  not modify, trim, regenerate, or change the golden corpus or its manifest/checksums;
- do not require optional git-ignored repository-root sample files for canonical coverage once an
  equivalent committed fixture exists;
- full-frame parity continues to mean exact columns, dtypes and values, not approximate equality.

This section explicitly supersedes Spec 013's earlier assumption that every parameter combination
must parse a full production-length file twice. The **semantic combinations and exact-equality
contract stay locked; the amount of redundant source data used to prove them does not.**

If the compact suite is fast enough that the inner `ProcessPoolExecutor` in `test_fast_neware.py`
no longer provides a material benefit, it may be removed. If retained, it must continue to obey the
outer `CELLXPLORER_PREFLIGHT_CPU_BUDGET`/NDAX worker-budget rules established by Specs 013 and 045.

## 3. Beta bootstrap: reuse immutable current-schema database setup

### Current anchors

```text
tests/test_beta_bootstrap.py
    _create_migrated_database()
    BetaBootstrapTests.setUp()
    BetaBootstrapTests.beta_session()
    BetaBootstrapTests.stable_session()
    write_raw_stable_database()
    stamp_stable_revision()
```

### Target

If method-level timing confirms repeated current-schema migration/database creation is a material
cost, construct a known-good **current-schema SQLite template** once per module/class and clone its
bytes into each test's private temporary Stable/Beta location instead of rerunning the same migration
sequence for every ordinary session helper call.

Rules:

- create the template through the real current migration/bootstrap path at least once; do not hand
  invent a schema that could drift from production;
- every test still receives a separate writable database file under its own temporary root;
- no SQLAlchemy engine/session is shared between tests;
- copied databases must preserve the database-instance-identity semantics needed by the test. If a
  test requires a fresh/distinct identity, create/reseed that identity through an existing
  production/test helper rather than silently sharing one copied identity;
- WAL/connection pragmas required by the behavior under test must still be enabled;
- tests for legacy revision recognition, future/unknown revisions, corruption, migration behavior,
  raw schema recognition, and similar database-state boundaries must bypass the current-schema
  shortcut and construct the exact state they claim to test;
- staging/copy tests must still operate on real filesystem copies and verify real manifest/digest/
  import-path behavior.

Do not change `backend/app/services/beta_bootstrap.py` solely to accommodate a test shortcut unless
profiling exposes a real production defect independently worth fixing.

## 4. Neware Excel: reuse serialized templates, not mutable workbooks

### Current anchors

```text
tests/test_neware_excel.py
    _write_synthetic_workbook()
    _convert_to_duration_dialect()
    _write_metadata_workbook()
    related workbook/dialect builders
```

### Target

The existing synthetic workbook is already semantically compact, so preserve its essential
segments. If profiling confirms `openpyxl` construction/save/load is the dominant cost:

- build a small set of immutable base workbook byte templates once per module/class;
- copy/write those bytes into each test's private path before mutation;
- derive duration-dialect/metadata/invalid variants from a private copy, never a shared mutable
  `Workbook` instance;
- avoid repeatedly rebuilding an identical workbook from cell-by-cell Python operations when only
  one field/worksheet differs.

The compact fixture must continue to include the current deliberate semantics, including repeated
programmed step identity, charge + CV charge, discharge, rest, time ordering, energy/capacity
reconstruction, and independent step/cycle summary validation where applicable.

Do not remove a segment merely because a shorter workbook parses faster. Remove/restructure only
redundant serialization/setup proven not to carry a distinct assertion.

## 5. Portable analysis: optimize repeated infrastructure, not the two-row science fixture

### Current anchors

```text
tests/test_portable_analysis.py
    raw_frame()
    PortableAnalysisTests.make_session()
    PortableAnalysisTests.setUp()
    create_analysis()
    create_export()
    read_report()
    rewrite_report()
```

### Target

Profile first. The two-row `raw_frame()` is already minimal enough to exercise one charge and one
discharge point, so do not treat row count as the expected optimization.

Potential optimizations are valid only when timing proves them dominant, for example:

- reuse immutable serialized/template inputs that are regenerated identically across many tests;
- avoid rebuilding an identical expensive portable-report/runtime scaffold when a test only needs a
  lower-level manifest/payload helper;
- move immutable class/module setup out of per-test setup while copying it into each private mutable
  test location;
- use the lowest production function that actually corresponds to the assertion instead of running
  a complete export/import round trip for a helper-level behavior.

However:

- tests whose purpose is export must still execute real export;
- tests whose purpose is import/round-trip must still execute real import/round-trip;
- security/integrity/path/source/cache/provenance assertions must remain intact;
- each test keeps its own DB/session/cache/import directory and mutable output files;
- do not mock away the subsystem boundary being tested simply to save time.

## 6. Do not optimize the golden full-source corpus by shrinking it

The full binaries under:

```text
tests/fixtures/golden_analysis/sources/
```

are intentionally a separate regression layer. `tests/test_golden_analysis.py` verifies the source
checksums and the harness parses each unique source at most once per module run.

Spec 048 must not:

- trim/rewrite those binaries;
- replace them with synthetic sources;
- loosen expected numerical projections/tolerances;
- regenerate expected results for speed;
- skip analysis families;
- turn full-source golden verification into an optional test.

If profiling later shows the golden module itself dominates the suite, optimize duplicated harness
setup/cache reuse *within the existing isolated module contract* as a separate measured change; do
not reduce the corpus as the default solution.

## 7. Coverage-preservation audit

For every changed slow module, add a concise table to the implementation record:

```text
Old expensive behavior/assertion
→ new fixture/setup path
→ where the same semantic condition is now asserted
```

This is especially required when replacing repeated full-file NDAX combinations.

A reviewer must be able to confirm that a speedup came from less redundant setup/data, not from
silently deleting a case.

If test methods are split/combined/renamed, record the mapping. Literal test-count equality is not
required when structure improves, but every prior semantic case and assertion class must remain
represented.

## Out of scope

- application/UI changes;
- scientific formula changes or `CALC_VERSION` changes;
- parser support expansion;
- changing Neware/BioLogic/Excel production semantics;
- trimming the golden corpus;
- backend test caching/skipping;
- another global preflight scheduler rewrite;
- frontend test optimization;
- release/version bump solely for this tooling work.

## Implementation order

1. Confirm the branch remains based on the intended current `main` and that the Spec 045 shared
   runner/timing implementation is present.
2. Record Spec 045-based module timings and method/setup-level timings for the four target modules.
3. Optimize `test_fast_neware.py` first, because repeated full parses are the clearest fixture-size
   problem and already have direct leaf semantics that can be separated.
4. Re-measure the backend slowest-module list.
5. Optimize `test_beta_bootstrap.py` if repeated migration/template creation remains dominant.
6. Optimize `test_neware_excel.py` only if workbook serialization/construction is measured dominant.
7. Optimize `test_portable_analysis.py` only at its measured infrastructure hotspot.
8. Stop when remaining hotspots cannot be made materially cheaper without weakening their contract.
9. Run focused module verification, then canonical no-cache + normal preflight and record the final
   timing/slowest-module output.

## Verification

At minimum, run the modified target modules directly after each change. The final verification is:

```powershell
python -m unittest tests.test_fast_neware tests.test_beta_bootstrap tests.test_neware_excel tests.test_portable_analysis -v
python scripts\preflight.py --no-cache
python scripts\preflight.py
```

Also verify:

```text
- git diff --check: PASS
- golden source/manifest files: NO CHANGES
- browser/manual UI checks: NOT REQUIRED (test/tooling-only change)
```

The normal preflight is not a replacement for `--no-cache` here: the forced run is required once at
final verification to prove the complete backend/frontend verification contract still executes
with the optimized backend fixtures.

### Timing record

Record comparable before/after wall time for:

- each target module actually optimized;
- the backend test stage / slowest-module list from preflight;
- full `preflight.py --no-cache`.

One representative before/after measurement is sufficient unless the result is clearly anomalous.
Do not spend implementation time on exhaustive benchmark repetitions.

## Acceptance criteria

1. Every prior semantic test case/assertion in the modified modules remains represented and mapped
   in the implementation record.
2. The golden full-source corpus and its checksums/expected projections are unchanged.
3. `test_fast_neware` no longer performs a large repeated production-length parse matrix merely to
   cover the six cycle-mode/software-cycle combinations.
4. All six `(cycle_mode, software_cycle_number)` combinations still receive end-to-end parity
   coverage, exact columns/dtypes/values remain checked, and at least one full committed real-source
   parity smoke remains.
5. Direct compact decoder tests cover page structure, supported status/range decoding, validity,
   decoded fields, and fallback boundaries that were previously entrusted to long files.
6. Any Beta bootstrap database-template reuse preserves per-test writable isolation and bypasses the
   shortcut for tests whose purpose is migration/revision/corruption state.
7. Any Excel template reuse is immutable between tests and preserves all deliberate synthetic
   protocol/dialect semantics.
8. Portable-analysis optimizations preserve real export/import/round-trip boundaries wherever those
   are the assertion being tested.
9. No backend module is skipped/cached and no scientific tolerance/fixture expectation is weakened.
10. The optimized modules show a material wall-time reduction attributable to less redundant
    setup/data; unchanged modules need not be forced into artificial optimizations.
11. `python scripts\preflight.py --no-cache` and normal `python scripts\preflight.py` both pass.
12. Final review can state exactly which expensive work was removed and why the resulting smaller
    fixture/setup proves the same behavior.

## Implementation record

Reviewer preparation only:

- Renumbered this plan from the stale/conflicting Spec 046 identifier to Spec 048.
- Rebuilt `feature/test-fixture-runtime-optimization` onto `main` at
  `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6` before implementation.
- No implementation or production code was changed during this preparation.
