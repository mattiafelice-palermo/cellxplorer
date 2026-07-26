# Spec 015: Golden analysis regression corpus

Status: **Implemented** (2026-07-26). Branch: `feature/golden-analysis-regression-corpus`.  
Review document: [`reviews/015-golden-analysis-regression-corpus-review.md`](reviews/015-golden-analysis-regression-corpus-review.md) — **approved, ready to merge**.

## Implementation record

- Committed four full `.ndax` sources under `tests/fixtures/golden_analysis/sources/`.
- Added manifest, eight golden cases, `tests/golden_analysis_support.py`, `tests/test_golden_analysis.py`,
  and `scripts/build_golden_analysis_corpus.py` (`export` / `refresh-expected` / `verify`).
- `approval.md` status: **approved** (2026-07-26).
- Focused verification: `python -m unittest tests.test_golden_analysis -v` — **24 tests OK (~7.7 s)**.
- Corpus verify: `python scripts\build_golden_analysis_corpus.py verify --manifest tests\fixtures\golden_analysis\manifest.json` — **8/8 cases PASS**.
- Full backend suite: `python -m unittest discover tests` — **387 tests OK (~41 s)**.
- Uncached preflight: `python scripts\preflight.py --no-cache` — **PREFLIGHT PASSED (5/5)**.
- Unique cold `parsing.parse_timeseries` calls per module: **3** (chargeability and rate_capability share one hash).
- Committed fixture size: **~4.8 MB** binaries + JSON specs/expected outputs; trimmed manifest **~6 KB**.
- Selected sources:
  - `cycles_time_steps.ndax` — 193 cycles / 71190 rows (`1b226f9f…`) from Test analysis cell 613
  - `dcir_source.ndax` — 221 cycles / 78677 rows (`36b20c04…`) from DCIR test
  - `chargeability_source.ndax` + `rate_capability_source.ndax` — 37 cycles / 20491 rows (`c4c655f8…`) from Chargeability test

## R* implementation record (2026-07-26)

### Round 1

- **R1 (partial):** Production ingestion + real protocol-dependent cases.
- **R2:** Distinct cycles/Time-Capacity projections; derivative under `computation.time_capacity`.
- **R3 (partial):** Isolated cache root.
- **R5 (partial):** Analysis selectors; absolute paths removed.
- **R6:** Trimmed manifest metadata.
- **R7 (partial):** Focused/verify/backend recorded.

### Round 2

- **R9:** `project_result` rejects NaN/Infinity instead of coercing to `null`; projection-path test added.
- **R10:** Removed in-place `regenerate_golden_fixture_outputs.py`. Canonical updates use
  `export` / `refresh-expected` into a candidate directory with SAME/DIFF digests.
- **R1:** DCIR golden case now includes charge and discharge 0.701C series (7 measurements each).
- **R8:** Cycles absolute projection keeps full scientific quantities/metrics; normalization keeps
  specific capacities plus absolute scientific context. Required-key assertions added.
- **R5:** Rate Capability analysis/cell/source/plot resolved independently; plot-name CLI selectors;
  builder unit test covers a rate analysis whose cell differs from Chargeability.
- **R3:** Instruments `parsing.parse_timeseries` (and cache module binding); module temp root cleaned
  and prior `CELLXPLORER_DATA` restored in teardown; create failure cleans up.
- **R7:** Raw frames validated for required columns/dtypes; normal tests assert no export/refresh;
  preflight `--no-cache` recorded.
### Round 3

- **R11:** Candidate output paths reject committed fixture root and descendants, and outputs inside
  the selected source tree. Temporary `_data` caches are removed on success and error. Structured
  scientific diffs report changed JSON paths with numeric abs/rel deltas; optional `--diff-report`
  JSON. Focused builder safety tests added.
- **R12:** `restore_data_root_binding()` reloads config/cache/scanner to the prior data root on
  golden test teardown and setup failure. Order-sensitive restore regression test added.
