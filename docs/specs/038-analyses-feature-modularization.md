# 038 — Analyses feature modularization

**Status:** In progress — 038.1 and 038.2 implemented and review-clean; 038.3 active
**Implementation:** Implement only through the sequential child specifications listed below.
**Repository:** `mattiafelice-palermo/cellxplorer`
**Authoring baseline:** `main` and `origin/main` at `b6452a4d6691ef1f9b6acf3e353a6f05a5873ed7`
**Merge base:** `b6452a4d6691ef1f9b6acf3e353a6f05a5873ed7`
**Shared branch:** `feature/analyses-feature-modularization`
**Depends on:** None. The implementation must preserve every analysis behavior present on the current `main` when each child starts.
**Parent review:** None. The parent closes through the eight child reviews and the final integration matrix.

All UI work inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).
Every child must also read
[`../agent-knowledge/architecture.md`](../agent-knowledge/architecture.md),
[`../agent-knowledge/state-and-performance.md`](../agent-knowledge/state-and-performance.md), and
[`../agent-knowledge/change-playbooks.md`](../agent-knowledge/change-playbooks.md).
Children that touch saved artifacts or portable reports must additionally read
[`../portable-analysis-html.md`](../portable-analysis-html.md).

## Why this is a parent specification

The frontend analyses domain is already partly modular, but its physical organization and its
dependency direction are inconsistent:

- analysis-owned files are spread across `pages/`, `components/`, and the root of `frontend/src/`;
- `frontend/src/pages/AnalysisPage.tsx` is 10,700 physical lines and is simultaneously a route,
  editor controller, Cycles implementation, Time/Capacity implementation, plotting library,
  saved-artifact renderer, and portable-report workflow;
- Steps, DCIR, Chargeability, and Rate Capability are standalone cards, while Cycles and
  Time/Capacity remain embedded in the page;
- several family cards import shared helpers from `AnalysisPage.tsx`, even though that page imports
  those cards, creating a page-as-library circular dependency;
- the Analysis Database, open-analysis workspace, and individual analysis editor belong to one
  product domain but have no common folder;
- saved-plot previews, background warmup, and portable export are mixed into the live editor.

This is too much risk for one implementation checkpoint. The parent locks the final ownership
model and behavior-preservation rules. Each child moves or extracts one coherent boundary and is
reviewed before the next begins.

This specification is about **frontend ownership and dependency direction**. It is not a redesign
of scientific calculations, analysis data shapes, plotting UX, or the backend service layout.

## Plain-language model of the domain

| Concept | Meaning in CellXplorer | Target owner |
|---|---|---|
| Analysis | Durable title, shared sample set, calculation choices, presentation choices, saved plots, and provenance | Backend persistence plus `features/analyses/editor/` |
| Analysis Database | The collection screen that creates, opens, imports, filters, and deletes analyses | `features/analyses/database/` |
| Workspace | The app-level tab and keep-mounted system for several open analyses | `features/analyses/workspace/` |
| Editor | The screen that edits one analysis recipe; it never edits raw Neware data | `features/analyses/editor/AnalysisEditor.tsx` |
| Analysis family | One scientific view: Cycles, Time/Capacity, Steps, DCIR, Chargeability, or Rate Capability | `features/analyses/editor/families/` |
| Saved plot | A persisted view recipe within an analysis, not a copy of raw/scientific data | Editor policies plus `editor/artifacts/` |
| Draft plot | A session-only unsaved view that must never enter backend artifact or portable endpoints | `editor/artifacts/DraftPlotCard.tsx` plus editor state |
| Result | Backend-returned numerical arrays with family-specific scientific meaning | Backend services; temporarily cached by React Query |
| Artifact | Regenerable Plotly figure, SVG, thumbnail, or 4:3 hover preview derived from a saved plot | `editor/artifacts/` |
| Portable report | Versioned standalone HTML package made from saved plots and optional original sources | Frontend flow under `editor/portable/`; package correctness remains backend-owned |

The frontend edits a recipe, requests a result, and renders it. Python remains authoritative for
the scientific meaning and numerical calculation.

## Current verified implementation

