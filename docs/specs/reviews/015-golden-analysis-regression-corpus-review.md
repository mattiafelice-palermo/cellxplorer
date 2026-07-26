# Review 015: Golden analysis regression corpus

Branch: `feature/golden-analysis-regression-corpus`  
Head reviewed: `5e47e628899707f407882c41398a484931a266b8`  
Base and merge base: `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`  
Cumulative branch scope: two commits ahead of `main`  
Status: **Round 2 follow-ups implemented in working tree / next commit — R4 scientific approval still pending**

## Round 2 summary

Composer materially improved the implementation:

- protocol-dependent cases now contain real Steps, DCIR, Chargeability and Rate Capability results;
- source installation uses the production ingestion path;
- Time/Capacity derivative settings are now applied under `computation.time_capacity`;
- the cache root is isolated for the golden test module;
- manifest metadata is substantially reduced;
- the builder now exposes analysis selectors;
- focused and full-backend results are recorded.

However, the corpus still does not satisfy the complete scientific contract. Several safeguards can also allow an invalid golden baseline to be accepted or overwritten.

## Status of previous findings

| Finding | Round 2 status |
|---|---|
| R1 — Empty protocol-dependent cases | **Partially addressed**. Cases are non-empty, but DCIR still covers discharge only. |
| R2 — Duplicate normalization/derivative cases | **Addressed**. The outputs are now distinct and the derivative mode is active. |
| R3 — Cold isolated parsing | **Partially addressed**. The cache root is fresh and isolated, but parser-call instrumentation and cleanup remain incomplete. |
| R4 — Scientific approval | **Open**. All seven checkpoints remain pending. |
| R5 — Workstation-bound builder | **Partially addressed**. Absolute paths/IDs were removed, but Rate Capability source resolution and saved-plot selection remain incorrect or fixed. |
| R6 — Excess manifest metadata | **Addressed**. |
| R7 — Verification/harness completeness | **Partially addressed**. Focused, verify and backend runs are recorded; required assertions and full preflight remain missing. |

## R1 — High: DCIR golden coverage still omits charge resistance

**Affected files**

- `tests/fixtures/golden_analysis/specs/dcir_baseline.json`
- `tests/fixtures/golden_analysis/expected/dcir_baseline.json`
- builder case generation
- `tests/test_golden_analysis.py`

### Current

The regenerated DCIR output is now real, but it contains one series only:

- `direction: "discharge"`;
- seven discharge measurements;
- no charge series.

The specification requires at least one discharge and one charge rest/pulse series. The approval checkpoint also requires one independently calculated charge resistance and one discharge resistance.

### Target

Add a charge DCIR series from the same complete DCIR source. This may be a second series in the existing case or a second bounded DCIR case.

### Acceptance criteria

- Golden output contains both `direction: "charge"` and `direction: "discharge"`.
- Both series contain finite `dcir_mohm`, relative-change arrays and measurement metadata.
- The harness explicitly asserts both directions.
- `approval.md` independently checks one charge and one discharge resistance.

## R8 — High: the Cycles projections discard required scientific coverage

**Affected files**

- `tests/golden_analysis_support.py`
- `tests/fixtures/golden_analysis/expected/cycles_baseline.json`
- `tests/test_golden_analysis.py`

### Current

The new `cycles_absolute` allowlists make the baseline smaller, but they remove required scientific outputs. The committed baseline keeps only a limited set of quantities and metrics.

Missing coverage includes, at minimum:

- per-cycle retention;
- voltage-efficiency output;
- cycle/charge/discharge duration quantities and related summary metrics;
- CV fraction/reached metrics;
- final retention and total-duration summaries;
- other stable summary metrics returned by the production service.

The spec requires retention, voltage statistics, CV time/capacity, polarization and summary metrics—not merely a small representative subset.

### Target

Use a bounded projection that preserves every scientific field required by Spec 015. Separate absolute and specific projections only where units differ; do not remove unrelated scientific quantities to make the files distinct.

