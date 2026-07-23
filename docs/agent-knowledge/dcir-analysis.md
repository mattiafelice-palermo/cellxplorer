# DCIR analysis

The DCIR tab measures direct-current internal resistance from an adjacent long-rest and
short-current-pulse pair. Its scientific and UI state is deliberately isolated from the shared
protocol segments used by Cycles and Steps.

## Scientific definition

For every occurrence of the selected rest/pulse pair:

- `Vrest` is the last valid voltage in the rest step.
- `Vpulse` is the last valid voltage in the pulse step.
- Pulse current is the median absolute current over the pulse records, converted to amperes.
- Discharge resistance is `1000 * (Vrest - Vpulse) / abs(I_A)`.
- Charge resistance is `1000 * (Vpulse - Vrest) / abs(I_A)`.

The result is expressed in milliohms. Relative change is
`100 * (R - Rfirst) / Rfirst`, so the first valid occurrence is zero. The backend emits occurrence,
cycle, and elapsed-time X arrays together so changing the displayed axis does not trigger another
scientific computation.

The implementation is in:

- `backend/app/services/dcir.py`: candidate detection and per-occurrence calculation
- `backend/app/services/analysis_engine.py`: explicit `(cell, DCIR segment)` series computation
- `backend/app/routers/analyses.py`: candidate and result endpoints
- `frontend/src/components/DcirPlotCard.tsx`: DCIR adapter, series builder, and plot
- `frontend/src/components/ProtocolSegmentsPanel.tsx`: shared grouped protocol editor used by
  DCIR and the other protocol-segment workflows

## Private segment ownership

DCIR segments live at top-level `spec.dcir_segments`; they must never be written to or inferred
from `spec.protocol_segments`. A DCIR target is scoped to one protocol signature and stores an
exact `rest_step_index` plus `pulse_step_index`. This separation lets the DCIR editor offer
specialized rest/pulse recognition without changing protocol filtering in Cycles or block
definitions in Steps.

Candidate recognition is only an editing aid. It suggests adjacent rest/pulse pairs using editable
minimum-rest, maximum-pulse, and rest-to-pulse ratio thresholds. Detection reads the reconstructed
protocol's `time_limit_s`, so Neware millisecond duration fields must be normalized by
`protocol.reconstruct_protocol` before matching. Suggestions prefill the same grouped protocol
editor used elsewhere; the user can inspect and confirm the exact two steps before saving. API
errors must be shown as loading failures, never as a successful "no matches" result.

## Series and cache boundaries

One plotted line is one explicit `(cell_id, segment_id)` pair in
`spec.computation.dcir.series`. There is no replicate aggregation in the DCIR tab. Cells sharing a
protocol signature may be offered as additional series for the same confirmed segment; cells on
other protocol signatures need a target defined for their protocol.

The scientific cache includes:

- analysis selection
- `computation.dcir.series`
- private `dcir_segments`
- source fingerprints and scalar metadata

Display choices in `presentation.dcir_view` are excluded from the scientific cache key:

- absolute resistance versus change from first
- occurrence, cycle, or elapsed-time X axis
- candidate-recognition thresholds

Saved plots and portable reports reuse the canonical trace/layout builders exported from
`DcirPlotCard.tsx`. Keep live, saved-preview, thumbnail, and export rendering on those same helpers
to avoid visual drift.

## Verification

Focused tests:

```powershell
python -m unittest tests.test_dcir
python -m unittest tests.test_analysis_engine.AnalysisEngineTests.test_dcir_compute_emits_explicit_cell_segment_series
python -m unittest tests.test_analysis_cache.AnalysisCacheTests.test_dcir_view_does_not_change_scientific_cache_spec
python -m unittest tests.test_analysis_cache.AnalysisCacheTests.test_dcir_series_and_private_targets_change_scientific_cache_spec
```

The synthetic tests cover candidate detection, charge/discharge signs and formulas, repeated
occurrences, explicit series output, all three X arrays, and cache ownership.