The baseline contains 37 directly analysis-owned frontend files, totaling 28,316 physical lines.
The important current anchors are:

- `frontend/src/pages/AnalysesIndexPage.tsx`
  - `PortableFolderTree`
  - `AnalysisCreateForm`
  - exported `AnalysesIndexPage`
- `frontend/src/pages/AnalysisPage.tsx`
  - shared helpers beginning around `useDelayedFlag`, `plotAxisStyle`, `tracesToColumns`,
    `resolveExportPlan`, `PlotHeader`, and `usePlotSizeSync`;
  - Cycles blocks `CycleSettings`, `tracesForResult`, `cyclePlotLayout`, and `CyclePlotCard`;
  - Time/Capacity blocks `TimeCapacitySettings`, `tracesForTimeCapacity`, `timeCapacityLayout`, and
    `TimeCapacityPlotCardView`;
  - saved-artifact blocks `SavedPlotPreview`, `SavedTimeCapacityPreview`,
    `AnalysisCacheWarmupRenderer`, `CachedSavedPlotPreview`, `TabDraftPlotCard`, and
    `SavedPlotsPanel`;
  - portable blocks from `PortablePlotSnapshot` and `buildPortablePlotSnapshots` through the
    portable estimate/preflight/export state and two portable modals;
  - page controller `AnalysisPageView`, exported as memoized `AnalysisPage`.
- existing family cards:
  - `frontend/src/components/StepsPlotCard.tsx`;
  - `frontend/src/components/DcirPlotCard.tsx`;
  - `frontend/src/components/ChargeabilityPlotCard.tsx`;
  - `frontend/src/components/RateCapabilityPlotCard.tsx`.
- existing database, workspace, plotting, protocol, policy, recognition, and warmup modules listed
  explicitly in the child specifications.

Current circular dependency evidence is grep-able through imports from
`../pages/AnalysisPage` in the four existing family cards and the import of
`AnalysisCacheWarmupRenderer` from that page in `CacheWarmupCoordinator.tsx`.

There are also two visibility implementations:

- the context-aware `frontend/src/analysisVisibility.ts`;
- the simpler `isCellHiddenInAnalysis`, `isAnalysisSegmentHidden`, and `isSeriesHidden` exports in
  `AnalysisPage.tsx`.

These must become one policy, not continue to give different families separate interpretations of
the same saved analysis state.

## Locked target tree

The completed feature must have this ownership structure. The two files under `pages/` remain only
as route adapters. The 49 target entries consist of 35 existing files moved into the feature, 12
coherent extractions from large page files, and 2 thin route wrappers.

```text
frontend/src/
├── pages/
│   ├── AnalysesIndexPage.tsx
│   └── AnalysisPage.tsx
│
└── features/
    └── analyses/
        ├── database/
        │   ├── AnalysesIndexView.tsx
        │   ├── AnalysisDatabaseTable.tsx
        │   ├── AnalysisPlotSummary.tsx
        │   └── AnalysisSamplePreviewModal.tsx
        │
        ├── workspace/
        │   ├── AnalysisWorkspaceTabs.tsx
        │   ├── AnalysisWorkspaceContent.tsx
        │   ├── analysisWorkspace.ts
        │   └── analysisQueryCache.ts
        │
        └── editor/
            ├── AnalysisEditor.tsx
            │
            ├── families/
            │   ├── cycles/
            │   │   ├── CyclePlotCard.tsx
            │   │   └── diagnosticCycles.ts
            │   ├── time-capacity/
            │   │   └── TimeCapacityPlotCard.tsx
            │   ├── steps/
            │   │   └── StepsPlotCard.tsx
            │   ├── dcir/
            │   │   └── DcirPlotCard.tsx
            │   ├── chargeability/
            │   │   └── ChargeabilityPlotCard.tsx
            │   └── rate-capability/
            │       └── RateCapabilityPlotCard.tsx
            │
            ├── plotting/
            │   ├── plotStyle.ts
            │   ├── seriesStyling.ts
            │   ├── paletteDraft.ts
            │   ├── plotAxisLayout.ts
            │   ├── plotExplainers.ts
            │   ├── plotStylePresets.ts
            │   ├── sourceChainPlot.ts
            │   ├── PlotStylePanel.tsx
            │   ├── SeriesStyleModal.tsx
            │   ├── PlotHeader.tsx
            │   ├── plotLayout.ts
            │   ├── plotExport.ts
            │   └── plotRuntime.ts
            │
            ├── protocol/
            │   ├── ProtocolSegmentsPanel.tsx
            │   ├── ProtocolStructureViewer.tsx
            │   ├── protocolGroupNormalization.ts
            │   ├── protocolStepFilters.ts
            │   └── protocolStepNeighbours.ts
            │
            ├── recognition/
            │   ├── RecognitionProgress.tsx
            │   └── recognitionProgress.ts
            │
            ├── policies/
            │   ├── analysisDraftPolicy.ts
            │   ├── analysisPlotPolicy.ts
            │   ├── analysisVisibility.ts
            │   └── multiSourceAnalysisPolicy.ts
            │
            ├── artifacts/
            │   ├── DraftPlotCard.tsx
            │   ├── SavedPlotsPanel.tsx
            │   ├── SavedPlotPreviews.tsx
            │   ├── AnalysisCacheWarmupRenderer.tsx
            │   ├── CacheWarmupCoordinator.tsx
            │   └── warmupCompletion.ts
            │
            └── portable/
                └── PortableReportFlow.tsx
```

