# 040 — Canonical cycler data architecture

**Status:** Plan — shared branch created; 040.1 is the first authorized implementation child  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring baseline / merge base:** `main` at `562c2edff1277fef71789244c95e3b17abc586fa` (`0.22.0-beta.5`)  
**Shared branch:** `feature/spec-040-canonical-cycler-data-architecture`  
**Depends on:** Parent 039 (`Neware Excel export support`) complete/review-clean and merged. Its final 039.4 review records the fresh cumulative Parent 039 review as clean.  
**Coordination:** [`040-agent-coordination.md`](040-agent-coordination.md)

Every child must read:

- `AGENTS.md`;
- `docs/specs/README.md`;
- `docs/agent-knowledge/README.md`;
- `docs/agent-knowledge/architecture.md`;
- `docs/agent-knowledge/state-and-performance.md`;
- `docs/agent-knowledge/change-playbooks.md`;
- `docs/agent-knowledge/scientific-regression-testing.md`;
- `docs/parser-capacity-findings.md`;
- Parent 039 and `reviews/039.4-neware-excel-analysis-regression-and-closure-review.md`, because 040 deliberately replaces 039's intentionally global Neware parser bundle with the permanent multi-cycler architecture.

Children that touch analysis or portable-report provenance must additionally read the current analysis/portable-report documentation. Child 040.4 changes plotting/API behavior and therefore also inherits `docs/agent-knowledge/visual-style-guide.md`.

## Why this is a parent specification

CellXplorer currently has a useful and scientifically sensible cycling representation, but that representation is **implicitly owned by the Neware parser**. The application expects fields such as cycle, programmed step, executed step, status, step-relative time, current, voltage, capacity and energy, and many downstream calculations are built around those meanings.

That model is worth preserving. The problem is not that it is Neware-like; the problem is that its semantics are not yet declared as a **CellXplorer contract** and parser/cache provenance is still structured around one Neware parser bundle.

Parent 039 extends Neware support to structured `.xlsx` exports by adapting those workbooks to the same raw/protocol model. Parent 040 takes the next architectural step:

1. make the existing Neware-like representation an explicit CellXplorer canonical cycling model;
2. define exactly what every canonical field means, including programmed-versus-executed step identity and time semantics;
3. make source-format parsing a small dispatch/adapter boundary rather than a Neware-specific global;
4. move parser/cache/provenance identity from one global parser bundle to **source-specific parser identities** while preserving reproducibility;
5. extend the canonical raw model to support synchronized auxiliary voltage channels, including three-electrode measurements, without making ordinary two-electrode analyses format-specific;
6. prove that existing `.nda`, `.ndax`, and structured Neware `.xlsx` behavior is scientifically unchanged.

These are related but independently risky boundaries. They are split into five reviewable children so a regression in the canonical contract, dispatch, cache/provenance, multi-voltage path, or downstream compatibility can be isolated before the next layer is added.

## Product goal

After Parent 040, CellXplorer must have one explicit canonical cycling representation that all source formats adapt into.

The intended architecture is:

```text
Physical source file
(.nda / .ndax / structured .xlsx / future .mpr / ...)
        ↓
source-format recognition + adapter
        ↓
CellXplorer canonical raw cycling DataFrame
        ↓
versioned raw Parquet cache
        ↓
existing scientific calculations and protocol-aware services
        ↓
versioned cycle cache / analyses / plots / exports
```

Downstream scientific code should normally ask **what canonical fields and capabilities are available**, not which instrument produced the file.

## Locked design principle: canonical, deliberately Neware-like

The canonical model should remain close to the current Neware representation because it is an efficient and understandable model of battery cycling:

```text
record
  ├─ source-local record index
  ├─ logical cycle
  ├─ programmed protocol step
  ├─ executed step occurrence
  ├─ semantic step/status type
  ├─ step-relative time
  ├─ optional source-elapsed time
  ├─ signed current
  ├─ primary voltage
  ├─ charge/discharge capacity counters
  ├─ charge/discharge energy counters
  ├─ timestamp
  └─ optional synchronized auxiliary signals
```

