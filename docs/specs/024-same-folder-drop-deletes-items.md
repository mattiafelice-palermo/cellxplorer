# 024 — Dropping an item into the folder it already lives in deletes it

**Status:** Implemented
**Branch:** `feature/same-folder-drop-fix`
**Scope:** backend (`routers/tree.py`) + frontend (`ProjectsPage.tsx`, new pure module) + tests
**Severity:** data loss — a user gesture that looks like a no-op silently removes a cell or a
replicate group from a folder.

## Symptom

In the Projects view, drag a cell onto the folder it is already in and drop it. The cell
disappears from that folder. Nothing warns the user; the row is simply gone on the next tree
refresh. The cell itself still exists in the Cell Database — only its folder membership is
destroyed — but from the user's point of view a file vanished from a folder.

## Root cause

Two independent misses. The backend is the one that actually destroys data.

### Backend — `move_folder_cells` / `move_folder_groups` (`backend/app/routers/tree.py`)

```python
add_cell_refs(db, target_folder_id, cell_ids)          # 1. add to target
db.query(FolderCell).filter(
    FolderCell.folder_id == source_folder_id,          # 2. delete from source
    FolderCell.cell_id.in_(cell_ids),
).delete(synchronize_session=False)
```

`add_cell_refs` reads the target folder's existing `cell_id` set and inserts only ids that are
**not** already present (`if cid not in existing`), because `FolderCell` has a
`UniqueConstraint("folder_id", "cell_id")`.

So when `source_folder_id == target_folder_id`:

1. step 1 is a **no-op** — the row is already there;
2. step 2 then deletes that same row.

Net effect: the only membership row is removed. `move_folder_groups` has the identical
add-then-delete shape against `FolderReplicateGroup`, so replicate groups are destroyed the
same way.

### Frontend — `transferCells` / `transferGroups` (`frontend/src/pages/ProjectsPage.tsx`)

`handleDropOnFolder` calls `transferCells(folder.id, copy, cellItems)` unconditionally; there is
no check that an item's `folderId` differs from the drop target. The same two functions also
back the **Move to** / **Copy to** destination picker (`openDestination`), so choosing the
folder an item is already in reproduces the bug without any dragging.

### Not affected

- **Analyses** move via `updateAnalysis({ folderId })` — an assignment, not add-then-delete.
- **Sub-folders** move via `moveFolder({ parent_id })` — also an assignment, and
  `update_folder` already rejects self-parenting (`"A folder cannot contain itself"`) and
  cycles (`folder_contains`).

Only cells and replicate groups are destroyed.

## Locked design decisions

1. **The guard is per item, not per drag.** A multi-selection can span several source folders
   (`transferCells` already buckets by `item.folderId`). Dropping a mixed selection on folder A
   must move B's and C's items normally while leaving A's items untouched. A blanket
   "drag originated here → ignore the whole drop" check is wrong and is explicitly rejected.
2. **The backend fix is an early return, not a reordering.** Deleting before adding would also
   avoid the data loss, but `add_cell_refs` assigns `position = next_folder_cell_position(...)`,
   so the row would silently jump to the end of the folder. Same-folder moves must preserve
   ordering exactly.
3. **The backend keeps validating first.** The early return happens *after* the existing
   404 checks so a request naming a nonexistent folder still fails, even when source == target.

## Tasks

### T1 — Backend: make a same-folder move a no-op

**File:** `backend/app/routers/tree.py`
**Current:** `move_folder_cells` and `move_folder_groups` add then delete unconditionally.
**Target:** after the existing `HTTPException(404, "No such folder")` validation, return early
when `source_folder_id == target_folder_id`. Add a comment naming the failure mode so the
add-then-delete order is not "cleaned up" back into a bug later.

**Acceptance:**
- `POST /api/folders/{id}/cells/move` with `source_folder_id == id` leaves the `FolderCell` row
  intact, with its original `position`.
- Same for `POST /api/folders/{id}/replicate-groups/move` and `FolderReplicateGroup`.
- A move naming a nonexistent source or target folder still returns 404.

### T2 — Frontend: skip same-folder buckets in the transfer helpers

**File:** `frontend/src/pages/ProjectsPage.tsx`
**Current:** `transferCells` / `transferGroups` bucket items by source folder and fire a
mutation for every bucket, including the bucket whose source is the target.
**Target:** the bucketing moves into a new pure module (T3) that omits the
`sourceFolderId === targetFolderId` bucket. Applies to both move and copy: copying an item into
the folder it is already in is a guaranteed no-op server-side (`add_cell_refs` dedupes), so the
request is pure noise.

