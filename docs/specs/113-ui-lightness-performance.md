# 113 — UI lightness, startup responsiveness, and slow-laptop profiling

Status: Implemented on `feature/ui-lightness-perf` for Alpha `0.29.0-alpha.15` (from `main` @ `ee0913a8` / Alpha `0.29.0-alpha.14`); build, 1,037 frontend tests, Rust/installer tests, and 6× CPU Edge A/B benchmarks passed.

## Overview & Motivation

CellXplorer felt responsive on fast desktop hardware, yet field testing Alpha (`0.29.0-alpha.14`) on an older, lower-spec laptop revealed several UI responsiveness bottlenecks:

1. **7–8 second dark blank startup window:** On first launch of Alpha on a slower laptop, WebView2 sat at a blank dark window for 7–8 seconds before even the first loading modal rendered.
2. **Sustained UI sluggishness during background activity and library interaction:** Polling for background jobs ran at the application root, re-rendering dense tables on every tick, while checkbox selections and table interactions in large Cell and Analysis views mounted hundreds of heavyweight tooltip/hover-card portals and unmemoized subtrees.
3. **Slow `/analyses` loading regression trap:** Moving Plotly out of initial startup helps startup only if browsing the Analysis Database does not immediately force synchronous Plotly parsing, yet opening an actual analysis editor must still feel instantaneous.
4. **Silent 1–2 second freeze on network-drive navigation:** Pasting a UNC/network path into the Load Cells address bar and pressing Enter left the previous directory visible with no visual feedback for 1–2 seconds while SMB enumeration completed, whereas adding an unconditional spinner would flash annoyingly on fast (<50 ms) local folders.

**Scope boundary:** All work in this batch is strictly confined to frontend UI lightness, startup code-splitting, render isolation, pagination, and loading UX. Zero changes were made to Neware/BioLogic parsers, Parquet caches, or scientific calculations, and 100% UI/UX parity was preserved.

---

## Profiling & Benchmarking Methodology

Every optimization was checked against concrete measurements comparing `main` (`ee0913a8`) against `feature/ui-lightness-perf`:

1. **Production bundle & V8 ESM parse benchmark:**
   - Built production frontend assets for both `main` and `feature/ui-lightness-perf` with `npm run build` (`tsc -b && vite build`).
   - Audited `dist/index.html` `<script>` and `<link rel="modulepreload">` entries to verify which chunks execute eagerly on boot.
   - Measured V8 ESM module parse latency across startup chunks using Node's `vm.SourceTextModule` (7-run median on desktop CPU).
2. **Deterministic Node micro-benchmarks:**
   - Compared `git show main:...` vs. the working tree using exact production modules for:
     - `useTimeCapacityProgressiveWarmup` idle timer wakeups and serialization work over 60 seconds after warmup completion.
     - `startupQueryPersistence` write count, serialized payload size, and main-thread JS time during startup cache bursts (500 cells, 100 analyses).
     - `AnalysisDatabaseTable` column-resize drags (`120 px` drag render and `localStorage` write counts).
3. **Real Chromium / WebView2 (Microsoft Edge) 6× CPU-throttled A/B harness:**
   - Launched headless Microsoft Edge via Chrome DevTools Protocol with `Emulation.setCPUThrottlingRate: 6` (simulating an older/low-power laptop CPU) against an isolated in-memory dataset of **200 cells, 80 analyses, 20 replicate groups, and 10 folders**.
   - Rewrote `http://127.0.0.1:8642/api/` requests via `Page.addScriptToEvaluateOnNewDocument` to an isolated local mock server so the user's real backend process and `%USERPROFILE%\.cellxplorer*` databases remained untouched.
   - Measured: cold startup (wall time, Script CPU time, Total Blocking Time, JS Heap), background-job polling on a 100-row Cell Database, 8 consecutive checkbox selections on a 100-row Cell Database, Analysis Database load (80 analyses), and synthetic column-resize drag.

---

## Executive Summary — Before vs. After Results

### Production Startup Bundle & Parse (`dist/index.html`)

| Metric | `main` (`ee0913a8`) | `feature/ui-lightness-perf` | Change |
|---|---:|---:|---:|
| Preloaded startup JS (`dist/index.html`) | `6,515.8 KB` (1 monolithic chunk incl. `4,505.3 KB` `plotly.min`) | `788.6 KB` | **-87.9%** (8.3× smaller) |
| V8 ESM parse time (desktop, 7-run median) | `147.9 ms` | `22.3 ms` | **6.63× faster** |