### Acceptance criteria

- `cycles_baseline` explicitly includes capacity/energy, CE/EE, voltage statistics, CV time/capacity, retention, polarization and summary metrics.
- Tests assert the required keys, rather than only comparing generated JSON.
- `cycles_normalization` asserts specific-capacity values while retaining the scientific context needed to interpret them.
- No required field can disappear while golden tests continue to pass.

## R9 — High: non-finite production values are converted to `null` before comparison

**Affected files**

- `tests/golden_analysis_support.py`
- `tests/test_golden_analysis.py`

### Current

`project_result()` recursively converts every non-finite float to `None`. The comparator rejects NaN/Infinity only when called directly with a non-finite value.

All real golden cases pass through `project_result()` first. A production regression that emits NaN or Infinity can therefore become JSON `null` and pass whenever the expected projection also contains `null`.

The existing NaN test exercises `compare_values()` directly and does not cover this path.

### Target

Reject non-finite scientific values during projection or before projection. Do not apply a generic NaN/Infinity-to-null conversion.

Intentional missing data should already be emitted as `None` by the production service or handled by an explicitly documented path rule.

### Acceptance criteria

- `project_result({"value": math.nan})` and Infinity fail clearly.
- A test injects a non-finite value into a production-shaped result and proves the complete projection/comparison path fails.
- Existing legitimate `None` values remain supported.
- No expected JSON is regenerated to hide a non-finite output.

## R10 — High: a new script overwrites committed goldens directly

**Affected file**

- `scripts/regenerate_golden_fixture_outputs.py`

### Current

The script directly modifies committed specs, rewrites the committed manifest and overwrites every committed expected JSON file in `tests/fixtures/golden_analysis/`.

This bypasses the locked workflow in which:

1. the builder writes a separate candidate;
2. numerical changes are reviewed;
3. approval checkpoints are performed;
4. reviewed files are copied explicitly.

The script also hard-codes fixture IDs, a protocol signature, step indices and electrode area.

### Target

Remove this one-off script, or convert it into a candidate generator that requires an explicit output directory outside the committed fixture tree.

The canonical update path should remain `build_golden_analysis_corpus.py export`.

### Acceptance criteria

- No repository script rewrites committed golden specs, manifest or expected JSON in place.
- Regeneration always writes to a separate candidate directory.
- The command produces or documents a numerical diff before replacement.
- Normal verification remains read-only.
- Hard-coded one-off patch values are removed.

## R5 — Medium: Rate Capability export still resolves the Chargeability source

**Affected file**

- `scripts/build_golden_analysis_corpus.py`

### Current

The CLI resolves `rate_analysis_id`, but export still:

- obtains `rate_plot` from the Chargeability analysis spec;
- uses `chargeability_cell_id` for the Rate Capability case;
- copies the Chargeability cell source as `rate_capability_source.ndax`;
- never resolves the primary cell/source of the selected Rate Capability analysis.

Saved-plot names are also still fixed in code.

The committed corpus happens to use a Rate Capability plot stored in `Chargeability test`, so this defect is hidden for the current defaults. Passing a different `--rate-analysis` does not reliably export that analysis.

### Target

Resolve each role independently from its selected analysis:

- load the Rate Capability analysis spec;
- resolve its selected cell;
- resolve that cell's source;
- resolve or accept the Rate Capability saved plot from that analysis.

Do the same for saved-plot selectors where names are currently hard-coded.

### Acceptance criteria

- A distinct `--rate-analysis` exports its own selected cell and source.
- The manifest checksum for the rate role corresponds to that resolved source.
- A missing or ambiguous saved plot fails with a useful message.
- Tests cover a Rate Capability analysis whose cell differs from the Chargeability analysis cell.
- No hidden dependency on the default plot names remains.

## R3 — Medium: parser instrumentation and temporary-root cleanup are incomplete

**Affected files**

- `tests/golden_analysis_support.py`
- `tests/test_golden_analysis.py`

### Current

