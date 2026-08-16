# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest reviewer-inspected implementation commit: `9ec962623b5ccd307e3a48ff3d848896347f1b6e`  
Status: **CHANGES REQUIRED — R5**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved.
- R4 palette preview is user-accepted.
- R5 modifier/range selection is **REOPENED from user browser evidence**. The latest implementation is still not behaviorally correct: Shift-click consistently omits the second/clicked endpoint in the user's real browser.
- R6/R7/R8/R9 remain accepted/resolved.
- R10 detached legend rendering is user-accepted.
- R11 embedded legend presentation is **USER-ACCEPTED**.
- R12 local scientific-preview latency is **USER-ACCEPTED**.
- The broader cumulative manual/browser matrix remains incomplete.

## Verification record

### Implementer-reported — latest repository pass

- focused frontend tests: PASS — 65 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 128 backend/frontend modules;
- implementer browser check: NOT RUN.

### User browser/manual evidence

- R11 modal/legend scroll ownership: PASS.
- R12 preview responsiveness: PASS.
- R5 Shift-click range: FAIL. The second/clicked endpoint is still omitted in the real browser.

### Reviewer-independent

I independently inspected the current pure range policy and the current pointer-down/click/checkbox event wiring. The pure range helper is inclusive; therefore another code-only rewrite without browser reproduction is not sufficient evidence for R5.

I did **not** independently execute browser automation or local application commands.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED.**

### R4 — Medium: Palette preview blank in browser

**Resolution: USER-ACCEPTED.**

### R5 — Medium: Shift-click range selection still omits the clicked endpoint in the real browser

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts` only if the selection-policy API genuinely needs adjustment
- focused interaction/browser tests where practical

**Current**

The pure `seriesSelectionRange(...)` / `seriesSelectionResult(...)` policy is endpoint-inclusive in unit tests, and the UI now snapshots modifiers at pointer-down. Nevertheless, the user has retested the actual application and reports that Shift-click still consistently leaves the second/clicked row out of the final visible selection.

This means the remaining defect is in the live interaction/state/event path, not proven fixed by the pure policy test. Possible causes include a second selection transition from browser/React checkbox semantics, row/click bubbling, sortable pointer handling, or a subsequent state update that removes the endpoint. Do not assume which one: reproduce it first and inspect the actual event/state sequence.

**Target**

Make one browser gesture produce exactly one deterministic selection-state transition. Click A, then Shift-click D must leave A/B/C/D selected after all pointer/click/change/focus/sortable handlers have finished. The same must hold for reverse ranges and for both row-body and checkbox interaction paths.

**Explicit browser authorization for this pass**

The user's current instruction explicitly authorizes the implementer to use browser tooling for R5 and supersedes the older project-session instruction that browser use was prohibited. For this finding, browser reproduction/debugging is not only permitted but required if the implementer environment provides it.

**Mandatory browser-debug requirement**

This finding has already survived multiple code-only fixes. Before changing more code:

1. reproduce the failure in the running frontend/application using an actual browser/runtime;
2. instrument or otherwise inspect the row/checkbox pointer-down → click → change/state-update sequence as needed;
3. identify which handler/update removes or fails to add the endpoint;
4. apply the smallest fix;
5. rerun the browser scenario repeatedly after the fix.

Do **not** hand R5 back as fixed based only on unit tests, TypeScript, or code inspection. If browser tooling is genuinely unavailable in the implementer environment, report that environment limitation explicitly and leave R5 unresolved rather than claiming success.

**Acceptance criteria**

- In a real browser: click A, Shift-click D → A/B/C/D remain selected after the gesture completes.
- In a real browser: click D, Shift-click B → B/C/D remain selected.
- Repeat both directions at least 10 times without intermittently losing the endpoint.
- Exercise both row-body Shift-click and selection-checkbox Shift-click.
- Shift+Ctrl/Cmd on the second gesture follows Shift-range precedence and includes the endpoint.
- Plain Ctrl/Cmd still toggles exactly the clicked series.
- Browser text selection, context-menu behavior, drag activation, preview-eye actions and native checkbox changes do not create a second conflicting selection transition.
- Add/adjust focused automated coverage for the confirmed root cause where practical.
- Record the browser/runtime used, exact reproduction steps, observed root cause, and post-fix browser result in the implementer handoff.
- Also run focused frontend tests, TypeScript, Vite build, `git diff --check`, and canonical `python scripts\\preflight.py`.

### R6 — Low: Multi-selection legend membership presentation

**Resolution: RESOLVED.**

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution: USER-ACCEPTED.**

### R8 — Low: `Open` marker control alignment/presentation

**Resolution: RESOLVED.**

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: USER-ACCEPTED.**

### R10 — Medium: Detached Legend preview was blank

**Resolution: USER-ACCEPTED.**

### R11 — Medium: Embedded legend overflow/presentation

**Resolution: USER-ACCEPTED.**

### R12 — Low: Local scientific preview visibly lagged behind appearance edits

**Resolution: USER-ACCEPTED.**

## Decision

**CHANGES REQUIRED — fix only R5. Browser use is explicitly authorized by the user for this pass. This pass requires real-browser reproduction and post-fix verification; do not return a code-only claim of success. After the browser-verified fix, run the normal focused verification and hand back to REVIEWER for the same cumulative FINAL_REVIEW.**
