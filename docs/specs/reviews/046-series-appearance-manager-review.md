# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Latest runtime-fix checkpoint reviewed: `14c9c89046dea4af029478fa1f8b948dca3e996f`  
Additional user-directed UI commit preserved: `25ccd1ff370f1ba73cb0b194807d36f5e7faaf39`  
Status: **CHANGES REQUIRED — R5, R11, R12**

## Current cumulative status

- R1/R2 repository closure remains resolved.
- R3 All-series aggregate/homogenization remains resolved, including linked-secondary colour behavior.
- R4 palette preview is now accepted by the user in the latest browser pass; the user reports the remaining previously failing preview behavior works.
- R5 remains open: Shift range selection now mostly works, but the last Shift-clicked series is excluded. The range must be inclusive of both anchor and endpoint.
- R6/R8 retain the user's later mixed-switch/Open presentation adjustment from `25ccd1ff...`; R7 and R9 remain accepted by the user as part of the statement that everything else works well.
- R10 detached Legend preview is now accepted by the user: the latest screenshot shows the legend entries rendering.
- The user selected the vertically flowing legend design and requested an explicit full-size legend expansion path (R11).
- The user also reports a perceptible delay between appearance edits and the scientific preview updating (R12).
- The broader cumulative manual/browser matrix is still not declared complete; after these fixes the affected paths must be rerun before any merge-ready decision.

## Verification record

### Implementer-reported — R4/R5/R10 follow-up (`14c9c890...`)

- focused frontend tests: PASS — 62 targeted tests;
- frontend typecheck: PASS;
- frontend production bundle: PASS;
- canonical preflight: PASS — 4/4 stages;
- browser/manual checks: NOT RUN by implementer.

### User browser/manual acceptance — latest round

PASS:
- detached Legend preview now visibly renders;
- palette preview and the other previously reported UI fixes are reported working well.

FAIL / change requested:
- Shift-click contiguous selection excludes the final clicked endpoint;
- preview styling changes have a noticeable delay before appearing in the plot;
- long vertically ordered legends would benefit from an explicit larger read-only legend view rather than relying only on the embedded scrollbar.

### Reviewer-independent

I independently inspected:
- the current Shift row/checkbox event path and `seriesSelectionRange(...)` use;
- the current modal preview path, including `useDeferredValue(draftOverrides)` / `useDeferredValue(draftRules)` and the separate 250 ms parent commit debounce;
- the current detached legend transformation and embedded Plotly preview;
- the latest user screenshots and stated acceptance results.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED across `269f6f56...` and `9c9c87ea...`.**

### R4 — Medium: Palette preview blank in browser

**Resolution: USER-ACCEPTED after `14c9c89046dea4af029478fa1f8b948dca3e996f`.**