Do **not** redesign the whole scientific model merely to make it abstract. New source formats adapt to CellXplorer's model; CellXplorer does not become a union of every vendor's native schema.

## Canonical raw contract

Parent 040 locks the following meanings. Exact implementation helpers/types may be refined by the children, but these scientific meanings require an explicit parent amendment to change.

### Required core columns

A source that claims normal cycling capability must be able to produce the following canonical fields:

| Canonical field | Locked meaning |
|---|---|
| `record_index` | Stable source-local acquisition order. Numeric and unique within the source after parser normalization. |
| `cycle` | Source-local logical cycling index used by CellXplorer's cycle aggregation/stitching. It need not equal a vendor's raw counter if that counter does not represent logical battery cycles. |
| `step_index` | **Programmed protocol-step identity**: which declared operation/sequence this row belongs to. Repeated executions reuse the same `step_index`. |
| `step` | **Executed step occurrence identity**: one concrete execution block. Repeated execution of the same programmed step receives a different `step`. |
| `status` | CellXplorer semantic operation/status string. Existing Neware meanings such as Rest / charge / discharge / CV / CCCV remain the canonical vocabulary where already established. Adapters translate vendor-native modes into these semantics. |
| `time_s` | Time elapsed since the current executed `step` began. This remains step-relative for backward compatibility and for current capacity/time calculations. |
| `voltage_v` | The **primary voltage** used by ordinary existing CellXplorer analyses unless the analysis explicitly selects another voltage channel. |
| `current_ma` | Signed cell current in mA under one documented CellXplorer sign convention. Existing Neware behavior remains the baseline and all adapters must normalize to it. |
| `charge_capacity_mah` | Canonical charge-side accumulated capacity counter in mAh, with reset/carry behavior described by adapter metadata and normalized sufficiently for existing per-step delta semantics. |
| `discharge_capacity_mah` | Canonical discharge-side accumulated capacity counter in mAh, with the same rules as above. |
| `timestamp` | Absolute timestamp for each record when the source contains enough information to reconstruct it; otherwise null/NaT with explicit capability metadata. |

### Canonical optional-but-standard columns

The following are first-class canonical fields when the source can provide them:

```text
total_time_s
charge_energy_mwh
discharge_energy_mwh
working_potential_v
counter_potential_v
```

`total_time_s` means source-elapsed acquisition time and must not silently replace the existing step-relative `time_s` meaning.

Additional instrument channels (temperature, analog inputs, etc.) may remain auxiliary raw columns. Parent 040 does not create a generic signal database or EAV schema.

### Voltage-channel semantics

`voltage_v` is a compatibility and scientific-default field, not necessarily the only voltage measured.

For ordinary two-electrode battery data:

```text
voltage_v = measured cell voltage
working_potential_v = absent
counter_potential_v = absent
```

For a three-electrode full-cell measurement where both electrode potentials versus a reference are available:

```text
working_potential_v = E_working vs reference
counter_potential_v = E_counter vs reference
voltage_v = full-cell voltage between working and counter
```

Where full-cell voltage is not stored directly but both electrode potentials are reliable and synchronized, the adapter may derive:

```text
voltage_v = working_potential_v - counter_potential_v
```

The derivation must be explicit in source metadata/capabilities and covered by tests. Do not store a third duplicate `cell_voltage_v` column merely to copy `voltage_v` unless a future requirement establishes a distinct need.

Use **working/counter** terminology in the canonical data layer. UI labels may say Positive/Negative only when the source/configuration establishes those electrode roles.

### Status semantics

Parent 040 does not require renaming the established status strings simply for architectural purity. Existing calculations currently recognize Neware-like status values; those meanings become CellXplorer-owned semantics.

Adapters must not pass arbitrary vendor-native labels downstream and expect scientific code to understand them.

A future extension may replace string matching with a richer enum/phase representation, but that is out of scope unless a child discovers a concrete correctness defect that cannot be solved without it. Such a change requires a parent amendment because it may change cached scientific meaning.

