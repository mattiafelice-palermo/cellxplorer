# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest reviewer-inspected implementation commit: `9a9dab9c6bfd820b1e626f16862bc29bb0e5d33d`  
Status: **CHANGES REQUIRED — R11**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved.
- R4 palette preview is user-accepted.
- R5 modifier/range selection is **code-review clean in `9a9dab9c...` but requires user browser recheck**. The previous runtime failure came from reading modifier keys from a later click event after pointer-down; `9a9dab9c...` now captures modifier intent at pointer-down and feeds that explicit snapshot into the single selection policy for both row and checkbox paths.
- R6/R7/R8/R9 remain accepted/resolved.
- R10 detached legend rendering is user-accepted.
- R11 remains open. The implementer correctly improved the **expanded** full-legend modal, but the user clarified that the visual defect being discussed is primarily the **embedded Legend preview inside the Series appearance modal**. The embedded preview remains a small Plotly legend floating at the upper-left of a large panel with awkward empty width/height and Plotly scrollbar behavior.
- R12 local scientific-preview latency is code-review clean in `fcca1660...` and still requires user browser confirmation.
- The broader cumulative manual/browser matrix remains incomplete.

## Verification record

### Implementer-reported — latest R5/R11 pass (`9a9dab9c...`)

- focused frontend tests: PASS — 64 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages, 128 backend/frontend modules;
- manual/browser checks: NOT RUN by implementer.

### Reviewer-independent

I independently inspected:

- the new pointer-down modifier snapshot used by row and checkbox selection;
- Shift-over-Ctrl/Cmd precedence in `seriesSelectionResult(...)`;
- suppression of the checkbox's second native selection transition;
- the content-adaptive expanded legend change;
- the unchanged embedded legend layout visible in the user's screenshot.

I did **not** independently execute the test/build/preflight commands or browser/manual checks.

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

The root cause was the event lifecycle, not the range algorithm. The inclusive pure helper was already correct, but the UI previously decided the gesture partly at pointer-down and then passed a later raw click event into the selection policy. Releasing Shift/Ctrl between pointer-down and click—or checkbox native change ordering—could therefore reinterpret the same gesture and omit/toggle the endpoint.

`9a9dab9c...` now captures `{ shiftKey, toggleKey }` once at pointer-down for row and checkbox gestures and passes that explicit snapshot into `seriesSelectionResult(...)`. Shift remains higher priority than Ctrl/Cmd, and the checkbox suppresses its native second transition for modified gestures.

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

### R11 — Medium: Embedded Legend preview still has poor geometry and Plotly-scrollbar presentation

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/legendPreview.ts` or a focused legend-list renderer/helper extracted from it
- focused frontend tests

**Current**

The `Open full legend` action is useful and the expanded modal is now content-adaptive, but that fixed the wrong surface. In the main Series appearance modal, the embedded Legend preview still renders as Plotly's own compact legend inside a much larger fixed panel. With only a few entries it occupies a small strip in the upper-left while most of the panel is unused; when entries overflow, Plotly's narrow internal scrollbar appears inside that sparse surface. This is the visual problem shown by the user's screenshot.

**Target**

Redesign the **embedded Legend preview itself** around the user's accepted Option-C direction:

- preserve a single-column, top-to-bottom reading order;
- use the available width intentionally rather than leaving the legend as a narrow Plotly block on the left;
- let the legend section use the remaining vertical space beneath the fixed scientific preview instead of leaving unused modal space below it;
- for ordinary short legends, show all entries with no scrollbar;
- for longer legends, use a normal bounded `ScrollArea`/modal-body overflow only when content truly exceeds the available area;
- keep `Open full legend` as the escape hatch for very long legends, using the same entries/order/styles;
- preserve passive/read-only behavior and exact effective legend presentation (name/order/colour/opacity/line dash+width/marker shape+open state/legend visibility).

The original child spec required a detached Plotly legend preview, but the user's final manual-design decision supersedes the renderer detail if Plotly's built-in legend layout prevents this UX. It is acceptable—and likely preferable—to render a dedicated React/Mantine vertical legend list **derived from the existing `buildLegendPreview(...)` trace presentation data**, so there is still one styling/order source of truth rather than a second styling model. Do not hardcode a separate list of series or recompute styling independently.

**Acceptance criteria**

- With 4–5 entries, the embedded preview looks deliberately laid out across the available panel width and does not show an internal scrollbar.
- The legend section grows/fills the available space below the scientific preview rather than leaving a large unused area at the bottom of the modal.
- Entries flow only top-to-bottom in one column and preserve exact effective order.
- A long legend scrolls only after the available embedded area is genuinely exhausted.
- `Open full legend` displays the same entry model in a roomier surface; closing it preserves all selection/draft state.
- Marker-only, line-only and line+marker entries visibly represent the effective colour, opacity, dash, line width, marker symbol and open/filled state closely enough to judge appearance.
- `show_in_legend:false` and helper/non-legend traces remain absent; the preview eye remains independent.
- Focused tests cover entry extraction/order/style mapping and overflow/layout policy where practical.
- TypeScript, Vite build, `git diff --check`, and canonical `python scripts\\preflight.py` pass.
- Browser/manual confirmation remains required; do not claim Parent 046 complete from code checks alone.

### R12 — Low: Local scientific preview visibly lags behind appearance edits

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

The local preview now consumes the current draft directly; the 250 ms debounce remains on parent persistence only.

## Decision

**CHANGES REQUIRED — fix only R11. R5 and R12 are repository-clean pending user browser confirmation. After R11 verification, hand back to REVIEWER for the same cumulative FINAL_REVIEW. Do not claim the remaining browser/manual matrix complete.**
