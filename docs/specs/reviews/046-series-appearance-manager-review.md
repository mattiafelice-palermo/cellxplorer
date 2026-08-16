# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest reviewer-inspected implementation commit: `7b5fe4e7d926756523e1eb233a608a0901911c63`  
Status: **CHANGES REQUIRED — R11**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved.
- R4 palette preview is user-accepted.
- R5 modifier/range selection is **code-review clean in `9a9dab9c...` but requires user browser recheck**. The previous failure was traced to modifier state being read from a later click event; the fix now captures modifier intent at pointer-down for both row and checkbox paths and feeds one explicit snapshot to the inclusive selection policy.
- R6/R7/R8/R9 remain accepted/resolved.
- R10 detached legend rendering is user-accepted.
- R11 remains open. `7b5fe4e7...` correctly replaced the sparse embedded Plotly legend with a single-column React/Mantine legend list derived from the canonical legend-preview trace data, but the user's browser pass exposes two new layout defects: the **whole Series appearance modal becomes vertically scrollable**, and the embedded legend rows are too widely spaced.
- R12 local scientific-preview latency is code-review clean and still requires user browser confirmation.
- The broader cumulative manual/browser matrix remains incomplete.

## Verification record

### Implementer-reported — latest R11 pass (`7b5fe4e7...`)

- focused frontend tests: PASS — 65 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 128 backend/frontend modules;
- manual/browser checks: NOT RUN by implementer.

### User browser/manual evidence after `7b5fe4e7...`

- The new embedded vertical legend direction is accepted conceptually.
- The whole Series appearance modal now scrolls vertically; the user explicitly wants the modal itself fixed and only the legend box to own legend overflow.
- Legend entries need less vertical/interline spacing.

### Reviewer-independent

I independently inspected:

- the root `Modal`/main `Group` sizing;
- `PreviewPanel`'s new `height: "100%"` flex column;
- the embedded legend `PanelShell` and its `ScrollArea`;
- `LegendPreviewList`, where embedded rows currently use `Stack gap={4}`, `minHeight: 30`, and a 28 px-high SVG swatch;
- the pointer-down modifier snapshot from the preceding R5 pass.

The root modal currently constrains only `styles.content.height`; it does not explicitly make the modal body a `minHeight: 0`, `overflow: hidden` flex container. That allows the new full-height/flex preview column to push overflow to the modal-level scroll container even though the legend list itself has a `ScrollArea`.

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

The inclusive range algorithm was not the failure. The browser path previously decided the same gesture twice from different events. `9a9dab9c...` now captures `{ shiftKey, toggleKey }` once at pointer-down for row and checkbox gestures and uses that explicit snapshot in `seriesSelectionResult(...)`, with Shift taking precedence over Ctrl/Cmd and the checkbox native second transition suppressed.

Browser acceptance still requires repeated forward/reverse Shift ranges, Shift+Ctrl/Cmd ranges, and ordinary Ctrl/Cmd toggles without intermittently losing the clicked endpoint.

### R6 — Low: Multi-selection legend membership presentation

**Resolution: RESOLVED.**

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution: USER-ACCEPTED.**

### R8 — Low: `Open` marker control alignment/presentation

**Resolution: RESOLVED.**

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: USER-ACCEPTED.**

### R10 — Medium: Detached Legend preview is blank with visible legend-eligible series

**Resolution: USER-ACCEPTED.**

### R11 — Medium: Embedded legend overflow escapes to the whole modal and rows are too loose

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/legendPreview.ts` only if entry-model changes are necessary
- focused frontend tests

**Current**

`7b5fe4e7...` makes the correct architectural change: the embedded legend is now a passive single-column React/Mantine list derived from `buildLegendPreview(...)` data, and the full-legend modal reuses the same entry model. However:

1. The parent `Modal` still only fixes `styles.content.height`; its body is not explicitly constrained as a non-scrolling `flex: 1; min-height: 0; overflow: hidden` region. `PreviewPanel` now has `height: "100%"` and its legend panel flexes into remaining space. In the browser, the overflow therefore escapes upward and makes the **entire Series appearance modal scroll**, which the user rejects.
2. The embedded legend rows are unnecessarily tall: the list uses `Stack gap={4}`, each row has `minHeight: 30`, and the swatch SVG is 28 px high. The user wants the series visually closer together.

**Target**

Keep the accepted single-column Option-C-style legend, but tighten overflow ownership and density:

- the **Series appearance modal itself must not gain a vertical scrollbar because of the legend**;
- constrain the modal body/main three-panel row so it stays within the existing fixed modal height (`min-height: 0` / `overflow: hidden` at the appropriate ancestors);
- the embedded `Legend preview` panel should occupy the remaining space under the fixed scientific preview;
- **only the legend panel's body/list should scroll when its entries exceed that available space**;
- preserve existing independent panel scrolling where already intentionally used elsewhere (Series/Appearance); do not turn the root modal into the overflow owner;
- make the embedded legend rows substantially denser: smaller row minimum height, smaller swatch height, and little/no inter-row gap, while retaining readable text and marker/line samples;
- the expanded full-legend modal may be slightly roomier, but should still avoid excessive row spacing;
- preserve one-column top-to-bottom order, passive behavior, canonical effective styling, and the `Open full legend` action.

**Acceptance criteria**

- Opening Series appearance at the normal desktop size shows **no root/modal vertical scrollbar introduced by the legend**.
- The scientific preview remains fixed-size and does not shrink.
- The embedded Legend preview fills the available area below it.
- With 4–5 entries, all entries are visible without scrolling and are visually compact, with noticeably less interline space than `7b5fe4e7...`.
- With enough entries to overflow, the scrollbar appears **inside the Legend preview body only**; scrolling it does not move the modal title, scientific preview, Series panel, or Appearance panel.
- Entry order remains top-to-bottom and identical to the canonical effective legend order.
- `Open full legend` reuses the same entry model and remains read-only.
- Marker-only, line-only and line+marker samples continue to represent effective colour, opacity, dash, width, symbol and open/filled state.
- `show_in_legend:false` and helper/non-legend traces remain absent; preview-eye hiding remains independent.
- Focused tests cover legend-entry extraction/style mapping and any testable sizing/overflow policy helpers; browser verification is still required for scroll containment and density.
- TypeScript, Vite build, `git diff --check`, and canonical `python scripts\\preflight.py` pass.

### R12 — Low: Local scientific preview visibly lags behind appearance edits

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

The local preview consumes the current draft directly; the 250 ms debounce remains on parent persistence only.

## Decision

**CHANGES REQUIRED — fix only R11. R5 and R12 are repository-clean pending user browser confirmation. After R11 verification, hand back to REVIEWER for the same cumulative FINAL_REVIEW. Do not claim the remaining browser/manual matrix complete.**