- **R4:** Scientific and privacy approval completed; `scripts/verify_golden_approval_checkpoints.py` added.

Status: **Approved — ready to merge**  
Repository: `mattiafelice-palermo/cellxplorer`  
Target branch: `feature/golden-analysis-regression-corpus`  
Base: current `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`  
Review file: `docs/specs/reviews/015-golden-analysis-regression-corpus-review.md`

## 1. Goal

Create a committed, scientifically approved regression corpus based on **full real Neware source files**. The corpus must run in the normal backend test suite and detect unintended changes in parsing, per-cycle derivation and all CellXplorer analysis results.

The initial corpus must use exactly four source files:

1. the complete source file used by `DCIR test`;
2. the complete source file used by `Chargeability test`;
3. the complete source file used by the selected Rate Capability analysis;
4. one complete `.ndax` cycling file of roughly 200 cycles, shared by the Cycles, Time/Capacity and Steps cases derived from `Test analysis`.

The approximately 200-cycle file must contain the scientific structures needed by those three families, including a real CC→CV capacity-counter reset and the multi-step block used by the Steps case. Prefer a source in the range of roughly 150–250 cycles; if no suitable source exists, report the nearest valid candidate and its cycle count before proceeding.

Do not trim rows, cycles, steps or occurrences from these four source binaries. Expected outputs may be reduced to stable scientific projections, but every test input must remain the complete source file.

The result must not depend on the developer's live database, local file paths, analysis IDs, pre-existing cache state or any source outside the committed fixture directory.

## 2. Why this is needed

The repository already has strong synthetic unit coverage for calculations and protocol recognition. It also has optional real-file parser parity tests. What is missing is a committed, independently approved scientific baseline spanning the complete backend analysis pipeline.

A snapshot generated from current code is not automatically a scientific reference. The initial corpus must therefore include explicit manual checkpoints that verify the most important values from the raw records and formulas before the expected outputs are accepted.

## 3. Locked decisions

### 3.1 Full-source required corpus

The user has explicitly approved using the complete source files for this specification.

Commit the four selected `.nda`/`.ndax` binaries under `tests/fixtures/golden_analysis/sources/`. The required golden tests must:

- verify each binary SHA-256 before use;
- parse each source through the production Neware parsing path;
- build raw and per-cycle caches from scratch inside the isolated test data root;
- parse each source only once per test-module run and reuse the resulting isolated caches across its cases;
- run the production scientific services against those caches;
- compare stable scientific projections with approved expected JSON.

The committed source binary is the canonical fixture input. Do not commit extracted `raw.parquet` or precomputed cycle Parquet as an alternative source of truth.

Before committing the files, the implementation agent must report for each source:

- original filename and proposed generic fixture filename;
- extension;
- SHA-256;
- file size;
- parsed row count and cycle count;
- source analysis and analysis family coverage.

Do not alter the binary contents to anonymize them, because doing so changes the actual parser input and checksum. Use generic repository filenames and generic fixture entity names. Review embedded metadata for sensitive customer or personal information before commit. If a source cannot be committed through the repository's normal Git workflow because of file size, stop and report it; do not introduce Git LFS or another storage mechanism without explicit approval.

### 3.2 No live-database dependency

Normal tests must never open `%USERPROFILE%\.cellxplorer\cellxplorer.db` or use the user's cache directory.

The corpus-generation command may inspect the local database only when explicitly invoked with `--data-root` or `--database`. It must operate on a temporary SQLite backup/snapshot, not mutate the live database.

### 3.3 Test backend scientific outputs, not screenshots

Golden tests must call the production backend scientific services. Do not compare PNG/SVG thumbnails, Plotly layout, timestamps or other presentation artifacts.

Use these production entry points:

- `backend/app/services/analysis_engine.py::compute`
- `backend/app/services/analysis_engine.py::compute_time_capacity`
- `backend/app/services/analysis_engine.py::compute_steps`
- `backend/app/services/analysis_engine.py::compute_dcir`
- `backend/app/services/chargeability.py::compute`
- `backend/app/services/rate_capability.py::compute`