No broad barrel file is required. Prefer explicit imports from the owning module. A small local
index may be introduced only when it removes repeated public imports without hiding ownership; it
must not recreate `AnalysisPage.tsx` as a compatibility library.

## Locked ownership and dependency rules

### 1. This is a behavior-preserving refactor

The final application must preserve:

- the routes and query-parameter deep links for Analysis Database and opened analyses;
- analysis loading, normalization, editing, autosave, explicit save, duplicate, filing, and delete;
- workspace tabs, keep-mounted/unmount policy, dirty-state prompts, and update/restart guards;
- every family request, query key, loading/error/empty state, settings control, trace, layout,
  visibility rule, export action, style editor, and plot interaction;
- saved-plot open/update/copy/delete/new-draft transitions;
- saved thumbnail, hover preview, full artifact, warmup, stale-generation, and retry behavior;
- portable estimate, plot selection, source preflight/update, download/share, progress, and error
  recovery;
- light/dark application chrome and the independent light Plotly presentation.

Do not use the refactor to rename user-facing labels, reorder controls, change defaults, simplify
error handling, or adjust visual geometry.

### 2. Pages are one-way route adapters

At completion:

- `pages/AnalysesIndexPage.tsx` translates route/search intent and renders
  `AnalysesIndexView`;
- `pages/AnalysisPage.tsx` translates route/override props and renders `AnalysisEditor`;
- no module under `features/analyses/` imports either page;
- pages do not export plotting, visibility, artifact, or family helpers.

Temporary compatibility imports are allowed only inside the child that needs them and must be
removed before that child or an explicitly named later child closes. Child 038.8 removes every
remaining feature-to-page dependency.

### 3. The complete analyses domain has one home

The Analysis Database and individual editor are not peer products. They are collection and detail
screens for the same Analysis record. Workspace is the application lifetime layer between them.

Cross-feature use remains valid when ownership is clear:

- `ProjectsPage.tsx` imports `AnalysisPlotSummary` from the analyses feature;
- app shell/update/settings code imports workspace state from the analyses feature;
- the analyses editor may continue importing generic `Plot`, debounced inputs, filename helpers,
  download helpers, navigation events, and cell-owned popovers from their existing shared owners.

Do not move `frontend/src/api.ts`, generic shared controls, download infrastructure, or cell-owned
components into the analyses feature merely because the editor uses them.

### 4. Family modules own scientific-view adaptation, not scientific calculation

Each family card owns:

- its family-specific settings UI;
- its family-specific React Query request;
- conversion of the backend result into canonical Plotly traces and layout;
- its live plot surface, style panel, and ordinary image/data exports;
- exported builders needed by saved previews, artifacts, and portable figures.

Backend services remain authoritative for formulas, protocol recognition, source stitching,
selection resolution, units, provenance, and numerical results.

