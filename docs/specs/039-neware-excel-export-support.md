# 039 — Neware Excel export support

**Status:** Plan — implement only through the sequential child specifications listed below  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring baseline:** `main` and `origin/main` at `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`  
**Merge base:** `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`  
**Shared branch:** `feature/neware-excel-support`  
**Depends on:** None. Preserve every `.nda`/`.ndax` import, source-lifecycle, cache, protocol and analysis behavior present on the current `main` when each child starts.  
**Coordination:** [`039-agent-coordination.md`](039-agent-coordination.md)

Every child must read:

- `AGENTS.md`;
- `docs/specs/README.md`;
- `docs/agent-knowledge/README.md`;
- `docs/agent-knowledge/architecture.md`;
- `docs/agent-knowledge/state-and-performance.md`;
- `docs/agent-knowledge/change-playbooks.md`;
- `docs/parser-capacity-findings.md`.

Children that touch a specific analysis family must also read its specialist knowledge document and
`docs/agent-knowledge/scientific-regression-testing.md`. Child 039.3 changes import UI and therefore
also inherits `docs/agent-knowledge/visual-style-guide.md`. Child 039.4 touches packaging/release
closure and must additionally read the current Windows packaging and release guidance.

## Why this is a parent specification

Neware can export a completed or running test as an Excel workbook. In practice this can happen by
mistake, leaving a scientifically valid measurement available only as `.xlsx` rather than the
`.nda`/`.ndax` formats CellXplorer currently accepts.

The supplied Neware workbook is not a generic spreadsheet. It is a structured Neware export with
separate point-level records, cycle summaries, executed-step summaries, programmed protocol,
metadata and logs. The point-level and protocol information are rich enough to map the workbook to
CellXplorer's existing canonical raw-data and protocol structures.

That makes Excel support feasible without adding an Excel-specific analysis subsystem. However, the
feature crosses several sensitive boundaries:

- raw electrochemical units and counter semantics;
- programmed step identity versus executed step occurrence;
- metadata and protocol reconstruction;
- parser/cache reproducibility;
- bounded import inspection and background work;
- source update and continuation behavior;
- all six analysis families;
- Windows sidecar packaging.

Implementing all of that as one checkpoint would make it difficult for a coding model to isolate
mistakes and for a reviewer to distinguish a parser defect from an import or analysis integration
defect. This parent therefore locks the complete target while four children implement and review
one coherent boundary at a time.

## Product goal

CellXplorer must accept **structured Neware `.xlsx` exports** as another Neware source format and
map them into the same internal structures already used for `.nda` and `.ndax`.

After import, normal downstream code should not need to ask whether the original source was binary
Neware or Neware Excel. The intended flow is:

```text
Neware source (.nda / .ndax / supported .xlsx)
        ↓
format-dispatched parser
        ↓
canonical raw DataFrame
        ↓
versioned raw Parquet cache
        ↓
existing calc.per_cycle(...)
        ↓
versioned cycle Parquet cache
        ↓
existing source lifecycle and analyses
```

The feature is complete only when a Neware Excel source behaves as a normal Cell source through
import, cache rebuild, source checking/updating and applicable analyses.

## Plain-language model

| Concept | Meaning | Locked owner |
|---|---|---|
| Neware Excel export | Structured workbook produced by Neware software, not an arbitrary user spreadsheet | `backend/app/services/neware_excel.py` plus parser dispatch |
| `record` sheet | Point-level scientific measurement records | Scientific source of truth for raw data |
| `step` sheet | One row per executed step occurrence | Independent cross-check for raw step reconstruction |
| `cycle` sheet | Neware's cycle-level summary | Independent cross-check for CellXplorer's raw-derived cycle results |
| `test` sheet | Test metadata plus programmed step plan | Source for declared protocol metadata when fields are present |
| `unit` sheet | Export/source/device/unit metadata | Optional metadata only |
| `step_index` | Programmed Neware protocol-step number | Existing canonical raw column |
| `step` | Unique executed step occurrence | Existing canonical raw column |
| Parser version | Reproducibility identity of the parser bundle | Existing global `parsing.PARSER_VERSION` contract |
| Scientific calculations | Capacity, energy, DCIR, Steps, Chargeability, C-rate, etc. | Existing backend services; not the Excel parser |

## Supplied workbook — verified reference facts

The workbook supplied while authoring this specification was inspected directly. These values are
reference facts for implementation and review, not guesses about every possible Neware export.

### Workbook structure