The expected projection must preserve the API-facing scientific arrays and structural fields consumed by the frontend.

### 3.4 Inputs are independent from expected outputs

The committed Neware binaries are the inputs. Production parsing, cache construction and scientific services derive all actual results during the test.

Expected values must not be generated by a helper that is also used to construct or modify the source input. Do not patch parsed frames, inject precomputed per-cycle data or bypass the production parser in the golden cases.

### 3.5 Explicit approval workflow

Normal tests and preflight must never regenerate or overwrite expected output.

The generation tool writes a candidate corpus to a separate output directory. Updating committed goldens is an explicit developer action followed by Git diff review and scientific checkpoint verification.

### 3.6 Fixed corpus selection and bounded outputs

The initial corpus contains four complete binaries only:

- one full DCIR source;
- one full Chargeability source;
- one full Rate Capability source;
- one full approximately 200-cycle source shared by Cycles, Time/Capacity and Steps.

Do not add a separate source for every saved plot or quantity. Reuse each parsed source across all compatible cases.

The source binaries are intentionally not truncated. Keep the committed expected JSON bounded by projecting only the scientific fields required by Section 7. Large raw arrays are allowed only where the complete array is itself the contract, particularly Time/Capacity curves and Chargeability curves.

Record the total fixture size and golden-test runtime in the implementation record. If parsing the four full files makes preflight unreasonably slow, first profile the actual cost and optimize fixture setup so each source is parsed once. Do not replace full sources with trimmed extracts without returning for a specification decision.

## 4. Current implementation anchors

Read these before implementation:

- `AGENTS.md`: scientific ownership, test isolation, `CALC_VERSION`, preflight and maintained-tree rules.
- `docs/agent-knowledge/README.md`
- `docs/agent-knowledge/change-playbooks.md`
- `docs/agent-knowledge/state-and-performance.md`
- `docs/agent-knowledge/dcir-analysis.md`
- `docs/agent-knowledge/chargeability-analysis.md`
- `docs/agent-knowledge/rate-capability-analysis.md`
- `docs/steps-tab-series-redesign.md`
- `backend/app/services/calc.py::per_cycle`
- `backend/app/services/cache.py::{raw_path, cycles_path, load_raw, load_cycles}`
- `backend/app/services/analysis_engine.py::{default_spec, compute, compute_time_capacity, compute_steps, compute_dcir}`
- `backend/app/services/analysis_cache.py::_scientific_spec`
- `backend/app/services/chargeability.py::compute`
- `backend/app/services/rate_capability.py::compute`
- `backend/app/routers/analyses.py` family endpoints
- Existing tests, especially:
  - `tests/test_analysis_engine.py`
  - `tests/test_step_blocks.py`
  - `tests/test_dcir.py`
  - `tests/test_chargeability.py`
  - `tests/test_rate_capability.py`
  - `tests/test_rate_capability_corpus.py`
  - `tests/test_fast_neware.py`

Do not replace or weaken the existing synthetic tests. The golden corpus is an additional layer.

## 5. Target repository structure

Create:

```text
tests/
├── golden_analysis_support.py
├── test_golden_analysis.py
└── fixtures/
    └── golden_analysis/
        ├── README.md
        ├── manifest.json
        ├── approval.md
        ├── sources/
        │   ├── cycles_time_steps.ndax
        │   ├── dcir_source.<nda-or-ndax>
        │   ├── chargeability_source.<nda-or-ndax>
        │   └── rate_capability_source.<nda-or-ndax>
        ├── specs/
        │   ├── cycles_baseline.json
        │   ├── time_capacity_baseline.json
        │   └── ...
        └── expected/
            ├── cycles_baseline.json
            ├── time_capacity_baseline.json
            └── ...
scripts/
└── build_golden_analysis_corpus.py
docs/
├── agent-knowledge/
│   └── scientific-regression-testing.md
└── specs/
    └── 015-golden-analysis-regression-corpus.md
```

