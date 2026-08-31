# Spec 055 Agent Coordination

This file is the append-only handoff log between implementer and reviewer.

- Workflow state is authoritative in `055-agent-state.json`.
- Detailed technical findings are authoritative in `reviews/`.
- Entries are appended by `spec_workflow.py`; do not rewrite old entries.

## Handoff log

### 2026-08-31T08:53:15+02:00 — REVIEWER → IMPLEMENTER — 055.1

**Result:** Workflow initialized

**Message**

Begin Spec 055 on `feature/plot-workflow-polish`, based on `main` at `3714d3733c38a0a5ea1174b4b91f49df356e64ac`. Implement only child 055.1 first. Re-verify the export/dirty-state root cause against the live code before patching; preserve the parent boundary between persistent saved-plot state and transient/export-only state. Follow `AGENTS.md`, the analysis state/performance guidance, and the visual style guide for any UI changes. Do not pre-implement 055.2 or 055.3.

---
### 2026-08-31T09:29:52+02:00 — IMPLEMENTER → REVIEWER — 055.1

**Result:** Implementation ready

**Verification**

- 055.1 focused regression: node --test frontend/tests/plotExport.test.ts (3 passed); frontend suite: 158 modules passed in canonical preflight; frontend type check and production bundle passed; isolated tests.test_import_flow passed, then python scripts\\preflight.py --no-cache passed. Disposable Plotly reproduction observed nested xaxis.type/yaxis.type mutation from the shallow export graph.

**Message**

055.1 implementation is ready for review. Root cause reproduced: exportFigure shallow-copied only the top-level layout and passed live trace objects to Plotly, so Plotly image normalization could write inferred nested fields into the editor-owned figure graph. The fix deep-clones traces and layout at the export boundary, preserves the existing title/size/margin behavior, and adds a regression that simulates the observed normalization and verifies live traces/layout/style remain unchanged. No post-export dirty reset was added.

---
### 2026-08-31T10:12:00+02:00 — REVIEWER → IMPLEMENTER — 055.1

**Result:** Changes required

**Findings**

- R1
- R2

**Message**

Code inspection accepts the deep-clone export boundary provisionally and found no post-export dirty-reset workaround. R1 remains because the committed reproduction/test does not connect Plotly's derived-layout mutation to the persisted `plotViewSignature(spec)` that actually drives `activePlotDirty`; reproduce and record the pre/post saved-view signatures plus the exact persistent field/reference that changes, and correct the diagnosis if the former shallow export path cannot produce that change. R2 preserves the explicit manual acceptance matrix for Cycles, Time/Capacity, and one additional shared-export family, including unchanged and already-dirty saved plots, export preview, and PNG/SVG/PDF where available; no manual run is reported. Do not begin 055.2 or 055.3 while R1 or R2 remains open. See `docs/specs/reviews/055.1-export-without-dirtying-plot-state-review.md` for the exact acceptance criteria.

---
### 2026-08-31T10:44:01+02:00 — IMPLEMENTER → REVIEWER — 055.1

**Result:** Review fixes ready

**Verification**

- plotExport focused regression passed; python scripts\preflight.py --no-cache passed: 158 backend/frontend modules, frontend type check, production bundle; disposable installed-style Vite run manually verified Cycles, Time/Capacity, and DCIR: unchanged PNG/preview kept Update disabled, SVG/PDF downloads preserved state, and an intentional persisted export-format edit plus a real DCIR edit stayed dirty after export

**Message**

055.1 review fixes are ready. R1 corrected: on the pre-fix shallow path, Plotly normalization changed only derived layout/trace objects and could not change the persisted plotViewSignature; the new regression captures equal pre/post saved-view signatures and guards the repaired clone boundary. The exact legitimate dirty path observed in the UI is PlotHeader updateStyle -> presentation.plot_styles.<tab>.export_format when the user changes the export preference; file generation itself does not mutate that signature. R2 manual matrix completed in the disposable Alpha-style app: Cycles, Time/Capacity, and DCIR each opened saved plots with Update disabled; PNG and export preview kept it disabled; SVG/PDF were exercised where available and remained side-effect-free after the intentional format edit; an explicit DCIR plot edit enabled Update and PNG/PDF left it enabled. No dirty reset workaround added.

