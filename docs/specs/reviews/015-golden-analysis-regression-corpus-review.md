# Review 015: Golden analysis regression corpus

Branch: `feature/golden-analysis-regression-corpus`  
Head: `880c8219af470bc51cbdc02909e7b5cf1c74ae2f`  
Base and merge base: `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`  
Scope: clean; one feature commit ahead of `main`  
Status: **changes required — not ready to merge**

## Confirmed

The branch adds the intended four binary fixture roles, checksum verification, production-service dispatch, recursive numerical comparison, corpus documentation and update tooling. The branch has no unrelated feature work.

Composer reports `python -m unittest tests.test_golden_analysis -v` passing with 10 tests in approximately 4.5 seconds. No full backend run or preflight result is recorded.

## R1 — Critical: four protocol-dependent goldens contain no scientific results

Affected files:

- `tests/golden_analysis_support.py`
- `scripts/build_golden_analysis_corpus.py`
- `tests/fixtures/golden_analysis/expected/{steps,dcir,chargeability,rate_capability}_baseline.json`
- corresponding specs and manifest entries

### Current

The harness manually creates `SourceFile` rows without populating `header_meta` or the normalized source metadata. It then calls `scanner.parse_file`, which only builds the raw and cycle caches; it does not read and assign the Neware header.

Consequently, the current golden outputs approve failure states:

- Steps: zero blocks and `steps_no_match`.
- DCIR: zero measurements and `dcir_no_match`.
- Chargeability: no candidates or executed curves.
- Rate Capability: no blocks, points, rates or reference rate.

The Steps builder also takes protocol segments from analysis 20, identified as the Chargeability analysis, while attaching them to the separate 193-cycle source. This does not represent the Steps plot from the cycling source.

These outputs fail the core scientific coverage required by the spec.

### Target

Install each binary through the production source-ingestion path, or explicitly populate the same header fields that `scanner.ingest_path` produces before parsing. Build the Steps segment from the actual protocol of `cycles_time_steps.ndax`.

Regenerate the candidate outputs only after all four cases produce real measurements.

### Acceptance criteria

- Steps has at least one multi-step block with non-empty occurrence, cycle and time arrays.
- DCIR has both charge and discharge series with finite resistance values and measurement metadata.
- Chargeability has at least one semantic candidate and one executed curve.
- Rate Capability has at least one detected real sweep with rates, CC-only capacities and a reference rate.
- None of these baseline cases ends in a `*_no_match` or `*_no_candidates` state.

## R2 — High: derivative and normalization cases are duplicates of their baselines

Affected files:

- `scripts/build_golden_analysis_corpus.py`
- `specs/cycles_normalization.json`
- `specs/time_capacity_derivative.json`
- corresponding expected JSON

### Current

`cycles_normalization.json` and `cycles_baseline.json` generate byte-identical expected files.

The Time/Capacity derivative and baseline files are also byte-identical.

The builder writes derivative settings under `presentation.time_capacity`. The backend reads them from `computation.time_capacity`, so the derivative mode is never activated.

The normalization flag is likewise a presentation field that does not create a distinct backend scientific result.

### Target

- Put derivative configuration in `computation.time_capacity`.
- Make the normalization case exercise a genuinely distinct scientific input or projection.
- Add an areal Time/Capacity path using a fixed electrode area, as required by the spec.
- Remove a duplicate case only after explicitly revising the locked coverage.

### Acceptance criteria

- The derivative result contains non-empty derivative X/Y arrays and is not identical to the voltage-current baseline.
- A manually checked derivative point is recorded.
- Specific and areal normalization values are explicitly asserted.
- No two cases advertised as distinct scientific computations have identical expected JSON.

## R3 — High: the tests do not guarantee a cold, isolated production parse

Affected files:

- `tests/golden_analysis_support.py`
- `tests/test_golden_analysis.py`

### Current

The test module defaults to the persistent repository `.test-cellxplorer` directory. `GoldenFixtureEnvironment.create()` creates a temporary `data_root`, but never binds the already-imported cache/configuration modules to it.

`scanner.parse_file` can therefore call `cache.build` against an existing checksum/version cache. `cache.build` skips binary parsing when raw and cycle Parquet files already exist.

The “parsed once” test counts calls to `scanner.parse_file`, not actual source parsing. It also creates a fresh environment only inside that test, while other tests independently create additional environments.

A parser regression could therefore be hidden by stale Parquet from an earlier run.

### Target

Use one module-level isolated environment whose scientific cache is physically under a temporary root. Ensure every unique binary is cold-parsed once and then reused by all cases.

Instrument the actual binary parsing boundary, not only `scanner.parse_file`.

### Acceptance criteria

