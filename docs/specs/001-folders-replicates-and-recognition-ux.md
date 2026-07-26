# Spec: Folder/replicate refinements + read-only protocol viewer + recognition progress

Status: **ready to implement**. Author hand-off for another AI agent. Written 2026-07-24.

This spec covers three groups of work:

- **Part A** — refinements to the just-built "place cells/replicates in folders" and
  "convert cells ↔ replicate" features (project view + cell database).
- **Part B** — item 2: a **read-only protocol-structure viewer** for the C-rate and
  Chargeability automatic-identification panels.
- **Part C** — item 9: a **realistic progress indicator** for the C-rate (and, by extension,
  Chargeability/DCIR) recognition pass, replacing the bare spinner.

Read the whole file before editing. Each task lists the exact files, the current behaviour,
the target behaviour, and acceptance criteria. Line numbers are approximate — grep for the
quoted anchors.

---

## Ground truth: what already exists (do not re-build)

These were built in earlier sessions and are working / building:

- `frontend/src/components/PlaceInFoldersModal.tsx` — reusable modal. Props:
  `{ opened, onClose, cellIds?: number[], groupIds?: number[], title?, onSaved? }`. Fetches
  `GET /api/tree`, flattens folders, shows a checkbox per folder pre-filled from current
  membership (indeterminate when only some of the target items are in the folder), and on
  **Apply** diffs `desired` vs current membership and calls the add/remove endpoints. A
  just-landed fix makes the reset `useEffect` depend on `[opened]` only (previously it
  depended on the `cellIds`/`groupIds` array literals and wiped every click).
- `LibraryPage.tsx` (cell database):
  - Multi-select toolbar has a **"Place in folders"** button → opens `PlaceInFoldersModal`
    with `cellIds={selectedIds}`.
  - `createReplicateGroup` mutation → `POST /api/replicate-groups {name, cell_ids}`. On
    success it currently opens `PlaceInFoldersModal` for the new group via
    `setPlaceGroupId(group.id)` **after** creation. **Part A2 replaces this.**
  - `ungroupReplicates` mutation exists → `POST /api/replicate-groups/ungroup {group_ids}`.
- `CellDetailTabs.tsx` — has a **"Place in folders"** button in the tab-strip header
  (`cellIds={[cell.id]}`). **Part A1 moves/duplicates this into the LibraryPage cell-edit
  header.**
- `ProjectsPage.tsx`:
  - `groupAsReplicate` mutation: creates a replicate group from selected cells and files the
    group into the folders the cells sit in. **Part A4 extends it.**
  - `explodeReplicate` mutation: `POST /api/replicate-groups/ungroup {group_ids}`. **Part A5
    extends it.**
  - Context-menu items: "Place in folders…", "Group as replicate", "Explode replicate(s)".
  - Left-side folder chevron, header Expand/Collapse split-buttons, and the drag-drop fix
    (drop zone on the whole subtree with `stopPropagation`) all landed already.

### Relevant backend endpoints (all already exist and are used elsewhere)

- `GET /api/tree` → `Tree { folders: FolderNode[]; projects: ProjectNode[] }`. `FolderNode`
  has `id, name, parent_id, cell_ids, cells[], replicate_groups[] (each with id,name,cell_ids),
  children[]`.
- `POST /api/folders/{id}/cells {cell_ids}` / `DELETE /api/folders/{id}/cells/{cellId}`
- `POST /api/folders/{id}/replicate-groups {group_ids}` /
  `DELETE /api/folders/{id}/replicate-groups/{groupId}`
- `POST /api/replicate-groups {name, cell_ids}` → `ReplicateGroupSummary` (has `id`, `cell_ids`)
- `POST /api/replicate-groups/ungroup {group_ids}` → `{ ok }` (deletes the group, cells become
  standalone; **does not** re-file the cells anywhere — see A5)
- `GET /api/background-jobs/by-token/{token}` → the job for a client token, or `null`
- `GET /api/background-jobs/{job_id}` → a single job

### Invalidation convention

After any folder/replicate mutation, invalidate `["tree"]`, `["cells"]`, `["replicate-groups"]`.

---

## Part A — Folder & replicate refinements

### A0. Auto-deselect in PlaceInFoldersModal — DONE

The reset effect now depends on `[opened]` only. Verify it stays that way; do not re-add
`cellIds`/`groupIds` to the dependency array.