### Real Microsoft Edge (WebView2 Engine) under 6× CPU Throttling

| Scenario (200 cells, 80 analyses, 20 groups, 10 folders) | `main` (`ee0913a8`) | Intermediate Checkpoint(s) | Final `feature/ui-lightness-perf` | Net Improvement |
|---|---|---|---|---|
| **Cold Startup — Wall Time** | `11,120 ms` (blank dark screen) | — | `3,950 ms` (+ frame-1 splash) | **2.82× faster (-7.17 s)** |
| **Cold Startup — Script CPU** | `10,059 ms` | — | `2,846 ms` | **3.53× less CPU** |
| **Cold Startup — Total Blocking Time (TBT)** | `10,357 ms` | — | `3,160 ms` | **-69.5%** |
| **Cold Startup — JS Heap** | `31.1 MB` | — | `13.3 MB` | **-57% RAM** |
| **Background Job Polling (100-row Cell DB)** | `1,602.5 ms/tick` (first run: `1,563 ms/tick`) | Pure polling *before* 2 s idle Plotly prefetch: `20.4 ms/tick` (first run: `17.2 ms/tick`) | `570.4 ms/tick` (includes one-time ~4.25 s background Plotly idle prefetch firing at `t = 2 s`) | **78.6×–91× less pure polling CPU (-98.7%)** |
| **Cell DB Checkbox Clicks (100 rows, avg of 8 clicks)** | `2,138.4 ms/click` (`15,439 ms` CPU) | After row memo + lazy hover + native `title`: `787.6 ms/click` (`4,280 ms` CPU) | `509.2 ms/click` (`2,445 ms` CPU) | **4.20× faster; 6.31× less CPU (-84.2%)** |
| **Analysis DB Load (80 analyses) — Wall Time** | `3,368 ms` (80 rows; Plotly preloaded) | *Before* lazy `AnalysisEditor`: `7,589 ms` (caught regression!) → After lazy editor/hover (80 rows): `3,268 ms` | `2,199 ms` (25/page + lazy editor + idle prefetch) | **1.53× faster** |
| **Analysis DB Load — Script CPU** | `3,706 ms` | After lazy editor/hover (80 rows): `3,353 ms` | `1,938 ms` | **1.91× less CPU** |
| **Analysis DB Load — JS Heap** | `209.4 MB` | After lazy editor/hover (80 rows): `26.7 MB` | `27.5 MB` | **7.6× less RAM** |

### Deterministic Node Micro-Benchmarks

| Target (`git show main:...` vs. Branch) | Before (`main`) | After | Verdict |
|---|---:|---:|---|
| **`AnalysisDatabaseTable` column resize drag (`120 px`)** | `120` renders + `120` `localStorage.setItem` | `1` render + `1` write | **120× fewer writes/renders** (note: clean Edge 6× drag measured `871 ms → 65 ms` Script CPU, though synthetic `PointerEvent` dispatch showed run-to-run variance so the deterministic `120 → 1` trace is primary evidence) |
| **`useTimeCapacityProgressiveWarmup` idle loop (60 s post-done)** | `600` wakeups / `1,800` `JSON.stringify` / `4.29 ms` CPU | `0` / `0` / `0 ms` | **Zero idle timer wakeups** (clean idle hygiene; tiny CPU impact — not a cause of perceived sluggishness) |
| **`startupQueryPersistence` startup burst (500 cells, 100 analyses)** | `5` sync writes / `1,588.1 KB` / `5.86 ms` | `1` idle write / `354.9 KB` / `2.71 ms` | **5× fewer writes** & moved to `requestIdleCallback` (modest win; avoids small hitches) |

---

## Action-by-Action Post-Mortem & Rationale

### Action 1 — Route, modal, preview, and Plotly code-splitting + idle/hover `AnalysisEditor` prefetch

