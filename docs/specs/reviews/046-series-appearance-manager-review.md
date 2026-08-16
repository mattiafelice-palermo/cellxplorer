# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest reviewer-inspected implementation commit: `9ec962623b5ccd307e3a48ff3d848896347f1b6e`  
Status: **CODE CLEAN — USER BROWSER RECHECK REQUIRED**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved.
- R4 palette preview is user-accepted.
- R5 modifier/range selection is **code-review clean in `9a9dab9c...` but requires user browser recheck**. Modifier intent is now captured once at pointer-down for both row and checkbox paths and fed to one inclusive selection policy.
- R6/R7/R8/R9 remain accepted/resolved.
- R10 detached legend rendering is user-accepted.
- R11 embedded legend presentation is **code-review clean in `9ec96262...` but requires user browser recheck**. The embedded legend uses the accepted single-column React/Mantine list, root modal overflow is now contained, only the legend list owns legend overflow, and embedded rows are denser.
- R12 local scientific-preview latency is code-review clean and requires user browser confirmation.
- The broader cumulative manual/browser matrix remains incomplete.

## Verification record

### Implementer-reported — latest R11 pass (`9ec96262...`)

- focused frontend tests: PASS — 65 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 128 backend/frontend modules;
- manual/browser checks: NOT RUN by implementer.

### Reviewer-independent

I independently inspected:

- the root Series appearance `Modal` content/body now using `flex: 1`, `minHeight: 0`, and `overflow: hidden`;
- the main three-panel row now constraining overflow;
- the embedded Legend preview panel retaining its own `ScrollArea`;
- embedded legend density reduced from 30 px rows / 28 px swatches / 4 px row gap to 24 px rows / 22 px swatches / zero row gap;
- the preceding R5 pointer-down modifier snapshot and single selection-policy path.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED.**

### R4 — Medium: Palette preview blank in browser

**Resolution: USER-ACCEPTED.**

### R5 — Medium: Modifier selection intermittently lost the clicked endpoint

**Resolution state: CODE REVIEW CLEAN in `9a9dab9c6bfd820b1e626f16862bc29bb0e5d33d`; USER BROWSER RECHECK REQUIRED.**

The browser failure was caused by event timing, not by `seriesSelectionRange(...)`. The old UI could read Shift/Ctrl from a later click event after the gesture started. The current implementation captures `{ shiftKey, toggleKey }` at pointer-down and uses that explicit snapshot for both row and checkbox selection. Shift takes precedence over Ctrl/Cmd; checkbox native change is suppressed for modified gestures.

Browser acceptance still requires repeated forward/reverse Shift ranges, Shift+Ctrl/Cmd ranges, and ordinary Ctrl/Cmd toggles without intermittently omitting the clicked endpoint.

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

### R11 — Medium: Embedded legend overflow escaped to the whole modal and rows were too loose

**Resolution state: CODE REVIEW CLEAN in `9ec962623b5ccd307e3a48ff3d848896347f1b6e`; USER BROWSER RECHECK REQUIRED.**

The implementation now:

- constrains the root modal content and body with `minHeight: 0` and `overflow: hidden`;
- constrains the main three-panel row so legend overflow cannot escape to the modal;
- keeps the embedded legend panel flexing into the remaining space below the fixed scientific preview;
- leaves overflow ownership with the legend's `ScrollArea`;
- tightens embedded rows to 24 px minimum height, zero inter-row stack gap, 4 px swatch/text gap, and 22 px swatch height;
- preserves the same single-column canonical legend-entry model for embedded and full-legend views.

Browser acceptance requires confirming that the Series appearance modal itself no longer scrolls because of the legend, that only the embedded legend box scrolls on genuine overflow, and that the denser row spacing is visually appropriate.

### R12 — Low: Local scientific preview visibly lagged behind appearance edits

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

The local preview now consumes the current draft directly; the 250 ms debounce remains only on parent persistence.

## Decision

**REPOSITORY/CODE REVIEW CLEAN — BLOCKED ON USER BROWSER ACCEPTANCE.** Recheck R5 (modifier selection), R11 (modal-vs-legend scroll ownership and row density), and R12 (immediate preview response), then continue the remaining cumulative Parent 046 manual/browser matrix. Do not declare merge readiness until that evidence is supplied.