### A1. Cell-edit modal: move "Place in folders" next to Save/Cancel

**Where:** `frontend/src/pages/LibraryPage.tsx`. The cell detail panel, when `editingCell` is
true, renders a header with **Cancel** and **Save changes** buttons (grep `saveCellEdit`, the
`editingCell ? (...)` block around the "Save changes" button, ~line 1514–1530) followed by a
`Divider label="Editable details"` and the `Cell name` field.

**Current:** the "Place in folders" button lives in the `CellDetailTabs` tab-strip header
(smaller, `size="compact-sm"`), visually detached from Save/Cancel (see user screenshot).

**Target:**
1. Add a **"Place in folders"** button into the same button group as Cancel / Save changes in
   the LibraryPage cell-edit header. Match their size (whatever `size` those buttons use —
   `"md"` in the screenshot; at minimum the same **vertical** height). Order suggestion:
   `Place in folders | Cancel | Save changes`.
2. It opens `PlaceInFoldersModal` with `cellIds={[selectedCell.id]}` and a title like
   `Place {cell name} in folders`. Add local state `placeCellOpen` in LibraryPage.
3. **Remove** the button from `CellDetailTabs.tsx` header (revert that change) so it does not
   appear twice for the LibraryPage case. Keep `CellDetailTabs` clean.
   - Note: `CellDetailTabs` is also rendered in `ProjectsPage` and
     `AnalysisSamplePreviewModal`. Those contexts already have their own "Place in folders"
     affordance (project context menu). So removing it from `CellDetailTabs` is safe.

**Acceptance:** In the cell editor, "Place in folders" sits inline with Cancel/Save changes,
same height; clicking opens the folder picker for that one cell; no duplicate button in the
tab strip.

### A2. Create-replicate modal: choose folders **inside** the name dialog

**Where:** `LibraryPage.tsx`, the "Create replicate group" `Modal` (grep
`title="Create replicate group"`, ~line 1290). It has a `groupName` `TextInput` and a create
button calling `createReplicateGroup.mutate({ name, cell_ids: selectedIds })`.

**Current:** folder placement happens in a **second** modal opened after creation
(`setPlaceGroupId(group.id)`). Remove that two-step flow.

**Target:** put folder selection **in** the create modal:
1. Add a folder checklist to the create modal below the name field — a scrollable list of all
   folders (from `GET /api/tree`, flattened with depth indent) with checkboxes. Track chosen
   folder ids in local state `groupFolderIds: Set<number>`.
   - Recommended: extract the folder-checklist UI from `PlaceInFoldersModal` into a small
     reusable presentational component `FolderChecklist` (see note below) so both the modal
     and this dialog share it. If time-constrained, inline a simple version here.
   - Default: pre-check the folders the **selected source cells** already sit in (union of
     their folder membership), so the new replicate lands next to its cells by default. The
     user can uncheck.
2. On create, change `createReplicateGroup` so its `mutationFn` (or an `onSuccess` chained
   sequence) also files the new group into every checked folder:
   `for (fid of groupFolderIds) await post('/api/folders/'+fid+'/replicate-groups', { group_ids: [group.id] })`.
   Prefer doing it inside an async `mutationFn` so failures surface and invalidation runs once
   at the end.
3. **Delete** the post-creation `placeGroupId` modal and its state.

**Acceptance:** Creating a replicate from the cell database lets you tick target folders in the
same dialog; the new group appears in those folders; no second modal pops up.

#### Note: `FolderChecklist` extraction (optional but preferred)

`PlaceInFoldersModal` has membership logic (checked/indeterminate from current membership) that
the create-dialog does not need (a brand-new group is in no folder yet). Two clean options:
- (a) Extract a **presentational** `FolderChecklist({ folders, isChecked, isIndeterminate,
  onToggle })` and keep membership logic in each caller. `PlaceInFoldersModal` passes its
  membership-derived predicates; the create dialog passes a plain `Set<number>` membership.
- (b) Give `PlaceInFoldersModal` a `mode: "manage" | "add"` and reuse it directly in the create
  flow, deferring the actual POSTs until after the group exists. This is trickier because the
  group id does not exist at modal-open time; **(a) is recommended.**

### A3. Project view: toolbar button for "Group as replicate" (not only right-click)