| Sheet | Used range | Meaning |
|---|---:|---|
| `unit` | `A1:I7` | Source path, device tuple, test start/end and unit labels |
| `test` | `A1:W37` | Test metadata plus programmed step plan |
| `cycle` | `A1:H41` | 40 Neware cycle-summary rows |
| `step` | `A1:K202` | 201 executed-step-summary rows |
| `record` | `A1:P13983` | 13,982 point-level records plus header |
| `log` | `A1:G228` | Neware event log |
| `idle` | `A1:F1` | Empty in this export |
| `curve` | `A1:A1` | Empty in this export |

### Verified scientific/structural observations

- `record.DataPoint` runs uniquely and monotonically from 1 through 13,982.
- `record.Cycle Index` spans 1 through 40.
- `record.Total Time(min)` is monotonic non-decreasing.
- The `test` step plan contains 26 rows:
  - 20 executable measurement/rest steps;
  - 5 `Cycle` control steps;
  - 1 `End` control step.
- The `step` sheet contains 201 unique executed `Step Number` values.
- A programmed `Step Index` can execute more than once within the same cycle.
- In the supplied workbook, splitting `record` whenever cycle, programmed step, normalized status
  changes, or step-relative time decreases yields exactly 201 execution segments.
- Those 201 derived segments match the `step` sheet sequentially for cycle, programmed step, step
  type, onset, end and duration.
- Recalculating per-cycle capacity from the raw records with CellXplorer's existing per-executed-step
  delta semantics agrees with the Neware `cycle` summary to approximately:
  - maximum charge-capacity deviation `0.0009 mAh`;
  - maximum discharge-capacity deviation `0.0004 mAh`.
- Charge/discharge time agrees to approximately `0.00034 min`.
- Trapezoidal integration of `Power(W)` against elapsed time agrees with the workbook cycle-energy
  summaries to approximately `0.0052 mWh`.
- The test metadata exposes at least:
  - active material `19.21 mg`;
  - nominal capacity `3.3 mAh`;
  - test start `2026-07-17 11:21:32`;
  - builder and remarks;
  - global voltage protection bounds;
  - record settings.
- The Excel export does **not** expose every binary Neware condition expression/global-user-variable
  field needed for CellXplorer's semantic Chargeability auto-recognition.

The real workbook contains identifying paths/remarks. It must not be committed to the repository
unless the user separately gives explicit privacy approval. Compact synthetic workbooks should be
generated in tests.

## Locked decisions

### 1. This is a Neware Excel importer, not a generic Excel importer

Supported new format:

```text
.xlsx produced in the expected structured Neware export layout
```

Explicitly out of scope:

```text
arbitrary Excel files
.xls
.xlsm
CSV-as-a-substitute
user-authored column mapping
```

A workbook renamed to `.xlsx` but lacking the required Neware structure must fail clearly.

### 2. `record` is the scientific source of truth

The canonical raw DataFrame must be reconstructed from the point-level `record` sheet.

The `cycle` and `step` sheets are independent verification layers. They must never be used to hide a
wrong raw mapping by replacing CellXplorer-derived values with Neware's summaries.

### 3. Preserve both step identities

The parser must produce both existing concepts:

```text
step_index = programmed protocol step number
step       = unique executed step occurrence
```

Do not collapse them into one field.

This distinction is necessary because:

- protocol selection/recognition operates on programmed steps;
- capacity/time aggregation and Steps occurrence analysis need actual executions;
- one programmed step can run repeatedly within one cycle because of loop control.

### 4. Do not delete or disable Steps analysis

The supplied workbook has enough information to reconstruct executed steps safely. Missing an
optional `step` summary sheet in some future workbook may reduce independent validation, but it does
not by itself make Steps unsupported: execution boundaries can be derived from the raw record.

If a workbook cannot produce a reliable programmed/executed-step mapping, that particular workbook
must fail closed rather than silently producing incorrect Steps data.

### 5. Preserve one canonical downstream data model

Do not introduce:

- Excel-specific cycle calculations;
- Excel-specific Steps calculations;
- Excel-specific DCIR formulas;
- Excel-specific Chargeability extraction;
- Excel-specific Rate Capability extraction;
- an Excel-only cache format.

The parser's job is to convert source semantics into the existing canonical raw/protocol structures.
Existing analysis services then remain authoritative.

### 6. Missing protocol information must remain missing

Do not infer, synthesize or guess Neware condition expressions, jump logic or global-user-variable
assignments that are absent from the export.

The parser may expose explicit capability metadata/warnings such as:

```text
protocol_conditions_available = false
```

