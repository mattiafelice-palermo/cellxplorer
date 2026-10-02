# 067 — Understandable C-rate analysis guidance

Status: Planned.
Branch: `codex/alpha-analysis-improvements`.
Review document: [067 review](reviews/067-understandable-rate-capability-guidance-review.md).

## Goal

Explain Rate Capability analysis without requiring knowledge of the detector.
Add contextual help: compare capacity at different charging/discharging speeds;
one direction varies while the opposite stays fixed. Explain completed voltage
limits, the configured minimum rates, CC-only capacity and nominal capacity.
Keep the plot/settings uncluttered: information button and expandable details.

## Truthful diagnostics

Improve no-match feedback using evidence the recognition path actually has.
Report a proven missing nominal-capacity prerequisite or proven insufficient
distinct rates only when applicable. Do not infer why a candidate failed merely
because no block matched. Existing incomplete-pair reasons may be translated to
plain language; ambiguous cases explain the supported pattern and offer the
existing recognition settings/protocol inspection, without claiming corruption.
Include actual configured limits when reporting them. Do not loosen recognition
or change scientific calculations to make the help look successful.

## Acceptance

Tests distinguish missing rate prerequisites, no supported sweep and incomplete
steps, verify copy uses current settings and preserves numerical output. Browser
verify help/no-match feedback in light/dark with disposable data. Astra Medium
review, full preflight, commit/push checkpoint before proceeding.