**Where:** `ProjectsPage.tsx`, the top toolbar row that holds the project-level actions
(grep the `New analysis` button, ~line 1020; also the folder-panel actions "Add
cell/replicate", "Import here"). The current group/explode actions are **only** in the
right-click context menu (`canGroupAsReplicate` / `canExplodeReplicate`).

**Target:**
1. Add a visible **"Group as replicate"** button in the toolbar near "Add cell/replicate" /
   "Import here" / "New analysis". Enable it only when `canGroupAsReplicate` is true
   (`selectedCells.length >= 2 && selectedCells.length === selectedActionItems.length`).
   `onClick` runs the same `groupAsReplicate.mutate({ name, cellIds, folderIds })` payload the
   context menu uses.
2. Optionally add a companion **"Explode replicate"** button enabled on `canExplodeReplicate`.
   (Nice-to-have; context menu already covers it.)
3. Keep the context-menu items — the toolbar button is additive.

**Acceptance:** Selecting ≥2 cells in the project tree enables a toolbar "Group as replicate"
button; clicking it creates the replicate exactly like the context-menu action.

### A4. On grouping cells → replicate, **remove the source cells from the folder**

**Where:** `ProjectsPage.tsx`, `groupAsReplicate` mutation.

**Current:** creates the group and adds the **group** to the source folders. The individual
cells remain filed in those folders too, so the folder shows both the cells and the replicate.

**Target:** after creating the group and filing it into the folders, **remove each source cell
from the folder(s) it was in**. The selected cells are `TreeItem`s carrying `id` (cell id) and
`folderId`. In the async `mutationFn`, after the group create + group-file loop, do:
`for (cell of selectedCells) await del('/api/folders/'+cell.folderId+'/cells/'+cell.id)`.
Group the deletes by folder if convenient. Only remove from the folder the cell was actually
selected in (its `folderId`), not from all folders.

**Acceptance:** After "Group as replicate", the folder contains the replicate group and no
longer lists the constituent cells as standalone entries.

### A5. On exploding a replicate, **return its cells to the replicate's folder**

**Where:** `ProjectsPage.tsx`, `explodeReplicate` mutation.

**Current:** calls `POST /api/replicate-groups/ungroup {group_ids}` which deletes the group;
the cells become standalone and are **not** placed in any folder — so they vanish from the
folder where the replicate lived.

**Target:** before or after ungrouping, capture, for each selected group, its `folderId` (from
the `TreeItem`) and its member `cell_ids`, then after ungroup add those cells back into that
folder:
1. Look up each selected group's `cell_ids`. The `TreeItem` for a replicate group has `id` and
   `folderId` but **not** `cell_ids`; resolve them from the tree: `findFolder(folders,
   item.folderId)` → `.replicate_groups.find(g => g.id === item.id)?.cell_ids`. (`findFolder`
   already exists at module scope in `ProjectsPage.tsx`.)
2. Rework `explodeReplicate.mutationFn` to accept richer payload:
   `{ groups: { groupId: number; folderId: number; cellIds: number[] }[] }`.
   - `await post('/api/replicate-groups/ungroup', { group_ids: groups.map(g => g.groupId) })`
   - then `for (g of groups) if (g.folderId != null) await post('/api/folders/'+g.folderId+'/cells', { cell_ids: g.cellIds })`
3. Update the context-menu (and any toolbar) call sites to build this payload.
   - Backend caveat: verify the group's `cell_ids` are still readable **before** ungroup (the
     group is deleted by ungroup). Capture them client-side from the tree first (step 1), so
     order does not matter, but do the folder-add **after** ungroup so the cells are standalone.

**Acceptance:** Exploding a replicate that lived in folder F leaves its cells filed in folder F.

---

## Part B — Item 2: read-only protocol-structure viewer (C-rate & Chargeability)

### Goal

In the **automatic identification** panels of the C-rate and Chargeability tabs, add a button
that opens a modal showing the cell's **protocol step structure** (the same nested tree the
Steps/segment editor shows), but **read-only** — no checkboxes, no selection — purely to
inspect and navigate the protocol, with the steps the **automatic parser selected** clearly
highlighted.

### Data available (no backend change needed for the highlight)

- Protocol structure: `GET /api/cells/{cellId}/protocol?include_observed=true` → `CellProtocol`
  with `tests[].files[].protocol` (`FileProtocol` has `groups` nested tree + `steps[]`). This
  is exactly what `ProtocolSegmentsPanel` fetches.
