# Spec 048 implementation review — Test fixture runtime optimization

Status: **Changes requested — user-authorized performance extension**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6` (`main` at review start)  
Reviewed implementation: `1e71a6fa124b1528d665501ca795385c76c3a99b`

## Review scope and result

The implementation of the original Spec 048 scope is clean by code review. I found no concrete
coverage regression in the compact Fast Neware parity fixture, Beta-bootstrap current-schema
cloning, portable-analysis immutable export reuse, or the decision to leave Neware Excel unchanged
after profiling.

The implementer reported:

- focused target modules: **PASS**, 149 tests, 35.573 s;
- `python scripts\\preflight.py --no-cache`: **PASS**, 45.42 s;
- normal `python scripts\\preflight.py`: **PASS**, 36.89 s;
- `git diff --check`: **PASS**;
- `compileall`: **PASS**;
- golden scientific source/manifest files: **unchanged**.

Reviewer verification in this round was code-reading first. I did not independently rerun the full
suite; the implementer's canonical preflight evidence is taken as the aggregate execution record.

Confirmed by review:

- all six `(cycle_mode, software_cycle_number)` combinations still run end-to-end on the compact
  deterministic `.ndax` fixture;
- one committed full real-source exact parity smoke remains;
- the direct NDC fixture is independently byte-packed rather than serialized through the production
  NumPy dtype, and it covers multi-page layout, validity filtering, multiple statuses/current
  ranges, decoded fields, exact dtypes/columns, and fallback boundaries;
- the small `fast_neware.py` production change only releases mmap-backed NumPy views before invoking
  the saved original fallback and is exercised by the unknown-status/range tests;
- Beta template setup is created once through the real migration path, while each test still gets a
  private writable DB file and SQLAlchemy engine/session;
- the portable malformed-chain cases now reuse only immutable valid setup and deep-copy each report
  before mutation; each case still executes both inspection and import failure paths;
- no golden scientific fixture was changed.

## User-authorized performance extension

During review on 2026-08-16, the user explicitly expanded the objective: preserve scientific and
test correctness, but continue beyond the original Spec 048 scope where useful with a practical
target of bringing normal preflight toward **~10 s total**, and investigate the forced no-cache
critical path as well.

The following R items are therefore performance follow-ups requested by the reviewer under that
explicit user instruction. They are not corrections to the already-clean original Spec 048
implementation.

### R1 — High: remove avoidable test-pool tail latency and tune the worker count

Affected files:
- `scripts/run_backend_tests.py`
- `scripts/preflight.py`
- `tests/test_run_backend_tests.py`
- `tests/test_preflight_script.py`

**Current**

The shared test pool submits backend modules in filename-sorted order. It records durations for
printing, but does not use successful prior durations to schedule the next run. After Spec 048, the
standalone target-module measurements are about 19.0 s for `tests.test_portable_analysis` and
16.6 s for `tests.test_neware_excel`, while the normal complete backend stage was still 36.54 s.
Long tasks can therefore begin late in the pool and extend the tail. The default also always uses
up to 16 workers without a current post-Spec-048 worker-count comparison, so resource contention
may also be contributing.

**Target**

Make scheduling cost-aware without skipping, caching, merging, or weakening any test:

1. Persist successful per-task duration history (backend modules and frontend policy files) in a
   small local preflight timing cache or an extension of the existing cache format.
2. On later runs, submit known tasks longest-first. Treat new/unknown tasks conservatively so an
   unmeasured new slow task cannot be stranded at the end.
3. Timing history may affect ordering only; `--no-cache` must still execute every task.
4. Preserve one subprocess and one private `CELLXPLORER_DATA` directory per backend module.
5. Measure the current suite with a bounded worker-count sweep appropriate to the development
   machine (for example 4/8/12/16, omitting values that exceed the CPU budget) and choose the
   measured best default/heuristic rather than assuming 16 is optimal.

**Acceptance criteria**

- Tooling tests prove duration-based ordering, malformed/missing history fallback, exact task
  failure attribution, and that every task still executes.
- Per-module data-root isolation is unchanged.
- `--no-cache` changes no coverage semantics; timing history may only change execution order.
- Record same-machine before/after complete test-stage wall time and the worker-count sweep.
- Keep the change only if it gives a real wall-time improvement or establishes with measurements
  that scheduling/worker count is not the remaining limiter.

### R2 — High: parallelize the remaining large serial test modules without weakening them

Affected files:
- `tests/test_portable_analysis.py`
- `tests/test_neware_excel.py`
- new coherent `tests/test_portable_analysis_*.py` / `tests/test_neware_excel_*.py` modules or
  non-test helper modules as appropriate
- `scripts/run_backend_tests.py` only if discovery needs a small compatible adjustment

**Current**

`tests.test_portable_analysis` still takes about 18.98 s for 34 tests and
`tests.test_neware_excel` about 16.56 s for 67 tests. The runner parallelizes at **module**
granularity, so all methods inside each of these large files remain serial even though many tests
have independent temporary databases/workbooks/files. These two modules therefore impose a floor
well above the desired ~10 s backend critical path even after the original fixture reductions.

**Target**

Profile the post-Spec-048 methods and break the two oversized modules into a small number of
coherent independently runnable modules where test ownership permits it, so the existing bounded
runner can execute those groups concurrently. Prefer structural splitting plus shared immutable/test
support helpers over risky mocking or arbitrary fixture truncation.

Examples of reasonable ownership boundaries are export/report generation vs import/integrity/path
validation for portable analysis, and record parsing vs protocol/metadata/analysis integration for
Neware Excel. Choose boundaries from the actual tests rather than these names mechanically.

Rules:

- preserve every existing test method/subtest, assertion, tolerance, dialect, failure case and
  scientific comparison;
- do not share mutable DBs, workbooks, cache roots, reports or application-data roots between
  modules/tests;
- helper files must not accidentally be rediscovered as duplicate `test_*.py` modules;
- do not truncate the golden corpus or replace real integration tests with mocks;
- micro-optimize additional measured setup only where it remains clearly redundant after splitting.

**Acceptance criteria**

- All 34 existing portable-analysis tests and all 67 existing Neware-Excel tests remain represented
  with equivalent assertions/semantics.
- Focused execution of the complete split set passes.
- Canonical preflight discovers each test exactly once.
- Record per-new-module durations and the complete backend-stage wall time.
- Aim to bring the longest backend test task below roughly 8–10 s if this can be done without
  weakening coverage; if a coherent module must remain slower, document the measured reason.

### R3 — Medium: measure a Rolldown-powered Vite migration against the 45 s bundle bottleneck

Affected files if the experiment is retained:
- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/vite.config.ts` only if genuinely required
- the Vite React plugin dependency only if required by the supported migration
- focused preflight/build-policy tests if cache/toolchain assumptions change

