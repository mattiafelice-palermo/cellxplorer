# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Reopened — 051.2 implementation pending**  
Ready to merge: **No**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Children: [`../051.1-biologic-mpr-cycle-reconstruction.md`](../051.1-biologic-mpr-cycle-reconstruction.md), [`../051.2-time-capacity-consecutive-capacity-axis.md`](../051.2-time-capacity-consecutive-capacity-axis.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`

## Current cumulative status

Parent 051 and Child 051.1 are review-clean at the BioLogic parser/cycle/capacity level. The real EGG source was traced successfully from raw ID-211 / ID-7 quantities through canonical phase capacities and `calc.per_cycle(...)`, and the 1,629-cycle repeating source is supported by the observed Rest/Charge/Discharge execution pattern.

The later real-browser acceptance exposed a separate generic Time/Capacity defect: `display_mode=consecutive` with a capacity X-axis restarts the backend `display_x` coordinate at phase/cycle boundaries. Browser/API verification reproduced the same defect on Neware, proving that it is not BioLogic-specific and predates Spec 051.

The user now explicitly requires that visible defect to be fixed before this workflow completes. It has therefore been promoted into Child **051.2 — Time/Capacity consecutive capacity-axis concatenation** on the same branch/workflow rather than leaving the branch merge-ready with a known broken interaction.

051.2 is format-neutral and owns only the display-coordinate correction. It must not redefine canonical capacities, `calc.per_cycle(...)`, BioLogic cycle reconstruction, or parser behavior. The current required design is backend-owned acquisition-order capacity concatenation, with rest rows holding the current coordinate, stable overview/refinement coordinates, a Time/Capacity result-schema cache-generation bump, focused Neware + BioLogic regressions, canonical preflight, and real browser acceptance.

## User-authorized acceptance setup for 051.2

The user explicitly authorizes the implementer to recreate the two acceptance cases from scratch after the user deletes the test Cells from the local database. The implementer may re-import/re-register the specific EGG and Neware test Cells through normal CellXplorer workflows, allow caches to rebuild normally, and create/delete temporary analyses for browser verification.

This authorization is limited to those test Cells/analyses and their normal cache lifecycle. It does not authorize modification, clearing, migration, reseeding, or manual SQLite editing of unrelated user data. Private database/source/cache bytes must not be committed.

## Historical verification through 051.1

Implementer-reported verification before promotion of 051.2 includes:

- focused BioLogic regressions: PASS;
- canonical preflight: PASS;
- real EGG source/canonical/per-cycle trace: PASS;
- browser diagnosis: RUN with user approval;
- Cell 135 Capacity + Consecutive: malformed backend `display_x` reproduced;
- Neware control Capacity + Consecutive: same generic reset behavior reproduced;
- Time + Consecutive: monotonic/unchanged in the diagnosis.

Reviewer inspection confirmed the generic owner is `backend/app/services/analysis_engine.py::_time_capacity_display_x(...)`, whose Consecutive path performs a single-origin subtraction rather than concatenating capacity resets. The same logic exists at the branch merge base.

## Merge readiness

**Ready to merge: No.**

The authoritative workflow is now `051.2 -> IMPLEMENTER / IMPLEMENT`. A fresh 051.2 review and a fresh cumulative Parent 051 review are required before merge readiness can be restored.