- `parsing.parse_timeseries` or the equivalent real parser boundary runs exactly once per unique source hash.
- The test starts with no raw or cycle Parquet.
- All generated caches are inside the temporary fixture root.
- No `.test-cellxplorer` or live cache is read or written.
- The temporary database and caches are removed after the module.
- A pre-existing external cache cannot change whether the parser is exercised.

## R4 — High: the corpus has not received scientific approval

Affected file:

- `tests/fixtures/golden_analysis/approval.md`

### Current

All seven required scientific checkpoints remain pending, with no approver or date.

The spec explicitly says that automated tests may run while approval is pending, but the branch is not ready to merge as a scientific golden baseline.

### Target

After R1–R3 are corrected, independently verify the reference calculations against raw rows and protocol fields.

### Acceptance criteria

Each checkpoint records:

- exact raw rows or protocol fields;
- formula and unit;
- manually verified value;
- comparison with the golden output;
- approver and date.

Approval must cover CC+CV capacity, CE/EE, counter continuity, Steps timing, charge and discharge DCIR, Chargeability SoC/reference capacity and Rate Capability CC-only capacity/reference rate.

## R5 — Medium: the builder is tied to one workstation and database layout

Affected file:

- `scripts/build_golden_analysis_corpus.py`

### Current

The script hard-codes:

- personal absolute Windows paths;
- analysis IDs;
- cell IDs;
- saved-plot names;
- the same chargeability source and cell for the Rate Capability role.

The CLI only accepts `--data-root`, `--output` and `--replace`; it does not accept or resolve the requested analyses.

Moving a source file, changing an analysis ID or running the tool on another installation breaks corpus generation.

### Target

Resolve analyses, saved plots, selected cells and their exact source paths from the SQLite snapshot. Accept analysis titles or IDs through explicit CLI arguments and reject ambiguous title matches.

Remove all absolute personal paths and fixed database IDs from repository code.

### Acceptance criteria

- `--help` exposes Cycles, DCIR, Chargeability and Rate Capability analysis selectors.
- Export succeeds against a copied data root whose source paths differ from the original workstation.
- Ambiguous titles fail with a request for an ID.
- No `C:\Users\...` path or local analysis/cell ID remains in the script.

## R6 — Medium: the manifest contains unnecessary raw metadata and identifiers

Affected files:

- `scripts/build_golden_analysis_corpus.py`
- `tests/fixtures/golden_analysis/manifest.json`

### Current

The builder copies every `cell_metadata` entry into the manifest. This includes complete `raw.*` protocol metadata plus searchable identifiers such as builder, channel, device information, remarks, GUIDs and original experiment naming.

Most of this metadata is then attached as `CellMetadata`, while the required `SourceFile.header_meta` remains empty. It both exposes unnecessary information and contributes to the very large manifest.

The spec only requires active mass, nominal capacity, electrode area and deterministic entity relationships in the manifest.

### Target

Keep only scalar metadata required by calculations. Derive source protocol/header information from the committed binary through production parsing.

### Acceptance criteria

- The manifest contains no `raw.*`, GUID, device, channel, builder, remark or original-path fields unless individually justified.
- Active mass, nominal capacity and electrode area are retained.
- Protocol reconstruction uses parsed `SourceFile.header_meta`.
- The source privacy review is recorded before merge.

## R7 — Medium: required verification and harness tests are incomplete

Affected files:

- `tests/test_golden_analysis.py`
- Spec implementation record

### Current

Only the focused 10-test run is reported. The spec also requires the full backend suite and uncached preflight, with exact results recorded.

The current test file does not fully verify:

- required raw columns and dtypes;
- a missing spec file;
- that corpus generation is never invoked during normal tests;
- that no path outside the fixture/test root is accessed;
- the actual parser invocation count across the whole module.

The live-database test only compares two path strings.

### Target

Add the missing harness assertions and run the complete verification only after R1–R6.

### Acceptance criteria

Record successful results for:

```powershell
python -m unittest tests.test_golden_analysis -v
python scripts\build_golden_analysis_corpus.py --help
python scripts\build_golden_analysis_corpus.py verify --manifest tests\fixtures\golden_analysis\manifest.json
python -m unittest discover tests
python scripts\preflight.py --no-cache
```

## Follow-up order

`R1 → R2 → R3 → R5 → R6 → R7 → R4`

## Verification record

### Implementer reported

- `python -m unittest tests.test_golden_analysis -v`
- 10 tests passed in approximately 4.5 seconds.

### Reviewer independently performed

- Inspected the complete branch diff against the correct merge base.
- Read the harness, builder, test module, specs and committed expected outputs.
- Compared the duplicate expected-file blob hashes.
- No test command was executed in the reviewer environment.
- No GitHub workflow or commit status was attached to this feature-branch commit.