Downstream recognition must degrade honestly. In particular, Chargeability auto-recognition may
return no match for an Excel source whose workbook does not contain the required expressions.

### 7. Preserve current metadata ownership

Current `main` deliberately stores the complete parsed header once per source in
`SourceFile.header_meta`. `CellMetadata` receives only curated Cell-level summary fields plus user
metadata/overrides.

Excel support must **not** reintroduce the old behavior of expanding the complete source metadata
into thousands of `CellMetadata` rows.

### 8. Preserve bounded import inspection

`backend/app/services/import_inspection.py` currently:

- hashes/reads source files outside a DB session;
- caches header metadata by `(hash, size, mtime_ns)`;
- samples one source first;
- uses bounded multiprocessing only for larger batches;
- verifies size/mtime did not change while inspection ran.

Excel inspection must plug into that pipeline. It must not make list/folder enumeration parse
workbooks or turn inspection into a long SQLite transaction.

### 9. Preserve source identity and source lifecycle

SHA-256 of the original workbook bytes remains the source identity. Existing online/offline/changed
state, conservative source adoption, continuation/source ordering and cache replacement semantics
remain in force.

### 10. Preserve global parser-version provenance

Current caches and analyses pin one global parser version. This feature must not introduce per-format
parser provenance in one analysis.

Use a deterministic parser-bundle identity that changes when the Excel canonical mapping changes
while continuing to incorporate the binary Neware parser version.

### 11. Do not bump `CALC_VERSION` for parser support alone

Adding a source-format parser changes parser identity, not the scientific meaning of
`calc.per_cycle` or other existing calculations.

If implementation discovers that a scientific formula must change to support Excel, stop for an
explicit parent amendment. Do not silently bundle that change into this feature.

### 12. No database migration is expected

`SourceFile.ext` already stores a short string, `header_meta` is JSON, and source parser state already
has a parser-version field. `.xlsx` does not require a new table/column.

If implementation appears to require a schema change, stop and re-evaluate before adding a
migration.

### 13. First supported workbook contract is the verified English Neware export

Header lookup may normalize:

- case;
- leading/trailing whitespace;
- repeated internal whitespace.

Do not use fuzzy matching to guess semantically different columns. Localized export headers are a
future extension unless a second verified export establishes their contract.

### 14. Capability degradation is explicit

Required raw capability:

```text
record sheet + required record columns
```

Optional validation/metadata capability:

```text
step sheet  → executed-step cross-check
cycle sheet → cycle-result cross-check
test sheet  → metadata + declared protocol
unit sheet  → auxiliary metadata
log sheet   → preserved/ignored auxiliary source information
```

A missing optional sheet must not cause scientific values to be fabricated.

## Current verified implementation and anchors

The child specs reverify exact code before editing. At this parent baseline, important anchors are:

### Parser boundary — `backend/app/services/parsing.py`

- module contract: direct `NewareNDA` integration lives here;
- `PARSER_VERSION = NewareNDA.version.__version__`;
- `RAW_COLUMNS`;
- `parse_timeseries`;
- `_flatten`;
- fast direct `.ndax` XML header path `_read_ndax_metadata_flat`;
- `read_header_metadata`;
- metadata normalization and `protocol.reconstruct_protocol` call.

### Cache boundary — `backend/app/services/cache.py`

- cache identity `(file hash, parser version, calc version)`;
- `raw_path`;
- `cycles_path`;
- `build`;
- `build_write_behind`;
- `load_raw` / `load_raw_columns`;
- `load_cycles`;
- `schedule_build` and current-version background-build de-duplication.

### Current import inspection — `backend/app/services/import_inspection.py`

- `_HEADER_CACHE_LIMIT`;
- `remember_header_metadata` / `cached_header_metadata`;
- `FileInspection`;
- `inspect_file`;
- `inspect_files`;
- current extension check `.nda/.ndax`;
- source-size/mtime stability verification;
- immutable identity snapshot/matching.

### Import/API boundary — `backend/app/routers/files.py`

- `import_filename_allowed`;
- `_inspect_import_path`;
- `_metadata_preview`;
- `cell_metadata_from_header`;
- upload/path/folder selection endpoints;
- preview and raw-data endpoints;
- Cell registration and background cache preparation.

### Background source lifecycle — `backend/app/services/scanner.py`

- current `.nda/.ndax` scan wording/filter;
- `source_signature` / `_require_signature`;
- cache preparation;
- source parsing/update paths;
- conservative handling of files that change during reads.

### Scientific consumers

