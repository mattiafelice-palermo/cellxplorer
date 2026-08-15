# 041 — BioLogic `.mpr` GCPL cycling support

**Status:** Implementation in progress; final cumulative Sol review pending
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Authoring reference:** current `main` at `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`, active Parent 039 work, draft Parent 040, and the supplied BioLogic GCPL6 `.mpr` sample  
**Implementation baseline / merge base:** **resolve from the exact `main` commit produced by merging Parent 040; do not implement from the authoring reference above**  
**Shared branch:** `feature/biologic-mpr-gcpl-support`  
**Depends on:** Parent 039 merged, then Parent 040 complete/review-clean/merged  
**Review workflow:** [`workflow/README.md`](workflow/README.md), with state in [`041-agent-state.json`](041-agent-state.json) and handoffs in [`041-agent-coordination.md`](041-agent-coordination.md)

Every child must read:

- `AGENTS.md`;
- `docs/specs/README.md`;
- Parent 040 and its final cumulative review;
- `docs/agent-knowledge/README.md`;
- `docs/agent-knowledge/canonical-cycling-data.md`;
- `docs/agent-knowledge/architecture.md`;
- `docs/agent-knowledge/state-and-performance.md`;
- `docs/agent-knowledge/change-playbooks.md`;
- `docs/agent-knowledge/scientific-regression-testing.md`;
- the topic-specific analysis documentation named by each child.

Children with UI changes also read `docs/agent-knowledge/visual-style-guide.md`. Children touching packaging read the current Windows packaging guidance. Child 041.6 reads `CELLXPLORER_CONTEXT_MAINTENANCE.md` and current release/version guidance.

## Why this is a parent specification

BioLogic EC-Lab `.mpr` files are binary modular electrochemistry files. Supporting them is technically feasible, but correct cycling support crosses several independent boundaries:

- binary container/module parsing;
- data-record layout and column decoding;
- GCPL/GCPL6 cycle, step, status, current, capacity and energy semantics;
- settings/protocol metadata;
- three-electrode voltage channels and reference-electrode metadata;
- import/source lifecycle and packaged runtime;
- Time/Capacity UI for electrode potentials;
- all existing analysis families and reproducibility/provenance;
- licensing/provenance constraints around existing GPL parsers.

Parent 040 deliberately establishes the CellXplorer-owned canonical cycling model first. Parent 041 therefore does **not** redesign the application around BioLogic. It implements one new adapter that maps supported BioLogic GCPL-family `.mpr` files into the same canonical raw/protocol/cache structures used by existing Neware sources.

The work is divided into six children so binary-decoding defects can be separated from scientific mapping defects, and those can be separated from import/UI/integration defects.

## Product goal

Users must be able to import a supported BioLogic EC-Lab `.mpr` GCPL-family cycling file and use it as a normal CellXplorer source.

The intended flow is:

```text
BioLogic EC-Lab .mpr (supported GCPL-family contract)
        ↓
independently implemented MPR binary reader
        ↓
BioLogic GCPL adapter
        ↓
CellXplorer canonical raw cycling DataFrame
        ↓
source-specific parser identity + Parquet cache
        ↓
existing cycle calculations / analyses / plots / exports
```

For three-electrode GCPL6 data:

```text
Ewe vs reference  → working_potential_v
Ece vs reference  → counter_potential_v
full-cell voltage → voltage_v
```

The existing ordinary `voltage_v` path remains the default for cycle/DCIR/Chargeability/Rate Capability calculations. Time/Capacity may additionally display the two electrode potentials through the capability added in Parent 040.

The first implementation's production contract is the independently verified CC/rest GCPL
layout. The exact MPR record layout currently decoded by the reader does not expose a separate
measured-current column for potentiostatic rows; such rows fail closed rather than reconstructing
current from `dq/time`. The direct mapper still covers a dedicated measured-current field for a
future verified layout, but no standalone/combined CCCV MPR acceptance claim is made for the
current byte contract.

## Initial supported scope

Parent 041 supports **BioLogic EC-Lab `.mpr` files containing galvanostatic cycling in the verified GCPL family**, including the supplied GCPL6-style three-electrode battery measurement.

The parent does **not** promise arbitrary `.mpr` technique support.