## Parser/adapter contract

The permanent parser boundary should stay simple. Do not introduce a large plugin framework, dynamic entry points, dependency injection container, or class hierarchy for a solo-maintained desktop application.

The target should support operations equivalent to:

```python
recognize_source(path) -> source_format
parser_identity(path) -> stable parser identity string
parse_timeseries(path) -> canonical pandas.DataFrame
read_header_metadata(path) -> normalized source metadata / capabilities
validate_canonical_timeseries(df, capabilities=...) -> None
```

The exact owner/module names are child-level decisions. `backend/app/services/parsing.py` may remain the public facade, but it must no longer mean “the Neware parser.”

## Source-specific parser identity

Parent 039 deliberately preserves one global Neware parser-bundle identity because it still supports only Neware sources. Parent 040 replaces that temporary constraint with a source-specific reproducibility model.

### Locked identity properties

Each registered `SourceFile` already has a `parser_version` field. After 040, that field must represent the **effective parser identity used to produce that source's canonical raw cache**.

A parser identity must include enough information to invalidate the raw cache when either:

- the source-format decoder changes in a way that can change canonical output; or
- the canonical raw contract/version changes in a way that changes stored meanings.

A conceptual identity is:

```text
<compact-format-id>:<adapter-revision>:r<canonical-raw-version>
```

The persisted identity must be **30 characters or fewer** because `SourceFile.parser_version` is currently `String(30)` and this parent deliberately avoids a relational migration.

Examples are illustrative but intentionally fit the bound:

```text
nb:2026.6.11:r1
nx:3:r1
```

Use one documented compact grammar in 040.3. Do not encode source hashes, application version, Python version, or other environment noise.

### Cache identity

Current raw/cycle caches are keyed by `(file_hash, parser_version[, calc_version])`. Preserve that content-addressed architecture, but use each source's effective parser identity rather than a single process-global parser version.

### Mixed parser identities in one Cell

A Cell's ordered SourceFiles may, in principle, have different parser identities or formats. The architecture must not require all sources in a Cell or analysis to share one global `PARSER_VERSION`.

Stitching and analysis cache/provenance code therefore must resolve parser identity **per source**.

This does not broaden continuation compatibility. Parent 034's current multi-source scientific safety rules remain authoritative: protocol-derived analyses still fail closed for multiple sources until their reviewed mapping exists. Cycles and Time/Capacity may use the normal source chain.

## Analysis provenance

Existing analyses pin parser/calculation provenance so a saved analysis does not silently change when scientific code changes.

Parent 040 preserves that principle but makes parser provenance source-specific.

A final provenance representation must be able to answer, for every contributing source:

```text
source hash
source position
source parser identity
source format/descriptor if useful
```

and still record the calculation version used for derived scientific results.

Do not keep a misleading single `provenance.parser_version` field if different sources can legitimately use different parser identities. Existing saved analyses must remain readable through normalization/migration of their JSON spec shape; do not add a relational database migration solely for this JSON evolution.

If analysis `SPEC_VERSION` must advance because the persisted JSON schema changes, do so with focused backward-compatibility tests.

## Multi-voltage capability model

Three-electrode support is a canonical raw-data capability, not a BioLogic-specific special case.

Source metadata should expose bounded capability information sufficient for backend/UI decisions, conceptually:

```json
{
  "source_format": "...",
  "capabilities": {
    "primary_voltage": true,
    "working_potential": true,
    "counter_potential": true,
    "absolute_timestamps": true,
    "declared_protocol": true
  },
  "voltage_roles": {
    "voltage_v": "cell",
    "working_potential_v": "working_vs_reference",
    "counter_potential_v": "counter_vs_reference"
  },
  "reference_electrode": "... or null"
}
```

Exact JSON spelling belongs to 040.4 after current 039 metadata conventions are inspected. Keep the metadata bounded and source-owned in `SourceFile.header_meta`; do not expand it into hundreds of `CellMetadata` rows.

## Current verified implementation at the 040 merge base

