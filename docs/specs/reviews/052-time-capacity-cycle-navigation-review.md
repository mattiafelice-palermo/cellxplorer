# Spec 052 Implementation Review — Time/Capacity Cycle Navigation

**Branch:** `feature/time-capacity-cycle-navigation`  
**Reviewed implementation commit:** `e327c3f90af84130736a7865a8b89f0949445f60`  
**Previous final review transition commit:** `c03a7eb512842cdfaa81e38df0bf8ca395cb8c68`  
**Merge base:** `df99746ee6d8827e3ff55762e4d28c5b22fa646e`  
**Review round:** 5 — child 052.1 implementation review  
**Status:** Changes required — R2  
**Ready to merge:** No

## Review status

R1 remains resolved. Child `052.1` was implemented in `e327c3f90af84130736a7865a8b89f0949445f60`. Static inspection confirms the intended left/center/right restructuring, equal-height arrow controls, direct ref-capable separator trigger, above-trigger arrowed Popover, and delayed hover handoff are present.

One concrete acceptance defect remains: the centered navigation cluster is allowed to wrap internally. The user's post-handoff browser screenshot shows the forward `› | »` group dropping to a second line at normal desktop width. This directly contradicts the desired single-line toolbar geometry and the implementer's reported normal-desktop acceptance result.

Per direct user instruction, Spec 052 must not be marked `COMPLETE` until the user explicitly authorizes completion.

## Findings

### R1 — Medium — Resolved — Null-bound fallback disables safe backward/history navigation

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts`
- `frontend/tests/timeCapacityCycleNavigation.test.ts`

**Resolution:** Commit `c19913e9bebd5bfc0e80c016afef41ea2909e440` narrows the null-bound disable policy. Single-cycle backward navigation remains usable and lower-clamped at cycle 1; Previous View remains available when history exists; upper-bound-dependent actions remain disabled until a reliable maximum is available. Non-empty Specific cycles still disables the continuous navigator.

**Status:** Resolved.

### R2 — Medium — Open — Normal desktop navigation cluster wraps onto two lines

**Affected files:**

- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`
- `docs/specs/052.1-cycle-navigation-visual-refinements.md`

**Current:** The 052.1 implementation uses three equal grid columns (`repeat(3, minmax(0, 1fr))`) and the center `Group` allows wrapping. That constrains the main navigation cluster to roughly one third of the toolbar width and permits its last controls to wrap. In the user's normal-desktop acceptance screenshot, the forward `› | »` group appears below the rest of the center cluster. The implementer had recorded the normal desktop geometry as RUN/passing, but the user's subsequent browser evidence demonstrates that this acceptance point is not met.

**Target:** At normal desktop width, the entire center cluster must remain one continuous horizontal row:

```text
Cycle navigation [window] [«|‹] [from] [—o—] [to] [›|»]
```

Keep Previous View + Home in the left zone, keep Jump to on the right, and keep the center cluster geometrically centered. Do not solve centering by giving the center only one third of the width if that forces an internal wrap. At narrower supported widths, if a breakpoint is genuinely needed, move/wrap the center cluster as a whole rather than splitting its own controls across rows.

**Acceptance criteria:**

- At the user's normal desktop analysis geometry, all center-cluster controls stay on one line.
- The forward `› | »` group remains directly after the `To` input on that same line.
- Previous View + Home remain left; Jump to remains right; the main cluster remains visually centered.
- Plot-style-panel-open geometry does not make the center cluster wrap internally, overlap, or clip.
- If a narrower-layout fallback is retained, the central navigation controls remain an indivisible one-line cluster; any row transition happens at the zone/cluster level.
- Re-run the focused navigation tests, TypeScript, production build, and canonical preflight.
- Re-run the manual desktop geometry check at the width that exposed the defect. Also run the pointer-drag slider gesture that remained NOT RUN in the handoff, and report it truthfully.

## Child 052.1 implementation inspection

The remaining 052.1 changes are consistent with the child scope by static inspection:

- Previous View and Home moved to the left zone.
- Jump to remains in the right zone.
- Segmented arrow buttons changed from `compact-xs` to `xs`, matching the adjacent numeric-input height contract.
- The separator trigger is now a ref-capable `UnstyledButton` target rather than a Tooltip/Fragment-style wrapper.
- The Popover is positioned above the trigger, uses an arrow, modest radius, and portal anchoring.
- Hover/focus state uses a short delayed close so pointer travel from trigger to dropdown can keep the callout open.
- Existing range/history/query/cache/scientific code was not broadened in this commit.

## Verification

### Implementer-reported for `e327c3f90af84130736a7865a8b89f0949445f60`

- `node --test frontend\tests\timeCapacityCycleNavigation.test.ts`: **PASS (13/13)**.
- TypeScript (`npx.cmd tsc --noEmit`): **PASS**.
- Production build (`npm.cmd run build`): **PASS**.
- Canonical preflight (`python scripts\preflight.py`): **PASS (4/4 stages; 155 backend/frontend test files/modules)**.
- Browser/manual acceptance: **RUN**, except pointer-drag gesture **NOT RUN**.

### Reviewer-independent

- Confirmed current `main` remains `df99746ee6d8827e3ff55762e4d28c5b22fa646e` and is the exact merge base; the branch is ahead with no unrelated base drift.
- Inspected implementation commit `e327c3f90af84130736a7865a8b89f0949445f60`, live workflow state, child spec, and cumulative branch scope.
- Inspected the actual layout diff showing equal one-third grid columns plus a wrapping center group.
- Treated the user's browser screenshot as direct manual acceptance evidence that the normal-desktop one-line layout currently fails.
- GitHub reports no combined status checks for `e327c3f90af84130736a7865a8b89f0949445f60`.
- Repository commands and browser checks were **not independently executed** by the reviewer.

## Merge readiness

**Not ready to merge. R2 is open.** After R2 is fixed, the workflow must still remain open for user acceptance; do not transition Spec 052 to `COMPLETE` without explicit user authorization.