Supported first-class target:

```text
GCPL / GCPL6-style battery cycling where required fields and sequence semantics can be decoded and validated
```

Explicitly out of scope unless a parent amendment is made:

```text
PEIS / GEIS scientific analysis
CV / CVA analysis workflows
CA / CP analysis workflows
ModuloBat general support
arbitrary linked-technique MPR files
multi-technique sequence chains containing EIS
BCS/BT-Lab formats that are not the same verified MPR contract
MPT text import as a user-facing source format
```

The low-level reader may be structured to support future techniques, but child acceptance is based only on the verified GCPL-family contract.

## Supplied `.mpr` — independently verified reference facts

The supplied private sample was inspected directly at the byte/container level while authoring this spec.

File:

```text
BB_eNargiZinc_Discharge-OD19_04_GCPL6_C16.mpr
```

Verified facts:

```text
size: 307,115 bytes
file magic starts with: BIO-LOGIC MODULAR FILE
module markers: 3
```

Using the module header's declared lengths, the file contains:

| Module | Version | Declared data length | File position |
|---|---:|---:|---:|
| `VMP Set` | 10 | 6,953 bytes | starts after marker at byte 52 |
| `VMP data` | 11 | 291,606 bytes | marker at byte 7,070 |
| `VMP LOG` | 10 | 8,309 bytes | marker at byte 298,741 |

The `VMP data` module independently exposes:

```text
n_datapoints = 5,483
n_columns = 16
```

The encoded column-ID sequence in this sample is:

```text
1, 2, 3, 21, 31, 65, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468
```

These numeric IDs are reference facts for the supplied sample. Their semantic/type mapping must be established by the independent parser work and paired EC-Lab validation; do not paste a third-party GPL table into production code.

The sample is private and must **not** be committed to the repository without explicit user approval.

## Official BioLogic three-electrode semantics

BioLogic's official Application Note 58 describes GCPL6 battery cycling with a reference electrode and states that EC-Lab records:

- `Ewe`: working/positive electrode versus reference;
- `Ece`: counter/negative electrode versus reference;
- `Ecell`: full-cell voltage between the two active electrodes.

It also explains that GCPL6 controls the full-cell voltage while simultaneously monitoring the two half-cell potentials.

Parent 041 maps these concepts into Parent 040's canonical roles rather than exposing vendor variable names to scientific downstream code.

## Licensing and implementation provenance — locked

Existing open-source projects can parse `.mpr`, but at least one actively maintained implementation examined during planning is GPL-3.0-or-later.

Parent 041 must **not** solve licensing concerns by mechanically “rewriting,” renaming or vectorizing GPL source. Extensive modification does not automatically remove the original license.

Production CellXplorer MPR code must therefore be independently authored and must not:

- import a GPL MPR parser as a runtime dependency;
- copy source code, dtype tables, comments, tests or large mapping tables from a GPL project;
- ask an implementation agent to translate/rewrite a GPL parser into different syntax;
- vendor GPL parser code into CellXplorer.

Implementation should be based on:

- BioLogic's official documentation for technique/electrode semantics;
- directly observable MPR file structure and module headers;
- privacy-approved/sample files owned by the user/project;
- paired EC-Lab `.mpr` and text `.mpt` exports generated from the **same experiment** as empirical ground truth;
- independently written binary-layout/mapping notes committed to CellXplorer;
- focused tests derived from those independently established facts.

This is a software-engineering provenance rule, not formal legal advice. If distribution licensing needs legal certainty, obtain counsel rather than relying on line-count differences.

## Paired `.mpt` validation requirement

A text `.mpt` export of the **same experiment** is the preferred scientific ground truth because it lets the implementation compare decoded binary fields to EC-Lab's own text export.

Parent 041 may start low-level work using the supplied `.mpr`, but **041.2 may not be considered fully review-clean for real-file semantic parity, and 041.6 may not close the parent, without at least one privacy-approved paired `.mpr`/`.mpt` GCPL-family dataset** unless the user explicitly amends this requirement.

The paired file does not have to be committed. It may be used locally/read-only and its verification results recorded.

### First-implementation amendment