- **Original design & rationale:** Static ES module imports throughout `App.tsx` and feature modals kept routing simple and ensured Plotly and secondary pages were immediately available in memory once the single chunk loaded.
- **Why it hurt slower laptops:** Vite bundled everything reachable from `App.tsx` into one **`6,515.8 KB` startup chunk**, dominated by **`4,505.3 KB` of `plotly.min`**. Before the user even opened an analysis—or before an Alpha release tour even needed a plot—every CPU core on startup spent ~10 seconds (at 6× throttle) parsing and evaluating Plotly, secondary pages, and preview panels synchronously.
- **Profiler traps uncovered & what we changed:**
  1. Lazy-loading secondary routes in `frontend/src/App.tsx` (`AnalysisWorkspaceContent`, `InboxPage`, `ProjectsPage`, `SettingsPage`), removing the unused `AnalysesIndexPage` import, and gating closed `CommandPalette` / `DiagnosticsModal`.
  2. **Hidden link #1 caught by auditing `dist/index.html`:** Even after lazy-loading routes, `plotly.min` remained preloaded on boot because `WhatsNewCoordinator` statically imported `ReleaseIntroduction`, which statically imported `Plot`. Lazy-loading `ReleaseIntroduction` inside `frontend/src/components/WhatsNewCoordinator.tsx` broke that chain and dropped startup JS from **`6,515.8 KB` to `788.6 KB`**.
  3. **Hidden link #2 caught by the 6× Edge benchmark:** In the first code-split build, navigating to the Analysis Database spiked load time to **`7,589 ms`** because `AnalysisWorkspaceContent` statically imported `AnalysisEditor` and `AnalysisSamplePreviewModal` statically imported `CellDetailTabs` / `ReplicatePreviewPanel`, forcing `/analyses` list browsing to parse Plotly synchronously. Lazy-loading `AnalysisEditor` in `frontend/src/features/analyses/workspace/AnalysisWorkspaceContent.tsx`, lazy-loading `CellDetailTabs` and `ReplicatePreviewPanel` in `frontend/src/features/analyses/database/AnalysisSamplePreviewModal.tsx` and `frontend/src/pages/LibraryPage.tsx`, lazy-loading `AnalysisCacheWarmupRenderer` in `frontend/src/features/analyses/editor/artifacts/CacheWarmupCoordinator.tsx`, and wrapping `ImportCellsLauncher` in `LazyImportCellsLauncher` resolved this.
  4. **Preserving instantaneous analysis opening (`prefetchAnalysisEditor()`):** Because users expect opening an analysis to feel instantaneous, `frontend/src/App.tsx` defines an idempotent `prefetchAnalysisEditor()` helper (`import("./features/analyses/workspace/AnalysisWorkspaceContent")` + `import("./features/analyses/editor/AnalysisEditor")`). It triggers **2,000 ms** after `databaseStatus.data?.compatible === true && !bootstrapBlocking` via `requestIdleCallback(..., { timeout: 4000 })`, and also eagerly on `onMouseEnter` / `onFocus` of the **Analysis Database** sidebar `NavLink`.
- **Measured impact:** Startup JS dropped **-87.9%** (`6,515.8 KB → 788.6 KB`), cold startup fell **2.82×** (`11,120 ms → 3,950 ms`), cold startup JS heap fell **-57%** (`31.1 MB → 13.3 MB`), and opening an analysis remains warm in browser module cache once idle or hovered.
- **Honest verdict:** **Primary win.** Fixes startup cost without sacrificing opening speed for analyses. Note that the one-time background Plotly compile (~`4.25 s` at 6× throttle) still happens once during the `t = 2 s` idle window, which is why the final polling benchmark saw `570.4 ms/tick` (vs `20.4 ms/tick` pure polling).

### Action 2 — Frame-1 inline HTML+CSS startup splash & progress bar (`#cx-boot-splash`)

- **Original design & rationale:** `frontend/index.html` contained an empty `<div id="root"></div>`, assuming React would mount fast enough that React's own initialization modal would serve as the first loading state.
- **Why it hurt slower laptops:** On first launch of Alpha on an older laptop—compounded by cold WebView2 startup, unpacked bundle disk reads, Windows Defender/antivirus inspection, and JS parse/eval—`<div id="root"></div>` stayed completely empty against the dark window for **7–8 seconds** before React could render anything.
- **What we changed:** Added inline, zero-JavaScript HTML + CSS `#cx-boot-splash` inside `<div id="root">` in `frontend/index.html`, featuring `/app-icon.png`, the `CellXplorer` wordmark, `Starting application…`, an indeterminate teal CSS progress bar, `@media (prefers-color-scheme: dark)` surface matching (`#ffffff` light / `#242424` dark), and `prefers-reduced-motion` support. React's `createRoot(root).render(...)` replaces the element automatically as soon as the app mounts.
- **Measured impact:** Combined with Action 1's -87.9% JS reduction, the browser paints a visible progress indicator on frame 1 instead of sitting blank for 7–8 seconds.
- **Honest verdict:** **High UX impact.** Does not change backend boot time by itself, but eliminates the "is the app hung?" dead air before JS mounts.

