# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest reviewer-inspected implementation commit: `fcca1660fa2b842fc880b0eea4ba7cb5a577c6bc`  
Status: **CHANGES REQUIRED — R5, R11**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved, including linked-secondary colour behavior.
- R4 palette preview is user-accepted after the latest browser pass.
- R5 remains open. The new pure selection policy is inclusive, but the live checkbox/row event path still loses modifier intent depending on pointer/key release timing; the user reports intermittent omission of the second/endpoint series, including Shift/Ctrl-modified selection.
- R6/R7/R8/R9 remain accepted/resolved.
- R10 detached Legend preview is user-accepted and visibly renders.
- R11 is implemented structurally, but the user's screenshot exposes poor expanded-view geometry: a short four-entry legend is forced into a 520 px Plotly surface, leaving a very large empty body while still showing an internal scrollbar.
- R12 is code-review clean in `fcca1660...`: local `useDeferredValue` lag was removed and only parent persistence remains debounced at 250 ms. This still needs the user's browser recheck after the next handoff.
- The broader cumulative manual/browser matrix is not yet declared complete.

## Verification record

### Implementer-reported — R5/R11/R12 pass (`fcca1660...`)

- focused frontend tests: PASS — 62 tests;
- TypeScript: PASS;
- Vite build: PASS;
- `git diff --check`: PASS;
- canonical preflight: PASS — 4/4 stages;
- manual/browser checks: NOT RUN by implementer.

### User browser/manual evidence after `fcca1660...`

- Full legend modal opens, but the supplied screenshot shows a short legend occupying only the top of a very tall blank Plotly area, with an internal scrollbar still present.
- Shift/Ctrl-modified selection still intermittently omits the second/clicked endpoint series.

### Reviewer-independent

I independently inspected:

- `fcca1660...` against its reviewer handoff base;
- `seriesSelectionResult(...)`, the row/checkbox pointer/click/change event wiring, and the focused selection tests;
- `expandLegendPreview(...)`, the nested full-legend modal, and the expanded legend tests;
- the local preview path after removal of `useDeferredValue` and the retained 250 ms parent persistence debounce;
- the user's latest screenshot and runtime report.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED.**

### R4 — Medium: Palette preview blank in browser

**Resolution: USER-ACCEPTED.**

### R5 — Medium: Modifier selection still intermittently loses the clicked endpoint

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts` only if the selection-policy API is adjusted
- focused frontend tests

**Current**

`seriesSelectionResult(...)` itself returns an inclusive range, but the UI still passes a raw React click event into `selectSeries(...)`. The checkbox stores Shift intent on pointer-down (`shiftCheckboxClick.current`) only to decide that the later click is a range gesture; it then calls `onSelect(event)`, whose `event.shiftKey` can already be false if the user released Shift between pointer-down and click. The row body has the same timing dependency because it does not persist modifier intent from pointer-down at all. This explains why the pure test passes while browser behavior remains intermittent.

The user's latest report also mentions Shift/Ctrl-modified selection, so modifier precedence must be deterministic rather than dependent on which modifier remains present on the eventual click event.

**Target**

Capture the selection gesture's modifier intent explicitly and feed explicit modifier state into one selection policy. Do not infer a range/toggle from a later raw click event after already deciding differently at pointer-down. Preserve current locked semantics: Shift means same-group contiguous range; Ctrl/Cmd means arbitrary toggle; when Shift is present together with Ctrl/Cmd, Shift range behavior takes precedence and remains inclusive.

**Acceptance criteria**

- Click A, Shift-click D → A/B/C/D selected, including when Shift is released between mouse-down and click/up.
- The same is true through the selection checkbox/control.
- Reverse range D → Shift-click B gives B/C/D.
- Shift+Ctrl/Cmd on the second gesture follows the documented Shift-range precedence and includes the endpoint.
- Plain Ctrl/Cmd toggling continues to add/remove exactly the clicked series.
- Repeated operations do not randomly omit the second/clicked element.
- Checkbox native `onChange`, row click, drag activation and preview-eye interactions cannot apply a second conflicting selection transition.
- Focused tests cover the modifier-intent/endpoint policy, and the final browser recheck must exercise realistic pointer-down/click timing.

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

### R11 — Low: Expanded full-legend view wastes most of its surface and still presents an internal scrollbar for a short legend

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/legendPreview.ts`
- `frontend/tests/legendPreview.test.ts`

**Current**

The new `Open full legend` action and nested passive modal are structurally correct and reuse the same legend-preview data. However, `expandLegendPreview(...)` hard-codes `LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT = 520`. The user's screenshot shows the resulting defect directly: four vertically ordered entries occupy only a small strip at the top of a 520 px Plotly canvas, the rest is blank, and a scrollbar is still visible. This defeats the purpose of the expanded view.

**Target**

Make the expanded legend content-adaptive while preserving the preferred top-to-bottom reading order. The Plotly legend surface should be tall enough to show all ordinary entries without its own cramped internal scrollbar, but should not impose a large minimum height when only a few entries exist. For genuinely long legends, let the expanded content grow up to a sensible viewport/modal cap; if overflow remains, prefer scrolling the expanded modal/body around the complete legend surface rather than recreating the tiny embedded Plotly scrollbar experience.

**Acceptance criteria**

- Four entries produce a compact full-legend view with no large blank lower half.
- Ordinary legends that fit the expanded viewport show all entries without an internal Plotly legend scrollbar.
- Entries remain single-column/top-to-bottom in the same effective order as the embedded preview.
- Long legends can use substantially more vertical space than the embedded preview and remain reachable when they exceed the viewport.
- The expanded view continues to reuse the same legend data/styles and remains passive/read-only.
- Closing it preserves the parent modal's selection and draft state.
- Focused tests assert content-adaptive expanded height rather than a fixed 520 px minimum and preserve data/order identity.

### R12 — Low: Local scientific preview visibly lags behind appearance edits

**Resolution state: CODE REVIEW CLEAN in `fcca1660fa2b842fc880b0eea4ba7cb5a577c6bc`; USER BROWSER RECHECK REQUIRED.**

The implementation now feeds `draftOverrides` and `draftRules` directly into the scientific and detached-legend preview builders. The 250 ms debounce remains only on parent/spec persistence, so the intentional stale local frame has been removed without forcing the parent analysis state to rebuild synchronously on every drag/spinner event.

Acceptance still requires the user to confirm that single/bulk appearance edits now feel immediate and that colour dragging/spinners remain responsive.

## Decision

**CHANGES REQUIRED — fix only R5 and R11. R12 is repository-clean pending user browser confirmation. Run focused frontend verification plus TypeScript, Vite build, `git diff --check`, and canonical `python scripts\\preflight.py`, then hand back to REVIEWER for the same cumulative FINAL_REVIEW. Do not claim the remaining browser/manual matrix complete.**