For this first implementation the user explicitly amended the paired-file gate: no `.mpt` is
available, and the feature should proceed without one. The branch therefore records the exact
absence of private MPR/MPT parity evidence and does not claim real-file parity. The accepted first
implementation evidence is the independent byte-layout contract, project-owned synthetic MPR
fixtures, normal application integration, and fail-closed behavior where the byte contract is
insufficient. MPT remains excluded from user import and may be added later as validation evidence.

For committed regression, use deterministic synthetic MPR builders or compact de-identified fixtures whose bytes are independently generated by CellXplorer test code.

## Locked performance architecture

### One file

For one `.mpr`, prefer:

```text
memory-map / memoryview
→ sequential module-header walk by declared length
→ NumPy structured dtype/frombuffer for bulk records
→ vectorized/unique-code mapping
→ canonical DataFrame construction
```

Do not decode every numeric field record-by-record with Python `struct.unpack` loops when a fixed structured dtype can decode the data block in one NumPy operation.

### Module discovery

Do not split/copy the entire file on the byte string `MODULE`. The module header already declares lengths. Walk modules sequentially, validate bounds/magic, and create zero-copy views where practical.

### Categorical/code mapping

For encoded categorical fields that repeat across many rows:

- map unique codes once;
- use NumPy/pandas vectorized reconstruction;
- do not perform a linear mapping-table scan for every row.

### Multiple files

Do not add inner multiprocessing to one MPR parse unless profiling proves it beneficial. The bulk data decode should already run in NumPy and is likely memory/I/O bound.

Reuse CellXplorer's outer bounded import/scientific-preparation process pools to parallelize **between independent files** for large batches.

### Async

Do not add async file I/O. Local binary read + NumPy decode does not benefit from application-level async complexity.

## Canonical scientific mapping — parent locks

### Record identity

If MPR does not contain an explicit source record number suitable for CellXplorer, use stable zero/one-based acquisition ordinal normalized to the repository's canonical `record_index` convention. The exact base must be established in 041.2 and applied deterministically.

### Programmed step

BioLogic sequence identity (`Ns` or verified equivalent) maps to canonical `step_index` after one deterministic numbering normalization. Do not renumber based on observed execution order if the source already contains a stable programmed-sequence ID.

### Executed step

Canonical `step` identifies each concrete execution occurrence. Create a new executed occurrence when verified execution-boundary signals indicate the sequence restarted/changed, including as applicable:

- sequence ID change;
- explicit sequence-change flag;
- step-relative time reset;
- other independently verified GCPL execution marker.

Do not rely solely on current sign to define step boundaries.

### Status

Translate BioLogic row/sequence behavior into CellXplorer canonical statuses. Do not pass `GCPL`, `mode=...`, raw flag names or other vendor-native labels downstream as scientific status.

The adapter may classify an executed block retrospectively from its control modes/current direction so a sequence containing both CC and CV portions can map to existing canonical CCCV semantics without inventing separate programmed steps.

Exact classification rules are locked in 041.2 after paired validation.

### Time

Canonical:

```text
time_s       = elapsed time within executed canonical step
total_time_s = elapsed time since source acquisition start
```

If BioLogic provides whole-test `time` plus a step-time field, map them directly after validation. If step time is absent, derive it from execution boundaries and total time; do not redefine canonical `time_s` as total time.

### Current

Normalize BioLogic current into Parent 040's documented CellXplorer sign convention. Never change global sign convention to match BioLogic.

### Capacity

Prefer a vendor-provided accumulated charge quantity when its semantics are verified against paired `.mpt`/EC-Lab output. Map it into separate canonical charge/discharge counters according to normalized direction.

Current integration may be used as an independent validation and as a documented fallback only if required vendor capacity fields are absent and the fallback is explicitly covered by the parent/child acceptance criteria.

Do not mix vendor counters and integration silently on different rows.

### Energy

If the supported GCPL MPR exposes verified energy counters, map them. Otherwise it is acceptable to derive canonical charge/discharge energy from synchronized primary voltage/current/time in the adapter using a documented deterministic integration method, provided tests establish sign/reset semantics.

If energy cannot be made reliable in the first supported contract, leave energy capability missing/NaN rather than fabricate it. 041.2 must record the final decision.

### Timestamp

Use the verified acquisition-start timestamp from MPR log/settings plus source elapsed time. If the needed timestamp is absent, expose `absolute_timestamps = false`; do not use file modification time.

