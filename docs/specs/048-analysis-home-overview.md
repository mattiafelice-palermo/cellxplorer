# Spec 048 — Analysis home overview

Status: **Plan**  
Authoring repository: `mattiafelice-palermo/cellxplorer`  
Authoring baseline: `main` at `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Suggested implementation branch: `feature/analysis-home-overview`  
Review document: `docs/specs/reviews/048-analysis-home-overview-review.md`

> The implementation agent must re-check current `main`, the actual merge base, `AGENTS.md`,
> `docs/agent-knowledge/README.md`, `docs/agent-knowledge/state-and-performance.md`,
> `docs/agent-knowledge/visual-style-guide.md`, and `docs/specs/README.md` before starting. The
> live branch and current tests override this authoring snapshot.

## 1. Goal

Add a **Home** view to each opened analysis. Home is the default landing surface for a freshly
opened analysis and gives the user a compact overview of the saved plots already belonging to that
analysis.

The page should let the user understand, at a glance:

- how many saved plots the analysis contains;
- which analysis families contain saved plots;
- when the analysis was created and last modified;
- several representative saved plots from every analysis family;
- the most recently updated saved plots across the analysis.

From Home, the user can either:

- open an analysis family, or
- open one exact saved plot directly in its owning family.

Home is a **navigation and overview surface**, not a new scientific analysis family and not a second
saved-plot system.

## 2. User-approved page structure

The structural layout is locked from the approved mockup. Exact icons, colors, button treatments,
spacing, typography, empty states, and interaction details must follow the repository visual style
guide rather than the image-generation mockup.

The page, from top to bottom, is:

1. the existing analysis title/action row, unchanged;
2. the existing analysis-family tab row, with **Home** inserted first;
3. one row of compact summary cards;
4. a full-width grid of analysis-family cards;
5. a compact **Recently updated plots** table.

Home does **not** show the normal sample/settings sidebar, central live plot editor, or plot-style
sidebar.

## 3. Locked design and behavior decisions

### 3.1 Home is frontend workspace state, not an `AnalysisTabKey`

Do **not** add `"home"` to `ANALYSIS_TAB_KEYS` or to the persisted `AnalysisTabKey` type.

`AnalysisTabKey` is part of the saved-analysis/saved-plot domain and currently identifies actual
analysis families/settings. Home has no scientific computation, saved presentation state, plot
style, draft plot, export meaning, or backend result kind.

Keep the existing scientific `activeTab: AnalysisTabKey` semantics intact and introduce the
smallest frontend-only view discriminator needed to express whether the editor is showing Home or
the active scientific tab.

A suitable shape is conceptually:

```ts
type AnalysisEditorView = "home" | "analysis";
```

with `activeTab` still holding the current/last real `AnalysisTabKey`. Equivalent implementations
are acceptable if they preserve the same ownership boundary.

### 3.2 Fresh opens land on Home

When an analysis is freshly opened without an explicit deep link, Home is the initial view.

Session behavior:

- while an analysis remains mounted in the workspace, its current Home/family view should be
  restored from the existing session-only analysis workspace state;
- closing the analysis and opening it again from scratch lands on Home;
- Home itself is not written into the persisted analysis spec or backend database.

### 3.3 Existing deep links bypass Home

Existing URL/deep-link semantics are preserved:

- `?plot=<saved-plot-id>` opens that exact saved plot in its family;
- `?tab=<AnalysisTabKey>` opens that family;
- an explicit deep link wins over the default Home landing behavior.

### 3.4 Existing dirty-plot leave protection also applies to Home

Navigating from a dirty saved plot or an unsaved new plot to Home must use the same
save/discard/cancel flow already used when changing analysis families.

Home must never become a bypass around the current draft/saved-plot protection logic.

Required outcomes:

- **Save**: complete the existing save path, then show Home;
- **Discard**: discard through the existing policy, then show Home;
- **Cancel**: stay on the current plot and preserve the edit/draft exactly.

### 3.5 Home never starts scientific computation

Opening Home must not start Cycles, Time/Capacity, Steps, C-rate, Chargeability, DCIR, or Recap
computation merely to populate the page.

Home must not mount hidden live Plotly figures for the analysis families.

The existing `keepMounted={false}` behavior for scientific tabs is load-bearing and must remain.
When Home is active, the scientific family panel is unmounted.

### 3.6 Home thumbnails are cached-artifact previews only

The category cards use existing saved-plot thumbnail artifacts where available.

A Home thumbnail lookup may:

- perform the existing lightweight saved-thumbnail cache lookup;
- display a cached thumbnail;
- display a stable neutral placeholder on cache miss/error.

A Home thumbnail lookup must **not**:

- call a scientific compute endpoint;
- mount a live `Plot`/Plotly figure;
- synchronously generate a saved-plot artifact;
- start an unbounded thumbnail-generation queue.

Existing background warmup remains the owner of background cache preparation. Home may benefit
from thumbnails that warmup has already produced, but Home does not create a second warmup system.

### 3.7 Home is read-only with respect to saved plots

Home provides navigation only. It does not duplicate the edit/delete/save controls from the normal
`SavedPlotsPanel`.

There is no global **New plot** action on Home. New plot creation remains inside the relevant
analysis family, where the required family settings and draft lifecycle already exist.

### 3.8 Family set and ordering

Render every plot-producing analysis family in the same canonical order as the editor tabs:

1. Time / capacity (`time_capacity`)
2. Cycles (`cycles`)
3. Steps (`steps`)
4. C-rate (`crate`)
5. Chargeability (`chargeability`)
6. DCIR (`dcir`)
7. Recap (`recap`)

`settings` is not a plot category and is excluded from the family grid.

Do not hard-code the six categories visible in the mockup and accidentally omit Recap.

### 3.9 Category cards show up to four saved plots

Each category card contains:

- repository-standard Tabler icon and canonical family label;
- saved-plot count;
- up to **four** saved-plot thumbnails, chosen by `modified_at` descending;
- a compact family-navigation action such as **View all plots** / chevron;
- a clear zero-plot empty state when applicable.

For deterministic ties, preserve the existing `saved_plots` order (or use plot ID as a stable
secondary key). Do not randomize representative plots.

All seven family cards are shown even when some contain zero saved plots. The page therefore also
acts as an analysis-family navigator.

### 3.10 Recent section is “Recently updated”, not invented open history

Current `SavedAnalysisPlot` data contains `created_at` and `modified_at`; it does not contain a
persistent `last_opened_at`, `opened_by`, or user identity.

Therefore the bottom section is named **Recently updated plots**, not “Recently opened plots”. It
uses existing `SavedAnalysisPlot.modified_at` and does not invent authorship/open-history data.

Show up to five saved plots sorted by `modified_at` descending. The compact table contains:

- Plot — small cached thumbnail plus plot name;
- Category;
- Updated.

Clicking a row opens that exact saved plot through the existing saved-plot opening path.

### 3.11 Summary cards use existing analysis data

The four summary cards are:

- **Total plots** — count of `spec.saved_plots ?? []`;
- **Categories with plots** — number of plot-producing families with at least one saved plot;
- **Last updated** — the loaded analysis `modified_at`;
- **Created** — the loaded analysis `created_at`.

Do not show fake author names or “updated by” metadata.

### 3.12 Visual contract

The approved mockup defines composition, not a new visual language.

Implementation must follow `docs/agent-knowledge/visual-style-guide.md`:

- Mantine components and theme tokens first;
- Tabler icons only;
- quiet, compact, information-dense scientific UI;
- `Paper withBorder radius="md"`-style cards;
- theme-safe light/dark chrome;
- channel primary color for active/navigation emphasis;
- no decorative per-category rainbow palette;
- no gradients/glass/heavy shadows;
- full plot thumbnails remain white/publication-style in both light and dark chrome;
- icon-only controls have tooltip and accessible name;
- long plot names truncate safely and expose their full value;
- keyboard operation must not depend on hover.

## 4. Current implementation anchors

The implementation agent must inspect the live versions of these anchors before editing.

### `frontend/src/features/analyses/editor/AnalysisEditor.tsx`

Relevant anchors on the authoring baseline:

- `TAB_DEFS`
- `AnalysisTabHeader`
- `const [activeTab, setActiveTab]`
- the cold-open path using `resolveColdOpenWorkspace(...)`
- `activateAnalysisTabInternal`
- `activateAnalysisTab`
- `openSavedPlotDirect`
- `openSavedPlot`
- the render comment immediately above `keepMounted={false}`
- the family `<Tabs.Panel ...>` blocks

This component owns editor orchestration. Do not move scientific calculations into Home and do not
broadly refactor unrelated editor state.

### `frontend/src/features/analyses/workspace/analysisWorkspace.ts`

Relevant anchors:

- `AnalysisWorkspaceEditorState`
- `getAnalysisWorkspaceEditorState`
- `setAnalysisWorkspaceEditorState`
- `clearAnalysisWorkspaceEditorState`

This is the correct home for session-only view restoration. Home must not be persisted into
`AnalysisSpec`.

### `frontend/src/api.ts`

Relevant anchors:

- `ANALYSIS_TAB_KEYS`
- `AnalysisTabKey`
- `SavedAnalysisPlot`
- `AnalysisSummary`
- `AnalysisFull`
- `AnalysisSpec`

`ANALYSIS_TAB_KEYS` must remain domain-only; no `home` entry.

### `frontend/src/features/analyses/editor/artifacts/SavedPlotsPanel.tsx`

Relevant anchors:

- `visiblePlots`
- the saved-preview generation admission queue
- saved-card `onOpen(plot)` behavior
- `SavedPlotPreview`
- `SavedTimeCapacityPreview`

Reuse the current saved-plot opening semantics. Home does not replace this panel.

### `frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx`

Relevant anchors:

- `lookupPlotThumbnail`
- `SavedPlotPreview`
- `SavedTimeCapacityPreview`
- current cached artifact/thumbnail signatures

Home needs a cached-only thumbnail presentation path. Reuse the existing lookup/signature logic
rather than creating a second artifact format.

### Repository guidance

Read at minimum:

- `AGENTS.md`
- `docs/agent-knowledge/README.md`
- `docs/agent-knowledge/state-and-performance.md`
- `docs/agent-knowledge/visual-style-guide.md`
- `docs/specs/README.md`
- `docs/specs/038.6-saved-plot-artifacts-extraction.md`

## 5. Target frontend structure

Preferred new ownership:

```text
frontend/src/features/analyses/editor/
├── AnalysisEditor.tsx
├── home/
│   ├── AnalysisHome.tsx
│   └── analysisHomePolicy.ts        # optional; use only for pure grouping/sorting helpers
├── artifacts/
│   ├── SavedPlotPreviews.tsx
│   └── ...
└── ...
```

Do not add a `home/` directory merely to satisfy this tree if one component plus one small pure
helper is sufficient. Conversely, do not grow `AnalysisEditor.tsx` with the entire dashboard
markup. Extract the coherent Home surface.

## 6. Data flow

Home should be derivable from data already loaded for the analysis:

```text
AnalysisFull
  ├─ created_at / modified_at
  └─ data: AnalysisSpec
       └─ saved_plots: SavedAnalysisPlot[]
             ├─ id
             ├─ name
             ├─ tab
             ├─ modified_at
             └─ saved presentation/computation snapshot