### Action 3 — Isolating background-job and source-check polling out of `App.tsx`

- **Original design & rationale:** Root `App.tsx` fetched `backgroundJobs` (`refetchInterval` `700 ms` while running, `5 s` idle) and `sourceCheckJob` (`600 ms` while running) so it could drive the global header Activity indicator, completion toasts, query invalidations, and `ActivityCenter` drawer.
- **Why it hurt slower laptops:** Putting high-frequency `useQuery` hooks in `App.tsx` meant **every polling tick re-rendered the entire application root**, cascading into the active route (`LibraryPage` or `AnalysisDatabase`). Under 6× CPU throttling on a 100-row Cell Database, each polling tick consumed **`1,563–1,602.5 ms`** of Script CPU—longer than the `700 ms` polling interval—pinning the main thread at >100% saturation whenever an import, cache warmup, or index scan ran.
- **What we changed:** Created `frontend/src/components/BackgroundActivityController.tsx` to self-contain `backgroundJobs`, `sourceCheckJob`, their side-effect `useEffect`s, the header Activity button + `AnalysisUpdateIndicator`, and conditionally gated `ActivityCenter`. Removed all of that polling state from `frontend/src/App.tsx`.
- **Measured impact:** Pure polling Script CPU per tick dropped from **`1,602.5 ms/tick` to `20.4 ms/tick`** (**78.6× reduction, -98.7%**; first A/B run: `1,563 ms → 17.2 ms`, **91×**).
- **Honest verdict:** **Massive win.** Eliminates a chronic main-thread saturation bug whenever background work runs.

### Action 4 — `LibraryPage` selection & render optimizations (100% UI parity)

- **Original design & rationale:** `LibraryPage.tsx` passed inline action closures, eagerly mounted Mantine `<HoverCard>`, `<Popover>`, and three per-row `<Tooltip>` wrappers across all visible rows (25–100 rows), rendered full `CellLibraryColumnMenu` / `ColumnResizeHandle` header trees inline, and kept closed modals mounted inside the component tree.
- **Why it hurt slower laptops:** Toggling a single checkbox updates `selectedCellIds` in `LibraryPage`. Because rows, column headers, replicate tables, and closed modal props were unmemoized and multiplied across up to 100 visible rows of Mantine Popover/Tooltip portals, every single checkbox click cost **`2,138.4 ms` wall time** at 6× CPU throttle.
- **What we changed (two measured checkpoints):**
  - **Stage 1 (Row & Popover lightness):**
    - Refactored `CellHoverCard` in `frontend/src/components/CellSamplePopovers.tsx` to defer mounting Mantine `<Popover>` and computing `cellFacts()` until the pointer lingers **350 ms** (80 ms close delay), and removed unused `HoverCard`.
    - Updated `ReplicateMembershipCell` in `frontend/src/pages/LibraryPage.tsx` to mount `<Popover>` only when `opened` is true.
    - Extracted `memo`-wrapped `LibraryCellRow` with a module-level `EMPTY_REPLICATE_GROUPS` constant and a stable `rowActionsRef`, and replaced 3 per-row Mantine `<Tooltip>` components (Edit / Open / Remove) with native HTML `title` attributes.
  - **Stage 2 (Addressing the remaining `~535 ms/click` shell re-render cost):**
    - Extracted `memo`-wrapped `CellTableColumnHeaders` so selection changes skip re-rendering 8 `CellLibraryColumnMenu` trees, `StatusHeaderHelp`, and 9 `ColumnResizeHandle`s.
    - Extracted `memo`-wrapped `ReplicateGroupsSection` so cell checkbox toggles do not re-render replicate tables.
    - Conditionally gated all 8 closed modals (`PlaceInFoldersModal` ×2, Create/Add/Edit Replicate Group, Replicate Preview, Cell Details, `DestructiveImpactModal`).
- **Measured impact (100 rows visible, avg over 8 consecutive clicks, 6× CPU):**
  - `main`: **`2,138.4 ms/click`** (`15,439 ms` total Script CPU)
  - After Stage 1: **`787.6 ms/click`** (`4,280 ms` total Script CPU)
  - After Stage 2: **`509.2 ms/click`** (**4.20× faster**), **`2,445 ms` total Script CPU** (**6.31× less CPU, -84.2%**)
