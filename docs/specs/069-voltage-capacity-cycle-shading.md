# 069 — Sample-hue cycle shading for Voltage/Capacity

Status: Implemented; independent review and final preflight/checkpoint pending.
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

## Implementation and focused verification

Optional normalized `PlotStyle.cycle_shading` stores frozen defaults and stable
sample exceptions. Series Appearance previews locally and applies/reset settings
explicitly. Full bounds come from `maxAvailableCycle`; unknown bounds cannot
enable the editor's default range until manual bounds are explicitly entered.
Stored manual bounds remain usable. Source growth requires Update full range.

The existing canonical-cycle/phase capacity segments receive colors after
palette/rule/channel resolution. No traces, computations, requests or scientific
caches are added. Named/rgb/hsl colors and alpha are supported by the existing
locked tinycolor2 dependency, now declared directly. Gray/unknown/display-only
cycles retain neutral/base colors. The bounded multiline mapping annotation
preserves reference geometry and appears in shared figure layouts.

Focused policy and production-renderer tests cover modes/endpoints, reversal,
bands, malformed inputs, unknown bounds, immutable selected/all application and
reset, persisted styles, frozen navigation, canonical vs source cycle identity,
phase colors, channel/palette hue changes, current/time/derivative exclusions,
null break rows, replicate keys, scientific export-column invariance and
interactive/export parity. TypeScript compilation passes. Browser acceptance,
Astra review and full preflight are coordinated by the root implementer.

## Root acceptance evidence

132 focused tests, TypeScript and canonical preflight passed (4/4 stages,
122.92 s, four workers). Disposable browser acceptance covered smooth/all-sample
and reversed six-band modes, selected-sample apply, draft reset dismissal, base
hue changes, frozen bounds while navigating, save/reload and actual PNG export.
Time-axis plots hide Cycle shading. Light/dark controls and compact preview key
visibility were checked; a clipped key was corrected and regression-tested.
The scientific library and real installed applications were untouched.
