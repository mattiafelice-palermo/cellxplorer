# 069 — Sample-hue cycle shading for Voltage/Capacity

Status: Planned.
Branch: `codex/alpha-analysis-improvements`.
Review document: [069 review](reviews/069-voltage-capacity-cycle-shading-review.md).

## Approved scope

Add Cycle shading to Series Appearance only for Time/Capacity analysis, applied
only to Voltage/Capacity curves. Defaults preserve existing colors. Retain each
sample's resolved hue; vary HSL lightness, saturation or both across cycles.
Changing the base sample color updates its gradient. Time plots and current
curves do not receive this styling.

## Controls and identities

Enable, mode (lightness/saturation/both), first/last endpoints, reverse gradient,
smooth/stepped progression with bounded band count, fixed cycle mapping range,
selected-sample/all-samples application, preview and reset. Endpoints/range use
validated bounded numbers. An automatic range must use the full available
scientific cycle range, not the current navigated window; persist/freeze resolved
bounds so navigation cannot recolor a cycle. Charge/discharge of the same cycle
share shading. Do not key shading to sampled row number or trace order.

Persist optional presentation in existing style JSON. Preserve current overrides,
visibility and palette precedence, legend grouping and disabled behavior. Explain
cycle progression with a compact key instead of hundreds of legend entries.
Reuse already segmented curves; do not add a trace per raw point or background
recomputation. Shared traces must carry the same colors into saved/image/portable
outputs; data exports are scientifically unchanged.

## Acceptance

Focused tests verify hue preservation, modes/endpoints/reversal/steps, stable
navigation, sample overrides, same-cycle phase colors, old-style compatibility,
time/current nonapplication and export trace parity. Browser verify per-sample
and all-sample controls, hue changes, navigation, reset/save in light/dark.
Astra Medium review, full preflight and pushed checkpoint.