- **Honest verdict:** **Major win with zero visual/functional compromise.** Native `title` on row icon buttons trades Mantine styled poppers for OS tooltips on those 3 icon buttons per row while preserving exact click/keyboard/accessibility semantics (`aria-label`). Note that `LibraryPage`'s own toolbar/filter state (~2,700-line host component) accounts for the remaining ~509 ms at 6× throttle (~85 ms unthrottled).

### Action 5 — `AnalysisDatabaseTable` `25 / 50 / 100` pagination, `ColumnResizeHandle` drag fix, and lazy plot hover

- **Original design & rationale:** While `LibraryPage` already defaulted to `25 / 50 / 100` rows per page, `AnalysisDatabaseTable` rendered every matching analysis row simultaneously, mounted an eager Mantine `<HoverCard>` per row in `AnalysisPlotSummary`, kept `AnalysisSamplePreviewModal` mounted while closed, and handled column resizing with raw `pointermove` listeners (`beginResize`) calling `setWidths` and `localStorage.setItem` on every pixel moved.
- **Why it hurt slower laptops:** As an analysis database grows (80+ analyses), mounting all rows and all hover-card portals at once inflated Script CPU (`3,706 ms`) and JS heap (`209.4 MB` on `main` when paired with preloaded Plotly). Meanwhile, dragging a column border saturated the main thread with synchronous layout + `localStorage` writes on every frame.
- **What we changed:**
  - Added **`25 / 50 / 100` pagination** (default **`25`**, persisted in `cellxplorer-analysis-page-size`) to `frontend/src/features/analyses/database/AnalysisDatabaseTable.tsx`, with page-scoped header selection plus a `"Select all N matching analyses"` banner/prompt (preserving safe batch actions across filtered results), and gated `AnalysisSamplePreviewModal`.
  - Replaced raw `beginResize` in `AnalysisDatabaseTable.tsx` with the shared `ColumnResizeHandle` so column widths visually preview via transform/CSS and commit React state + `localStorage` once on `pointerup`.
  - Refactored `frontend/src/features/analyses/database/AnalysisPlotSummary.tsx` to lazy-mount a `<Popover>` only after hovering **160 ms** (120 ms close delay) instead of mounting an eager `<HoverCard>` per row.
- **Measured impact:**
  - Analysis Database load (80 analyses, 6× CPU): `main` `3,368 ms` wall / `3,706 ms` Script CPU / `209.4 MB` heap → final **`2,199 ms` wall** (**1.53× faster**), **`1,938 ms` Script CPU** (**1.91× less CPU**), **`27.5 MB` JS heap** (**7.6× less RAM**).
  - Node column resize (`120 px` drag): **`120 renders + 120 localStorage.setItem` → `1 render + 1 write`**. (On Edge 6× CPU, the clean drag checkpoint measured `871 ms → 65 ms` Script CPU, though synthetic `PointerEvent` drag automation varied across runs.)
- **Honest verdict:** **Strong memory, load, and drag win.** Matches the Cell Database UX (`25 / 50 / 100`) cleanly and keeps large analysis collections snappy.

### Action 6 — Anti-flash delayed loading feedback for slow / network-drive navigation

