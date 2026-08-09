# Rate-capability analysis

## Scientific meaning

The C-rate tab detects two independent protocol families:

- **Charge-rate capability:** the charge rate varies while the following discharge rate remains
  fixed.
- **Discharge-rate capability:** the discharge rate varies while the preceding charge rate remains
  fixed.

The plotted capacity always belongs to the rate-determining CC step. An adjacent CC charge and CV
charge are linked as one recognizable charge protocol, but their capacities are not added. The CV
step proves that the charge protocol reached and completed its voltage hold; including its
capacity would hide the intended CC-rate trend.

`backend/app/services/rate_capability.py` owns protocol pairing, automatic sweep recognition, raw
cutoff validation, and capacity/current normalization. Do not reproduce this logic in the
frontend.

## Recognition pipeline

`build_rate_pairs` converts protocol steps into logical charge/discharge pairs:

- adjacent CC charge and CV charge steps with the same rate become a `cc_cv` charge structure;
- a native CCCV charge remains `cccv`;
- a CC-only charge remains `cc`;
- rest and control steps are recorded as scaffold tokens but do not become measurement phases;
- fixed Neware step numbers and exact rest durations are never part of the scientific identity.

Executed raw data then validates both sides of every pair. The measurement phase and its
complementary reference phase must reach their declared upper/lower voltage cutoffs. A
time-limited step that stops before its voltage cutoff is not a valid capability point.

Valid pairs are scanned in protocol order. A sweep requires at least the configured number of
distinct rates, one approximately fixed complementary rate, common voltage endpoints, and a
consistent charge structure. Monotonic rate progression and repeated rest/control scaffolding are
configurable recognition signals:

- `prefer` uses the signal for segmentation/scoring;
- `require` rejects a candidate without it;
- `ignore` removes that signal from recognition.

The monotonic pass splits post-sweep recovery/reference cycles from an increasing or decreasing
rate sequence. Users select semantic rules and detected rates, never raw step blocks. The
highest-confidence charge and discharge block is selected independently for each cell.

## Common-rate normalization and asymmetry

Normalized retention and charge/discharge asymmetry use one global reference rate. It is the
lowest C-rate represented in both selected families for every selected cell, within the configured
C-rate tolerance. Do not silently choose a separate reference for each cell: that would make a
multi-cell comparison look equivalent when its baselines differ.

For family \(f\), cell \(i\), rate \(C\), and the global reference \(C_ref\):

`retention(i, f, C) = 100 * capacity(i, f, C) / capacity(i, f, C_ref)`

The dimensionless rate-capability asymmetry is:

`asymmetry(i, C) = discharge_retention(i, C) / charge_retention(i, C)`

It is calculated only at rates shared by charge and discharge across all displayed cells. A value
above one means discharge retention exceeds CC-only charge retention under these protocol
definitions. It is not coulombic efficiency: charge capacity excludes the CV contribution, while
the discharge point is the completed discharge capacity.

`build_common_rate_comparison` in `backend/app/services/rate_capability.py` owns this calculation.
The frontend must consume its reference and derived values rather than independently normalizing
the plotted arrays.

## Axes and normalization

The X-axis supports declared C-rate, observed current magnitude, specific current, and areal
current density. These values are ordered numerically but rendered as categories with equal visual
spacing: a rate-capability plot compares discrete programmed conditions, so the horizontal distance
between C/10 and C/5 must not imply a smaller experimental interval than the distance between 1C
and 5C. The original numerical X values remain in hover data and CSV/XLSX exports; categorical
display positions must never replace the scientific values in exported data.

Users may switch to proportional spacing, which restores a linear numerical X-axis. Both spacing
modes preserve the real numerical X values in hover data and data exports.

The Y-axis supports CC capacity, specific CC capacity, and areal CC capacity. Specific values use
resolved active mass; areal values use resolved electrode area. Missing metadata disables the
corresponding frontend choices. It also supports retention from the global lowest common rate and
the dimensionless charge/discharge asymmetry ratio.

For an adjacent CC/CV charge protocol, the charge-capability point uses only the CC step's
`charge_capacity_mah`. The CV step remains available only to recognition and cutoff validation.
Discharge-capability points use the swept CC discharge step's `discharge_capacity_mah`.

Line and grouped-bar renderers share the same result and export builders. For multiple cells, color
represents cell identity. In grouped capacity or retention bars, charge is solid and discharge uses
diagonal hatching in the same cell color. The asymmetry renderer has one combined series per cell,
so it does not use a direction pattern.

## Ownership and caching

The backend endpoint is `POST /api/analyses/{id}/rate-capability`. Its cache family is
`rate_capability`, with an independent entry in
`backend/app/services/analysis_cache.py::RESULT_SCHEMA_VERSIONS`. Schema version 3 preserves every
resolved `(cell_id, entry_kind, entry_ref_id)` selection context. The C-rate response still
contains one scientific series per physical cell, but the frontend hides that shared series only
when every occurrence of the cell is hidden. A scoped exclusion in one replicate must not hide a
standalone or differently grouped occurrence of the same cell.

Frontend implementation lives in
`frontend/src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx`. It
owns the dedicated React Query request,
automatic summaries, advanced semantic rules, rate filters, axis controls, traces/layout, styled
image export, CSV/XLSX export, and the retained-plot/single-loader behavior. Cold recognition sends
a `job_token` and polls `GET /api/background-jobs/by-token/{token}` through
`frontend/src/features/analyses/editor/recognition/recognitionProgress.ts` so the plot card can
show staged progress (including
intra-cell stages from `rate_capability.compute`). `Show detected steps` opens the read-only
`ProtocolStructureViewer` highlighting `measurement_step_index` values from the result.
`frontend/src/features/analyses/editor/AnalysisEditor.tsx` supplies only tab wiring, saved-plot normalization,
thumbnail generation, and portable-report snapshots.

The generic cycle compute must remain disabled while the C-rate tab is active. Saved thumbnails
and portable figures use the same dedicated endpoint and trace/layout builders as the live plot.

Focused scientific regression coverage is in `tests/test_rate_capability.py`.
Context-aware visibility coverage is in `frontend/tests/analysisVisibility.test.ts`.

## Multi-source continuation safety

Rate capability is currently unsupported for a Cell with multiple ordered source files. The UI's
`crate` tab maps to the backend `rate_capability` family, and endpoint, saved-preview artifact, and
warmup paths all use the shared `analysis_engine.protocol_analysis_guard`. This avoids guessing
semantic rate steps across restarted files; Cycles or Time / capacity remain available until a
reviewed source-signature/local-step mapping is introduced.

## Synthetic validation corpus

`tests/fixtures/rate_capability_corpus.json` is a declarative set of synthetic protocol families.
`tests/test_rate_capability_corpus.py` generates reconstructed Neware-like steps and raw
time-series records from every entry, then exercises the complete pipeline:

1. logical charge/discharge pairing;
2. CC-only capacity extraction;
3. raw upper/lower cutoff validation;
4. semantic sweep recognition.

The corpus deliberately varies step numbers, voltage windows, sweep direction, charge structure,
rest/control scaffolds, repeated rates, non-monotonic order, and small fixed-rate programming
jitter. Its negative cases cover too few rates, constant-rate cycling, both directions changing,
inconsistent voltage windows, interrupted measurements, mixed charge structures, and inconsistent
required scaffolds.

Add a corpus entry whenever a new supported protocol grammar or confirmed false-positive pattern
is found. Keep the generator free of production detector calls when constructing its expected
inputs, or a bug could reproduce itself in both sides of the test. Synthetic coverage protects the
protocol grammar but does not replace validation against independently produced real cycler files.