The exact source extensions must match the selected files. Generic fixture filenames are required; the manifest preserves the original checksum and source-analysis mapping.

Update:

- `.gitignore`: allow `.nda` and `.ndax` only below `tests/fixtures/golden_analysis/sources/`; keep general binary and Parquet ignores.
- `AGENTS.md`: add the new durable test/script/docs locations to the maintained repository tree.
- `docs/agent-knowledge/README.md`: link the new scientific-regression document.
- `docs/specs/README.md`: add Spec 015 to the index and reconcile the review path with the current separate-review-file convention.

Do not create the review file during implementation unless a review is actually performed.

## 6. Corpus data contract

### 6.1 `manifest.json`

Use a versioned manifest. Minimum shape:

```json
{
  "schema_version": 1,
  "description": "CellXplorer golden analysis regression corpus",
  "sources": [
    {
      "key": "cycles_time_steps",
      "binary_path": "sources/cycles_time_steps.ndax",
      "sha256": "64-lowercase-hex",
      "file_size_bytes": 0,
      "row_count": 0,
      "cycle_count": 0,
      "source_analysis": "Test analysis",
      "families": ["cycles", "time_capacity", "steps"]
    }
  ],
  "entities": {
    "cells": [],
    "replicate_groups": []
  },
  "cases": [
    {
      "id": "cycles_baseline",
      "kind": "cycles",
      "spec_path": "specs/cycles_baseline.json",
      "expected_path": "expected/cycles_baseline.json",
      "source_keys": ["cycles_time_steps"],
      "source_analysis": "Test analysis",
      "source_plot": "saved-plot-name-or-null",
      "comparison_profile": "scientific_default"
    }
  ],
  "comparison_profiles": {
    "scientific_default": {
      "relative_tolerance": 1e-7,
      "absolute_tolerance": 1e-9
    }
  }
}
```

Additional fields are allowed when documented in the fixture README.

Do not store:

- local absolute paths;
- database UUID;
- user notes/descriptions;
- credentials or unrelated local settings;
- customer/project names in fixture entity labels or filenames;
- analysis IDs from the live database as fixture identity.

### 6.2 Full binary source fixtures

Each manifest source points to one complete committed `.nda` or `.ndax` file.

Rules:

- verify the file checksum before parsing;
- do not trim, rewrite or normalize the binary;
- do not rely on a cache committed from another machine;
- use the production parser and cache builder to produce normalized raw and per-cycle data in the isolated test root;
- validate parsed row count, cycle count and required normalized columns against the manifest;
- preserve one source key for the approximately 200-cycle file and reuse it across Cycles, Time/Capacity and Steps cases;
- use the exact full files attached to the DCIR, Chargeability and selected Rate Capability analyses.

The test harness may keep parsed DataFrames/caches in memory or in its temporary data root for the duration of the module. It must not write generated Parquet into the repository fixture directory.

### 6.3 Protocol and source metadata

Protocol/header metadata must be obtained from the committed binary through the production parsing/import path. Do not maintain a hand-copied `protocol.json` as a second protocol source.

The manifest may store only the scalar fixture metadata that does not reliably come from the binary or that the user intentionally overrides for analysis reproduction, including:

- active mass;
- nominal capacity;
- electrode area;
- explicit fixture cell/test/source relationships.

Chargeability conditions, user-variable assignments, DCIR step definitions and Rate Capability protocol structure must come from the actual parsed source header, then be referenced by the normalized standalone analysis spec.

### 6.4 Entity metadata

The manifest must describe enough deterministic entities to recreate an isolated database:

- explicit fixture cell IDs and generic names;
- source-to-test-to-cell ordering;
- scalar cell metadata used by calculations:
  - active mass;
  - nominal capacity;
  - electrode area;
- replicate group membership and order where used.

Use explicit IDs from the manifest so output identity is stable.

### 6.5 Standalone specs

Each file in `specs/` is a complete normalized analysis spec that can run against fixture entity IDs without the local database.