- **Original design & rationale:** `ImportFilesystemPickerModal.tsx` uses TanStack Query with `placeholderData` when browsing directories so local folder switches stay visually seamless without clearing the table on every click.
- **Why it hurt user confidence on network drives:** When pasting a UNC/network path (`\\server\share\...`) into the Load Cells URL bar and pressing Enter, SMB directory listing frequently takes **1–2 seconds**. Because `placeholderData` intentionally kept the previous folder visible while fetching, there was **zero visual acknowledgment** that Enter worked—leading users to think their keypress was dropped. Showing an unconditional spinner, however, would cause jarring flashes on fast (<50 ms) local folders.
- **What we changed:**
  - Created a tiny zero-dependency hook in `frontend/src/useDelayedFlag.ts`: `useDelayedFlag(active, delay = 180, minimum = 280)`. *(Deliberately kept separate from `plotRuntime.ts`'s helper so importing it into the import picker never pulls Plotly into the picker or startup graph.)*
  - In `frontend/src/components/ImportFilesystemPickerModal.tsx`, derived `isNavigatingFolder = opened && !indexedScope && browseQuery.isFetching && Boolean(browseData)` and `showFolderLoading = useDelayedFlag(isNavigatingFolder, 180, 280)`.
  - Surfaced non-disruptive progress only once navigation exceeds 180 ms (and held for at least 280 ms once shown so feedback never flickers): an `Opening…` badge + subtle `Loader` in the address bar, `loading={showFolderLoading}` on the Refresh button, a subtle 3px animated `<Progress>` overlay at the top of the file list `<Paper>`, and `opacity: 0.55` dimming on stale rows.
- **Measured impact:** Verified deterministically in `frontend/tests/delayedFlag.test.ts`: resolutions `< 180 ms` produce zero UI changes/flashes; resolutions `>= 180 ms` display cleanly and remain visible `>= 280 ms` after trigger.
- **Honest verdict:** **Targeted UX win.** Directly fixes the "did my Enter keypress register?" uncertainty on network drives with zero regression on local disks.

### Action 7 — Event-driven `useTimeCapacityProgressiveWarmup` (removing permanent 100 ms `setInterval`)

- **Original design & rationale:** `useTimeCapacityProgressiveWarmup.ts` polled every 100 ms with `window.setInterval(pump, 100)` while an interactive Time/Capacity tab existed so it could detect idle periods and React Query state changes without wiring subscriptions.
- **Why it hurt (theoretically) & what we changed:** A permanent 100 ms timer kept firing 10 times/sec even after warmup completed (`progress.done`), paused, or failed. Replaced `window.setInterval(pump, 100)` in `frontend/src/features/analyses/editor/families/time-capacity/useTimeCapacityProgressiveWarmup.ts` with reactive triggers (prop effect, `queryClient.getQueryCache().subscribe`, interaction/visibility listeners) plus a single one-shot `setTimeout` for the 1.5 s idle window—scheduling **zero timers** once `progress.done`, `failure`, `!active`, or document hidden.
- **Measured impact (Node 60 s post-done micro-benchmark):** Wakeups **`600 → 0`**, `JSON.stringify` calls **`1,800 → 0`**, CPU **`4.29 ms/min/tab → 0 ms`**.
- **Honest verdict:** **Clean idle hygiene, tiny CPU impact.** Worth doing so idle tabs sleep completely, but `4.29 ms/min` was never a meaningful contributor to laptop slowness.

### Action 8 — Idle-scheduled & deduplicated `startupQueryPersistence.ts`

- **Original design & rationale:** Persisted 4 core startup TanStack Query keys to `localStorage` on a `200 ms` debounce timer so subsequent cold starts could hydrate library/analysis lists immediately.
- **Why it hurt (modestly) & what we changed:** Initial parallel API responses arriving within seconds triggered repeated synchronous `JSON.stringify` + `localStorage.setItem` calls on the main thread during startup, even if `dataUpdatedAt` across all 4 keys was unchanged. In `frontend/src/startupQueryPersistence.ts`, increased `WRITE_DELAY_MS` from `200 ms` to `1500 ms`, scheduled persistence inside `requestIdleCallback(..., { timeout: 4000 })` (retaining synchronous `pagehide` flush on tab close), and added `lastFlushedSignature` over `dataUpdatedAt` timestamps to skip redundant writes.
- **Measured impact (Node burst benchmark, 500 cells / 100 analyses):** Synchronous writes **`5 → 1`**, serialized bytes **`1,588.1 KB → 354.9 KB`**, main-thread JS time **`5.86 ms → 2.71 ms`**, deferred off the active startup frame.
- **Honest verdict:** **Modest win.** Good defensive hygiene against small startup micro-hitches; paired cleanly with `frontend/tests/startupQueryPersistence.test.ts` deduplication coverage.

---

## Intentionally Preserved Trade-Offs & Future Opportunities

The following heavyweight patterns were audited and deliberately **kept untouched** in this batch because they encode intentional UX guarantees. Each has concrete triggers if field testing on lower-spec laptops calls for further work:

1. **`keep-mounted` + `visibility: hidden` + `RetainedAnalysisPanel` + WebGL (`scattergl`) contexts:**
   - *Original rationale:* Switching between open analysis tabs and analysis families stays instantaneous and Plotly preserves responsive layout (avoiding `0×0` canvas collapse under `display: none`).
   - *Laptop risk:* On 8 GB / integrated-GPU laptops with many open analyses, retained DOM plus live WebGL contexts accumulate RAM/VRAM.
   - *Existing user control & next step:* Users already have **Settings → Performance → Release inactive analyses (`unmount`)**. If memory/GPU pressure shows up on weak laptops, consider a bounded LRU cap (e.g., keeping only the 2–3 most recent analyses mounted) or hardware-aware defaults via `navigator.deviceMemory` / `navigator.hardwareConcurrency`.
2. **`AnalysisEditor.tsx` (6,265 lines) & `Plot.tsx` memoization leaks:**
   - *Finding:* Unstable inline props (`newPlotHeaderProps`, `familyUpdate`, `validPlotIds = new Set(...)`) and an unmemoized `Plot.tsx` wrapper mean interactions inside an open analysis can re-render unchanged plot shells.
   - *Next step:* Revisit with targeted `useMemo` / `React.memo` if editing inside an open analysis feels sluggish on older laptops.
3. **Backend `time_capacity_workers` startup process pool warmup (Spec 052.6):**
   - *Original rationale:* Pre-warming 2–6 Python worker processes at backend startup eliminates a ~1.6 second first-drag freeze in Time/Capacity analyses.
   - *Laptop risk:* On 4-core / 8 GB machines, spawning multiple Python worker processes concurrently with initial cold launch competes directly with UI and HTTP startup for CPU, disk I/O, and RAM.
   - *Next step:* Consider deferring backend worker pool warmup by ~15 seconds or until `/analyses` is first entered.
4. **Custom slim Plotly partial bundle:**
   - *Finding:* `plotly.js-dist-min` (`4,505.3 KB`) ships 3D, mapbox, geo, ternary, and financial trace renderers that CellXplorer never uses.
   - *Next step:* Building a cartesian + `scattergl` partial Plotly bundle (~`1–1.5 MB`) would cut the remaining idle-prefetch and cold analysis compile cost by roughly **65–70%**.

---

## Files Changed & Verification Record

### Modified / Added Files (19 files, `feature/ui-lightness-perf`)

- **Modified (16):**
  - `frontend/index.html`
  - `frontend/src/App.tsx`
  - `frontend/src/components/CellSamplePopovers.tsx`
  - `frontend/src/components/ImportFilesystemPickerModal.tsx`
  - `frontend/src/components/WhatsNewCoordinator.tsx`
  - `frontend/src/features/analyses/database/AnalysisDatabaseTable.tsx`
  - `frontend/src/features/analyses/database/AnalysisPlotSummary.tsx`
  - `frontend/src/features/analyses/database/AnalysisSamplePreviewModal.tsx`
  - `frontend/src/features/analyses/editor/artifacts/CacheWarmupCoordinator.tsx`
  - `frontend/src/features/analyses/editor/families/time-capacity/useTimeCapacityProgressiveWarmup.ts`
  - `frontend/src/features/analyses/workspace/AnalysisWorkspaceContent.tsx`
  - `frontend/src/pages/LibraryPage.tsx`
  - `frontend/src/startupQueryPersistence.ts`
  - `frontend/tests/releaseAnnouncement.test.ts` (added `lazy`/`Suspense` mocks for `WhatsNewCoordinator`)
  - `frontend/tests/startupQueryPersistence.test.ts` (added `dataUpdatedAt` deduplication coverage)
  - `frontend/tests/whatsNewStartup.test.ts` (added `lazy`/`Suspense` mocks for `WhatsNewCoordinator`)
- **Added (3):**
  - `frontend/src/components/BackgroundActivityController.tsx`
  - `frontend/src/useDelayedFlag.ts`
  - `frontend/tests/delayedFlag.test.ts`

### Verification Results

- **Frontend production build (`cd frontend && npm.cmd run build`):** Passed (`tsc -b && vite build` in `2.10 s`); zero dynamic-import chunking warnings for Plotly or ImportPicker; `#cx-boot-splash` verified in `dist/index.html`; `plotly.min` absent from `dist/index.html` preload tags.
- **Frontend unit/policy test suite (`cd frontend && node --test --experimental-strip-types tests/*.test.ts`):** **1,036 / 1,036 passed, 0 failed** (`7.77 s`).
- **Automated Node & Real Edge (6× CPU) A/B profiling harnesses:** Passed across `main` vs. `feature/ui-lightness-perf` with numbers reported in the Executive Summary above.
- **Pending:** Full repository preflight (`python scripts\preflight.py`), commit, push to `origin`, and merge to `main`.