These anchors were rechecked against `main@562c2edff1277fef71789244c95e3b17abc586fa`. Every child must still reverify them before editing because the shared branch evolves sequentially.

### `backend/app/services/parsing.py`

Current post-039 behavior is already a small Neware-family dispatcher, but it still owns one global parser bundle:

```python
NEWARE_NDA_VERSION = NewareNDA.version.__version__
EXCEL_PARSER_REVISION = neware_excel.EXCEL_PARSER_REVISION  # 6
PARSER_VERSION = f"{NEWARE_NDA_VERSION}-cxp{EXCEL_PARSER_REVISION}"
SUPPORTED_NEWARE_SOURCE_EXTENSIONS = frozenset({".nda", ".ndax", ".xlsx"})
```

At this baseline the effective bundle is `2026.6.11-cxp6`.

Important anchors:

- `source_filename_allowed` owns the supported suffix policy;
- `source_parser_family` returns `binary` for `.nda/.ndax` and `excel` for `.xlsx` and is already used to forbid unsafe cross-family exact-hash relinking;
- `parse_timeseries` dispatches `.xlsx` to `neware_excel.parse_timeseries` and binary Neware to `NewareNDA.read(...)`;
- `validate_parsed_output` delegates Excel cycle-summary validation to `neware_excel.validate_cycles`;
- `_read_ndax_metadata_flat` owns the fast direct NDAX XML header path;
- `read_header_metadata` dispatches `.nda/.ndax/.xlsx`, normalizes curated metadata and reconstructs protocol information;
- `NewareNDA` is still imported directly here, consistent with current `AGENTS.md`.

### `backend/app/services/neware_excel.py`

Spec 039 is landed, including its follow-up Excel dialect and import-resilience work. `EXCEL_PARSER_REVISION = 6`; the raw parser emits the established canonical-looking fields including `record_index`, `cycle`, programmed `step_index`, executed `step`, normalized status, step-relative `time_s`, source-elapsed `total_time_s`, current, primary voltage, charge/discharge capacity and energy, timestamp, and `power_w` where available. It preserves `record` as the point-level scientific source of truth and uses optional `step`/`cycle` sheets only as independent validation.

The dialect work added a unitless "record clock" workbook variant whose step-summary reconciliation compares against the record's step-relative elapsed column rather than the exported timestamp span. `time_s` remains step-relative in both dialects, so the canonical contract below is unaffected, but children must reverify this rather than assume it. See `docs/neware-excel-variant-findings.md`.

### `backend/app/services/cache.py`

The cache remains content-addressed and global-parser-versioned:

```text
raw__p<PARSER_VERSION>.parquet
cycles__p<PARSER_VERSION>__c<CALC_VERSION>.parquet
```

Important anchors:

- `schedule_build` deduplicates on `(file_hash, parsing.PARSER_VERSION, CALC_VERSION)`;
- `build` and `build_write_behind` call `parsing.parse_timeseries`, `calc.per_cycle`, and source-owned validation;
- current raw/cycle lookups default to `parsing.PARSER_VERSION`;
- historical exact-version reads already accept an explicit parser version;
- current `CALC_VERSION` is `1.6.1`.

### `backend/app/services/scanner.py`

Current source lifecycle still assumes the global bundle for “current” scientific state:

- `_has_current_scientific_cache` checks `parsing.PARSER_VERSION`;
- `parse_file` / stable source replacement call `cache.build(...)` and persist its returned global bundle into `SourceFile.parser_version`;
- scanner/import discovery uses the shared suffix policy;
- exact-hash relinking is guarded by `source_parser_family` so binary and Excel identities cannot be silently crossed.

### `backend/app/services/stitch.py`

Current functions accept one parser version for an entire ordered Cell source chain:

```python
stitch_cycles(ordered_hashes, parser_version, calc_version)
stitch_raw(ordered_hashes, parser_version)
```

They otherwise already preserve the important continuation invariants: ordered source position, observed-cycle dense global mapping, `segment`, `source_hash`, source-local cycle labels, and fail-closed behavior after a missing middle cache.

