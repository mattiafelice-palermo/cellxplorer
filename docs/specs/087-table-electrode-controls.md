# 087 — Table sizing and electrode display names

Status: Complete; final preflight and cumulative Astra Medium review passed. Branch: `codex/table-electrode-controls`.
Review document: [Cumulative Astra review](reviews/087-table-electrode-controls-review.md).

Complete the approved future-features batch after scanner recovery (085) and
inline scientific presets (086). Add persistent resizable columns to the Cell
Database, replicate table and Projects tree. Keep selection/actions accessible
and horizontal scrollbars clear of content.

Settings owns reusable display-label choices for Full cell, Working electrode
and Counter electrode. Time/Capacity series editing may use a shared base name
and automatic channel suffixes, choose custom labels, and invert the two electrode
display labels for a plotted Cell/source chain. Underlying channel identities,
measurements, sign conventions and data export columns stay authoritative.
The editor must show the fixed channel name and “Showing: …”. Naming is stored
in plot presentation so saved/reopened plots, previews and exports agree without
depending on later Settings changes. Existing plots retain their naming.

Investigate sample replacement from the empty workspace using a different Cell,
including save/reopen. Fix confirmed stale sample details; do not claim an
unreproduced plotting lockout is fixed. The hard-file header checks return masses
for all thirteen archived sources. A structured 1 mg value and 1.44 g in remarks
are distinct evidence; do not infer scientific mass from free text or silently
rescale larger recorded values. Preserve original sources.

Verify focused production paths, actual browser interactions, full four-worker
preflight, and request an independent GPT-6 Astra Medium cumulative review of
all changes in this batch, addressing findings before final integration.

## Verification record

All thirteen archived hard-file headers returned a structured mass on current
source; the expected approximately 1.4 g values are present in five cases.
Some other fields contain much larger recorded values, and case-06's 1 mg
structured field differs from its 1.44 g remarks. No independent EC-Lab export
was supplied, so no parser conversion or scientific mass was changed.

The browser recognized a different replacement Cell from the empty Cycles
workspace and created a draft. Time/Capacity also plotted the replacement.
The reported plotting lockout remains unreproduced; a confirmed stale sidebar
name was corrected by merging current Cell names. The network-drive scanner
incident remains outside the available evidence (see 085).

Browser checks saved a custom electrode label, changed all three series through
one base name, inverted the displayed labels while keeping the fixed channel
identity visible, and saved the plot. Cell column resizing persisted after reload.
Focused Settings and styling/export policy tests passed.

The saved three-channel legend and replacement Cell survived browser reload.
A 12 px pointer drag changed the Cell column from 336 to 348 px without a jump;
keyboard sizing and reload persistence also passed for Projects. Both private
parser corpora verified unchanged (six sources/three chains and thirteen
sources/twelve chains). Cumulative Astra Medium review found issues corrected
in the review follow-up; the final re-review is clean. Grouped series can share
names, but inversion requires adding the particular Cell individually.

Final no-cache preflight passed all four stages and all 219 backend/frontend
test files/modules after the review corrections. Browser verification also
confirmed a stale Settings save returns a conflict without losing the unsaved
edit, and explicit reload restores the current list including the concurrent
addition. The final implementation is version 0.28.0-alpha.20; no installer
release or tag was requested.
