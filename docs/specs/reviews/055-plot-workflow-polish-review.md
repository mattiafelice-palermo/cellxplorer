# Spec 055 — Plot workflow polish — Parent review

## Status

**BLOCKED on corrected-build verification and cumulative manual UI acceptance.**

All three child specifications reached review-clean, but the first cumulative manual pass found two parent-level UX defects after the child reviews:

1. the newly added header `Series visibility` control was not part of the accepted UX and had to be removed;
2. advanced PNG/data-export settings were incorrectly persisted through the analysis plot-style update path, so changing export-only settings could enable a saved plot's `Update` button.

The implementer fixed both defects in `727544bbafddeea802405c4dca05b548041cb71f` (`Fix export settings dirty state and remove series visibility control`). Code inspection accepts both fixes. The parent must nevertheless remain blocked because `727544b` has no fresh recorded focused/full test execution and the corrected integrated build has not yet received the required manual UI acceptance pass.

Do not mark Spec 055 `COMPLETE` until those observations are explicitly recorded.

## Review base and cumulative scope

- Repository: `mattiafelice-palermo/cellxplorer`.
- Branch: `feature/plot-workflow-polish`.
- Correct merge base / branch base: `main` at `3714d3733c38a0a5ea1174b4b91f49df356e64ac`.
- Final child-review checkpoint entering parent review: `43da65553485190d585885be393ae7201d45194b`.
- Parent blocked checkpoint: `6175b42830f928b95a4e16dd1c199fe875db8593`.
- Post-manual defect-fix checkpoint under this review: `727544bbafddeea802405c4dca05b548041cb71f`, exactly one commit after the blocked checkpoint.
- `727544b` changes only frontend plot/header implementation and focused frontend tests. It does not modify backend scientific calculations, migrations, database schema, analysis data, or workflow state.

## Parent manual-review defect D1 — unrequested Series visibility header control

**Status: code fix accepted at `727544b`; final UI absence still requires manual confirmation.**

### Current

The earlier 055.3 implementation exposed a new `Series visibility` menu in `PlotHeader`, with `Show only ...` and `Show all series` entries. During the cumulative manual review the user rejected that header control as unrequested.

### Fix inspected

`727544b` removes the control at the shared source:

- `PlotHeader.tsx` no longer imports Mantine `Menu` or the eye icons used by that control;
- `PlotSeriesVisibilityMenu` is deleted;
- the `seriesVisibility` prop is deleted from `PlotHeader`'s runtime and type surface;
- the rendered header no longer contains the menu;
- Cycles, Time/Capacity, Steps, DCIR, Chargeability, and Rate Capability no longer pass `seriesVisibility` into `PlotHeader`.

The focused source-contract regression in `frontend/tests/simplePlotLayout.test.ts` asserts that `PlotHeader.tsx` contains neither `Series visibility` nor `PlotSeriesVisibilityMenu`, and representative family sources no longer pass `seriesVisibility=`.

### Final-UX override

This parent-level user decision supersedes the earlier child-review assumption that a header `Series visibility` action surface was part of the accepted final UI. The 055.3 child review remains useful historical evidence for the internal stable-series identity, helper ownership, visibility persistence, and passive Plotly behavior that were reviewed at that checkpoint, but the final accepted UX must not expose the rejected header control.

No replacement visibility control is inferred or required by this parent review unless the user specifies one separately.

### Non-blocking implementation note

The family cards still contain some internal visibility candidate/action helpers from the earlier 055.3 implementation even though the shared header no longer consumes them. They are not rendered and do not violate the user's UI requirement. They are minor cleanup/performance debt rather than a current acceptance blocker.

## Parent manual-review defect D2 — advanced export settings must remain transient

**Status: code fix accepted at `727544b`; the grey-`Update` behavior still requires integrated manual confirmation.**

### Previous defect

`PlotHeader` previously received an `updateStyle(...)` callback from each plot family. Advanced export controls wrote fields such as image format/aspect/PPI/size and data-export format/precision/delimiters back into `presentation.plot_styles.<tab>`. Because the saved-view signature includes plot style, changing an export-only preference could legitimately make the saved plot appear edited even though the user had not changed the plotted view.

