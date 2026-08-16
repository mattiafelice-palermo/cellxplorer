# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
User-acceptance fixes previously reviewed: `269f6f56a5f6430f106a2875a5a964440f06efa3`, `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`  
Additional user-directed UI commit present before this review round: `25ccd1ff370f1ba73cb0b194807d36f5e7faaf39`  
Status: **CHANGES REQUIRED — R4 and R5 reopened by browser acceptance; new R10 from screenshot evidence**

## Current cumulative status

- R1/R2 repository-closure findings remain resolved.
- R3 All-series aggregate/homogenization is code-clean after its linked-secondary follow-up.
- R6 bulk legend membership, R7 row-body reorder, R8 Open alignment and R9 Palettes separation were previously code-clean; the user has made an additional UI adjustment at `25ccd1ff...`, which must be preserved and reviewed cumulatively after the current fixes.
- User browser acceptance now proves that R4 and R5 were **not** actually resolved in the runtime despite the earlier code-only review.
- The supplied screenshot also shows the detached **Legend preview** panel blank with five plotted series, which is a separate failure from the Palettes-tab palette preview and is recorded as R10.
- The remaining cumulative manual/browser matrix is still incomplete.

## Verification record

### Implementer-reported before this round

Initial R3–R9 fix pass (`269f6f56...`):
- focused frontend tests: PASS — 74 tests across seriesStyling / legendPreview / plotStylePalette / plotStylePresets;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 127 backend/frontend modules;
- browser/manual checks: NOT RUN by implementer.

R3/R8 follow-up (`9c9c87ea...`):
- `node --test frontend\\tests\\seriesStyling.test.ts`: PASS — 55 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 127 backend/frontend modules;
- browser/manual checks: NOT RUN by implementer.

### User browser/manual acceptance — round 2

FAIL:
- Shift+click still selects only the two endpoints instead of the contiguous rows between them.
- The Palettes-tab palette preview is still blank.
- Screenshot evidence additionally shows the detached `Legend preview` panel blank while five plotted series are present.

### Reviewer-independent

I independently inspected the live branch at `25ccd1ff370f1ba73cb0b194807d36f5e7faaf39`, including:
- current Shift selection and checkbox/row event wiring;
- `seriesSelectionRange(...)` and the current range-anchor policy;
- the hand-built `PalettePreview` SVG after the CSS-style-property change;
- `legendPreview.ts` and its zero-length trace transformation;
- the user-supplied screenshot showing a blank detached Legend preview;
- the additional `25ccd1ff...` user-directed mixed-switch/Open-alignment UI changes, which are unrelated to R4/R5/R10 and must not be discarded.

I did not independently execute the frontend or preflight commands, and I cannot substitute code inspection for the user's real browser evidence.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED across `269f6f56a5f6430f106a2875a5a964440f06efa3` and `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`.**

### R4 — Medium: Palette preview remains blank in the real browser

**Resolution state: REOPENED — USER BROWSER RECHECK FAILED.**

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- focused palette-preview tests/policies where practical

**Current**

The first fix moved Mantine `light-dark(...)` expressions from SVG presentation attributes into React style properties, but the user's next real-browser pass still reports a blank palette preview. The previous implementation-level theory therefore did not address the actual runtime failure.

**Target**

Find and fix the actual runtime cause. The palette preview must visibly render in the shipped app, not merely produce valid-looking SVG markup in source. Do not make another speculative token-location change without tracing the real rendering failure.

**Acceptance criteria**

- With any normal non-empty palette, the preview visibly shows curves in the palette colours plus readable axes/grid/legend chrome.
- Preset selection, reverse, colour edit, reorder, add/remove/duplicate visibly update the preview.
- It renders in both light and dark mode.
- Use browser/WebView-compatible colour values and geometry; if `light-dark(...)` is not supported in the actual runtime, replace it with a proven theme-safe mechanism rather than moving the same expression again.
- Add focused coverage for whatever root cause is found where practical.
- Final acceptance still requires the user to confirm the actual rendered preview.

