# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
User-acceptance fixes reviewed: `269f6f56a5f6430f106a2875a5a964440f06efa3`, `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`  
Status: **Code/repository review clean; BLOCKED on required user browser/manual acceptance**

## Confirmed

- `main` remains at the original merge base `6a8266bbbca2cc511d54be75c1c9d28710a82eab`; the feature branch is ahead-only and retains the expected Spec 046 frontend/documentation/versioning scope.
- R1/R2 repository-closure findings remain resolved.
- The user's first final browser pass produced R3–R9.
- R3's amended `All series` semantics are now implemented: per-series appearance controls aggregate effective concrete values, show Mixed/indeterminate when heterogeneous, and explicit bulk patches homogenize the current concrete set in one action.
- The R3 linked-secondary follow-up is resolved: `All series` keeps Colour actionable even when linked secondary traces exist; because all present primaries are also in the all-series target, the chosen colour resolves across primaries and linked secondaries while link semantics remain enabled. Ordinary arbitrary multi-selection keeps the existing linked-colour fail-safe.
- R4's palette-preview implementation was changed at the SVG/CSS theme-colour boundary. No further repository defect is proven, but the original blank runtime result requires user browser confirmation in light/dark mode.
- R5 Shift selection now uses bounded range logic, suppresses row text selection, prevents Shift native context behavior and keeps Shift pointer-down out of row-body drag activation.
- R6 bulk legend membership is one indeterminate-capable `Show in legend` checkbox.
- R7 row-body pointer reordering is available under the existing activation threshold while checkbox/eye/handle interactions remain isolated; handle and keyboard reorder remain.
- R8 now uses explicit labelled-field wrappers for Open in both single and bulk marker rows, putting the switch/checkbox on the same second-row control geometry as Symbol/Size without restoring a magic top margin.
- R9 adds a subtle non-focusable divider before `Palettes · Global`.
- The supported family builders, legendrank behavior, detached legend preview, preview-only eye semantics, palette/order composition and saved/export presentation state remain unchanged by these acceptance fixes.

## Verification record

### Implementer-reported — initial R3–R9 fix pass (`269f6f56…`)

- focused frontend tests: PASS — 74 tests across seriesStyling / legendPreview / plotStylePalette / plotStylePresets.
- TypeScript: PASS.
- Vite build: PASS.
- `git diff --check`: PASS.
- canonical preflight: PASS — 4/4 stages, 127 backend/frontend modules.
- Manual/browser checks: NOT RUN by implementer.

### Implementer-reported — R3/R8 follow-up (`9c9c87ea…`)

- `node --test frontend\\tests\\seriesStyling.test.ts`: PASS — 55 tests.
- TypeScript: PASS.
- Vite build: PASS.
- `git diff --check`: PASS.
- canonical preflight: PASS — 4/4 stages, 127 backend/frontend modules.
- Manual/browser checks: NOT RUN by implementer.

### Reviewer-independent

I independently inspected:

- both user-acceptance fix diffs;
- current `SeriesStyleModal.tsx` aggregate colour, marker-field geometry, selection/drag, legend, palette-preview and tab-separator wiring;
- `sharedValue(...)`, `seriesSelectionRange(...)`, linked-secondary resolution behavior and focused tests;
- current Parent 046 / 046.1 amended wording;
- the cumulative branch scope and live `main` merge base.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

### R3 — Medium: `All series` must aggregate effective appearance and homogenize mixed concrete series

**Resolution: RESOLVED across `269f6f56a5f6430f106a2875a5a964440f06efa3` and `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`.**

The first fix introduced effective aggregation and explicit all-series homogenization. The follow-up keeps all-series Colour enabled in the linked-secondary case and adds focused primary/linked-secondary mixed-colour coverage. Link semantics remain active and arbitrary multi-selection retains the previous fail-safe gate.

### R4 — Medium: Palette preview renders as blank white space

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

The implementation now routes theme-dependent SVG chrome colours through CSS style properties. The original defect was observed only in the real browser, so it cannot be finally accepted until the user confirms the preview visibly renders and updates in light/dark mode.

### R5 — Medium: Shift-click range selection is unreliable and leaks into browser-native behavior

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

Range selection is now bounded by a pure helper; row text is non-selectable; Shift click/context defaults are suppressed; Shift pointer-down does not initiate drag.

### R6 — Low: Multi-selection exposes redundant legend controls

**Resolution: RESOLVED in `269f6f56a5f6430f106a2875a5a964440f06efa3`.**

One tri-state checkbox now represents shown / hidden / mixed membership.

### R7 — Low: Reordering depends on hitting the drag handle

**Resolution state: CODE REVIEW CLEAN; USER BROWSER RECHECK REQUIRED.**

The non-interactive row body now forwards pointer drag activation with the thresholded sensor while descendants remain isolated.

### R8 — Low: `Open` marker control is vertically misaligned

**Resolution: RESOLVED in `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`.**

Single and bulk Open controls now use an explicit top label plus a second-row switch/checkbox, matching the two-row form geometry of Symbol/Size without hard-coded vertical offsets.

### R9 — Low: `Palettes · Global` needs stronger separation

**Resolution: RESOLVED in `269f6f56a5f6430f106a2875a5a964440f06efa3`.**

A restrained `aria-hidden` divider now separates Series/Rules from the global Palettes tab.

## External acceptance still pending

The user must rerun the affected browser checks, especially:

- R3 All-series Mixed state and one-action homogenization, including linked-secondary colour behavior;
- R4 palette preview visible/updating in light and dark mode;
- R5 repeated Shift-click with no native text/context leakage;
- R6 tri-state legend membership;
- R7 row-body drag versus ordinary/Ctrl/Shift selection;
- R8 Open alignment;
- R9 Palettes divider.

The rest of the Parent 046 cumulative 33-item manual/browser matrix must then be continued/completed. No implementer work is pending unless that browser pass exposes another concrete defect.

## Decision

**BLOCKED ON REQUIRED USER BROWSER/MANUAL ACCEPTANCE — code and repository review are clean at `9c9c87ea18dae2efcc0b12050f15ec0f468057fa`, but Parent 046 is not merge-ready until the user reruns the affected acceptance checks and completes the remaining cumulative matrix.**