That behavior contradicts the final parent decision: export configuration is transient output state, not saved-plot view state.

### Fix inspected

`PlotHeader.tsx` now owns a local normalized `exportStyle` state initialized from the incoming style. All advanced image/data-export controls mutate that local state only. The shared header no longer accepts or calls `updateStyle`.

The local export state covers, among other fields:

- image format (`png` / `svg` / `pdf`);
- export aspect ratio;
- PNG width/height;
- PPI;
- include-title setting;
- CSV/XLSX format;
- numeric precision;
- decimal separator;
- column delimiter.

`PlotHeader` passes the current local `exportStyle` explicitly into:

- `onExport(selectedFormat, renderedFilename, exportStyle)`;
- `onDataExport(renderedFilename, exportStyle)`;
- `getExportPreview(exportStyle)`.

The plot families were updated consistently:

- Cycles and Time/Capacity resolve the export plan, preview, PNG/SVG/PDF figure and PDF aspect ratio from the passed transient style;
- Steps, DCIR, Chargeability, and Rate Capability pass the transient style through their shared styled-plot export, preview and data-export paths;
- CSV/XLSX generation receives the transient numeric/formatting settings instead of the saved plot style.

Because none of these controls call the analysis `update(...)` path, changing them cannot by itself change the saved plot spec or `activePlotDirty`. The parent-supplied `updatePlotEnabled` prop therefore remains unchanged/grey unless some separate persistent plot edit is made.

`normalizePlotStyle(...)` returns a new normalized object for the local draft; the export controls mutate only export-related primitive fields on that local object, so this path does not alias the saved plot style back into the spec.

### Focused regression inspected

`frontend/tests/plotExport.test.ts` now records the intended contract:

- derived export operations leave `plotViewSignature(spec)` unchanged;
- `PlotHeader` has no `updateStyle` source path;
- the header passes the local `exportStyle` to both image and data-export callbacks.

This is primarily a source-contract regression rather than a mounted component dirty-state test. Direct code inspection provides the missing architectural check; the required final browser pass remains the end-to-end verification that the visible `Update` button stays grey.

## Previously accepted behavior retained

The `727544b` delta does not change the following previously reviewed behavior:

- export figure construction deep-clones Plotly-owned derived inputs before renderer normalization;
- saved-plot rename retains stable IDs and scientific/presentation state;
- custom saved names feed the normal filename template/sanitizer path;
- rename keyboard events from nested Rename/Delete controls do not trigger parent-row open;
- Cycles CE and Time/Capacity voltage-channel renderer identity/helper ownership fixes remain intact internally;
- shared Plotly single-click and double-click native legend visibility remain disabled;
- the passive Plotly layout remains memoized by incoming layout identity.

## Verification evidence

### Previously recorded full checks

The last recorded implementer handoff before the parent manual pass was `7c6e55b0337a1861b5a8226c335061f2c1e19702`, which reported:

- 055.3 focused tests: **PASS — 74 tests**;
- `npm.cmd exec -- tsc -b`: **PASS**;
- `python scripts\preflight.py --no-cache`: **PASS**;
- canonical aggregate: **160 backend/frontend modules**;
- frontend type check: **PASS**;
- production bundle: **PASS**;
- version consistency: **PASS**.

Those results predate `727544b` and therefore are not execution evidence for the two parent-level fixes.

### Evidence at `727544b`

Reviewer inspection confirmed:

- the exact delta from blocked checkpoint `6175b428` to `727544b`;
- the shared `PlotHeader` local export-state implementation;
- the advanced PNG/CSV/XLSX control handlers all write local state;
- all six changed plot families consume the passed transient export style on their export/preview/data paths;
- the shared Series visibility header UI and its prop are removed;
- focused tests were updated to encode both corrected contracts.

However:

- `727544b` contains no workflow handoff or verification report;
- GitHub has no combined status checks attached to `727544b`;
- GitHub has no workflow runs attached to `727544b`;
- the reviewer did not independently execute repository-local commands.

Fresh execution evidence is therefore still required before parent completion.

### Required fresh checks on the corrected checkpoint

At minimum record results for:

1. focused frontend tests covering the changed contracts, including `frontend/tests/plotExport.test.ts` and `frontend/tests/simplePlotLayout.test.ts`;
2. frontend TypeScript build (`npm.cmd exec -- tsc -b` or the repository-current equivalent);
3. canonical `python scripts\preflight.py --no-cache`.

Use the repository-current commands if `AGENTS.md` or workflow documentation has changed; do not rely on remembered commands.

## Existing manual evidence — superseded by corrected-build rerun requirement

Historical disposable-browser observations remain useful context:

- 055.1 previously exercised Cycles, Time/Capacity, and DCIR export/dirty/discard-reopen behavior;
- 055.2 previously exercised rename persistence/validation and fresh-tab reload;
- the first parent manual pass then exposed D1 and D2 above.

Because those defects changed shared `PlotHeader` and every plot family's export callback boundary, the parent acceptance must now be re-run on the corrected `727544b` build rather than treating older observations as the final integrated pass.

## Required corrected-build cumulative manual acceptance

Run on disposable/non-production analysis data. Do not modify real analyses solely for acceptance testing.

### A. Export settings and saved-plot dirty state

For **Cycles, Time/Capacity, and one auxiliary family such as DCIR**:

1. Open a saved plot and verify `Update` is grey/disabled.
2. Open advanced image-export settings and change several transient options, including format and aspect ratio; for PNG also change size/PPI and include-title where practical.
3. Generate preview and perform the export. Verify `Update` remains grey/disabled throughout.
4. Open advanced CSV/XLSX settings and change format, numeric precision, and applicable decimal/delimiter options. Export data and verify `Update` remains grey/disabled.
5. Make one real persistent plot edit and verify `Update` enables.
6. Change advanced export settings and export again; verify the existing real dirty state remains dirty rather than being cleared or replaced.
7. Save/Update the persistent edit, leave, reopen, and verify the saved view is reproduced with `Update` disabled.
8. Make another unsaved persistent edit, use the UI discard/open flow, reopen the saved plot, and verify the persisted state is unchanged and `Update` is disabled.

### B. Rename and export naming

1. Rename an existing saved plot and verify the custom name appears immediately and survives reload.
2. Verify the saved plot ID/open target remains stable.
3. Verify rename alone does not enable `Update`, and an already-dirty plot remains dirty through rename.
4. Export the opened renamed plot and verify the actual output filename is derived from the custom saved name through the normal sanitizer/template path.
5. Verify duplicate names remain allowed and blank/whitespace names are rejected.
6. With another plot/draft containing unsaved edits, rename an inactive saved plot and verify the active edit state is not disturbed.
7. Keyboard-check the saved-plots list: Enter/Space on the row opens it; Enter/Space on nested Rename/Delete controls activates only that control and does not invoke row open.

### C. Final UI scope — Series visibility control absent

For **Cycles, Time/Capacity, and one auxiliary family**:

1. Verify there is no header button/menu labelled `Series visibility`.
2. Verify the removal did not disturb the surrounding explainer, export, Update, New, or Series appearance controls.
3. Do not require the removed header Show-only/Show-all action in this final gate; that earlier expectation is superseded by the explicit parent manual-review decision that the control was unrequested.

### D. Passive Plotly legend behavior

1. Single-click a Plotly legend item and verify native Plotly visibility does not diverge from the application state.
2. Double-click a Plotly legend item and verify Plotly does not perform native isolate/restore.
3. Trigger an ordinary rerender/update after those clicks and verify no transient snap-back or competing Plotly-only visibility state appears.

## Parent acceptance decision

**Not accepted yet.**

The two defects found in the first parent manual pass are code-review resolved at `727544b`. No new correctness finding was identified in that fix commit. The remaining blockers are verification-only:

1. fresh focused/TypeScript/full no-cache check results for the corrected checkpoint are not recorded;
2. the corrected integrated build has not yet received the cumulative manual UI acceptance matrix above.

The workflow must remain `BLOCKED`. Do not run `resume-final-review` until those external verification dependencies are available. Once they are available, resume `FINAL_REVIEW`, record the exact observations here, and use `spec_workflow.py complete --spec 055` only if every required row passes.
