# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
User-acceptance fixes reviewed: `269f6f56a5f6430f106a2875a5a964440f06efa3`, `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`, `14c9c89046dea4af029478fa1f8b948dca3e996f`  
Additional user-directed UI commit preserved: `25ccd1ff370f1ba73cb0b194807d36f5e7faaf39`  
Status: **CODE/REPOSITORY REVIEW CLEAN; BLOCKED ON USER BROWSER RECHECK AND REMAINING MANUAL MATRIX**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved, including linked-secondary colour behavior.
- R6/R8 retain the user's later mixed-switch/Open presentation adjustment from `25ccd1ff...`; R7 and R9 remain code-clean.
- The user's second browser pass reopened R4 and R5 and exposed R10 from the supplied screenshot.
- `14c9c890...` addresses all three runtime failure paths directly. I found no further repository defect in that fix commit, but all three require the user's browser confirmation because the prior code-only fixes had already demonstrated that source inspection alone was insufficient.
- The remaining cumulative 33-item browser/manual matrix is still incomplete.

## Verification record

### Implementer-reported — R4/R5/R10 follow-up (`14c9c890...`)

- focused frontend tests: PASS — 62 targeted tests;
- frontend typecheck: PASS;
- frontend production bundle: PASS;
- canonical preflight: PASS — 4/4 stages;
- browser/manual checks: NOT RUN by implementer.

Earlier implementation/fix passes also reported focused tests, TypeScript, Vite build and canonical preflight passing as recorded in the coordination log and child review files.

### User browser/manual acceptance — round 2

FAIL before `14c9c890...`:
- Shift+click selected only the two endpoints rather than the contiguous range;
- the Palettes-tab palette preview remained blank;
- the supplied screenshot showed the detached `Legend preview` blank while five plotted series were present.

### Reviewer-independent

I independently inspected:
- `14c9c890...` against the exact reviewer handoff base;
- current Shift row/checkbox event ordering and the existing `seriesSelectionRange(...)` path;
- the new intrinsic palette-preview geometry module and current SVG rendering contract;
- the detached legend transformation, including the finite/null sentinel representation and `scattergl` → `scatter` compatibility conversion;
- the focused legend/palette tests;
- preservation of the user's `25ccd1ff...` mixed-switch/Open UI changes.

I did **not** independently execute the test/build/preflight commands or the real browser checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED across `269f6f56...` and `9c9c87ea...`.**

### R4 — Medium: Palette preview remains blank in the real browser

**Resolution state: CODE REVIEW CLEAN in `14c9c89046dea4af029478fa1f8b948dca3e996f`; USER BROWSER RECHECK REQUIRED.**

The previous attempted fix changed theme-token placement but left the runtime blank. The new fix addresses two concrete renderer risks instead: the SVG now has explicit intrinsic `width`/`height` plus a matching fixed `viewBox`, and all chart chrome uses `currentColor`/ordinary CSS variables rather than `light-dark(...)`. The curve/geometry model was extracted to `palettePreview.ts` with focused tests. This is a materially different fix, but only the user's WebView can close the runtime finding.

Acceptance still requires the preview to be visibly populated and updating in light/dark mode.

### R5 — Medium: Shift+click selects only endpoints instead of a contiguous range

**Resolution state: CODE REVIEW CLEAN in `14c9c89046dea4af029478fa1f8b948dca3e996f`; USER BROWSER RECHECK REQUIRED.**

The follow-up now handles the concrete bypass identified by the user's behavior: Shift-pointer-down on a series checkbox marks the range gesture, Shift-click is prevented from performing the checkbox's native endpoint toggle, and the checkbox explicitly calls the same `selectSeries(...)` range path as the row. Plain checkbox toggles remain on the ordinary `onChange` route; row-body Shift and drag isolation remain intact.

Acceptance still requires: select A, Shift-click D (row or checkbox) → A/B/C/D selected, repeatedly and without native text/context leakage.

### R6 — Low: Multi-selection legend membership presentation

**Resolution: RESOLVED; latest user-directed mixed-switch presentation from `25ccd1ff...` is preserved.**

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution state: CODE REVIEW CLEAN; USER BROWSER ACCEPTANCE STILL PART OF FINAL MATRIX.**

### R8 — Low: `Open` marker control alignment/presentation

**Resolution: RESOLVED; latest user-directed mixed-switch/Open presentation from `25ccd1ff...` is preserved.**

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: RESOLVED in `269f6f56...`.**

### R10 — Medium: Detached Legend preview is blank with visible legend-eligible series

**Resolution state: CODE REVIEW CLEAN in `14c9c89046dea4af029478fa1f8b948dca3e996f`; USER BROWSER RECHECK REQUIRED.**

The zero-length trace representation was the key runtime assumption disproved by the screenshot. The detached legend now replaces source arrays with a one-record sentinel (`x=[0]`, `y=[null]`) so Plotly materializes the trace/legend entry while the null ordinate prevents a curve/marker from drawing. `scattergl` is normalized to SVG-compatible `scatter` for this legend-only surface. Scientific arrays/customdata are still not retained, and the existing style/rank/group fields remain copied.

Acceptance still requires the detached Legend preview to visibly show the eligible entries, preserve their effective appearance/order, remain independent of the preview eye, and stay bounded for large legends.

## External acceptance still pending

Please rerun first:
1. R4 — Palettes-tab preview visibly renders and updates;
2. R5 — contiguous Shift range via both row body and checkbox;
3. R10 — detached Legend preview visibly contains the plotted legend entries.

Then continue the remaining Parent 046 cumulative manual/browser matrix. Any failure reopens the corresponding finding; passing these three does not by itself complete Parent 046 unless the remaining required checks are also completed.

## Decision

**BLOCKED ON REQUIRED USER BROWSER/MANUAL ACCEPTANCE — repository-side fixes R4/R5/R10 are review-clean at `14c9c89046dea4af029478fa1f8b948dca3e996f`; no implementer work is pending until the user browser recheck supplies evidence.**