### R5 — Medium: Shift+click still selects only endpoints instead of a contiguous range

**Resolution state: REOPENED — USER BROWSER RECHECK FAILED.**

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts` if helper policy changes
- focused interaction/policy tests where practical

**Current**

Despite the pure `seriesSelectionRange(...)` helper and row-level Shift handling, the user's browser pass still selects only two series rather than every row between the anchor and the Shift-clicked endpoint. This means the runtime interaction path is not actually reaching the contiguous-range behavior consistently.

A likely class of failure is that Shift-clicking a row selection affordance such as the checkbox follows its isolated toggle path rather than the row's range-selection path; the implementer must verify the real event path instead of assuming the helper is sufficient.

**Target**

Shift+click on the normal series selection affordance must produce the contiguous range visible in the current ordered quantity group. It must work repeatedly, without text selection/context-menu leakage, and without being defeated by the row-body drag sensor.

**Acceptance criteria**

- Select row A, then Shift-click row D: A/B/C/D are selected, not just A and D.
- The behavior works whether the user Shift-clicks the row body or the row's checkbox/selection target; plain checkbox clicks must still retain their normal toggle semantics.
- Repeated Shift-range operations preserve a predictable anchor.
- Shift across quantity groups remains disallowed.
- Ctrl/Cmd selection, preview eye and row-body/handle drag remain unaffected.
- Add interaction/policy coverage for the exact runtime path that was previously bypassing range selection.
- User browser recheck is required.

### R6 — Low: Multi-selection exposes redundant legend controls

**Resolution: RESOLVED; current branch includes an additional user-directed mixed-switch presentation adjustment at `25ccd1ff...`, to be retained.**

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution state: CODE REVIEW CLEAN; USER BROWSER ACCEPTANCE STILL PART OF FINAL MATRIX.**

### R8 — Low: `Open` marker control is vertically misaligned

**Resolution: RESOLVED; current branch includes an additional user-directed mixed-switch/Open presentation adjustment at `25ccd1ff...`, to be retained.**

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: RESOLVED in `269f6f56a5f6430f106a2875a5a964440f06efa3`.**

### R10 — Medium: Detached Legend preview is blank with visible legend-eligible series

Affected files:
- `frontend/src/features/analyses/editor/plotting/legendPreview.ts`
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/tests/legendPreview.test.ts`

**Current**

The supplied browser screenshot shows `Legend preview` as an empty bounded panel while the Series list contains five plotted series and the selected series is enabled for `Show in legend`. The current helper converts legend traces to normal-visible traces with `x=[]` and `y=[]`; previous source-level reasoning assumed Plotly would still materialize legend entries, but the real runtime evidence now disproves that assumption for this integration.

**Target**

The detached legend must visibly render all legend-eligible user series in the actual bundled Plotly/Tauri runtime while retaining the original constraints: no scientific curves/data, preview-eye independence, passive legend items, bounded/scrollable geometry, and true effective style/order.

**Acceptance criteria**

- A figure with one or more `showlegend !== false` user traces visibly renders their legend entries in the detached panel.
- The detached instance does not draw scientific curves or retain the full scientific arrays.
- Name, colour, line, marker, opacity, legend group/rank, show-in-legend state and ordering remain truthful.
- Preview-eye hiding does not remove an entry from the detached legend.
- Large legends remain bounded and reachable.
- Add focused regression coverage that exercises the representation actually accepted by bundled Plotly, rather than only asserting object shape.
- User browser recheck is required.

## Decision

**CHANGES REQUIRED — fix R4, R5 and R10 only, preserving the user's current `25ccd1ff...` UI changes and all previously resolved behavior. Run focused frontend verification plus canonical preflight, hand back to REVIEWER for the same cumulative FINAL_REVIEW, and do not claim the remaining manual/browser matrix complete.**
