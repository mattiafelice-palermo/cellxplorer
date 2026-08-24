# Spec 052 Implementation Review — Time/Capacity Cycle Navigation

**Branch:** `feature/time-capacity-cycle-navigation`  
**Reviewed implementation commit:** `ff57360b86d595139e3a3988f944a96ee9c07a0d`  
**Merge base:** `df99746ee6d8827e3ff55762e4d28c5b22fa646e`  
**Review round:** 1  
**Status:** Changes required  
**Ready to merge:** No

## Review status

The implementation is broadly aligned with Spec 052: it keeps `cycle_start`/`cycle_end` authoritative, derives the selected maximum from already-loaded relational summaries, removes the duplicate sidebar range fields, mounts editor-only navigation after `PlotHeader`, keeps slider drag transient until `onChangeEnd`, and leaves the current Time/Capacity request/cache/refinement path intact. One concrete fallback-state deviation remains and prevents a clean review.

## Findings

### R1 — Medium — Open — Null-bound fallback disables safe backward/history navigation

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts`
- `frontend/tests/timeCapacityCycleNavigation.test.ts`

**Current:** Spec 052 explicitly says that when `maxAvailableCycle === null`, the navigator should disable only actions whose semantics require the upper bound: window paging, forward movement, Home, slider, and bounded resize. The implementation instead defines `movementDisabled = specificCyclesActive || !hasBound` and applies it to both backward controls and to Previous View. `move(...)` also returns whenever `!hasBound`, while `shiftTimeCapacityCycleRange(...)` returns the unchanged range when the maximum is null. As a result, a temporary missing/unreliable cycle summary freezes the single-cycle backward action and disables a previously populated history stack, even though neither operation requires an upper bound.

**Target:** When the upper bound is unavailable and Specific cycles is not active, keep the single-cycle backward action usable with lower-bound clamping at cycle 1, and keep Previous View usable whenever history exists. Continue disabling whole-window paging, all forward movement, Home, slider, bounded window resizing/window-size selection, and Jump-to behavior that depends on bounded centering. Specific cycles must continue to disable the continuous-range navigator as a whole.

**Acceptance criteria:**

- With `maxAvailableCycle === null`, `[10, 20]` + single-cycle Back commits `[9, 19]`.
- With `maxAvailableCycle === null`, a range already beginning at cycle 1 does not move below 1 and does not create a redundant history entry.
- Whole-window paging, forward controls, Home, slider, bounded resize/window selector, and bounded Jump remain disabled with the truthful cycle-extent tooltip while the maximum is unavailable.
- Previous View remains enabled when history exists and restores the prior committed continuous range without requiring an upper-bound lookup.
- A non-empty `Specific cycles` list still disables backward movement and Previous View along with the rest of continuous navigation.
- Focused pure tests cover null-bound backward behavior and the null-bound Previous View policy/helper boundary as appropriate.

## Verification

### Implementer-reported

- `node --test frontend\tests\timeCapacityCycleNavigation.test.ts`: **PASS (12/12)**.
- TypeScript (`npx.cmd tsc --noEmit`): **PASS**.
- Production build (`npm.cmd run build`): **PASS**.
- `git diff --check`: **PASS**.
- Canonical preflight (`python scripts\preflight.py`): **PASS (4/4 stages; 155 backend/frontend modules)**.
- Browser/manual acceptance matrix: **NOT RUN**.

### Reviewer-independent

- Inspected implementation commit `ff57360b86d595139e3a3988f944a96ee9c07a0d` and cumulative branch scope against current `main`.
- Confirmed merge base is `df99746ee6d8827e3ff55762e4d28c5b22fa646e`; the branch contains the reviewer initialization plus the single implementation checkpoint.
- Inspected `AnalysisEditor.tsx`, `TimeCapacityPlotCard.tsx`, the new navigation component/policy, and the focused tests against the written Spec 052 behavior.
- Confirmed the existing Time/Capacity query identity still includes `cycles`, `cycle_start`, and `cycle_end`, and the navigation commits through the existing canonical `update(...)` path.
- Confirmed no backend, migration, parser/result-schema, `CALC_VERSION`, or scientific-cache change is present in the implementation scope.
- GitHub reports no combined status checks for the implementation commit.
- Repository test commands and browser/manual checks were **not independently executed** in this reviewer environment.

## Merge readiness

**Not ready to merge.** Resolve R1 and hand the branch back for review.
