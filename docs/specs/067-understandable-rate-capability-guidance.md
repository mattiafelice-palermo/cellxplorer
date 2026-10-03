# 067 — Understandable C-rate analysis guidance

Status: Complete; Astra Medium review, browser acceptance and canonical preflight passed.
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

## Implementation and verification

Contextual information buttons in the plot and identification settings open
plain-language help with expandable completion/capacity details and the current
configured minimum and tolerances. Evidence details explain only proven missing
current-to-C-rate conversion metadata, completed distinct-rate counts below the
configured minimum, and existing unverified-voltage validation flags. Ambiguous
no-match states offer the supported pattern, recognition rules and protocol
inspection. Draft, loading, error, disabled and display-filter states remain
distinct. Detector rules, capacity extraction and scientific calculations are
unchanged; the result cache schema advances to 5 for additive cell evidence.

Focused backend tests cover conversion prerequisites, declared/reconstructed
rate availability, tolerance-aware completed-rate counts, unverified voltage,
ambiguous sweeps and numerical-result invariance: 21 tests and 13 corpus subtests
passed. Seven frontend policy tests covering current limits and truthful copy
passed, and TypeScript passed. Browser acceptance, Astra Medium review and
canonical preflight are coordinated in the parent task before this checkpoint
is committed and pushed.

Golden scientific projection excludes only Rate Capability
`cells[*].recognition_evidence`, whose observations are covered by focused
tests. A narrow projection regression preserves every scientific key and
proves changed capacity or family-match status still fails comparison. Golden
analysis and approval-checkpoint verification passed all 35 tests; no committed
expected output or numerical tolerance was changed.

Final canonical preflight passed all four stages, including 191 backend/frontend
test modules, TypeScript and the production bundle (185.85 seconds total).
Disposable browser acceptance covered not-started/loading transitions, completed
recognition and incomplete-step evidence, and the help modal in light/dark.
Completed no-match copy is covered by focused tests rather than a browser fixture.
Astra Medium's independent review is PASS with no remaining findings.