The observation grain remains distinct:

| Family | One plotted point represents | Backend endpoint |
|---|---|---|
| Cycles | One completed cycle | `/api/analyses/{id}/compute` |
| Time/Capacity | One raw measurement record | `/api/analyses/{id}/time-capacity` |
| Steps | One occurrence of a selected protocol-step block | `/api/analyses/{id}/steps` |
| DCIR | One valid rest/pulse occurrence | `/api/analyses/{id}/dcir-protocols` and `/dcir` |
| Chargeability | A point along a matched controlled-charge event curve | `/api/analyses/{id}/chargeability` |
| Rate Capability | One validated programmed rate condition | `/api/analyses/{id}/rate-capability` |

Do not create a common compiler that assumes raw points, cycles, step occurrences, pulses, and rate
conditions can be aligned simply because all have numeric X values.

### 5. Shared plotting owns presentation only

`editor/plotting/` owns persisted plot-style normalization, series-style resolution, palettes,
axis/legend/layout helpers, PlotHeader, export encoding, runtime/zoom/size helpers, and style-editor
UI. It must not decide which measurements are scientifically valid or which event populations are
aligned.

Live plots, saved previews, thumbnails, SVG fallback, portable figures, and CSV/XLSX exports must
continue to use the same family trace/layout builders and final visibility state.

### 6. One visibility policy

`editor/policies/analysisVisibility.ts` is the only owner of:

- context-aware cell hiding;
- whole-segment hiding;
- individual-series hiding.

Preserve the current context-aware rule: a cell-level series shared by several selection
occurrences is hidden only when all relevant occurrences are hidden. When a family result does not
provide context metadata, preserve the legacy fallback used by that family. Hiding remains a
display decision; it must not silently change backend calculation scope.

### 7. Saved artifacts and portable reports remain separate

Artifacts are regenerable visual derivatives of saved plots. Portable reports are user-requested,
versioned packages that consume canonical artifacts and may include original sources.

- `editor/artifacts/` owns lookup, generation, storage, previews, thumbnails, and warmup.
- `editor/portable/PortableReportFlow.tsx` owns the user-facing export/share workflow.
- `backend/app/services/portable_analysis.py` continues to own package structure, checksums,
  source handling, and safe import.

Draft plots remain session-only and must never enter saved-artifact or portable endpoints.

### 8. Cohesion matters more than line count

This feature is not a campaign to force every file below an arbitrary size. The first
`AnalysisEditor.tsx` may retain local pieces such as the sample sidebar, Add Samples modal, recap
table, and analysis settings panel. Existing 1,000–2,800-line cohesive cards/editors may remain
intact. Split only the named ownership boundaries in this package.

### 9. Sequential, reviewable migration

- All children use the one shared branch `feature/analyses-feature-modularization`.
- Implement children in numeric order.
- Each child receives one focused implementation commit and pushed review checkpoint.
- Resolve blocking findings in `docs/specs/reviews/038.S-...-review.md` before starting the next
  child.
- Do not merge the branch to `main` between children.
- Do not combine unrelated cleanup, product changes, or backend decomposition with any child.

## API, data, cache, and migration consequences

This parent deliberately requires **none** of the following:

- no SQLite schema or migration change;
- no API route or request/response shape change;
- no analysis specification normalization change;
- no query-key rename or React Query cache-lifetime change;
- no backend cache-key, result-schema, provenance, or invalidation change;
- no `CALC_VERSION` bump;
- no saved-plot artifact signature or renderer-version bump merely because code moved;
- no local-storage key or workspace event-name change;
- no dependency addition;
- no portable HTML format change.

`SAVED_PLOT_THUMBNAIL_RENDER_VERSION` must remain unchanged unless review proves that the rendered
output actually changed. Such a change would contradict this parent and must stop for an explicit
amendment rather than being silently accepted as part of the move.

## Child specifications and dependency graph