When a case originates from a saved plot, reconstruct its effective scientific spec using the same merge semantics as `analysis_cache.saved_plot_data_signature`:

- analysis selection, with the saved plot's exclusions and hidden replicate groups;
- saved plot computation;
- saved plot aggregation;
- saved plot presentation where it changes backend output;
- analysis protocol and DCIR segment definitions.

Strip:

- saved plot IDs and thumbnails;
- local timestamps;
- unused saved plots;
- display-only fields that do not enter the chosen backend request, unless the case is specifically testing a backend display transformation such as Time/Capacity X-axis construction.

## 7. Required scientific coverage

The first corpus is incomplete unless all rows below are covered.

| Case | Required behavior |
|---|---|
| Cycles baseline | Per-cycle charge/discharge capacity and energy, CE/EE, voltage statistics, CV time/capacity, retention, polarization and summary metrics. Include a real CC→CV counter reset. |
| Cycles normalization | Specific capacity using active mass and one areal quantity path where the relevant family supports it. |
| Time/Capacity voltage-current | Full-precision, non-compact output with no display downsampling; verify continuous time and capacity across a step reset and exact null masking positions. |
| Time/Capacity derivative | One real dQ/dV or dV/dQ case with a fixed smoothing window and phase selection. |
| Steps | Explicit `(cell, segment)` series, occurrence/cycle/time X arrays, block quantities and block metadata. Include a multi-step block. |
| DCIR | At least one discharge and one charge rest/pulse series; absolute mΩ values, first-relative value of 0%, later relative change and measurement metadata. |
| Chargeability | Semantic candidate, initial/final SoC window, current ceiling, reference capacity and at least one executed curve with time/current/capacity/SoC arrays. |
| Rate Capability | At least one real detected sweep; CC-only capacity, selected rates, cutoff validation result and normalized retention. Include charge/discharge asymmetry only when both families exist in the source. |

Prefer one representative case per distinct scientific computation. Do not create duplicate golden files for saved plots that differ only in color, title, legend or other frontend presentation. The source file remains complete, but an individual Time/Capacity, Steps, DCIR or Chargeability case may use the bounded cycle/step/occurrence selection stored in its analysis spec.

Replicate aggregation remains covered by the existing synthetic tests in this initial four-source corpus. Do not manufacture a second "replicate" by attaching the same binary to two fixture cells. A real multi-cell golden replicate case can be added later with separately approved full sources.

If no suitable local Rate Capability source exists, stop and report the missing fixture instead of silently omitting that family.

## 8. Scientific approval checkpoints

Create `approval.md` and record the initial approved checkpoints. Each checkpoint must state:

- fixture/case;
- exact raw rows or protocol fields used;
- formula;
- expected value and unit;
- how it was independently checked;
- approver and date.

Minimum checkpoints:

1. **CC+CV capacity:** manually sum the charge step deltas and confirm the per-cycle charge capacity.
2. **Efficiency:** independently calculate CE and one EE value.
3. **Time/Capacity continuity:** show the raw counter reset and the expected cumulative half-cycle capacity after the reset.
4. **Steps:** manually calculate one block duration or phase time from its selected raw records.
5. **DCIR:** calculate one charge and one discharge resistance from `Vrest`, `Vpulse` and median pulse current.
6. **Chargeability:** derive one initial/final SoC window and reference capacity from protocol conditions/raw data.
7. **Rate Capability:** verify one plotted point uses only the swept CC-step capacity and excludes CV capacity; verify the chosen common reference rate.

The implementation agent may prepare these calculations, but the expected corpus must not be described as scientifically approved until the user has reviewed them. Until then, mark `approval.md` as `pending user approval` and make this status visible in the implementation record.

The automated tests still run while approval is pending, but the branch is not ready to merge as a scientific golden baseline.

## 9. Corpus builder

Implement `scripts/build_golden_analysis_corpus.py`.

Minimum behavior:

```powershell
python scripts\build_golden_analysis_corpus.py export `
  --data-root "$env:USERPROFILE\.cellxplorer" `
  --cycles-analysis "Test analysis" `
  --dcir-analysis "DCIR test" `
  --chargeability-analysis "Chargeability test" `
  --rate-analysis "<analysis-title-or-id>" `
  --output tmp\golden-analysis-candidate
```

Exact CLI spelling may differ, but document it in `--help` and the fixture README.

Requirements:

1. Refuse to use the same directory as the live data root for output.
2. Create a consistent temporary SQLite snapshot using the SQLite backup API before reading analysis records.
3. Resolve analyses unambiguously. If a title matches more than one analysis, require an explicit analysis ID.
4. Resolve the exact full source file used by each selected analysis.
5. For `Test analysis`, select one suitable full `.ndax` source of roughly 200 cycles for Cycles, Time/Capacity and Steps; do not export all 25 cells.
6. Verify source existence and calculate SHA-256, file size, parsed row count and cycle count.
7. Copy the four binaries unchanged to the candidate `sources/` directory under generic filenames.
8. Recreate generic fixture entities and standalone analysis specs without retaining live database IDs as fixture identity.
9. Parse the copied files through production services and produce candidate expected projections plus a clear numerical diff/summary.
10. Never overwrite an existing output directory unless an explicit `--replace` flag is supplied.
11. Never write directly to `tests/fixtures/golden_analysis/` implicitly.
12. Do not create trimmed binary copies or extracted raw Parquet fixtures.

Add a `verify` mode that checks the committed manifest, file hashes, parsed dimensions and all expected outputs. Missing or mismatched binaries must fail clearly; do not report a skip as success.

## 10. Test harness

### 10.1 Fixture installation

`tests/golden_analysis_support.py` must:

1. Load and validate manifest schema version 1.
2. Verify all four committed source SHA-256 values before any scientific comparison.
3. Create an isolated SQLite database using `Base.metadata.create_all()`; this is allowed for isolated tests.
4. Insert deterministic fixture `Cell`, `CellMetadata`, `SourceFile`, `Test`, `TestFile`, `ReplicateGroup` and membership rows.
5. Use the production parsing/import path to populate each fixture source's parsed header/source metadata and to build raw and per-cycle caches under the temporary `CELLXPLORER_DATA`.
6. Parse each binary at most once during the test module, then reuse the same isolated cache for every case that references it.
7. Validate manifest row count, cycle count and required normalized columns after parsing.
8. Clean up its temporary database and caches after the module.

Do not copy precomputed raw or per-cycle Parquet into the fixture. Parsing and `calc.per_cycle` are part of the required regression path.

### 10.2 Production dispatch

Use a small test-only dispatch table from manifest kind to the production service call. Do not add a new production abstraction only for the tests.

For Time/Capacity golden cases:

- use `precision="full"`;
- use `compact=False`;
- set `max_points_per_cell` above the fixture row count;
- use a fixed `viewport_width`;
- therefore do not test pixel-budget downsampling in the scientific golden corpus.

Downsampling remains covered by focused unit tests.

### 10.3 Stable projection

Before comparison, transform the production response into a stable scientific projection.

Exclude volatile fields:

- `computed_at`;
- `cache_status`;
- local paths;
- current source availability badges;
- `current_parser_version` and `current_calc_version`;
- progress/job data;
- purely descriptive text that is not part of a scientific contract.

Preserve:

- response `type`;
- parser/calc provenance recorded in the fixture manifest, not necessarily as equality assertions;
- cell/series identities after fixture anonymization;
- X arrays;
- scientific quantities;
- metrics and aggregation values;
- block/DCIR/chargeability/rate metadata used to explain values;
- non-availability scientific badge kinds and their stable identifiers;
- source fixture hashes and ordering where they are part of provenance.

Normalize dictionary key order and sort only collections whose production contract is unordered. Do not sort time-series arrays or series whose order is meaningful.

## 11. Comparison rules

Implement one recursive comparator with path-aware failure messages.

Rules:

