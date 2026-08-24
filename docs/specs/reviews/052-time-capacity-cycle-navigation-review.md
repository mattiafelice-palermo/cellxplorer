# Spec 052 Implementation Review — Time/Capacity Cycle Navigation

**Branch:** `feature/time-capacity-cycle-navigation`  
**Reviewed branch head:** `5558d33289e1b3816cc1c8a009c2f4a0ccb351a3`  
**Merge base / current main:** `df99746ee6d8827e3ff55762e4d28c5b22fa646e`  
**Review round:** 7 — cumulative final parent review after child 052.2  
**Status:** Cumulative code review clean; blocked on external browser acceptance and explicit user authorization  
**Ready to merge:** No

## Final review scope

This is a fresh cumulative review of Spec 052, 052.1 and 052.2 against the exact merge base `df99746ee6d8827e3ff55762e4d28c5b22fa646e`.

At review time the feature branch is 21 commits ahead and 0 behind `main`. The cumulative branch scope is limited to the Spec 052 specifications/reviews/workflow records plus the expected Time/Capacity frontend owners:

- `frontend/src/features/analyses/editor/AnalysisEditor.tsx`;
- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx`;
- `frontend/src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts`;
- `frontend/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx`;
- `frontend/tests/timeCapacityCycleNavigation.test.ts`.

No backend endpoint, scientific calculation, parser, database migration, cache version, or `CALC_VERSION` change is present in the feature scope.

## Cumulative findings status

- **R1 — Resolved.** Null-bound behavior preserves safe one-cycle backward movement and Previous View while keeping upper-bound-dependent navigation disabled until the selected maximum is reliable.
- **R2 — Resolved.** The desktop navigation center cluster stays on one row; narrow layouts move the whole cluster rather than wrapping its internal controls.
- **R3 — Resolved.** Full-window slider pointer mapping uses the segment's legal travel and reaches both range boundaries with fixed width.
- **R4 — Resolved in code.** The final implementation uses completion-aware low-resolution moving preview backpressure: at most one moving request is in flight, only the newest pending range is retained, completion admits the newest pending request, 50 ms idle promotes the latest transient range to full resolution, renewed movement invalidates full-resolution idle work, and release/cancel return to canonical full-resolution state.
- **R5 — Resolved.** Reopening an edited unsaved Time/Capacity draft does not reactivate virgin last-20 initialization.
- **R6 — Resolved.** Ctrl+first is a no-op without a reliable maximum while ordinary safe backward movement remains available.

No new cumulative implementation defect was found by static review.

## Locked behavior preserved

The cumulative branch retains the repository's existing scientific/data ownership boundaries:

- one canonical continuous scientific range remains `spec.computation.time_capacity.cycle_start/end`;
- Specific cycles retains precedence over continuous navigation;
- selected maximum is derived from already-loaded relational Cell summaries, independent of plot visibility;
- transient slider preview does not mutate saved plots, drafts, autosave state, presets, or the canonical `max_points_per_cell` setting;
- moving previews use a request-only `min(configuredMaxPoints, 1000)` cap;
- full-resolution requests use the user's configured point budget (4000 by default when unchanged);
- query identity includes range and point budget, so moving/full results are distinct cache identities;
- the existing compatible-placeholder behavior keeps the last compatible plot visible while replacement data is pending;
- scientific calculations remain backend-owned;
- no source-file/Parquet read is added merely to render navigation;
- saved-plot, style, export and refinement semantics are not broadened by the navigation feature;
- fresh Time/Capacity views use the one-time last-20 default and existing line-only base style without overwriting restored/edited state;
- the Time/Capacity-only Plotly Grid action writes canonical scoped `style.show_grid` through the existing plot-style path.

## Final verification record

### Implementer-reported latest handoff (`5558d33289e1b3816cc1c8a009c2f4a0ccb351a3`)

- Focused cycle-navigation / preview-state tests: **PASS (23/23)**.
- Simulated 100 ms moving-request latency with faster-than-40 ms pointer updates: **PASS**; one moving request in flight, newest-only pending retention, multiple completions before release, immediate newest admission on completion.
- Time/Capacity query-policy tests: **PASS (6/6)**.
- TypeScript: **PASS**.
- Production frontend build: **PASS** with existing repository warnings.
- Canonical preflight: **PASS (4/4 stages; all 155 backend/frontend test files/modules)**.
- Latest R4 browser/manual acceptance: **NOT RUN**.

Earlier accepted/manual evidence still supports the 052.1 geometry, anchored callout, real segment-bound dragging, Previous View behavior and edited-draft preservation. It does **not** prove the final backpressured R4 implementation, because the live-preview request architecture changed afterwards.

### Reviewer-independent

- Confirmed `main` is `df99746ee6d8827e3ff55762e4d28c5b22fa646e` and remains the exact merge base.
- Confirmed the feature branch is ahead only, with no cumulative backend/migration/cache-version scope.
- Read current workflow state and coordination before review; active child is `052.2`, `REVIEWER + REVIEW`, with no pending workflow `U*` messages.
- Inspected the final R4 diff/end state, including React Query request identity/cancellation, completion-aware scheduler state, navigator preview/commit boundaries, and focused tests.
- Confirmed GitHub exposes no combined status checks for the latest implementation commit.
- Repository test commands and browser checks were **not independently executed** by the reviewer.

## External acceptance gate

The cumulative code review is clean, but the feature is not ready to merge because required external acceptance is still unavailable.

The user previously observed the exact failure this final R4 architecture is intended to remove. Therefore the latest implementation needs a real browser/manual pass that confirms at minimum:

1. while the slider is held and moved continuously, the plot visibly advances before release rather than remaining static;
2. moving previews are responsive enough to be useful and do not create an obvious request backlog/storm;
3. after roughly 50 ms stationary while still held, the current transient range sharpens to the configured full resolution;
4. if movement resumes, stale full-resolution idle work does not replace the newer moving preview;
5. release produces one canonical/history step at full resolution and Previous View returns to the pre-drag range.

The user has also explicitly required that Spec 052 must **not** transition to `COMPLETE` until they authorize it.

## Merge readiness

**BLOCKED — not ready to merge.** There are no remaining implementer findings, but the required user/browser acceptance for the final live-scrubbing implementation has not been supplied, and explicit user authorization to complete is still outstanding. Resume final review only after that acceptance input is available.