| Child | Purpose | Depends on |
|---|---|---|
| [038.1](038.1-shared-plotting-and-visibility-foundation.md) | Create the shared plotting home, extract page helpers, and unify visibility | Parent |
| [038.2](038.2-analysis-database-and-workspace-organization.md) | Organize the Analysis Database and workspace; make the index route thin | 038.1 |
| [038.3](038.3-existing-editor-module-organization.md) | Move the already-separated families, protocol, recognition, policies, and diagnostic logic | 038.1, 038.2 |
| [038.4](038.4-cycles-family-extraction.md) | Extract Cycles as a complete family vertical slice | 038.1–038.3 |
| [038.5](038.5-time-capacity-family-extraction.md) | Extract Time/Capacity as a complete family vertical slice | 038.1–038.4 |
| [038.6](038.6-saved-plot-artifacts-extraction.md) | Extract saved previews/artifacts and move background warmup | 038.1–038.5 |
| [038.7](038.7-portable-report-flow-extraction.md) | Extract portable estimate/preflight/export/share orchestration | 038.1–038.6 |
| [038.8](038.8-analysis-editor-integration.md) | Extract `AnalysisEditor`, make `AnalysisPage` thin, remove compatibility paths, and verify the final tree | 038.1–038.7 |

## Parent-level out of scope

- Backend decomposition into `services/analysis/` family modules.
- Scientific formula, unit, aggregation, recognition, or provenance changes.
- A shared stacked-figure compiler or the future Top/Main/Bottom shared-X design.
- New analysis families, plot types, settings, or export formats.
- Redesign of the Analysis Database, editor, style modal, protocol panel, or workspace tabs.
- A general repository-wide migration of Cell Database, Projects, Imports, or Settings into
  feature folders.
- Renaming public analysis terms or changing route URLs.
- Splitting every large component or introducing a new state-management library.

## Parent-level acceptance

- The locked target tree exists and all 49 entries have the stated owner.
- The two route files are small route adapters; neither is a helper library.
- No module under `features/analyses/` imports from `pages/`.
- `AnalysisPage.tsx` no longer contains family, plot-builder, artifact, or portable-report code.
- Cycles and Time/Capacity are structurally equivalent to the four existing standalone families.
- Every family imports shared plotting and visibility functions from their feature owners.
- There is exactly one cell/segment/series visibility implementation.
- Live, saved, thumbnail, warmup, portable, and data-export paths use canonical family builders.
- Draft/autosave/workspace behavior is unchanged.
- All current endpoints, query keys, stored spec shapes, artifact signatures, event names, and
  local-storage keys are unchanged.
- No scientific/backend file changes are needed to make the frontend compile.
- `AGENTS.md`, the durable architecture knowledge, test path contracts, and this spec index match
  the final paths.

## Final verification and closure

Each child defines focused checks. After 038.8 and all child reviews are clean, run from the
repository root on the integrated branch:

```powershell
python -m unittest tests.test_app_channels -v
node --test frontend\tests\*.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py --no-cache
```

Final structural checks must also confirm:

```powershell
rg "pages/AnalysisPage|pages/AnalysesIndexPage" frontend/src/features/analyses
rg "from .*AnalysisPage" frontend/src
rg "isCellHiddenInAnalysis|isAnalysisSegmentHidden|isSeriesHidden" frontend/src/pages
```

The first two commands must return no feature-to-page/helper imports. The final command must return
no page-owned visibility implementation. A route wrapper importing `AnalysisEditor` is expected;
an analysis feature importing a route is not.

Use a disposable application data root for manual checks. Do not use the user's real CellXplorer
database. Unless the user separately authorizes browser automation, record the following matrix as
manual/not run rather than claiming it passed:

- Analysis Database create, import, open, duplicate, delete, and folder behavior;
- workspace open/switch/close/reopen with both memory policies and dirty prompts;
- all six family live plots, settings, visibility, style editor, image/data export, and saved plots;
- thumbnail lookup/generation, 4:3 hover preview, idle warmup, and failed warmup recovery;
- linked and self-contained portable export, source-change preflight, save/share, and re-import;
- light/dark chrome, keyboard access, loading/error/empty states, and compact layout.

The parent closes only when every child has an implementation record and clean review, every
focused commit is pushed on the shared branch, the final no-cache matrix is recorded exactly, and
there is no undocumented deviation from the locked decisions above.