- Selected step indices per cell:
  - **Rate capability** (`RateCapabilityPlotCard.tsx`): each point has
    `measurement_step_index: number` (see `RateCapabilityPoint`). Collect, per cell, the set of
    `measurement_step_index` across that cell's blocks/points.
  - **Chargeability** (`ChargeabilityPlotCard.tsx`): each match has `step_index: number` (see
    the match/candidate types). Collect per cell.

### Component to build

Create `frontend/src/components/ProtocolStructureViewer.tsx` (read-only). Reuse the existing
nested renderer where possible:

- `ProtocolSegmentsPanel.tsx` already contains `ProtocolGroupNode`, `familyGroups`,
  `groupSteps`, `normalizeGroup`, and the `STEP_GRID` table styling. These are currently
  **not exported** and are coupled to selection (checkboxes + `onToggleSteps`).
- Two options:
  - (a) **Extract** a presentational, selection-free variant of `ProtocolGroupNode` into a
    shared module (e.g. `ProtocolTree.tsx`) that takes `highlightedSteps: Set<number>` instead
    of `selectedSet` + `onToggleSteps`, renders no checkboxes, and tints highlighted step rows
    (e.g. `teal.0` background + a small "auto-selected" badge). Refactor `ProtocolSegmentsPanel`
    to consume the shared tree with its selection props layered on top. **Preferred** but more
    invasive.
  - (b) Build a **standalone** simplified tree in `ProtocolStructureViewer` that walks
    `familyGroups(family)` / `group.all_step_numbers` and renders group headers + a flat step
    table per group, highlighting `highlightedSteps`. Less code shared, lower risk. **Acceptable
    fallback.**
- The viewer is a `Modal` (wide, like the segment editor: `size="min(1100px, calc(100vw -
  3rem))"`, `centered`). Contents:
  - A protocol/cell selector when multiple cells/protocols are in the analysis (reuse the
    `ProtocolPicker` pattern, or a simple `Select` of cells). For a single cell, skip it.
  - A legend line: "Highlighted steps were selected by the automatic parser."
  - The read-only tree in a `ScrollArea` (fixed height ~`min(60vh, 620px)`).
  - No Save/Apply — just a Close button (and it must not mutate spec).

### Wiring

- **Rate capability** (`RateCapabilityPlotCard.tsx`, `RateCapabilitySettings`): in the
  automatic-recognition section (grep `FamilyRecognitionRules` / the recognition controls),
  add a button **"Show detected steps"** (icon `IconListSearch` or similar) that opens the
  viewer. Pass the per-cell highlighted step set built from `result.blocks[*].points[*]
  .measurement_step_index` (grouped by `cell_id`).
- **Chargeability** (`ChargeabilityPlotCard.tsx`, `ChargeabilitySettings`): same, highlighting
  from `result.matches[*].step_index` grouped by `cell_id`.
- The cell/protocol dropdown in the viewer selects which cell's protocol + highlight set to
  show.

### Acceptance

- Button appears in both C-rate and Chargeability auto-identification panels.
- Modal shows the nested protocol structure, navigable (expand/collapse groups), **no
  checkboxes**, **no selection side effects**.
- Steps the parser used are visibly highlighted; switching the cell dropdown updates both the
  protocol and the highlight set.
- Closing the modal leaves the analysis spec unchanged.

---

## Part C — Item 9: realistic recognition progress (C-rate, and Chargeability/DCIR)

### Problem

Opening the C-rate tab on a cycling cell shows a bare spinner while
`rate_capability.compute` runs its recognition. The user wants a **realistic** progress bar.

### What already exists (backend)

- `rate_capability.compute(db, spec, provenance, *, use_current_versions, progress=None)`
  (`backend/app/services/rate_capability.py`, ~line 846) **already** accepts a
  `ProgressCallback = Callable[[int, int, str, str], None]` and calls it **per cell**:
  `progress(cell_index-1, len(cells), cell.name, "Detecting rate sweeps")` and again
  `progress(cell_index, len(cells), cell.name, "Rate sweeps detected")` (~lines 877–988).
- The router endpoint `POST /api/analyses/{id}/rate-capability`
  (`backend/app/routers/analyses.py`, ~line 806) **already** opens a background job when
  `req.job_token` is provided (`_open_compute_job(..., "rate_capability", req.job_token)`) and
  passes `progress=_progress_callback(job_id)`. `_progress_callback` updates the job's
  `description` (`"Preparing plot data (k/N cells)"`), item status, and counters.