```

Home groups/sorts this array in frontend presentation logic only.

No new list endpoint or per-card database query is required.

Thumbnail flow:

```text
saved plot
  ↓
existing thumbnail signature/payload helper
  ↓
existing thumbnail lookup endpoint
  ├─ hit → render cached image
  └─ miss/error → stable placeholder
```

There is no compute/generate branch from Home.

## 7. Parent/child implementation plan

Implement this parent through two sequential children on one feature branch.

### 048.1 — Analysis Home navigation and workspace state

File: `docs/specs/048.1-analysis-home-navigation-and-workspace.md`

Establish Home as a frontend-only editor view, default fresh-open behavior, workspace restoration,
deep-link precedence, dirty-plot leave protection, and conditional mounting behavior.

This child intentionally does not build the final dashboard; it may use a minimal placeholder Home
surface to verify navigation safely.

### 048.2 — Saved-plot dashboard and cached thumbnails

File: `docs/specs/048.2-analysis-home-saved-plot-dashboard.md`

Build the approved Home composition: summary cards, all family cards, cached-only thumbnails,
recently updated table, empty/loading/error states, responsive behavior, and navigation from the
cards to the exact family/plot.

This split keeps the risky editor state/draft lifecycle changes separate from the mostly
presentational dashboard work.

## 8. Cache, schema, API, and scientific consequences

### Database migration

**None.**

Do not add persistent Home state, recent-open history, user identity, or dashboard records.

### Backend/API

**No backend API change is expected.**

Use the existing analysis detail and saved-thumbnail lookup contracts. If implementation discovers
that a backend change is genuinely necessary, stop and record the reason before expanding scope.

### Scientific calculations

**None.**

No scientific formula, result schema, unit, or family computation changes.

### `CALC_VERSION`

**No bump.**

### Analysis/result schema versions

**No bump.**

### Saved artifact cache version

**No bump** unless the implementation changes the actual thumbnail rendering meaning/format. A
cached-only consumer of existing thumbnails does not justify invalidating artifacts.

## 9. Performance requirements

The Home page must remain cheap relative to opening an analysis family.

Required invariants:

- no family compute request on Home open;
- no live Plotly figure mounted for Home thumbnail tiles;
- no hidden scientific family panels mounted while Home is active;
- existing `keepMounted={false}` remains in force;
- thumbnail access is cache lookup only;
- no unbounded queue of work;
- no N+1 backend analysis-detail requests — use the already loaded `AnalysisFull`/`AnalysisSpec`;
- no layout shift caused by thumbnails appearing: reserve stable thumbnail geometry;
- thumbnail cache miss/error resolves to a stable placeholder rather than a permanent loader.

The implementation may lazily admit cached-thumbnail lookup by viewport/category if useful, but do
not introduce a complex scheduling subsystem unless measurement shows it is needed.

## 10. Loading, empty, and error behavior

### Analysis still loading

Use the existing editor-level loading behavior. Do not render fake zero counts while the analysis
request is unresolved.

### No saved plots anywhere

Show:

- Total plots = 0;
- Categories with plots = 0;
- all seven family cards;
- a compact per-card “No saved plots yet” state with a navigation action;
- a neutral Recently updated empty state.

The user must still be able to open any family.

### Thumbnail cache miss

Show a stable neutral preview placeholder within the reserved white thumbnail frame. It remains
clickable and the plot name is still accessible.

### Thumbnail lookup error

Treat it like an unavailable preview, not like analysis failure. Do not replace the entire Home page
with an error state.

## 11. Accessibility and interaction

- Home is reachable as the first item in the analysis tab order.
- Family cards and saved-plot thumbnails/rows must be keyboard actionable using native interactive
  elements or correct button/link semantics.
- Do not make a generic `div` clickable without keyboard/focus behavior.
- Exact plot actions must expose the saved plot name in their accessible label/title.
- “View all plots” must expose its family name, e.g. `Open Cycles saved plots`.
- Focus indication must remain visible in light and dark mode.
- Long plot names use ellipsis/line clamp and a tooltip/title with the full name.

## 12. Out of scope

- new analysis/scientific families;
- new backend calculations;
- persisted Home state in SQLite;
- persistent recent-open tracking;
- user accounts, authorship, or “opened by” metadata;
- saved-plot deletion/editing from Home;
- global New plot creation from Home;
- drag/drop reordering of Home cards or saved plots;
- user-customizable dashboard layout;
- global project/analysis-database dashboard;
- portable-report changes;
- saved-plot schema changes;
- changes to scientific export semantics;
- broad `AnalysisEditor.tsx` refactor unrelated to Home.

## 13. Verification

Use the current branch guidance and exact canonical commands at implementation time.

At minimum:

1. run focused frontend policy/state tests added/updated by each child;
2. run related existing draft/workspace/saved-artifact policy tests;
3. run the frontend production build;
4. after the parent is complete, run:

```powershell
python scripts\preflight.py
```

Do not claim manual/browser verification unless actually run.

### Required manual browser matrix

Verify at normal desktop width and at a narrower supported desktop width:

- fresh analysis open → Home;
- close/reopen analysis → Home;
- switch Home → each family and back;
- switch Home → same family held in `activeTab`;
- dirty new draft → Home: Save / Discard / Cancel;
- dirty saved plot → Home: Save / Discard / Cancel;
- `?tab=` deep link;
- `?plot=` deep link;
- category with 0, 1, 4, and >4 saved plots;
- Recap present in the family grid;
- cached thumbnail hit;
- thumbnail cache miss/error;
- exact thumbnail click opens exact saved plot;
- Recently updated row opens exact saved plot;
- light mode;
- dark mode;
- keyboard focus/Enter/Space where applicable;
- long plot names and no horizontal overflow.

Using browser devtools/network or equivalent verification, confirm that simply opening Home does
**not** call scientific family compute endpoints.

## 14. Parent acceptance criteria

The parent is complete only when all of the following are true:

- [ ] Home is the first analysis sub-tab and the default fresh-open view.
- [ ] `ANALYSIS_TAB_KEYS` and persisted analysis/saved-plot tab semantics remain unchanged.
- [ ] Existing `?tab=` and `?plot=` deep links bypass Home correctly.
- [ ] Dirty draft/saved-plot leave protection applies when entering Home.
- [ ] Home does not mount or compute scientific family plots.
- [ ] The approved full-width layout is implemented with repository-standard styling.
- [ ] Summary cards show truthful existing metadata only.
- [ ] All seven plot-producing families appear, including Recap.
- [ ] Each family shows up to four most recently modified saved plots.
- [ ] Category and exact-plot navigation reuse existing editor/saved-plot paths.
- [ ] Home previews are cached-thumbnail lookup only; misses/errors use stable placeholders.
- [ ] The bottom section is Recently updated plots and uses `modified_at` rather than invented open history.
- [ ] No backend/schema/scientific/cache-version change was introduced unnecessarily.
- [ ] Light/dark, keyboard, loading/error/empty, truncation, and responsive behavior were verified.
- [ ] Parent preflight passes and the result is recorded.