### `backend/app/services/analysis_engine.py` and `analysis_cache.py`

`analysis_engine.SPEC_VERSION` is currently `9`. Scientific compute starts from one `parsing.PARSER_VERSION`, optionally replaces it with legacy `provenance["parser_version"]`, then passes that one version through every selected source and stitch call. Its result payload likewise exposes one parser version/current parser version.

`analysis_cache.ANALYSIS_CACHE_VERSION` is currently `4`. `result_key(...)` also resolves one global/pinned parser version and places that scalar in the scientific cache key. This is the main persisted-analysis/cache assumption that 040.3 must replace without breaking legacy pinned results.

### `backend/app/models.py`

`SourceFile` already provides the persistent source fields needed by 040:

```text
hash             String(64)
ext              String(10)
header_meta       JSON
parser_version    String(30), nullable
```

That `String(30)` bound is a locked implementation constraint for the new effective parser-identity grammar. Parent 040 remains migration-free only if new identities fit this existing field.

`Analysis.spec` and `Analysis.provenance` are JSON, so their shape can evolve through versioned normalization rather than a relational schema migration.

### Frontend/API/portable paths

Reverify before each child:

- `frontend/src/api.ts` scientific/raw/provenance response types;
- `features/analyses/editor/families/time-capacity/` quantity and export behavior;
- source metadata/header display;
- `backend/app/services/portable_analysis.py` source/provenance serialization;
- saved-artifact and analysis-cache signatures that include scientific result identity.

## Locked decisions

### 1. Existing Neware scientific behavior is the compatibility baseline

040 is an architecture/generalization feature. It must not change existing `.nda`, `.ndax`, or supported `.xlsx` numerical results simply because the parser boundary is reorganized.

If a real existing Neware scientific defect is discovered, record it separately unless it blocks the canonical contract. Do not hide a formula change inside this refactor.

### 2. Do not bump `CALC_VERSION` for representation/dispatch changes alone

Parser identity changes invalidate raw/cycle caches through parser provenance. `CALC_VERSION` changes only if the meaning of a calculation in `calc.py` or another scientific derived service changes.

If implementation appears to require a calculation semantic change, stop for explicit parent amendment.

### 3. No relational database migration is expected

`SourceFile.parser_version`, `ext`, `hash` and `header_meta` already provide the needed persistent source fields. New parser identities must fit the existing 30-character `parser_version` field. Analysis spec/provenance JSON may need versioned normalization, but that is not a database schema migration.

If a child concludes a relational column/table is essential, stop and justify it before adding a migration.

### 4. Keep one flat Parquet raw table per source

Do not move auxiliary voltages into separate files/tables that require row-by-row joins. Synchronized potentials belong as additional columns in the same canonical raw frame/cache.

### 5. `voltage_v` remains the default existing-analysis voltage

Adding electrode potentials must not silently change existing plots or formulas. Ordinary Cycles, Time/Capacity, DCIR, Chargeability and Rate Capability continue using `voltage_v` unless a later reviewed feature explicitly supports alternate-channel scientific calculation.

040.4 may expose alternate voltage channels in Time/Capacity plotting, but it must not silently substitute them into DCIR or cycle calculations.

### 6. Preserve source-local raw provenance

Auxiliary voltage selection does not change source identity. Hashing remains over original source bytes. Raw cache rows remain traceable through source hash/segment when stitched.

### 7. Preserve bounded import/list architecture

040 must not cause file enumeration or list endpoints to instantiate every parser or inspect source files. Source recognition/metadata reads remain in the bounded import/scanner paths established by Specs 035 and 039.

### 8. Avoid generic framework overengineering

Support the concrete adapter operations needed by CellXplorer. No external plugin discovery, no user-installable parser packages, no abstract signal graph, and no universal electrochemistry ontology in this parent.

## Child sequence

### 040.1 — Canonical cycling data contract and validation

Create the explicit canonical field/capability contract, documentation and focused validation helpers. Prove that current Neware binary/Excel parser output satisfies it without numerical changes.