- Poll endpoint: `GET /api/background-jobs/by-token/{token}` returns the job (with
  `description`, `counters`, item statuses) or `null` before it is created.
- Chargeability and DCIR endpoints follow the same shape (check whether their `compute`
  functions call `progress`; add per-cell calls if missing).

### What is missing (frontend) — the core of this task

The rate-capability query (`useRateCapabilityResult` in `RateCapabilityPlotCard.tsx`) posts to
`/api/analyses/{id}/rate-capability` **without** a `job_token`, so no job is created and the
UI only has `isLoading`. Fix:

1. **Send a job token.** Mirror the cycle/time-capacity pattern in `AnalysisPage.tsx` (grep
   `newComputeToken` / `job_token` / `setComputeToken`): generate a token, include
   `job_token` in the POST body, and keep the token in state for the duration of the request.
2. **Poll job progress while loading.** While the query `isLoading`/`isFetching` and a token is
   set, poll `GET /api/background-jobs/by-token/{token}` (React Query with `refetchInterval`
   ~400–600ms, `enabled` only while loading). Read `description` and `counters`
   (`{cached, reparsed, ...}`) and the completed/total from the description or item statuses.
3. **Render a progress bar** in place of the spinner: a Mantine `Progress` with
   `value = completed/total * 100` plus the current stage text (the job `description` /
   per-item `detail`). Fall back to an indeterminate/animated bar until the job appears.
4. Do the same for **Chargeability** and **DCIR** cards (shared helper recommended — see
   below).

### Important nuance: single-cell granularity

Per-cell progress is coarse: for **one** cell it jumps 0→100% with nothing in between, which is
the exact scenario the user hit ("if I have a cycling cell"). The slowness lives **inside** one
cell's recognition. To make the bar move for a single cell, add **intra-cell progress stages**:

- In `rate_capability.compute`, replace the single per-cell `progress` call with several
  stage calls that report a finer `(completed, total)` where `total = n_cells * n_stages`.
  Suggested stages per cell: `"Reading cycles"` → `"Detecting rate sweeps"` → `"Matching rate
  families"` → `"Building blocks"`. Emit `progress(done_units, total_units, cell.name, stage)`
  as each stage completes.
- `_progress_callback` records `completed`/`total` generically, so no router change is needed;
  but note it currently treats `completed=k` as "cell k finished" and dedupes via a `recorded`
  set and derives a "cached vs re-parsed" counter from the `detail` string. Review
  `_progress_callback` (`analyses.py` ~line 363) so finer-grained calls don't misfire the
  cached/re-parsed counters. Simplest: for these recognition tabs, have the callback (or a
  variant) just track `completed/total` + `description` without the cached/re-parsed
  bookkeeping, or pass a distinct `detail` that the callback maps to a generic "processing"
  status. Keep the cycle-tab callback behaviour unchanged.

If intra-cell stages are too invasive for a first pass, ship the per-cell bar (moves for
multi-cell) **plus** an animated/indeterminate `Progress` for the single-cell case with the
live stage label — that already reads as "realistic" and is much better than a bare spinner.
Document whichever you choose.

### Shared frontend helper

Because C-rate, Chargeability, and DCIR all have slow recognition, add a small reusable hook,
e.g. `useRecognitionProgress(token: string | null, enabled: boolean)` in a shared module
(near `AnalysisPage.tsx` exports or a new `frontend/src/recognitionProgress.ts`) that polls
`/api/background-jobs/by-token/{token}` and returns `{ percent, label, active }`, plus a
`RecognitionProgress` presentational component (Mantine `Progress` + label). Use it in all
three cards' loading states.

### Acceptance

- Opening the C-rate tab on an uncached cell shows a **progress bar with a live stage label**
  instead of a bare spinner; the bar advances as recognition proceeds and disappears when the
  plot renders.
- For multiple cells the bar advances per cell (k/N). For a single cell it either advances
  through intra-cell stages (preferred) or shows an animated bar with the current stage text.
- No behaviour change to the cycle-tab activity/progress. Cached loads still show no spurious
  progress (the job is only opened on a cache miss).
- Chargeability and DCIR get the same treatment (or a clearly-scoped follow-up if deferred).

---

## Cross-cutting: testing & DB hygiene