---
### 2026-08-31T10:47:04+02:00 — REVIEWER → IMPLEMENTER — 055.1

**Result:** Changes required

**Findings**

- R2

**Message**

R1 is resolved. The corrected signature regression explicitly proves that the pre-fix shallow Plotly mutation affected only derived layout/trace objects and did not change `plotViewSignature(spec)`; it also proves the repaired export boundary leaves the saved-view signature unchanged and separately identifies the intentional persisted `presentation.plot_styles.<tab>.export_format` dirty path. The recorded manual matrix also covers Cycles, Time/Capacity, and DCIR for clean saved plots, preview, PNG, SVG/PDF where available, and preservation of a real dirty state after export. R2 remains only because the explicit final manual row in Spec 055.1 is not recorded: after the export/dirty-state sequence, discard the unsaved changes, reopen the same saved plot, verify the persisted saved view is unchanged and `Update` is disabled. Record that observation for Cycles, Time/Capacity, and DCIR and hand 055.1 back for review. No product-code change is requested unless this check exposes a defect. Do not begin 055.2 or 055.3 yet.

---
### 2026-08-31T10:55:00+02:00 — REVIEWER → IMPLEMENTER — 055.1

**Result:** Review clean; next child 055.2

**Findings**

- None.

**Message**

User decision: formal manual confirmation will be performed at the end of the full Spec 055. This changes the timing of the previous R2 gate; it does not waive it. R1 is resolved and 055.1 code/automated review is clean. The former R2 is now a mandatory parent `FINAL_REVIEW` acceptance gate, recorded in `docs/specs/reviews/055-plot-workflow-polish-review.md` and the 055.1 review file. Begin only 055.2. Do not implement 055.3 until its workflow turn.

---
### 2026-08-31T11:02:01+02:00 — IMPLEMENTER → REVIEWER — 055.1

**Result:** Review fixes ready

**Verification**

- 055.1 focused plotExport regression passed; python scripts\preflight.py --no-cache passed previously at bdc8d3c with 158 backend/frontend modules, frontend type check, and production bundle. Disposable Alpha-style browser acceptance completed: Cycles toggled Normalize by g, invoked Discard and open, reopened Discharge capacity (mAh/g) comparison, and confirmed Update disabled with no Edited marker; Time/Capacity toggled Stack current below voltage, invoked Discard and open, reopened Time / capacity comparison, and confirmed Update disabled with no Edited marker; DCIR selected DCIR (mΩ), invoked Discard and open, reopened DCIR change from first (%) vs occurrence, and confirmed Update disabled with no Edited marker.

**Message**

R2 is closed. The final discard/reopen row was exercised for Cycles, Time/Capacity, and DCIR in the disposable Alpha-style app: each clean saved plot received an intentional persistent edit, the UI discard flow was used, the original saved plot was reopened, and the reopened plot had Update disabled with no Edited marker. The saved views remained unchanged; no product-code change was needed. 055.1 is ready for review-clean.

---
### 2026-08-31T11:21:25+02:00 — IMPLEMENTER → REVIEWER — 055.2

**Result:** Implementation ready

**Verification**

- python scripts\\preflight.py --no-cache passed: 158 backend/frontend modules, frontend type check, production bundle, and version consistency; focused analysisPlotPolicy/plotExport tests and live fresh-tab rename persistence passed

**Message**

055.2 saved plot rename is implemented and ready for review. Direct rename uses a focused modal with trim/blank/length validation, duplicate names allowed, stable IDs and nested plot state preserved, and metadata-only update through the existing autosave path. Active and inactive rename keep Update disabled unless scientific state is already dirty; current custom name is retained by Update and export filename resolution. Browser acceptance covered focus, blank rejection, duplicate names, active/inactive rename, disabled Update, backend persistence, and fresh-tab reload.

