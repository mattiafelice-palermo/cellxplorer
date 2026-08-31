# Spec 055 — Plot workflow polish

> Implementation branch base: `main` at `3714d3733c38a0a5ea1174b4b91f49df356e64ac` (2026-08-31), after Spec 054 closure.
> Branch: `feature/plot-workflow-polish`.
> Re-verify anchors against the live implementation branch before coding.

## Status

Parent specification. **Do not implement this file directly.** Implement its numeric children in order.

## Goal

Remove three small but high-friction inconsistencies in analysis plot workflows:

1. exporting a plot image must not make the plot appear edited;
2. saved plots can be given meaningful names after creation, and those names are used consistently;
3. users can explicitly isolate one plotted series and restore all series without relying on Plotly's double-click legend behavior.

These are grouped because all three concern the distinction between:

- persistent saved-plot configuration;
- transient plot interaction;
- export-only behavior.

The central invariant is that only intentional persistent plot changes should mark a saved plot as edited.

## Locked decisions

- Saved-plot dirty state continues to be derived from the persisted-view signature rather than from arbitrary UI events.
- Export is an output action, not an edit.
- Renaming a saved plot is a persistent metadata edit.
- "Show only this series" is an application-controlled visibility action.
- Plotly legend double-click isolation must be disabled so it cannot compete with the application interaction.
- Ordinary single-click legend behavior may remain only if it is compatible with the app's persisted visibility semantics; the child spec defines the exact requirement.
- Existing saved-plot IDs remain stable when renaming.
- No database migration is expected: saved plots currently live inside the analysis spec JSON. If live implementation has changed by coding time, re-evaluate rather than forcing this assumption.
- Avoid broad refactoring of `AnalysisEditor.tsx`. Extract narrowly reusable plot-policy helpers when needed.
- Preserve saved-plot, autosave, draft, leave-prompt, and preview behavior.

## Current implementation context

Relevant anchors include:

- `frontend/src/features/analyses/editor/AnalysisEditor.tsx`
  - `activePlot`
  - `activePlotDirty`
  - `snapshotSignature(...)`
  - `updateActivePlot`
  - saved-plot open/save/delete workflow
- `frontend/src/features/analyses/editor/artifacts/SavedPlotsPanel.tsx`
- `frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx`
- `frontend/src/features/analyses/editor/policies/analysisDraftPolicy.ts`
- `frontend/src/features/analyses/editor/policies/analysisPlotPolicy.ts`
- `frontend/src/features/analyses/editor/policies/analysisVisibility.ts`
- `frontend/src/features/analyses/editor/plotting/plotExport.ts`
- `frontend/src/features/analyses/editor/plotting/plotRuntime.ts`
- `frontend/src/features/analyses/editor/plotting/seriesStyling.ts`
- `frontend/src/components/Plot.tsx`
- family plot cards under:
  - `families/time-capacity/`
  - `families/cycles/`
  - `families/steps/`
  - `families/dcir/`
  - `families/chargeability/`
  - `families/rate-capability/`

The live code already has family-level export handling; for example `CyclePlotCard.tsx` builds an export-only figure and uses Plotly `toImage`. Preserve that architectural direction.

## Child specifications

### 055.1 — Export without dirtying plot state

Ensure PNG/image export cannot alter the persistent plot signature or enable `Update`.

### 055.2 — Rename saved plots

Add a direct rename operation for existing saved plots and use the custom name consistently in saved-plot UI and export naming.

### 055.3 — Show-only series interaction

Add explicit application controls for series isolation/restoration and disable Plotly legend double-click isolation.

## Implementation order

1. 055.1 first because it establishes the boundary between transient/export state and persistent state.
2. 055.2 second because it changes saved metadata only.
3. 055.3 last because it touches persistent/transient visibility semantics and legend interaction.

## Parent acceptance criteria

- Exporting a plot cannot create a false dirty state.
- Saved plots can be renamed without changing their IDs.
- Custom names are visible wherever saved plots are identified and are used in export filenames where a saved plot name is the appropriate source.
- Users can isolate one series and restore all series using CellXplorer controls.
- Plotly legend double-click no longer independently isolates/restores traces.
- Draft/saved plot leave prompts remain correct.
- Saved plot previews remain correct.
- Canonical frontend/full preflight checks pass.

## Out of scope

- full redesign of plot cards;
- changing scientific calculations;
- new plot families;
- plot-folder/tag systems;
- bulk saved-plot rename;
- arbitrary saved-plot reordering;
- replacement of Plotly;
- redesign of all legend styling.
