# Spec 055 — Plot workflow polish — Parent review

## Status

**BLOCKED on cumulative manual UI acceptance.**

All three child specifications are code-review clean and the cumulative branch review found no remaining product-code defect. The parent cannot be marked `COMPLETE` because the explicitly deferred end-to-end manual acceptance has not been performed against the fully integrated three-child feature in the intended UI.

This is an external verification dependency, not an implementation finding. Resume `FINAL_REVIEW` only when the manual UI pass can be performed on disposable/non-production analysis data so existing user data is preserved.

## Review base and cumulative scope

- Repository: `mattiafelice-palermo/cellxplorer`.
- Branch: `feature/plot-workflow-polish`.
- Correct merge base / branch base: `main` at `3714d3733c38a0a5ea1174b4b91f49df356e64ac`.
- Final child-review checkpoint entering parent review: `43da65553485190d585885be393ae7201d45194b`.
- The feature branch is 34 commits ahead of that merge base and 0 behind.
- The cumulative delta is limited to Spec 055 workflow/spec/review files, one related state/performance documentation clarification, frontend plot/editor implementation files, and focused frontend tests. No backend scientific calculation, migration, or persistent database-schema change is present in the cumulative scope.

All child reviews are clean:

- 055.1 — export without dirtying plot state: review clean;
- 055.2 — saved-plot rename: review clean;
- 055.3 — application-owned show-only/show-all visibility: review clean.

## Automated and code-review evidence

The latest implementer handoff at `7c6e55b0337a1861b5a8226c335061f2c1e19702` records:

- 055.3 focused tests: **PASS — 74 tests**, including direct `cycleTracesForResult(...)` aggregate/cell coverage;
- `npm.cmd exec -- tsc -b`: **PASS**;
- `python scripts\preflight.py --no-cache`: **PASS**;
- canonical aggregate: **160 backend/frontend modules**;
- frontend type check: **PASS**;
- production bundle: **PASS**;
- version consistency: **PASS**.

The reviewer did not independently execute those local commands. No GitHub combined status checks are attached to the parent checkpoint.

Cumulative code inspection accepts the implemented semantics already documented in the child reviews, including:

- export-only Plotly mutations cannot alter the persisted saved-view signature;
- rename changes saved-plot metadata while retaining stable IDs and scientific/presentation state;
- custom saved names feed the existing export filename sanitizer;
- `presentation.hidden_series_ids` is persistent saved-view state and therefore participates in dirty/save/reopen semantics;
- Show-only/Show-all operate on the currently applicable family-owned stable series keys;
- higher-level exclusions/protocol/diagnostic/data filters are not part of the user-level restore set;
- Cycles CE and Time/Capacity voltage channels are independent first-class targets while helper traces remain owner-bound;
- shared Plotly legend item-click and double-click native visibility are disabled;
- the passive Plotly layout is memoized by incoming layout identity;
- keyboard event handling for saved-plot Rename/Delete no longer triggers the parent row open shortcut.

## Existing manual evidence — useful but not sufficient for the parent gate

### 055.1 historical browser observations

Before 055.2 and 055.3 were integrated, the implementer recorded disposable Alpha-style browser checks for Cycles, Time/Capacity, and DCIR:

- clean saved plots remained clean after PNG/export preview;
- SVG/PDF paths were exercised where available;
- an intentional persistent edit stayed dirty across export;
- discard/reopen restored the saved view and left `Update` disabled.

### 055.2 historical browser observations

Before 055.3 was integrated, the implementer recorded browser checks covering:

- rename modal focus and validation;
- blank rejection and duplicate names;
- active and inactive rename;
- rename alone leaving `Update` disabled;
- backend persistence and fresh-tab reload.

The post-review keyboard fix was verified by focused policy tests, not by a recorded end-to-end keyboard browser pass.

### Why these observations do not close the parent gate

