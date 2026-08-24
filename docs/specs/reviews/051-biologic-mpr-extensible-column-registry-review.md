# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Final cumulative review — changes requested**  
Ready to merge: **No**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Children: [`../051.1-biologic-mpr-cycle-reconstruction.md`](../051.1-biologic-mpr-cycle-reconstruction.md), [`../051.2-time-capacity-consecutive-capacity-axis.md`](../051.2-time-capacity-consecutive-capacity-axis.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Implementation head reviewed: `cbd2ab95f88bc16829e203f8e303a652689ae388`  
051.2 clean-review checkpoint: `22a90f40f09e6f349cd62f2b96b070fa7b11e17d`

## Cumulative review conclusion

The cumulative implementation is technically and scientifically clean across Parent 051, Child 051.1, and Child 051.2. The branch remains based directly on current `main` / merge base `706dc0f14880202a8c5e22b35020502bcf3b4dc9`; the cumulative changed-file set is coherent with the feature and its promoted children, and no unrelated implementation scope was identified.

The final repository state establishes:

- `MPR_READER_REVISION = 2` for registry-resolved ordinary MPR columns with fail-closed unknown/ambiguous layout handling;
- BioLogic GCPL adapter revision `gcpl10` for the bounded explicit/declared/observed-execution logical-cycle contract;
- preserved raw/canonical/per-cycle scientific capacity semantics, including the real EGG ID-211 / ID-7 source-level validation;
- backend-owned acquisition-order Consecutive capacity display coordinates for mAh, mAh/g, and mAh/cm²;
- exact pre-downsample per-Cell origins for bounded Time/Capacity refinement, including unequal and sparse Cell coverage;
- `RESULT_SCHEMA_VERSIONS["time_capacity"] = 7` so stale persisted display-coordinate payloads cannot survive the changed response meaning;
- no migration and no global `CALC_VERSION` change for the display-only 051.2 correction.

The current-head implementer handoff reports canonical preflight PASS, the focused 194-test R2 matrix PASS, frontend policy/build PASS, and real EGG/Neware browser/API acceptance PASS. Reviewer inspection confirms the code/test ownership and versioning contracts; those commands and browser checks were not independently executed in this reviewer environment. GitHub exposes no combined status checks for implementation commit `cbd2ab95f88bc16829e203f8e303a652689ae388`.

One final documentation-index defect remains before the workflow can complete.

## Findings

### R5 — Low — `docs/specs/README.md` still describes the pre-051.2 workflow state

**Affected file:** `docs/specs/README.md`

**Current:** The Spec 051 index entry says that 051.1 is the active child, describes the branch as "Implementation in progress", and lists only `051.1-biologic-mpr-cycle-reconstruction.md`. It does not link or describe `051.2-time-capacity-consecutive-capacity-axis.md`, even though 051.2 has been promoted, implemented, reviewed clean, and is now part of the required cumulative Parent 051 scope.

**Target:** Make the Spec 051 index entry match the current repository/workflow: list both numeric children, describe 051.1 as review-clean cycle reconstruction, describe 051.2 as the review-clean generic Consecutive-capacity display/refinement correction, and state that the cumulative parent review is pending only this final documentation fix. Do not rewrite unrelated spec-index entries.

**Acceptance criteria:**

- The 051 entry links both `051.1-biologic-mpr-cycle-reconstruction.md` and `051.2-time-capacity-consecutive-capacity-axis.md`.
- It no longer calls 051.1 the active child.
- The status text reflects that 051.1 and 051.2 are implemented/review-clean and that Parent 051 is at final cumulative review.
- No unrelated documentation or production files are changed.
- Run the normal workflow verification required for the handoff and report exactly what ran.

## Merge readiness

**Not ready to merge solely because of R5.** No production/scientific defect remains in the cumulative review. After the narrow spec-index correction returns cleanly, the reviewer should resume `FINAL_REVIEW`, confirm the documentation delta, and complete the Spec 051 workflow.
