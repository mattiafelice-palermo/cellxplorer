# Chargeability analysis

## Scientific definition and matching

The Chargeability tab identifies voltage-controlled charge events by protocol meaning rather than
by fixed Neware step numbers or user-variable names. The configured requirements are an upper
bound for initial SoC, a lower bound for final SoC, a minimum declared current ceiling, and an SoC
tolerance.

`backend/app/services/chargeability.py` reconstructs that meaning from capacity formulas:

- a preceding discharge condition such as `DischargeAh - 0.8*User1` establishes 20% initial SoC;
- a voltage-controlled charge condition such as `ChargeAh - 0.6*User1` adds 60%, establishing an
  80% final SoC;
- both conditions must refer to the same capacity variable;
- the candidate charge step must have an explicit or reconstructable C-rate and one of the
  supported voltage-controlled Neware step types.

The formula parser is deliberately not an evaluator. It uses Python's AST only to reduce numeric
constants, variable names, addition/subtraction, scalar multiplication, and scalar division to a
linear expression. Calls, attribute access, powers, and products of two variables are rejected.
Keep that language small unless a verified Neware protocol requires another safe linear form.

Neware's `GlobleUserID` condition field records an expression into a global user variable. Protocol
reconstruction exposes both the raw ID and its `User1`, `User2`, ... mapping as
`global_user_id`/`stores_as` in `backend/app/services/protocol.py`. This lets the matcher locate the
full-cycle step that measured the reference capacity without depending on a particular variable
number.

## Declared protocol versus executed data

Candidate discovery uses protocol metadata. A curve is returned only when the candidate step also
exists in the raw Parquet data. Each executed occurrence becomes one match.

The capacity-based SoC axis uses the capacity measured by the protocol step that populated the
shared user variable. The extractor selects the larger positive recorded charge/discharge capacity
from that step, because unused Neware capacity columns can contain zeros rather than missing
values. If the assignment or measured capacity cannot be resolved, time/current/capacity axes
remain usable and only the SoC axis is unavailable.

The plotted C-rate is observed absolute current divided by the cell's resolved nominal capacity;
the protocol's declared C-rate is used for candidate filtering and compatibility. Specific and
areal axes use the same active-mass and electrode-area resolution as the other analysis families.

For multi-cell selections, compatibility is based on a semantic fingerprint of the inferred
initial/final SoC window, current ceiling, voltage target, and mode. Curves may still be inspected
when fingerprints differ, but the response and UI mark them as non-equivalent.

## Ownership, caching, and presentation

The backend endpoint is `POST /api/analyses/{id}/chargeability`. Its result schema has an
independent entry in `analysis_cache.RESULT_SCHEMA_VERSIONS`; change that entry when the cached
payload shape changes.

Frontend tab logic lives in
`frontend/src/components/ChargeabilityPlotCard.tsx`, not in the large Analysis page. The component
owns the dedicated React Query request, automatic-identification controls, axis choices, Plotly
traces/layout, styled image export, CSV/XLSX export, and delayed single-loader behavior. Like
C-rate, cold recognition uses a `job_token` plus `frontend/src/recognitionProgress.ts`, and
`Show detected steps` opens `ProtocolStructureViewer` highlighting matched `step_index` values.
`frontend/src/pages/AnalysisPage.tsx` only supplies shared plot infrastructure, tab wiring, saved
plot normalization, and thumbnail generation.

The generic cycle query must remain disabled while Chargeability is active. The chargeability
query retains the previous result during filter changes so the existing plot dims briefly instead
of disappearing or showing a second loader. Saved-plot previews use the same dedicated endpoint
and trace/layout builders as the live card.

Focused scientific coverage is in `tests/test_chargeability.py`; Neware global-user reconstruction
coverage is in `tests/test_protocol.py`.