- dictionary keys: exact;
- strings, booleans and integers: exact;
- list length and order: exact unless the manifest explicitly marks the path unordered;
- `null`: exact;
- finite floats: `math.isclose` with the case comparison profile;
- NaN or infinity in actual scientific output: fail unless the expected value explicitly represents an allowed missing value as `null`;
- float tolerance exceptions: allowed only as documented path-specific overrides in the manifest.

Default tolerance:

```text
relative_tolerance = 1e-7
absolute_tolerance = 1e-9
```

Do not solve failures by broadly loosening tolerances. A tolerance change requires a documented reason in the implementation/review record.

Failure output must identify at least:

```text
case id
JSON path
expected value
actual value
absolute difference
allowed tolerance
```

## 12. Tests

Create `tests/test_golden_analysis.py` with at least:

1. Manifest/schema, binary checksum and file-integrity validation.
2. A test proving there are exactly four source binaries with the locked family mapping.
3. Parsed raw column/dtype, row-count and cycle-count validation for every source.
4. A test proving the approximately 200-cycle file is reused by Cycles, Time/Capacity and Steps cases.
5. One subtest per manifest case that recomputes and compares the stable projection.
6. A test that mutates one expected nested float in memory and proves the comparator reports the precise path.
7. A test that NaN/infinity cannot pass unnoticed.
8. A test that missing source/spec/expected files fail with a useful message.
9. A test that the normal run does not access the live database or any path outside the fixture/test data roots.
10. A test or instrumentation assertion proving each source parser is invoked no more than once per module run.
11. A test that corpus generation is not invoked by normal test execution.

The test module must be discoverable by `scripts/run_backend_tests.py`; no new preflight stage is needed.

## 13. Cache, migration and version consequences

- No database migration.
- No production schema change.
- No frontend change.
- No `CALC_VERSION`, `PARSER_VERSION`, analysis result-schema or cache-version bump for adding this infrastructure.
- Future intentional scientific changes that alter golden output must:
  1. make the normal golden test fail first;
  2. decide and implement the appropriate `CALC_VERSION` or per-kind result-schema bump independently;
  3. regenerate a candidate;
  4. review the numerical diff and approval checkpoints;
  5. explicitly replace the expected output.

The golden updater must never hide a missing version-bump decision.

## 14. Documentation

Create `docs/agent-knowledge/scientific-regression-testing.md` containing:

- purpose and coverage of synthetic versus full-source golden tests;
- the locked four-source corpus selection;
- corpus file contract;
- how to add or replace a case;
- how to run and verify the corpus;
- how to review an intentional scientific change;
- source privacy and checksum rules;
- tolerance policy;
- runtime rule: parse each source once and reuse isolated caches.

The fixture `README.md` should be operational and shorter, with exact commands, a source table and a case table.

## 15. Out of scope

- Trimming or synthesizing the four approved source binaries.
- Committing the user's SQLite database.
- Adding more than the four initial full source files without a later scope decision.
- Introducing Git LFS or another external fixture store without approval.
- Frontend screenshot or Plotly image regression tests.
- Portable HTML/PDF visual regression.
- Refactoring `AnalysisPage.tsx`.
- Changing scientific formulas.
- Automatically accepting new outputs.
- Replacing focused synthetic/unit tests.

## 16. Implementation order

1. Inspect the live database and selected analyses read-only through a temporary SQLite snapshot.
2. Identify the exact full files for DCIR, Chargeability and Rate Capability.
3. Identify one suitable full approximately 200-cycle `.ndax` file from `Test analysis` for Cycles, Time/Capacity and Steps.
4. Report filenames, extensions, checksums, sizes, row counts, cycle counts, analysis mappings and estimated committed total before copying anything into the repository.
5. Copy the four unchanged binaries to a candidate fixture directory using generic filenames.
6. Implement manifest validation, source checksum validation and the recursive comparator with unit tests.
7. Implement isolated fixture database creation and production parser/cache construction, with one parse per source.
8. Add production-service dispatch and stable projections.
9. Generate standalone specs and candidate expected outputs from the selected analyses.
10. Perform and document independent scientific checkpoints.
11. Copy the reviewed candidate into `tests/fixtures/golden_analysis/`.
12. Add all golden cases and run focused tests.
13. Update `.gitignore`, repository tree, knowledge docs and spec index.
14. Run full preflight and record exact results, source/fixture size and golden-test runtime.

