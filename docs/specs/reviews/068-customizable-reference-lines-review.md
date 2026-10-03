# Spec 068 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-03.
Checkpoint: working tree on `codex/alpha-analysis-improvements` after `0b34e794`.
Verdict: **PASS — implementation review clean**. Root completed the separate
browser acceptance and canonical preflight gates after the review.

## Review and resolved finding

R1 (P2) is resolved. Previously a full-domain vertical reference label used
paper coordinates until its first drag, then was converted to the upper Y
subplot domain. A label at paper Y=0.2 jumped to Y=0.39 in stacked
Time/Capacity even on a horizontal-only drag. Full-domain vertical labels now
retain paper Y in both metadata and free placement; other labels retain their
appropriate local subplot domain. The exact reproduction is regression-tested.

The reviewed implementation uses bounded, deterministic normalization and
stable IDs; exact quantity/unit bindings; categorical-axis suppression;
append-only family geometry composition; modal-owned Apply/Cancel drafts; and
presentation-only style persistence. Label text is escaped. Global Plotly
annotation dragging is enabled only when every live annotation is owned, and
shared relayout/visibility guards remain intact. Scientific trace values,
worker policy, calculation versions, and zoom/uirevision ownership are unchanged.

Actual-family tests cover Cycles X/Y/CE, the four simple families, categorical
C-rate transitions, Time/Capacity derivatives and stacked Y2/Y3, and changed
normalization, voltage channels and time units. The portable test uses the
real HTML export/import path and asserts unchanged scientific cache identity
and measured values while preserving reference style and figure geometry.

## Evidence and limits

Independent reruns: **9/9** reference-line tests and **5/5** production-family
layout tests passed. Inspected the wrapper lifecycle regression and portable
roundtrip regression; their final aggregate run is implementer-owned.

The implementer reports browser checks of Cancel/Apply, duplicate/order,
save/reload, PNG output, unit incompatibility suppression, label-drag
persistence, and actual Plotly WebGL above/below DOM placement. Zoom/refinement
and navigation remained stable in the reported browser session. These are
attributed implementer checks, not reviewer-run browser acceptance.

The implementer subsequently verified the stacked lower-panel vertical-label
drag in the browser: a horizontal drag retained pixel Y=424.01385 and saved
paper Y=0.2. Apply/reopen preserved Y=0.2; Escape discarded the modal draft.
This closes the bounded R1 browser recheck. Canonical preflight passed all 4
stages in 113.03 seconds with 4 workers. Native desktop acceptance is not claimed.
