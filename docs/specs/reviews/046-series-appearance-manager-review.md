# Review 046 — Series appearance manager

Specification: [`../046-series-appearance-manager.md`](../046-series-appearance-manager.md)  
Branch: `feature/series-appearance-manager`  
Merge base: `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`  
Final-child review-clean checkpoint: `1096c744d878bfc495be3ab9aefbf332b261e877`  
Status: **Changes required**

## Confirmed

- The feature branch remains based directly on `main` at `6a8266bbbca2cc511d54be75c1c9d28710a82eab`, is ahead only, and contains no unrelated backend, parser, migration, cache, or scientific-calculation changes.
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

Manual/browser acceptance: **NOT RUN**. The active 046.3 specification contains 33 cumulative manual/browser checks. Earlier coordination messages summarized these as items 1–32; the specification itself is authoritative and includes item 33 for icon-only accessible labels/tooltips.

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
- current repository lifecycle, versioning and release guidance.

I did **not** independently execute test/build/preflight commands or browser/manual checks.

## Findings

### R1 — Medium: Completed user-facing feature has no required version/changelog closure

Affected files:

- `backend/app/config.py`
- `package.json`
- `package-lock.json`
- `frontend/package.json`
- `frontend/package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `CHANGELOG.md`

**Current**

The branch still carries application version `0.23.0-beta.1`, and the changelog has no Parent 046 entry. Current `AGENTS.md` requires completed user-facing work to update every maintained version declaration and `CHANGELOG.md`; backward-compatible features use a minor increment.

**Target**

Close the feature using the repository version helper with a synchronized minor Beta increment from `0.23.0-beta.1` to `0.24.0-beta.1`, and prepend a concise user-facing `New features` changelog entry describing the Series appearance manager additions. Do not tag or publish a release as part of this review fix.

**Acceptance criteria**

- Every maintained version declaration is `0.24.0-beta.1`.
- `CHANGELOG.md` has a `0.24.0-beta.1` section describing the user-facing Series appearance manager functionality without claiming unrun manual verification.
- `python scripts\\check_versions.py --expected-version 0.24.0-beta.1` passes.
- Canonical `python scripts\\preflight.py` is rerun after the version change and passes.

### R2 — Low: Spec lifecycle/status documentation still describes Parent 046 as unimplemented

Affected files:

- `docs/specs/046-series-appearance-manager.md`
- `docs/specs/046.1-series-selection-and-bulk-editing.md`
- `docs/specs/046.2-series-ordering-and-legend-order.md`
- `docs/specs/046.3-detached-legend-preview-and-integration.md`
- `docs/specs/README.md`

**Current**

The parent and all three children still say `Status: Plan`, and `docs/specs/README.md` does not list Spec 046 at all. That conflicts with the live implementation and clean child reviews and fails the final-review documentation/status closure requirement.

**Target**

Make current lifecycle documentation truthful without prematurely declaring the parent merge-ready: mark 046.1–046.3 implemented/review-clean, mark the parent implementation complete with final acceptance still pending the cumulative manual/browser matrix, and add Parent 046 plus its children to the spec index with the same state.

**Acceptance criteria**

- 046.1, 046.2 and 046.3 no longer say `Plan`; each records implemented/review-clean state.
- Parent 046 no longer says `Plan`; it records implementation complete while final merge readiness remains pending the required manual/browser acceptance evidence.
- `docs/specs/README.md` lists Parent 046 and all three children with status consistent with the spec files.
- No document claims any of the 33 manual/browser checks passed unless evidence is actually supplied.

## External acceptance still pending

The 33-item cumulative browser/manual matrix in 046.3 is required acceptance evidence and is currently **NOT RUN**. This is not an implementer finding because it was explicitly deferred for final user validation. After R1–R2 are resolved, if that evidence is still unavailable, the workflow must be placed in `BLOCKED` rather than marked complete or merge-ready.

## Decision

**CHANGES REQUIRED — fix only R1–R2, then return to the cumulative Parent 046 review. Do not modify the already review-clean feature implementation.**