### R5 — Medium: Shift-click contiguous range excludes the final clicked series

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts` only if the pure range helper needs correction
- focused frontend tests

**Current**

The latest browser pass shows that Shift selection now forms a range, but the final Shift-clicked row is not selected. If the anchor is A and the user Shift-clicks D, the UI effectively selects A/B/C rather than A/B/C/D.

The pure helper is intended to be inclusive, so the implementer must trace the real row/checkbox event path and controlled-checkbox state rather than assuming the helper alone proves correctness.

**Target**

Shift range selection must be inclusive of both the established anchor and the clicked endpoint, for both row-body and selection-checkbox gestures, while preserving the same-group boundary and existing browser-native suppression.

**Acceptance criteria**

- Click A, Shift-click D → A/B/C/D are all selected.
- The same inclusive result holds when D is activated through its checkbox/selection control.
- Reverse ranges are inclusive as well (D then Shift-click B → B/C/D).
- Repeated range operations keep a predictable anchor.
- Ctrl/Cmd selection, ordinary checkbox toggles, preview eye and drag activation remain isolated.
- Focused tests cover inclusive endpoint behavior through the interaction helper/path; final browser confirmation remains required.

### R6 — Low: Multi-selection legend membership presentation

**Resolution: RESOLVED; latest user-directed mixed-switch presentation is preserved.**

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution: USER-ACCEPTED in the latest browser pass.**

### R8 — Low: `Open` marker control alignment/presentation

**Resolution: RESOLVED; latest user-directed presentation is preserved.**

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: USER-ACCEPTED in the latest browser pass.**

### R10 — Medium: Detached Legend preview is blank with visible legend-eligible series

**Resolution: USER-ACCEPTED after `14c9c89046dea4af029478fa1f8b948dca3e996f`.**

The latest user screenshot visibly shows the detached legend entries.

### R11 — Low: Long vertically ordered legends need an explicit full-size inspection view

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- `frontend/src/features/analyses/editor/plotting/legendPreview.ts` only if reusable sizing/config helpers are appropriate
- focused frontend tests

**Current**

The embedded Legend preview now works and the user prefers the simple top-to-bottom reading order. However, long legends still rely on the relatively small embedded Plotly scroll area, while the overall modal has room for a clearer dedicated inspection path.

**Target**

Keep the existing embedded vertically ordered legend preview, and add a clear action in the `Legend preview` header (for example `Expand` / `Open full legend`) that opens a larger dedicated read-only legend modal/overlay. It must reuse the same legend-preview data and ordering rather than creating a parallel hardcoded rendering path.

**Acceptance criteria**

- A visible, compact action exists in the Legend preview header.
- Activating it opens a substantially larger legend-only modal/overlay.
- The expanded view preserves the same top-to-bottom entry order, effective labels, colours, line/marker styles, legend membership and ordering as the embedded preview.
- The expanded view remains passive/read-only; it does not toggle traces or mutate styling.
- Ordinary legends should be inspectable without the cramped embedded scrollbar; very large legends may still scroll inside the expanded view.
- Closing the expanded view returns to the Series appearance modal without losing selection or draft edits.
- Light/dark behavior and keyboard accessibility match existing Mantine modal patterns.
- Focused tests cover open/close behavior and confirm the expanded view consumes the same legend-preview data source.

### R12 — Low: Local scientific preview visibly lags behind appearance edits

Affected files:
- `frontend/src/features/analyses/editor/plotting/SeriesStyleModal.tsx`
- focused frontend tests/policy coverage where practical

**Current**

The user perceives a noticeable delay between editing one or multiple series and seeing the change in the scientific preview on the left. The modal currently sets draft state immediately but then feeds the scientific/legend preview through `useDeferredValue(draftOverrides)` and `useDeferredValue(draftRules)`. Separately, parent persistence uses a 250 ms commit debounce.

**Target**

The modal's own scientific preview should reflect current draft appearance changes immediately, with no intentional debounce/deferred-value lag. The heavier parent/spec persistence path may remain debounced if needed for performance, as long as the local preview uses the current draft and remains responsive during colour drags/spinner changes.

Do not solve this by forcing synchronous heavyweight parent rebuilds on every pointer event if the same UX can be achieved by decoupling local preview state from persisted commits.

**Acceptance criteria**

- Single-series and bulk appearance changes update the modal scientific preview on the same interaction/render cycle, without an intentional ~250 ms pause or deferred stale frame.
- Local preview uses current draft overrides/rules/base style; parent persistence may retain a bounded debounce.
- Colour dragging and numeric spinner/held-key interactions remain responsive.
- Detached legend preview stays in sync with the same current draft.
- No regression to saved/autosave state, palette application, order composition or close/flush behavior.
- Implementer explains which defer/debounce remains and why.

## Decision

**CHANGES REQUIRED — fix only R5, R11 and R12, run focused frontend verification plus TypeScript, Vite build, `git diff --check`, and canonical `python scripts\\preflight.py`, then hand back to REVIEWER for the same cumulative FINAL_REVIEW. Do not claim the remaining browser/manual matrix complete.**