---
### 2026-08-31T11:28:08+02:00 — REVIEWER → IMPLEMENTER — 055.2

**Result:** Changes required

**Findings**

- R1

**Message**

055.2 persistence, metadata-only dirty-state behavior, stable saved-plot fields, trim/blank/length/duplicate validation, custom-name retention through later Update, export filename resolution, and the reported focused/no-cache preflight evidence are accepted. R1 remains in `SavedPlotsPanel.tsx`: the saved-plot row handles bubbled Enter/Space by calling `onOpen(plot)`, while the new Rename button is nested inside that row. Unlike the mouse path, the keyboard path does not ignore child buttons. Keyboard activation of Rename can therefore open the saved plot (and may suppress or combine with Rename activation), violating both Rename keyboard behavior and the requirement that renaming an inactive plot must not disturb the current active plot/draft. Guard the parent row's keyboard handler from nested interactive controls, preserve Enter/Space open behavior on the row itself, add focused regression coverage, rerun the focused frontend tests and `python scripts\\preflight.py --no-cache`, then hand 055.2 back for review. Do not begin 055.3.

---
### 2026-08-31T11:40:56+02:00 — IMPLEMENTER → REVIEWER — 055.2

**Result:** Review fixes ready

**Verification**

- R1 fix focused tests passed: node --test --test-reporter=dot frontend/tests/analysisPlotPolicy.test.ts frontend/tests/plotExport.test.ts; npm.cmd exec -- tsc -b passed; python scripts\\preflight.py --no-cache passed with all 158 backend/frontend modules, frontend type check, production bundle, and version consistency

**Message**

R1 is resolved. SavedPlotsPanel now guards the parent row's Enter/Space shortcut when the event originates in a nested button, preserving keyboard opening on the row surface while leaving Rename/Delete in control. Added shouldOpenSavedPlotCardFromKey policy coverage for Enter/Space row activation, non-activation keys, and nested-control suppression. The existing mouse guard remains unchanged. Please recheck Rename and Delete keyboard activation and confirm inactive rename does not open the saved plot or disturb active state.

---
### 2026-08-31T11:44:54+02:00 — REVIEWER → IMPLEMENTER — 055.2

**Result:** Review clean; next child 055.3

**Findings**

- None.

**Message**

R1 is resolved at `269085bb971c298bc31ca0a3c1cecb0494a12524`. The saved-plot parent row now ignores Enter/Space originating from nested Rename/Delete buttons while retaining row-level Enter/Space opening, and the focused policy regression covers both paths. The requested focused tests, TypeScript build, and `python scripts\\preflight.py --no-cache` are recorded as passing; no GitHub status checks are attached. 055.2 is review-clean. Begin only child 055.3. The previously deferred parent-level final manual acceptance gate remains mandatory at cumulative `FINAL_REVIEW`.

---
### 2026-08-31T12:08:15+02:00 — IMPLEMENTER → REVIEWER — 055.3

**Result:** Implementation ready

**Verification**

- 055.3 focused visibility and Plotly event tests: PASS (93 tests)
- node --test frontend/tests/simplePlotLayout.test.ts: PASS (5 tests)
- python scripts\preflight.py --no-cache: PASS (159 backend/frontend modules, type check, production bundle, version consistency)

**Message**

Spec 055.3 implements application-owned Show only this series and Show all series actions through a shared keyboard-accessible PlotHeader menu. Stable family-owned visibility keys persist in presentation.hidden_series_ids; applicable candidates honor selection, protocol/diagnostic/data/scientific filters; helper and auxiliary traces follow primary targets. The shared Plot wrapper disables Plotly legend item and double-click visibility and returns false defensively. Cycles, Time/Capacity, Steps, DCIR, Chargeability, and Rate Capability are wired, with saved-plot dirty/reopen state covered by policy regressions. The cumulative manual acceptance gate remains for FINAL_REVIEW.

---