## Three-electrode mapping — locked

For a GCPL6/full-cell-control source with all channels available:

```text
working_potential_v = Ewe vs reference
counter_potential_v = Ece vs reference
voltage_v = Ecell
```

If `Ecell` is not explicitly stored but both Ewe/Ece are available and vendor semantics establish their common reference:

```text
voltage_v = working_potential_v - counter_potential_v
```

Requirements:

- test the sign/order against paired EC-Lab output;
- metadata records whether primary voltage is measured or derived;
- keep working/counter terms in the canonical backend;
- frontend may label positive/negative only when source metadata/configuration establishes that battery role;
- ordinary existing scientific analyses continue using `voltage_v`.

## Protocol mapping

BioLogic GCPL settings/sequences must be reconstructed into CellXplorer's existing declared-protocol representation sufficiently for applicable downstream services.

Do not create a BioLogic-only protocol response schema.

The adapter may build the existing canonical/Neware-like protocol structure from verified GCPL sequence parameters, including as available:

- sequence/program step identity;
- control mode/current or C-rate setting;
- direction;
- voltage limits/cutoffs;
- CV/current cutoff/hold behavior;
- rest duration;
- loop/goto/cycle behavior;
- record settings;
- reference/full-cell control capability.

Only map semantics directly supported by the source. Do not invent Neware condition-expression syntax for BioLogic concepts that do not exist.

If some current Chargeability/Rate Capability recognizer depends specifically on Neware metadata grammar that cannot be represented truthfully, expose a capability limitation and degrade honestly rather than fabricating fields.

## Parser identity

Use Parent 040's per-source identity model.

Conceptual identity:

```text
biologic-mpr:<adapter-revision>:raw<canonical-raw-version>
```

The MPR adapter revision must change when binary decoding or GCPL canonical mapping semantics change.

Do not bump `CALC_VERSION` merely to add MPR support.

## Database/storage

No relational migration is expected.

A BioLogic MPR remains a normal `SourceFile` with:

```text
path
filename
size
ext = "mpr"
hash
header_meta
parser_version
parse/cache status and summaries
```

Raw point data remain in regenerable Parquet, never individual SQLite rows.

If implementation appears to require a schema migration, stop for parent amendment.

## Child sequence

### 041.1 — Independent MPR container and data-block reader

Implement file/module-header walking, VMP data header/column layout decoding, zero-copy/NumPy bulk record parsing, structured errors and synthetic container tests. No CellXplorer cycle/status mapping yet.

### 041.2 — GCPL canonical time-series mapping

Map decoded GCPL records into Parent 040's canonical fields: record/cycle/programmed step/executed step/status/time/current/primary voltage/capacity/energy/timestamp. Validate against paired `.mpt` where available.

### 041.3 — GCPL settings, protocol metadata and three-electrode semantics

Decode the settings/log information needed for declared protocol, normalized metadata/capabilities, reference electrode, Ewe/Ece/Ecell role mapping and protocol-aware analyses.

### 041.4 — Import, source lifecycle and packaged runtime integration

Add `.mpr` to centralized source-format recognition, bounded inspection, browser/native pickers, registration, scanner/update/rebuild/continuation, outer multiprocessing and frozen backend packaging.

### 041.5 — BioLogic three-electrode Time/Capacity UX and source presentation

Use Parent 040's generic multi-voltage capability to expose Cell/Working/Counter potential choices, truthful reference-electrode labels, source metadata and saved/export/portable behavior. No BioLogic-specific plotting fork.

### 041.6 — Scientific regression, real-file parity and feature closure

Run direct binary-vs-MPT parity when a paired file is available; for this amended first
implementation record its absence and run the independent synthetic/integration closure instead,
including import/cache/source lifecycle, Cycles/Time-Capacity/Steps/DCIR/Rate Capability/
Chargeability applicability, performance, existing Neware golden regressions, documentation/context
and cumulative review.

```text
041.1 low-level MPR reader
    ↓ review-clean
041.2 canonical GCPL raw mapping
    ↓ review-clean
041.3 metadata/protocol/three-electrode semantics
    ↓ review-clean
041.4 import/source lifecycle/packaging
    ↓ review-clean
041.5 three-electrode UX
    ↓ review-clean
041.6 scientific regression/closure
    ↓ focused review + fresh cumulative parent review
FEATURE_COMPLETE after the final cumulative Sol review
```

