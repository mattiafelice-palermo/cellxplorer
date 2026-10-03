# 066 — CE curves for displayed replicate members

Status: Implemented; independent review and preflight passed.
Branch: `codex/alpha-analysis-improvements` (shared sequential batch, explicitly requested).
Review document: [066 review](reviews/066-replicate-ce-rendering-review.md).

## Goal and scope

Fix the Cycles renderer's exclusion of grouped cells' CE curves. Cells only must
show each displayed cell's CE; Mean with band shows the group's CE; enabling
individual members allows their CE alongside the mean. Preserve independent
primary/CE visibility and styling. Missing/nonfinite CE must not invent a curve.
Use one eligibility policy for traces, appearance descriptors and visibility
targets. A group's presence elsewhere must not suppress an unaggregated group.
Do not change scientific CE calculation or parsed data.

## Acceptance

Focused renderer/policy regressions cover Cells only, mean-only, mean plus
members, mixed groups with no aggregate, missing CE, hidden primary with visible
CE and hidden CE with visible primary. Live, saved, image and portable rendering
use the same trace builder. Browser check a disposable replicate analysis.
GPT-6 Astra Medium independently reviews implementation; resolve findings,
run canonical preflight, commit and push this checkpoint before the next spec.

## Verification

81 focused frontend tests passed, including trace rendering, visibility and
Appearance descriptors; TypeScript passed. Canonical preflight passed all four
stages with a four-worker budget. Browser verification in a disposable library
showed both members' CE curves in Cells only mode. Mean-only and mean-plus-members
were verified by renderer regressions. No scientific calculation changed.