- `backend/app/services/calc.py` — raw-to-cycle aggregation;
- `backend/app/services/protocol.py` — declared protocol normalization/signatures/groups;
- `backend/app/services/step_blocks.py` — executed-block aggregation;
- `backend/app/services/dcir.py` — rest/pulse recognition and occurrence calculations;
- `backend/app/services/chargeability.py` — semantic condition matching and curves;
- `backend/app/services/rate_capability.py` — rate-sweep recognition and CC capacity;
- `backend/app/services/analysis_engine.py` — raw/cycle loading, stitching and analysis-family orchestration.

## Target architecture

The final backend ownership should be conceptually:

```text
backend/app/services/
├── parsing.py
│   └── public source-format dispatch + shared metadata normalization
├── neware_excel.py
│   └── Neware Excel workbook recognition, record mapping, metadata/protocol mapping and validation
├── cache.py
│   └── unchanged canonical raw/cycle Parquet ownership
├── calc.py
│   └── unchanged scientific per-cycle ownership
├── protocol.py
│   └── unchanged normalized protocol ownership, plus bounded capability warning if needed
├── import_inspection.py
│   └── unchanged bounded inspection strategy, now accepting supported .xlsx
└── scanner.py
    └── unchanged lifecycle semantics, now discovering supported .xlsx
```

`neware_excel.py` must not import routers or analysis services. Routers/scanner must not import
`openpyxl` directly.

## API/data/cache/migration consequences

Expected parent-level consequences:

- **API:** existing import/source endpoints accept one additional extension; no parallel Excel API.
- **Raw data:** existing canonical raw columns; optional extra Excel-origin columns may be retained as
  auxiliary columns where useful.
- **Cycle data:** generated by current `calc.per_cycle`.
- **Metadata:** existing normalized result shape, plus bounded source-format/capability metadata if
  useful and backward compatible.
- **Cache:** same raw/cycle Parquet layout keyed by a new current parser-bundle version.
- **Analysis caches:** no new family-specific cache identity unless review identifies a real existing
  dependency issue unrelated to source format.
- **Database:** no migration.
- **Scientific version:** no `CALC_VERSION` bump.
- **Dependency:** add one bounded `openpyxl` dependency and prove packaged-sidecar availability.

## Child specifications and dependency graph

| Child | Purpose | Depends on |
|---|---|---|
| [039.1](039.1-neware-excel-timeseries-parser.md) | Recognize a Neware workbook and map `record` into the canonical raw DataFrame, including executed-step identity and energy semantics | Parent |
| [039.2](039.2-neware-excel-metadata-protocol-and-cache.md) | Reconstruct metadata/protocol, add parser dispatch/versioning/cache validation and prove backend scientific compatibility | 039.1 |
| [039.3](039.3-neware-excel-import-and-source-lifecycle.md) | Make `.xlsx` a user-visible import/source format through bounded inspection, scanning, registration, source updates and packaged runtime | 039.1–039.2 |
| [039.4](039.4-neware-excel-analysis-regression-and-closure.md) | Prove all applicable analysis families, real-workbook behavior, documentation/release closure and final parent integration | 039.1–039.3 |

All four children use the one shared branch `feature/neware-excel-support` and are review-gated.
Do not merge between children.

## Parent-level scientific invariants

1. Raw point count is preserved exactly.
2. `record_index` preserves source point ordering.
3. `cycle` preserves Neware's exported cycle index before any existing multi-source stitching logic.
4. `step_index` is programmed-step identity.
5. `step` is executed-occurrence identity.
6. Step-relative `time_s` retains reset semantics expected by existing display/aggregation code.
7. `timestamp` preserves source timestamps and may contain duplicates.
8. Capacity counters retain their source per-step reset semantics; do not convert them into cycle
   totals inside the parser.
9. Reconstructed energy counters have the same per-executed-step reset semantics expected by
   `calc.per_cycle`.
10. Current sign, status and phase semantics remain compatible with existing services.
11. `calc.per_cycle` remains the owner of cycle-level calculations.
12. Programmed protocol semantics are reconstructed only from explicitly exported fields.
13. Summary sheets validate the mapping but never override raw-derived results.
14. Missing condition expressions do not create false Chargeability matches.
15. Existing `.nda/.ndax` outputs are unchanged except for the intentional parser-version identity
    required by the global bundle contract.

## Parent-level failure policy

Fail closed when correctness is uncertain.

Examples that should reject the workbook rather than guess:

- missing required `record` columns;
- duplicate or invalid `DataPoint` identity;
- non-numeric required current/voltage/time fields;
- unknown non-empty executed step type without a verified mapping;
- impossible execution-step reconciliation when a `step` summary is present;
- cycle/step identity mismatches too large to be explained by documented rounding/record interval;
- changing source bytes during inspection/update;
- corrupt/unsupported ZIP/XML workbook structure.