- **Do not** drive verification against the user's running app DB casually. The dev backend
  (port 8643) shares `~/.cellxplorer` with the user's running app (port 8642). Prefer
  `tsc --noEmit` + `vite build` for frontend correctness, and `pytest` for backend.
- Backend tests live in `tests/` (`pytest`); frontend unit tests are `node --test
  --experimental-strip-types frontend/tests/*.test.ts` (note: test files importing `.tsx`
  fail under node's type-stripping — a harness limitation, not a real failure).
- For any UI check, use the **"Test" analysis** and snapshot its spec to a file first.
- Presentation-only additions (nothing that changes computed data) must stay **out** of the
  analysis cache key: only `presentation.hidden_protocol_segment_ids` is included in
  `analysis_cache._scientific_spec`. New display flags added to `presentation` are
  automatically excluded — keep it that way so toggles never force a recompute.

## Suggested implementation order

1. A1, A4, A5 (small, high-value folder/replicate fixes; A4/A5 make grouping coherent).
2. A2 (create-modal folder placement; extract `FolderChecklist` first).
3. A3 (toolbar button — trivial once A-group is done).
4. Part C item 9 (frontend job-token + progress hook; then optional intra-cell stages).
5. Part B item 2 (read-only viewer; extract shared tree or build standalone).

After each part: `cd frontend && npx tsc --noEmit && npx vite build`, and `python -m pytest`
for any backend change.

---

# Review of the implementation — follow-up tasks

Reviewed 2026-07-24, after Parts A/B/C were implemented. **Overall: the implementation is
faithful to this spec and is accepted.** The items below are follow-ups, not a rejection.

## What the review verified (do not redo)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vite build` | exit 0 |
| `python -m pytest tests/` | 279 passed, 34 subtests |
| `node --test --experimental-strip-types frontend/tests/*.test.ts` | 75 pass, 2 fail |

The 2 frontend failures are `cellSamplePopovers.test.ts` and `protocolGroups.test.ts`, both
failing with `ERR_UNKNOWN_FILE_EXTENSION ... .tsx`. This is the **pre-existing** node
type-stripping limitation documented above, unchanged by this work. Do not try to "fix" it as
part of these follow-ups.

Confirmed correct by reading the code (no action needed):

- `_recognition_progress_callback` is a **separate** reporter; `_progress_callback` (cycles /
  steps / time_capacity) is untouched, so the cached vs re-parsed counters still behave.
  Endpoint split verified: dcir / chargeability / rate_capability use the recognition
  reporter.
- `_finish_job` re-fetches the job **after** compute, so the recognition callback's enlarged
  `total` is in effect when it sets `completed = total`. The bar ends at 100%, not 25%.
- Intra-cell stages exist (4 per cell in `rate_capability`, matching in `chargeability`), so
  single-cell recognition advances.
- `buildExplodePayload` reads `cell_ids` from the tree **before** ungroup, then re-files after
  — the ordering trap is avoided.
- `buildGroupAsReplicatePayload`'s `cells[0].label` is safe: both call sites are gated on
  `>= 2` cells.
- `CellDetailTabs.tsx` has zero "Place in folders" references — the A1 revert is complete.

## R1. Recognition job items stay "queued" in the Activity popover

**Priority: medium** (cosmetic, but user-visible and looks like a hang).

**Where:** `backend/app/routers/analyses.py` — `_recognition_progress_callback` (~line 402)
and `_finish_job` (~line 428). UI that exposes it: `frontend/src/App.tsx` ~line 677, which
renders a status `Badge` per `job.items[]` entry.

**Current:** `_open_compute_job` creates one item per selected cell with
`status: "queued"`. `_recognition_progress_callback` only calls `background_jobs.update_job(...)`
— it never calls `update_item` or `record_result`. `_finish_job` only sweeps queued items to
`ready` inside its `if cached:` branch. So after a **successful, uncached** DCIR / C-rate /
chargeability recognition, the Activity entry shows the job header as `completed` while every
per-cell row underneath still shows a gray **"queued"** badge.

**Target:** per-cell rows must reflect reality by the time the job completes. Either fix is
acceptable; (a) is simpler and lower-risk:

- **(a)** In `_finish_job`, when `error is None`, sweep any still-`queued` items to `ready`
  regardless of the `cached` flag. Give the non-cached case a neutral detail such as
  `"Recognition complete"` (do **not** set `counter="cached"` for recognition jobs — that would
  pollute the cached/re-parsed summary that the cycle path builds).
- **(b)** Have `_recognition_progress_callback` mark progress per cell: it already receives
  `label` (the cell name). Map `label` → item id from the job's `items` list, set the current
  cell's item to `processing`, and mark the previous cell's item `ready`. More faithful, more
  code.

**Do not** change `_progress_callback` or the cycle/steps/time_capacity paths.

**Acceptance:** run an uncached C-rate recognition, open the Activity popover: the job reads
`completed` **and** no per-cell row is left badged `queued`. The cycle-tab Activity entry still
reads e.g. "Re-parsed 1 source file, read 24 from cache" exactly as before. `pytest` stays
green (add/adjust a `tests/` case if one asserts on job item status).

## R2. Create-replicate folder prefill can clobber the user's clicks

**Priority: low–medium** (narrow race, but it is the same failure mode as the A0 bug).

**Where:** `frontend/src/pages/LibraryPage.tsx`, the handler that opens the create-replicate
dialog (grep `setGroupDialogOpen(true)`, ~line 886).

**Current:**

```ts
setGroupFolderIds(foldersContainingCells(tree.data?.folders ?? [], selectedIds));
void qc.ensureQueryData({ queryKey: ["tree"], queryFn: ... }).then((data) => {
  setGroupFolderIds(foldersContainingCells(data.folders ?? [], selectedIds));  // <- overwrites
});
setGroupDialogOpen(true);
```

The modal opens immediately. On a **warm** tree cache the `.then()` resolves in a microtask and
is harmless. On a **cold** cache the fetch can take hundreds of ms while the dialog is already
interactive — any folder the user ticks or unticks in that window is silently reset. This is
the same class of bug as A0 (state reset stomping a fresh click).

**Target:** the async refresh must never override a user decision.
- Add a ref, e.g. `const groupFoldersTouched = useRef(false)`; set it to `true` in the
  `FolderChecklist` `onToggle`; reset it to `false` when the dialog opens.
- In the `.then()`, apply the refreshed prefill **only if** `!groupFoldersTouched.current`.
- Reset the ref alongside `setGroupFolderIds(new Set())` in `createReplicateGroup.onSuccess`.

**Acceptance:** with a cold tree cache (hard-reload the app), open "Group selected as
replicate", immediately tick a folder before the list settles — the tick survives. With a warm
cache the pre-checked folders still reflect where the source cells live.

## R3. `ProtocolStructureViewer` fetches the protocol under a duplicate query key

**Priority: nit** (one redundant request; no incorrect behaviour).

**Where:** `frontend/src/components/ProtocolStructureViewer.tsx` ~line 291.

**Current:** `queryKey: ["cell-protocol", cellId, "structure-viewer"]` for
`GET /api/cells/{cellId}/protocol?include_observed=true`. `ProtocolSegmentsPanel` already
caches the **identical URL** under `["cell-protocol", cellId, "with-observed-steps"]`, so
opening the viewer refetches data the app already holds.

**Target:** use the same key suffix (`"with-observed-steps"`) so the two share one cache entry.
Verify the URL and options match exactly before merging the keys — if they ever diverge
(different query params), keep them separate instead.

**Acceptance:** opening the viewer on a cell whose protocol was already loaded issues no new
network request (check the network panel or `read_network_requests`).

## Follow-up order and verification

1. R1 (backend + one UI check), 2. R2 (frontend), 3. R3 (nit).

After R1: `python -m pytest tests/ -q`. After R2/R3: `npx tsc --noEmit && npx vite build`.
Re-run `node --test --experimental-strip-types frontend/tests/*.test.ts` and expect the same
75 pass / 2 pre-existing `.tsx` failures — no new failures.

## Still unverified in a browser (worth a manual pass)

The reviewer did not drive the app, because the dev backend (8643) shares `~/.cellxplorer` with
the user's running app (8642) and A4/A5 mutate real folder/replicate data. Highest-value manual
checks:

- **A4/A5 round-trip:** group 2 cells in a folder → the cells disappear from that folder and
  the replicate appears; explode it → the cells reappear **in that same folder**.
- **Part C on a single cycling cell** (the original complaint): the bar visibly advances
  through the four stages instead of sitting at 0 until completion.
- **A2 on a cold cache:** see R2.
