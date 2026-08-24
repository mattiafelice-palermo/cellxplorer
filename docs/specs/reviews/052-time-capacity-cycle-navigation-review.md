# Spec 052 Implementation Review — Time/Capacity Cycle Navigation

**Branch:** `feature/time-capacity-cycle-navigation`  
**Reviewed implementation commit:** `c19913e9bebd5bfc0e80c016afef41ea2909e440`  
**Previous final review transition commit:** `c03a7eb512842cdfaa81e38df0bf8ca395cb8c68`  
**Merge base:** `df99746ee6d8827e3ff55762e4d28c5b22fa646e`  
**Review round:** 4 — reopened for post-implementation user acceptance refinement  
**Status:** Active child `052.1` awaiting implementation  
**Ready to merge:** No

## Review status

R1 remains resolved. The earlier cumulative review was technically clean, but browser/manual acceptance had not been run. The user subsequently exercised the feature and identified concrete layout/interaction refinements. The workflow is therefore reopened with active child `052.1`, governed by `docs/specs/052.1-cycle-navigation-visual-refinements.md`.

The previous `COMPLETE` state is no longer authoritative. Per direct user instruction, Spec 052 must not be marked `COMPLETE` again until the user explicitly authorizes completion after reviewing the refined UI.

## Findings

### R1 — Medium — Resolved — Null-bound fallback disables safe backward/history navigation

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts`
- `frontend/tests/timeCapacityCycleNavigation.test.ts`

**Resolution:** Commit `c19913e9bebd5bfc0e80c016afef41ea2909e440` narrows the null-bound disable policy. Single-cycle backward navigation remains usable and lower-clamped at cycle 1; Previous View remains available when history exists; upper-bound-dependent actions remain disabled until a reliable maximum is available. Non-empty Specific cycles still disables the continuous navigator.

**Status:** Resolved.

## Post-implementation acceptance scope — child 052.1

Direct user browser feedback requires a focused visual/interaction refinement, not a change to scientific semantics. The active child locks the following targets:

- Previous View + Home move to the left zone.
- The main cycle-navigation group is geometrically centered at normal desktop width.
- Jump to remains on the right.
- Backward/forward segmented button groups match the From/To input height.
- The line-dot-line separator opens an anchored hover/focus slider callout above the trigger, with modest rectangular corner radius and a centered downward triangular pointer.
- Pointer movement from trigger into the callout must keep it open for dragging.
- The current detached/top-left popover behavior must be eliminated.
- Existing slider transient/one-commit semantics, range/history policy, query/cache behavior, and accessibility are preserved.

This scope is implementation work under `052.1`, not a reopened R1 defect.

## Previous cumulative review facts retained

- Branch merge base remained `df99746ee6d8827e3ff55762e4d28c5b22fa646e`; there was no unrelated base drift at the prior review.
- `AnalysisEditor.tsx` derived the upper cycle bound only from already-loaded Cell/replicate summaries and kept visibility/exclusion state out of that bound.
- `TimeCapacityPlotCard.tsx` retained the existing Spec 050 query identity and Spec 051.2 refinement lifecycle; navigation commits mutated only the canonical Time/Capacity cycle range through the existing `update(...)` path.
- The duplicate sidebar `From` / `To` controls were removed while `Specific cycles` and `Max points per cell` remained in the Cycles accordion.
- The navigation strip remained editor chrome outside Plotly/export artifacts.
- Range/history/max-cycle policy stayed frontend-only; no backend route, migration, parser/result schema, `SPEC_VERSION`, `CALC_VERSION`, or scientific cache contract change was introduced.

## Verification

### Implementer-reported before child 052.1

- `node --test frontend\tests\timeCapacityCycleNavigation.test.ts`: **PASS (13/13)**.
- TypeScript (`npx.cmd tsc --noEmit`): **PASS**.
- Production build (`npm.cmd run build`): **PASS**.
- `git diff --check`: **PASS**.
- Canonical preflight (`python scripts\preflight.py`): **PASS (4/4 stages; 155 backend/frontend modules)**.
- Browser/manual acceptance matrix: **NOT RUN**.

### Reviewer-independent before child 052.1

- Static inspection of initial implementation `ff57360b86d595139e3a3988f944a96ee9c07a0d`, R1 fix `c19913e9bebd5bfc0e80c016afef41ea2909e440`, workflow/spec files, and cumulative branch scope against `main`.
- Re-inspected `AnalysisEditor.tsx`, `TimeCapacityPlotCard.tsx`, `TimeCapacityCycleNavigation.tsx`, `timeCapacityCycleNavigationPolicy.ts`, and `frontend/tests/timeCapacityCycleNavigation.test.ts`.
- GitHub reported no combined status checks for the implementation fix commit.
- Repository test commands and browser/manual checks were **not independently executed** in this reviewer environment.

## Merge readiness

**Not ready to merge while child `052.1` is active.** Review the implementer's returned changes against the child spec, then leave the workflow in final review awaiting explicit user completion authorization even if the technical review is clean.