Warnings/capability degradation are appropriate for:

- missing `cycle` summary;
- missing `step` summary when raw boundaries remain unambiguous;
- missing `test` declared-protocol metadata;
- absent condition-expression metadata.

## Performance invariants

- Import folder/list enumeration remains filesystem-only and bounded; it must not open workbooks per
  displayed row.
- `read_header_metadata` for Excel must not scan all point-level `record` rows.
- Full `record` parsing happens in the existing preview/cache/background scientific-work paths, not
  in list endpoints or SQLite registration transactions.
- Use `openpyxl` read-only iteration for large worksheets.
- Do not construct an ORM row per raw record.
- Do not expand full workbook metadata into `CellMetadata`.
- Preserve current adaptive import inspection strategy and process bounds.
- Preserve cache build de-duplication/atomic writes.

## Privacy and fixture policy

The supplied real workbook is useful as an acceptance reference but may contain private source path,
operator/builder and remarks metadata.

Unless explicitly approved by the user:

- do not commit it;
- do not add it to the golden corpus;
- do not paste private path/remark contents into test snapshots;
- generate compact synthetic `.xlsx` fixtures in tests;
- record real-workbook checks as local/read-only verification.

If the user later approves an anonymized or real fixture, follow the existing golden-corpus privacy
and scientific-approval conventions.

## Parent-level out of scope

- generic spreadsheet import;
- `.xls` or `.xlsm` support;
- localized header dictionaries without verified source examples;
- Arbin/BioLogic/Maccor/generic cycler adapter architecture;
- writing or repairing Excel workbooks;
- automatic conversion from `.xlsx` to `.nda/.ndax`;
- new scientific formulas or analysis families;
- redesign of Cell import UX;
- redesign of continuation/multi-source semantics;
- database schema changes;
- per-format parser versions in one analysis;
- automatic invention of missing Neware conditions;
- committing private source files without explicit approval.

## Parent-level acceptance

- A valid structured Neware `.xlsx` is accepted through normal Cell import and source workflows.
- An arbitrary `.xlsx` is rejected clearly.
- The workbook maps to the same canonical raw/cycle structures used by `.nda/.ndax`.
- Programmed and executed step identities remain distinct and correct.
- The supplied reference workbook yields 13,982 raw rows, 40 cycles, 201 executed steps and 26
  programmed plan rows when checked locally.
- Raw-derived capacities/times/energies agree with independent Neware summaries within the locked
  tolerances defined in the child specs.
- Cycles, Time/Capacity and Steps work for the supplied workbook.
- DCIR/Rate Capability/Chargeability use the existing applicability rules; absence of a pattern is
  not misreported as parser failure.
- Missing Chargeability condition expressions produce a truthful limitation/no-match, never a
  fabricated semantic match.
- Source checking/updating/rebuilding works for `.xlsx` under the existing conservative lifecycle.
- Full header metadata remains one `SourceFile.header_meta` JSON document per source.
- Import inspection remains bounded and does not regress the large-batch path.
- Existing `.nda/.ndax` behavior remains scientifically unchanged.
- No migration is added.
- `CALC_VERSION` is unchanged.
- Parser/cache provenance is deterministic.
- The packaged Windows backend can import `.xlsx`.
- All four children have implementation records and clean reviews.
- Final parent-level verification and documentation closure are recorded exactly.

## Final verification and closure

Each child defines focused checks. After 039.4 and all child reviews are clean, run the current
canonical verification from repository root, including at minimum:

```powershell
python -m unittest discover tests
node --test frontend\tests\*.test.ts
python scripts\preflight.py --no-cache
python scripts\check_versions.py
```

Because 039.3 changes frontend source files, the final no-cache preflight must include TypeScript and
production bundle verification under the current preflight policy.

Packaging verification must follow the live Windows packaging guidance. Do not claim a packaged
`.xlsx` import worked unless the frozen sidecar/application was actually exercised.

Manual/browser checks must be recorded as **RUN** or **NOT RUN**. Do not let an automated test/build
stand in for file-picker behavior, error rendering or packaged-runtime verification.

The parent closes only after:

- 039.1–039.4 are independently review-clean;
- the final cumulative reviewer compares the complete branch with the merge base;
- branch scope contains no unrelated implementation;
- final docs/status/index/changelog/version state matches reality;
- no undocumented deviation from the locked decisions remains.