The module uses a fresh temporary cache root, which prevents stale-cache reuse. However:

- `timeseries_parse_counts` is inferred from whether `raw.parquet` existed before `scanner.parse_file`; it does not instrument the actual parser boundary;
- the assertion therefore does not prove `parsing.parse_timeseries` was called exactly once;
- `_MODULE_DATA_ROOT` is passed as an externally owned root, so `env.close()` does not remove it;
- `tearDownClass()` does not remove the module temporary directory or restore the prior data-root binding.

### Target

Instrument the actual parser call and cleanly restore/remove test-global state.

### Acceptance criteria

- A mock/wrapper around `parsing.parse_timeseries` or the actual binary parser records exactly one call per unique hash.
- The module data root is absent after teardown.
- Previous `CELLXPLORER_DATA` and module bindings are restored where required.
- A failure during `setUpClass` also cleans temporary files.

## R7 — Medium: required harness assertions and full verification remain incomplete

**Affected files**

- `tests/test_golden_analysis.py`
- `docs/specs/015-golden-analysis-regression-corpus.md`

### Current

The implementation record reports:

- 16 focused tests;
- 8/8 corpus cases;
- 379 backend tests.

It does not record `python scripts\preflight.py --no-cache`.

The test named `test_required_raw_columns_present` only checks that the helper returns at least six names. It does not validate the actual raw frames or dtypes. There is also no assertion that normal tests never invoke corpus generation.

### Target

Complete the locked verification and make the assertions test actual behavior.

### Acceptance criteria

- Every unique parsed raw frame is checked for required columns and expected dtype families.
- A normal golden test run proves no export/regeneration function is called.
- `python scripts\preflight.py --no-cache` passes and its exact result is recorded.
- The canonical full test command from the current repository documentation is also recorded.
- No GitHub status is claimed unless a workflow actually ran.

## R4 — High: scientific approval is still pending

**Affected file**

- `tests/fixtures/golden_analysis/approval.md`

### Current

All seven manual checkpoints remain `pending`, with no calculations, approver or date.

### Target

Perform approval only after R1 and R8–R10 are corrected and the expected outputs are regenerated through the candidate workflow.

### Acceptance criteria

Each checkpoint records:

- exact raw rows or protocol fields;
- formula and unit;
- independently calculated value;
- golden value and comparison;
- approver and date.

The corpus must not be described as approved, and the branch must not merge as a scientific baseline, until all seven are complete.

## Documentation consistency

The repository copy of this review still records head `880c821…`, one commit of clean scope and the original pre-fix state. Update this same review file with the Round 2 results and the current head.

The branch also contains a repository-wide review-document migration for Specs 010–014 and new workflow instructions in `AGENTS.md`. This is documentation-only but outside the scientific corpus scope; the final merge description must acknowledge it, or it should be split into a separate documentation commit/branch if conflicts arise.

## Follow-up order

`R9 → R10 → R1 → R8 → R5 → R3 → R7 → R4`

## Verification record

### Implementer reported

- `python -m unittest tests.test_golden_analysis -v` — 16 tests OK, approximately 7 s.
- `python scripts\build_golden_analysis_corpus.py verify --manifest tests\fixtures\golden_analysis\manifest.json` — 8/8 cases PASS.
- `python -m unittest discover tests` — 379 tests OK, approximately 41 s.

### Reviewer independently performed

- Confirmed head `5e47e628899707f407882c41398a484931a266b8`.
- Compared the cumulative branch and the follow-up commit against the correct merge base.
- Read the updated harness, builder, regeneration script, manifest, approval file, specs and representative expected outputs.
- Confirmed the DCIR expected output contains discharge only.
- Confirmed Cycles projection allowlists omit required Spec 015 coverage.
- Confirmed the non-finite projection path converts NaN/Infinity to `None`.
- Confirmed the direct regeneration script overwrites committed fixture files.
- No test command or browser check was run in the reviewer environment.
- No GitHub workflow/status is attached to the reviewed head.