## Current repository anchors to reverify after 040 merges

Because 041 cannot start until 040 is merged, exact code anchors must be updated at implementation time. Expected owners include:

```text
backend/app/services/parsing.py                 format-neutral facade
backend/app/services/canonical_cycling.py       canonical raw contract
backend/app/services/cache.py                   source-specific parser cache
backend/app/services/stitch.py                  per-source cache stitching
backend/app/services/protocol.py                canonical declared protocol
backend/app/services/import_inspection.py       bounded inspection
backend/app/routers/files.py                    import/file picker/registration
backend/app/services/scanner.py                 source scan/update/preparation
backend/app/services/analysis_engine.py         Cycles/Time-Capacity/provenance
backend/app/services/step_blocks.py             Steps
backend/app/services/dcir.py                    DCIR
backend/app/services/chargeability.py           Chargeability
backend/app/services/rate_capability.py         Rate Capability
frontend/src/features/analyses/...              family UI/plotting
frontend/src/api.ts                             typed API
packaging/ + src-tauri/                         frozen sidecar/app
```

Do not implement against authoring-time paths if Parent 039/040 moved ownership.

## Test/fixture strategy

Use three layers.

### Layer A — synthetic byte-level MPR fixtures

Write small deterministic builders that generate only the independently documented module/data structures needed by tests. This provides committed regression without private user data.

### Layer B — paired EC-Lab `.mpr` / `.mpt`

Use at least one matching pair locally/read-only for semantic parity. Prefer more than one GCPL family/file-software version before claiming broad support.

### Layer C — supplied private GCPL6 sample

Use the supplied file locally/read-only for final three-electrode acceptance. Do not commit without explicit approval.

## Fail-closed policy

Reject unsupported/ambiguous MPR variants rather than guessing.

Examples:

- unknown data module version with no verified layout;
- required column ID whose dtype/meaning is unknown;
- record length does not match declared layout;
- technique/settings layout cannot be identified reliably;
- cycle/step mapping cannot be derived deterministically;
- Ewe/Ece role/reference relationship is ambiguous;
- source changes while being read/imported.

A clear unsupported-format error is preferable to plausible but wrong battery data.

## Parent-level acceptance

Parent 041 is complete only when all six children are review-clean and final cumulative review proves:

1. `.mpr` is parsed by independently authored CellXplorer code with no GPL runtime dependency/copied implementation;
2. supplied/paired MPR binary fields match EC-Lab `.mpt` ground truth within defined tolerances when a pair is available, or the user-amended first implementation records parity as unavailable without claiming it;
3. GCPL cycles, programmed steps and executed steps map deterministically to canonical semantics;
4. current sign/capacity/energy/timestamp mappings are validated;
5. three-electrode Ewe/Ece/Ecell mapping is correct and preserved through cache/API/Time-Capacity UI;
6. metadata/protocol reconstruction is truthful and capability limitations are explicit;
7. `.mpr` participates in normal bounded import/source lifecycle and large-batch outer multiprocessing;
8. no row-per-point SQLite storage or list-endpoint parsing is introduced;
9. existing Neware binary/Excel golden scientific results remain unchanged;
10. protocol-derived analyses work only when the mapped BioLogic protocol contains the semantics the existing recognizer actually requires; not-applicable is not failure;
11. no unexpected relational migration or `CALC_VERSION` bump occurs;
12. parser revision/cache/provenance behave under Parent 040's source-specific identity model;
13. frozen Windows backend/app can import and reuse a supported MPR when packaged verification is available, with packaged status recorded truthfully when it is not run;
14. current preflight passes and manual/packaged checks are truthfully recorded;
15. durable docs/project context are updated and final reviewer states merge readiness.

## Implementation record

The parent implementation is on the shared `feature/biologic-mpr-gcpl-support` branch. Child
commits and the cumulative closure evidence are recorded in the 041.6 implementation record. The
parent remains pending until the final Sol review explicitly marks the cumulative feature
`FEATURE_COMPLETE` and states merge readiness.