**Current**

CellXplorer is pinned to Vite `^5.4.14`. The implementer's forced preflight measured the production
bundle at about **45.16 s**, making it the no-cache critical path. Previous attempts to disable
minification or change the build target were correctly rejected because they changed the verified
artifact for only modest savings.

**Target**

Perform a measured migration experiment to the current stable Rolldown-powered Vite generation,
using a compatible supported React plugin and only if the installed Node version satisfies that
Vite generation's requirements.

This is an experiment with a fail-safe outcome:

1. Record the current production `vite build` time on the same machine.
2. Upgrade the Vite/tooling dependencies in a reversible focused change and run the real production
   build with the same application semantics (do not disable minification, relax targets, externalize
   Plotly, or otherwise make the checked artifact easier than the shipped artifact).
3. If CellXplorer compatibility is clean and the speedup is material, retain the migration.
4. If compatibility is questionable or the project-specific speedup is small, revert the dependency
   experiment completely and record the result rather than forcing the migration.

**Acceptance criteria**

If retained:

- lockfile is regenerated normally and dependency installation is reproducible;
- frontend policy tests pass;
- TypeScript check passes;
- production Vite build passes with the same offline/self-contained application contract;
- Plotly runtime consistency verification remains green;
- `python scripts\\preflight.py --no-cache` passes;
- record before/after Vite-build and total no-cache-preflight wall time.

If reverted:

- no experimental dependency/config residue remains in the branch;
- record the measured build result and concrete incompatibility or insufficient gain.

## Follow-up order

1. **R1** — improve scheduling and determine the best worker budget first, because this changes the
   measured critical path without touching test semantics.
2. **R2** — split/profile the remaining large serial modules using the R1 scheduler.
3. **R3** — investigate the independent frontend bundle floor.

Do **not** add backend test skipping/caching yet. That is a higher correctness-risk lever. Re-measure
normal preflight after R1/R2; if it is still materially above ~10 s, the reviewer will decide in the
next round whether a conservative incremental backend cache/test-impact mechanism is justified.
