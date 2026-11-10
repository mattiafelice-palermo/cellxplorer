# 108 — Source-evidenced CP loop display boundaries

Status: Complete; Astra/browser/private-corpus and clean-Windows preflight passed.
Branch: `codex/cp-loop-boundaries`.
Review document: [108 review](reviews/108-cp-loop-display-boundaries-review.md).

## Evidence and scope

The user questioned spike-like features absent from the reference screenshot,
then challenged classification of gaps from elapsed time alone. No timestamp
threshold is authorized as an acquisition-boundary detector.

All four supplied CP sources contain a `VMP loop` module with five indexes:
0, 7201, 14402, 21603, 28804. Its three interior source-defined boundaries
coincide exactly with the conspicuous long recording intervals. The table's
count/index envelope is independently described in the primary
[eclabfiles format documentation](https://github.com/vetschn/eclabfiles/blob/master/src/eclabfiles/mpr.py).
That corroborates the observed byte interpretation; it does not verify arbitrary
loop-module versions or layouts.

## Contract

Scope this change to CP sources with recorded Ece, matching the CP3 identity.
Decode only the observed bounded CP loop envelope after structural validation.
Require an unambiguous single module, the verified version, bounded count,
strictly increasing in-range indexes, first zero, terminal record count and
zero trailing padding. An absent or unverified table provides no display breaks;
do not infer them from time spacing, potential jumps, current polarity or raw
half-cycle changes alone.

Use the verified source loop ranges as display segments. Preserve every row,
voltage, current, capacity, cycle identity, source order and timestamp. Preserve
the time interval across a boundary; break the drawn line rather than compress
time. This is a source-loop boundary, not a claim about why acquisition paused.
Keep both sides of a boundary during display decimation and refinement. Retain
breaks through full/compact/indexed/legacy paths, interactive/PNG/portable plots
and selected ranges. Raw numeric exports keep every recorded value.

Reuse `mpr_acquisition_segment` and the existing explicit discontinuity path;
do not mark verified CP rows exploratory or add `mpr_elapsed_time_s` merely to
obtain line breaks. Keep scientific phase/capacity transformations unchanged.

Bump only the affected CP effective identity from `:cp2` to `:cp3`, preserving
the family/global calculation identities and all unrelated caches. Historical
`:cp2` primary voltage is already cell voltage and must keep that role when
pinned; the earlier no-CP-suffix artifacts remain working-only.

## Verification

Add independent byte fixtures with valid/missing/ambiguous/malformed tables;
normal and very long intervals inside one loop must remain connected. Verify
source-declared boundaries even at ordinary sampling cadence. Check exact data
and time parity with CP2 and all four originals, all three channels, full/compact
and selected-range breaks, warmed navigation, historical roles, exports and
unrelated-cache preservation. Preserve the Spec 107 private expectations; capture
a separate reviewed CP3 corpus only after an independent oracle comparison.
Run both earlier private corpora, focused tests, canonical preflight, production
browser acceptance and independent Astra Medium review. Commit/push, clean-Windows
branch gate, merge and exact-main CI follow the sequential workflow. No release,
installation or real-profile mutation is included.

## Verification outcome

The independent byte oracle verifies all 115,216 original records, 12 interior
loop boundaries and three source joins. Every previous raw column and every
cycle result matches retained CP2 Parquet exactly; source checksums are unchanged.
The prior 6/13-source corpora pass unchanged, and the separate four-source CP3
baseline passes without updating the retained CP2 baseline. Focused verification
passes 51 backend tests, 17 renderer tests and 21 CP/permissive tests after the
review correction. The production UI and its actual native PNG download were
visually verified. Recorded post-boundary transients remain visible.

The complete local four-worker preflight passes 240/241 modules/files plus
version, type and production-bundle stages. Its only failure is the established
host-native port-owner reporting limitation; no tests or protections were skipped.
The clean-Windows [branch preflight](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42903002873)
passed all 240 committed backend/frontend modules/files and all canonical stages
on implementation revision `d8c6a763`, including the native launcher test.