The parent review explicitly requires one consolidated manual UI confirmation **after the complete Spec 055 feature is assembled**. The historical observations predate the fully integrated 055.3 feature and do not manually verify all required cross-feature interactions. In particular, there is no recorded final integrated UI observation for:

- Show only / Show all across Cycles, Time/Capacity, and an auxiliary family;
- saved isolated-view Update/save/leave/reopen behavior;
- applicable-filter preservation after Show all;
- native Plotly single-click and double-click remaining passive in the finished UI;
- keyboard operation of the Show-only/Show-all action surface;
- post-fix keyboard activation of Rename/Delete versus row-level open behavior;
- custom saved-plot name appearing in an actual exported filename in the finished UI.

Automated tests and direct code inspection support those behaviors, but they are not substitutes for the explicitly required manual parent acceptance.

## Required cumulative manual acceptance matrix

Run this on a disposable analysis/test copy. Do not alter real user analyses solely for acceptance testing.

### A. Saved-plot dirty / export / save / reopen / discard

For **Cycles, Time/Capacity, and one auxiliary family such as DCIR**:

1. Open a saved plot and verify `Update` is disabled.
2. Run export preview and PNG; use SVG/PDF where available; verify export alone does not enable `Update`.
3. Make one real persistent plot edit and verify `Update` enables.
4. Export again and verify the existing dirty state remains dirty.
5. Save/Update the edited plot, leave it, reopen it, and verify the saved state is reproduced with `Update` disabled.
6. Make another unsaved edit, use the UI discard/open flow, reopen the same saved plot, and verify the persisted state is unchanged and `Update` is disabled.

### B. Rename and export naming

1. Rename an existing saved plot and verify the custom name appears immediately and survives reload.
2. Verify the saved plot ID/open target remains stable.
3. Verify rename alone does not enable `Update`, and an already-dirty plot remains dirty through rename.
4. Export the opened renamed plot and verify the actual output filename is derived from the custom saved name through the normal sanitizer.
5. Verify duplicate names remain allowed and blank/whitespace names are rejected.
6. With another plot/draft containing unsaved edits, rename an inactive saved plot and verify the active edit state is not disturbed.
7. Keyboard-check the saved-plots list: Enter/Space on the row opens it; Enter/Space on nested Rename/Delete controls activates only that control and does not invoke row open.

### C. Show only / Show all and persistence

Repeat on **Cycles, Time/Capacity, and one auxiliary family such as DCIR**:

1. Start from a multi-series saved plot with `Update` disabled.
2. Invoke `Show only this series` on a chosen first-class series.
3. Verify only that applicable first-class series remains and its legitimate helper traces behave correctly.
4. Verify `Update` enables.
5. Save/Update the isolated view, leave, reopen, and verify the isolation persists with `Update` disabled.
6. Invoke `Show all series` and verify the applicable set returns.
7. Verify a scientifically excluded, protocol-filtered, diagnostic-filtered, unsupported, or otherwise inapplicable series is **not** resurrected.
8. For Cycles, include CE/primary behavior; for Time/Capacity, include independently targetable voltage channels.

### D. Keyboard accessibility and passive Plotly legend

1. Reach the Show-only/Show-all controls by keyboard and activate them with the normal keyboard interaction; verify the same persistent visibility behavior as mouse activation.
2. Single-click a Plotly legend item and verify native Plotly visibility does not diverge from application state.
3. Double-click a Plotly legend item and verify Plotly does not perform native isolate/restore.
4. Trigger a rerender/update after those legend clicks and verify there is no transient snap-back state because Plotly never became a competing visibility source of truth.

## Parent acceptance decision

**Not accepted yet.**

The cumulative implementation and automated verification are clean, but the required final integrated manual UI pass is not recorded and cannot be truthfully inferred from code/tests. Therefore Spec 055 must not transition to `COMPLETE`.

Workflow action: block the parent on the external manual-acceptance dependency. When a disposable UI environment is available and the matrix above is explicitly observed, resume `FINAL_REVIEW`, record the observations here, then use `spec_workflow.py complete --spec 055` only if every required row passes.
