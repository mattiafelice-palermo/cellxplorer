# Spec 052 Implementation Review — Time/Capacity Cycle Navigation

**Branch:** `feature/time-capacity-cycle-navigation`  
**Reviewed implementation commit:** `c159c16c98f158824dc36d267e5bbd3ccfb50327`  
**Previous reviewer transition commit:** `7364556715de85ffedfa877dd3d8ecc99d966949`  
**Merge base:** `df99746ee6d8827e3ff55762e4d28c5b22fa646e`  
**Review round:** 6 — child 052.1 R2 fix review  
**Status:** Child 052.1 review clean; follow-up child 052.2 scheduled  
**Ready to merge:** No

## Review status

R1 remains resolved. R2 is resolved by implementer commit `c159c16c98f158824dc36d267e5bbd3ccfb50327`.

The R2 fix replaces the equal one-third desktop grid with a center `max-content` column and makes the central navigation group `wrap="nowrap"`. When the measured navigation strip is narrower than the desktop-fit threshold, the side zones move to a top row and the **whole** center cluster occupies a separate centered row instead of splitting its own controls. This matches the 052.1 acceptance target and the user's explicit requirement that the main navigation controls stay on one horizontal line.

The implementer also reports that the previously untested pointer-drag path was exercised successfully: the pointer moved from trigger into the callout, the slider drag changed the cycle window, and one Previous View step restored the pre-drag range.

No new implementation defect was found in the R2 patch by static review.

The workflow is nevertheless **not merge-ready** because the user has explicitly authorized another refinement round. New child `052.2-time-capacity-navigation-polish.md` captures that follow-up scope. Spec 052 must still not be marked `COMPLETE` without explicit user authorization.

## Findings

### R1 — Medium — Resolved — Null-bound fallback disables safe backward/history navigation

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts`
- `frontend/tests/timeCapacityCycleNavigation.test.ts`

**Resolution:** Commit `c19913e9bebd5bfc0e80c016afef41ea2909e440` narrowed the null-bound disable policy. Single-cycle backward navigation remains usable and lower-clamped at cycle 1; Previous View remains available when history exists; upper-bound-dependent actions remain disabled until a reliable maximum is available. Non-empty Specific cycles still disables the continuous navigator.

**Status:** Resolved.

### R2 — Medium — Resolved — Normal desktop navigation cluster wraps onto two lines

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `docs/specs/052.1-cycle-navigation-visual-refinements.md`

**Previous Current:** The first 052.1 implementation used three equal grid columns and a wrapping center `Group`, allowing the forward `› | »` group to drop below the rest of the center navigator at the user's normal desktop geometry.

**Target:** Keep the center cluster as one continuous horizontal row at normal desktop width; if a narrower supported width requires another row, move the center cluster as a whole rather than wrapping its internal controls.

**Resolution:** Commit `c159c16c98f158824dc36d267e5bbd3ccfb50327`:

- measures the navigation strip with `useElementSize()`;
- uses `minmax(0, 1fr) minmax(0, max-content) minmax(0, 1fr)` for desktop-fit geometry;
- sets the center `Group` to `wrap="nowrap"`;
- switches below the fit threshold to a two-row zone layout where left/right occupy the first row and the whole center cluster occupies the second row;
- retains horizontal overflow only as a narrow-layout fallback rather than internally wrapping the center controls.

**Acceptance criteria status:**

- Center-cluster controls stay on one horizontal line: **satisfied by code inspection; implementer browser rerun reported PASS**.
- Forward arrow group remains directly after To: **satisfied by no-wrap group structure**.
- Previous/Home remain left and Jump remains right: **preserved**.
- Plot Style open geometry: **implementer reported PASS**.
- Narrow fallback moves cluster as a unit: **satisfied by grid-area structure**.
- Focused tests/TypeScript/build/preflight rerun: **implementer reported PASS**.
- Pointer-drag slider path: **implementer reported RUN/PASS**.

**Status:** Resolved.

## Child 052.1 end-state inspection

Static review of the live branch confirms the accepted 052.1 structure remains intact:

- Previous View and Home are in the left zone.
- Jump to remains in the right zone.
- The main navigation cluster is nowrap and centered.
- Segmented arrow buttons use the same `xs` height contract as the adjacent numeric inputs.
- The slider trigger remains a stable ref-capable `UnstyledButton` target.
- The callout remains a Mantine Popover above the trigger with a centered arrow, modest radius and delayed hover handoff.
- Existing range/history/query/cache/scientific semantics were not broadened by the R2 patch.

## Follow-up child 052.2

The user explicitly requested a new refinement round after 052.1. The newly authored `docs/specs/052.2-time-capacity-navigation-polish.md` locks the following follow-up scope:

- range-shaped/full-window slider segment;
- live transient From/To **and plot** feedback while dragging, with one canonical commit on release and no query-per-pointer-event flood;
- ArrowLeft/ArrowRight movement while the slider has focus;
- Previous View recent-history dropdown;
- Ctrl+click on either left arrow -> first window and on either right arrow -> last window, with tooltip disclosure;
- fresh Time/Capacity default -> last 20 available cycles;
- fresh Time/Capacity default -> line-only rendering;
- Time/Capacity Plotly modebar Grid on/off action backed by canonical scoped `show_grid` state.

These items are **not** regressions in the reviewed 052.1 R2 patch. They are user-authorized new implementation scope for child 052.2.

## Verification

### Implementer-reported for `c159c16c98f158824dc36d267e5bbd3ccfb50327`

- `node --test frontend\tests\timeCapacityCycleNavigation.test.ts`: **PASS (13/13)**.
- TypeScript (`npx.cmd tsc --noEmit`): **PASS**.
- Production build (`npm.cmd run build`): **PASS**.
- Canonical preflight (`python scripts\preflight.py`): **PASS (4/4 stages; 155 backend/frontend test files/modules)**.
- Browser failing-width geometry: **PASS**.
- Browser Plot Style open geometry: **PASS**.
- Pointer-drag slider gesture: **RUN/PASS**; one Previous View step restored the pre-drag range.

### Reviewer-independent

- Confirmed current `main` remains `df99746ee6d8827e3ff55762e4d28c5b22fa646e` and is still the exact merge base.
- Inspected live workflow state and implementer handoff before reviewer action; no pending workflow `U*` messages were present.
- Inspected the actual R2 implementation diff and live `TimeCapacityCycleNavigation.tsx` end state.
- Inspected the 052.1 manual acceptance record updated by the implementer.
- Confirmed GitHub reports no combined status checks for `c159c16c98f158824dc36d267e5bbd3ccfb50327`.
- Repository test commands and browser checks were **not independently executed** by the reviewer.

## Merge readiness

**Not ready to merge because child 052.2 is now scheduled.** R1 and R2 are resolved, but the user has explicitly requested the additional 052.2 refinement round and has also explicitly prohibited a `COMPLETE` transition until they approve it.
