# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Closure-fix commit: `f3471eedb39d33396d98c582369cb971ed869a52`  
Status: **Code/repository review clean; BLOCKED on required manual/browser acceptance**

## Confirmed

- The feature branch remains based directly on `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`, is ahead only, and contains no unrelated parser, migration, cache, or scientific-calculation changes.
- 046.1, 046.2 and 046.3 each completed an independent child review and all child findings are resolved.
- Concrete selection retains the locked plain/Ctrl/Cmd/Shift, row-checkbox and quantity-tristate semantics; deliberate selection routes back to the Series tab, while preview-eye, collapse, drag and Palette interactions remain separate.
- `ALL_SERIES_KEY` remains a base-style editor rather than an alias for selecting all concrete rows.
- Multi-selection resolves mixed values from effective styles and writes bulk changes through the existing explicit `SeriesStyleOverride` layer. Legend naming remains single-series only; bulk legend membership and Reset selected preserve the intended scope.
- Preview-only visibility remains local modal state and is not persisted as legend membership.
- `series_order` is additive `PlotStyle` presentation state. Stored known keys are normalized safely, quantity-group order is fixed, cross-group moves are rejected, and palette-slot identity is not derived from reordered rows.
- The supported Cycles, Time/Capacity, Steps, DCIR, Chargeability and Rate capability builders propagate deterministic `legendrank` values without reordering scientific trace arrays.
- The main scientific preview remains fixed at its existing geometry and explicitly legend-free.
- The detached legend is derived from the real unhidden family-specific Plotly preview, filters `showlegend: false` helper traces, preserves effective name/style/group/rank presentation, and strips scientific positional/customdata payloads before the second Plotly instance.
- The final legend-preview fix is compatible with the bundled Plotly 2.35.3 runtime: empty positional arrays suppress curve drawing, normal trace visibility avoids the `legendonly` muted style, and disabling item/double-click while leaving Plotly otherwise interactive permits its bounded internal legend scrolling.
- The existing Palettes workflow remains intact; the only scope cue added to its tab is the restrained `Global` badge/title.
- Final repository closure is now present: all maintained version declarations are `0.24.0-beta.1`, `CHANGELOG.md` contains the Series appearance manager feature entry, all child specs are marked implemented/review-clean, Parent 046 truthfully records implementation complete with manual acceptance pending, and the spec index includes the complete 046 family.
- No durable architecture or project-context ownership boundary changes were introduced by Parent 046.

## Verification record

### Implementer-reported

046.1 final follow-up:

- `node --test frontend\\tests\\seriesStyling.test.ts`: PASS — 47 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS.

046.2 final follow-up:

- `node --test frontend\\tests\\seriesStyling.test.ts frontend\\tests\\plotStylePalette.test.ts frontend\\tests\\plotStylePresets.test.ts`: PASS — 66 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS — elevated rerun, 4/4 stages.

046.3 final follow-up:

- `node --test frontend\\tests\\legendPreview.test.ts frontend\\tests\\seriesStyling.test.ts frontend\\tests\\plotStylePalette.test.ts frontend\\tests\\plotStylePresets.test.ts`: PASS — 71 tests.
- `npx.cmd tsc --noEmit`: PASS.
- `npx.cmd vite build`: PASS.
- `python scripts\\preflight.py`: PASS — elevated, 4/4 stages, 127 backend/frontend modules.

Parent closure follow-up:

- `python scripts\\check_versions.py --expected-version 0.24.0-beta.1`: PASS.
- `python scripts\\preflight.py`: PASS — 4/4 stages, 127 backend/frontend modules.
- `git diff --check`: PASS — exit 0; line-ending notices only.
- Manual/browser checks: NOT RUN — cumulative 33-item matrix explicitly deferred for final user validation.

### Reviewer-independent

I independently inspected:

- the complete cumulative branch scope against the original merge base;
- all three final child review records and their resolved findings;
- selection, pruning, bulk editing, effective mixed values, legend-membership and Reset wiring in `SeriesStyleModal.tsx`;
- group-local ordering, `legendrank`, palette-slot and linked-secondary helpers in `seriesStyling.ts`;
- palette/order composition and local draft/flush behavior;
- fixed scientific-preview versus unhidden detached-legend preview construction;
- `legendPreview.ts`, including trace membership, style/rank copying, bounded geometry, payload stripping and passive interaction configuration;
- representative family-builder legend-rank propagation across the six supported Series-appearance families;
- Plotly.js 2.35.3 legend-data, click-handling and zero-length plotting behavior relevant to the detached preview;
- current repository lifecycle/versioning guidance;
- the Parent-review R1/R2 closure diff at `f3471eedb39d33396d98c582369cb971ed869a52`.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

All maintained declarations now use `0.24.0-beta.1`, `CHANGELOG.md` has a concise `New features` entry for the Series appearance manager, and the implementer reports both the exact version-consistency command and canonical preflight passing after the change. No release tag or publishing work was added.

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

**Resolution: RESOLVED in `f3471eedb39d33396d98c582369cb971ed869a52`.**

046.1–046.3 now record `Implemented — review-clean`; Parent 046 records implementation complete with final acceptance pending the cumulative manual/browser matrix; and `docs/specs/README.md` lists Parent 046 and all three children with the same truthful state. The documentation does not claim the unrun manual matrix passed.

## External acceptance still pending

The active 046.3 specification contains **33 required cumulative browser/manual checks** covering selection/bulk editing, ordering, detached-legend behavior, palette regression, dark/light theme behavior, keyboard interaction and icon-only accessibility. They remain **NOT RUN**.

This is not an implementer finding: the implementation and repository closure review are clean, and the remaining evidence requires the final user/browser validation that was explicitly deferred. Under the current reviewer workflow, unavailable required manual acceptance evidence must leave the feature `BLOCKED`, not `COMPLETE`.

## Decision

**BLOCKED ON REQUIRED MANUAL/BROWSER ACCEPTANCE — implementation review is clean, but the branch is not yet merge-ready. Resume FINAL_REVIEW after the 33-item matrix evidence is supplied.**