### 040.2 — Source-format adapter dispatch

Make `parsing.py` a format-neutral facade/dispatcher and give the existing Neware binary and Neware Excel paths explicit adapter identities. Preserve their exact output and import behavior. Do not yet rework all cache/provenance consumers.

### 040.3 — Per-source parser cache, stitching and provenance

Replace global parser-version assumptions in cache/stitch/analysis provenance with per-source parser identities. Preserve reproducibility and backward compatibility for saved analyses.

### 040.4 — Canonical multi-voltage path and Time/Capacity exposure

Add optional working/counter electrode potentials to the canonical raw model, metadata/API selection and Time/Capacity plotting/export path. Existing two-electrode behavior remains unchanged.

### 040.5 — Existing-format scientific regression and architecture closure

Run the full existing Neware binary/Excel scientific and source-lifecycle regression matrix, audit format-specific branches, reconcile documentation/project context and perform the fresh cumulative Parent 040 review.

```text
040.1 canonical contract
    ↓ review-clean
040.2 parser dispatch
    ↓ review-clean
040.3 per-source cache/provenance
    ↓ review-clean
040.4 multi-voltage path
    ↓ review-clean
040.5 regression/closure
    ↓ focused review + fresh cumulative parent review
FEATURE_COMPLETE
```

## Explicitly out of scope

- BioLogic `.mpr` decoding or import — Parent 041;
- BioLogic protocol/GCPL mapping — Parent 041;
- EIS/PEIS/GEIS analysis support;
- arbitrary CV/CA/CP electrochemistry analysis workflows;
- changing the scientific formulas used by Cycles/DCIR/Chargeability/Rate Capability;
- removing current multi-source protocol-analysis guards;
- user-defined parser plugins;
- generic user-defined column mapping;
- relational signal tables or one-record-per-point SQLite persistence;
- background parsing on list endpoints;
- reworking Neware statuses merely to use prettier names.

## Parent-level verification and acceptance

Parent 040 is complete only when all five children are review-clean and the final reviewer has independently inspected the cumulative branch.

Required parent-level evidence:

1. all existing Neware `.nda/.ndax` golden scientific projections remain numerically unchanged;
2. Parent 039's structured Neware `.xlsx` acceptance/regression remains green;
3. canonical raw validation is applied consistently at parser/cache boundaries without turning list/import discovery into a full parse;
4. cache keys use source-specific parser identities and do not globally invalidate unrelated formats;
5. a synthetic mixed-parser source chain can stitch Cycles/Time-Capacity data using each source's own parser identity where existing continuation rules permit it;
6. existing saved analyses with legacy single-parser provenance still load through explicit normalization and do not silently recompute;
7. new provenance records source-specific parser identity deterministically;
8. optional working/counter potential columns survive parse → Parquet → load → stitch → API → Time/Capacity plot/data export;
9. ordinary two-electrode analyses and plots are unchanged by the presence of the new capability;
10. no source-format branch has been introduced inside scientific calculation services except where source provenance/display is the actual subject;
11. no unexpected relational migration or `CALC_VERSION` bump occurred;
12. current `python scripts\preflight.py` passes on the final branch, with manual/packaged checks recorded truthfully as run or not run;
13. `AGENTS.md`, agent knowledge, parser/cache documentation and project context accurately describe the new architecture.

## Privacy and fixture policy

Do not commit private user source files merely to prove the architecture. Reuse the approved existing golden corpus and Parent 039's generated Excel fixtures. Multi-voltage tests in 040 should use synthetic canonical/Neware-shaped data unless a privacy-approved real source is explicitly available.

## Implementation record

The parent itself is not an implementable batch. Child specs own implementation records. The final 040.5 review must summarize:

- exact implementation merge base;
- child implementation/review SHAs;
- cumulative changed-file scope;
- parser/cache/provenance final design;
- existing-format regression evidence;
- manual/packaged checks actually run;
- any remaining non-blocking limitations;
- final merge-readiness decision.