## 17. Verification

Focused commands:

```powershell
python -m unittest tests.test_golden_analysis -v
python scripts\build_golden_analysis_corpus.py --help
python scripts\build_golden_analysis_corpus.py verify `
  --manifest tests\fixtures\golden_analysis\manifest.json
```

Regression suites:

```powershell
python -m unittest discover tests
python scripts\preflight.py --no-cache
```

Record:

- exact source files, SHA-256 values and sizes;
- parsed row and cycle counts;
- focused test result and duration;
- parser invocation count for each source;
- full backend result;
- full preflight result;
- total fixture directory size;
- approval status.

Do not claim user approval if it was not performed.

## 18. Acceptance criteria

- [ ] Exactly four complete Neware source binaries are committed.
- [ ] The full source used by `DCIR test` is the DCIR fixture.
- [ ] The full source used by `Chargeability test` is the Chargeability fixture.
- [ ] The full source used by the selected Rate Capability analysis is the C-rate fixture.
- [ ] One full approximately 200-cycle `.ndax` source is shared by Cycles, Time/Capacity and Steps.
- [ ] No source binary is trimmed, rewritten or replaced by extracted Parquet.
- [ ] Corpus tests run from a clean checkout without the live database or external source paths.
- [ ] Every binary checksum is verified before parsing.
- [ ] Production parsing and `calc.per_cycle` run inside the isolated test environment.
- [ ] Each source is parsed no more than once per test-module run.
- [ ] The six current scientific families are represented.
- [ ] Production analysis services are called directly for every case.
- [ ] Volatile response fields are excluded without discarding scientific structure.
- [ ] Exact/discrete and tolerant/float comparisons follow the locked rules.
- [ ] A deliberate numerical perturbation produces a clear path-specific failure.
- [ ] Expected outputs cannot be regenerated or accepted by normal preflight.
- [ ] `approval.md` contains all mandatory checkpoints and states the true approval status.
- [ ] Existing synthetic tests remain intact.
- [ ] No migration or production cache/version bump was introduced solely for the test infrastructure.
- [ ] `.gitignore`, `AGENTS.md`, knowledge index and spec index are updated.
- [ ] Source fixture size and test runtime are recorded.
- [ ] `python scripts\preflight.py --no-cache` passes.

## 19. Cursor Composer handoff

Implement `docs/specs/015-golden-analysis-regression-corpus.md` on branch `feature/golden-analysis-regression-corpus`, created from current `main`.

Read the whole spec and all files listed in **Current implementation anchors** before editing. Inspect the local database and analyses only through an explicit read-only SQLite snapshot. Do not modify the user's live database or source files.

The corpus must use four complete source binaries: the exact full files behind `DCIR test`, `Chargeability test` and the selected Rate Capability analysis, plus one full approximately 200-cycle `.ndax` file from `Test analysis` shared by Cycles, Time/Capacity and Steps. Do not trim or convert these source inputs to Parquet fixtures.

Start by reporting:

1. the exact `main` commit and feature-branch merge base;
2. the analysis IDs/titles and saved plots found for `Test analysis`, `DCIR test`, `Chargeability test` and the selected Rate Capability analysis;
3. the exact source file proposed for each family;
4. each source extension, SHA-256, size, parsed row count and cycle count;
5. confirmation that the approximately 200-cycle source contains the required CC→CV reset and Steps block;
6. estimated committed corpus size and expected golden-test runtime.

Do not copy files into the repository until this inspection is complete. Then implement in the specified order. Do not treat current application output as scientifically approved without the independent checkpoints.