Placing the guard in the transfer helpers — not in `handleDropOnFolder` — is deliberate: it
covers the destination-picker path (`copyTo` / `moveTo`) with the same code.

**Acceptance:**
- Dropping a cell on its own folder issues **no** network request.
- Dropping a selection spanning folders A and B onto A issues exactly one move request, for
  B's items only.
- Move to / Copy to → picking the item's current folder issues no request.

### T3 — Frontend: extract the drop rules into a tested pure module

**File (new):** `frontend/src/folderDrop.ts`
**File (new):** `frontend/tests/folderDrop.test.ts`

Follows the pattern established by `frontend/src/features/analyses/editor/artifacts/warmupCompletion.ts` — the decision logic is a
pure function with `node --test` coverage, so the rule is pinned without needing a browser.

Exports:

```ts
export type DropItem = { kind: "folder" | "cell" | "replicate_group" | "analysis"; id: number; folderId: number };

/** Bucket transferable items by source folder, omitting items already in `targetFolderId`. */
export function groupTransfersBySource(items: DropItem[], targetFolderId: number): Map<number, number[]>;

/** True when every dragged item already lives where it would land — the drop changes nothing. */
export function isNoOpDrop(items: DropItem[], targetFolderId: number): boolean;
```

`isNoOpDrop` rules, per kind:
- `cell`, `replicate_group`, `analysis` → no-op when `item.folderId === targetFolderId`.
- `folder` → no-op when `item.id === targetFolderId` (dropping a folder onto itself; the
  backend rejects this with 422 anyway). A folder dropped on its current *parent* is **not**
  treated as a no-op, because `DropItem` for a folder carries `folderId = its own id`, not its
  parent — the information is not available, and the resulting `moveFolder` is harmless.
- An empty item list is **not** a no-op (there is nothing to suppress).

**Acceptance:** tests cover — all-same-folder cells; mixed sources; empty list; folder-on-itself;
analyses; and that `groupTransfersBySource` preserves item order within a bucket.

### T4 — Frontend: stop advertising a no-op drop as a valid drop

**File:** `frontend/src/pages/ProjectsPage.tsx`
**Current:** `onDragOver` unconditionally calls `setDropTargetFolderId(folder.id)`, so a folder
highlights as a drop target even when the drop will do nothing. Before this spec that highlight
was actively misleading: the drop *did* do something — it deleted the row.
**Target:** when `isNoOpDrop(draggedItems, folder.id)` is true, do not set the drop-target
highlight and set `event.dataTransfer.dropEffect = "none"`.

**Constraint that dictates the implementation:** `dataTransfer.getData()` returns an empty
string during `dragover` (browsers only expose the payload on `drop`). The dragged items must
therefore be stashed in a ref at `dragstart`:

- add `dragItemsRef = useRef<DropItem[]>([])`;
- `handleDragStart` writes the same array it serialises into `dataTransfer`;
- `handleDropOnFolder` and a new `onDragEnd` clear it.

`drop` still parses `dataTransfer` as the authoritative payload — the ref is a hint for
`dragover` only, never the source of truth for what gets moved.

**Acceptance:**
- Dragging a cell over its own folder shows no drop highlight and a "no drop" cursor.
- Dragging that cell over any other folder highlights normally.
- Dragging a mixed A+B selection over A **does** highlight (the drop is not a no-op — B's
  items will move).
- Visual style guide applies: the existing `var(--mantine-primary-color-1)` highlight is
  unchanged for real drops; suppression means no highlight, not a new colour.

### T5 — Backend regression test

**File:** `tests/test_tree_folder_transfers.py` (new, or extend the existing tree test module if
one is present)

The UI guard alone is not enough — the endpoint stays reachable and must be safe on its own.

**Acceptance:** a test that creates a folder, files a cell in it, calls the move endpoint with
`source_folder_id == folder.id`, and asserts the cell is still in the folder. Equivalent test
for replicate groups. Plus a test that a genuine A→B move still moves.

## Implementation order

T1 → T5 (backend safe first, with its test) → T3 → T2 → T4.

## Verification

- `python -m pytest tests/test_tree_folder_transfers.py` (or the repo's `unittest` invocation).
- `node --test frontend/tests/folderDrop.test.ts` — note `frontend/tests/**` is outside the
  `tsc` program (`include` is `["src"]`).
- `npx tsc --noEmit` — required, `frontend/src/**` changed.
- `npx vite build` — required, `frontend/src/**` changed (new module in the entry graph).
- Manual: drag a cell onto its own folder; it must stay put and show no drop affordance.
