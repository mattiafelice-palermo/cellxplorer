# Spec 066 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-03.
Checkpoint: working-tree implementation on `codex/alpha-analysis-improvements`,
base `3f8b28f0d6e59856860ace1f9ecff1df2550869c`.
Verdict: **PASS — implementation review clean**. Final preflight and bounded
Cells-only browser acceptance are reported complete by the implementer.

## Final acceptance evidence

The implementer reports final canonical preflight **4/4 passed**, with 95
backend modules rerun; an earlier full run passed 190 backend/frontend
files/modules. Focused checks passed **81/81** and TypeScript passed after
the final edits. The final successful preflight supersedes the pending retry
noted below.

In the disposable browser analysis, Cells only displayed the member CE legend
entries `Acceptance sample 101 CE` and `Acceptance sample 103 CE`, their curves,
and the right CE axis. This browser evidence was supplied by the implementer;
the reviewer independently ran the code-level checks described below. Other
display modes remain renderer-tested, rather than browser-verified. Downloaded
image/portable output and native-app acceptance were not independently exercised.

## R1 re-review

R1 is resolved in the revised working tree. `cycleDisplayPolicy.ts` now owns
per-group member eligibility and is used by the renderer, visibility targets,
and Appearance descriptor builder. The Appearance builder exposes member CE
in Cells only and mean-plus-members, retains unaggregated-group members when
another group aggregates, and omits missing/nonfinite CE when result quantities
are present. Descriptor identities match the renderer's existing independent
CE style-resolution keys; no scientific or persistence format change is needed.

Independently ran `node --test frontend/tests/seriesStyling.test.ts`: **62/62
passed**, including the new five-mode Appearance regression. Together with the
initial renderer inspection and 10/10 renderer test run, no actionable
implementation findings remain. The implementer reports 81/81 focused tests.
The first full preflight reportedly timed out in `import_search_live` under
16 workers; a four-worker retry is pending. This review does not certify that
timeout as unrelated or claim preflight/browser acceptance.

## Resolved R1 — P2: Appearance excluded newly rendered member CE

`frontend/src/features/analyses/editor/plotting/seriesStyling.ts:250` and `:283`
still implement the previous eligibility rules. The CE descriptor loop rejects
every grouped Cell, and the primary descriptor loop suppresses every grouped
Cell when any aggregate exists and individuals are disabled.
`PlotStylePanel.tsx:203` calls this builder; `CyclePlotCard.tsx:1940` supplies no
replacement descriptor list. Consequently the new member CE traces cannot be
selected for individual appearance edits, and an unaggregated group's primary
and CE series disappear from Appearance when another group has an aggregate.
This violates Spec 066's shared eligibility and independent styling requirement.

Direct execution of the descriptor builder reproduced:

- Cells only, grouped Cell 1: `[c1]` (member CE missing).
- Mean plus members, Group 7 / Cell 1: `[g7,c1,y2:coulombic_efficiency:g7]`
  (member CE missing).
- Aggregate for Group 8 plus unaggregated Group 7 / Cell 1:
  `[g8,y2:coulombic_efficiency:g8]` (both Cell 1 descriptors missing).

Use the shared per-group eligibility policy for Appearance as well as rendering
and visibility targets; keep missing/nonfinite CE out of Appearance. Add focused
descriptor/panel regressions for these modes and a member CE style override that
is reflected by the canonical trace builder.

## Evidence and limits

Independently ran the renderer test module: **10 tests passed**, including all
three newly added replicate cases. Inspected the live/export trace derivation
and saved-preview call sites: they use `cycleTracesForResult`; the change does
not modify CE calculation or persisted scientific data. The added finite-value
gate prevents an empty member CE trace.

The test command also named `cyclePlotLayout.test.ts`, but emitted only the ten
renderer cases; this review does not claim an independent layout-test pass.
Canonical preflight was running in the implementer's session. Browser,
downloaded image/portable output, and native-app acceptance were not performed
by this reviewer. Browser acceptance remains required by the spec.
