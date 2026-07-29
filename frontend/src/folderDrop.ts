/**
 * Rules for dragging library items between project folders.
 *
 * Extracted from `ProjectsPage` because the interesting part is a decision, not a
 * rendering concern, and because getting it wrong destroys data: before spec 024,
 * dropping a cell onto the folder it already lived in issued a move whose backend
 * implementation (add-to-target, then delete-from-source) removed the cell's only
 * membership row. The cell silently vanished from the folder.
 *
 * The backend now refuses same-folder moves as well. These helpers keep the client
 * from asking in the first place, and let the UI stop advertising a drop that would
 * do nothing.
 */

export type DropItemKind = "folder" | "cell" | "replicate_group" | "analysis";

export type DropItem = {
  kind: DropItemKind;
  id: number;
  /**
   * The folder the item is currently filed in. For a `folder` item this is the
   * folder's *own* id, not its parent — the tree rows carry no parent reference.
   */
  folderId: number;
};

/**
 * Bucket items by the folder they come from, dropping anything already filed in
 * `targetFolderId`.
 *
 * A multi-selection can span several source folders, so the guard has to be per
 * item: dropping a mixed A+B selection onto A must still move B's items. Order
 * within each bucket follows the input order.
 */
export function groupTransfersBySource(
  items: DropItem[],
  targetFolderId: number
): Map<number, number[]> {
  const bySource = new Map<number, number[]>();
  for (const item of items) {
    if (item.folderId === targetFolderId) continue;
    const ids = bySource.get(item.folderId) ?? [];
    ids.push(item.id);
    bySource.set(item.folderId, ids);
  }
  return bySource;
}

/**
 * True when every dragged item already sits where it would land, so the drop
 * changes nothing and should not be offered as a drop target.
 *
 * An empty selection is not a no-op — there is no drag in progress to suppress,
 * and treating it as one would kill the highlight for drags whose payload we
 * could not read (`dataTransfer` is opaque during `dragover`).
 */
export function isNoOpDrop(items: DropItem[], targetFolderId: number): boolean {
  if (items.length === 0) return false;
  return items.every((item) =>
    // A folder dropped on *itself* does nothing (the backend answers 422). A folder
    // dropped on its current parent is not detectable here — `folderId` is the
    // folder's own id — but that move is a harmless assignment, so it may proceed.
    item.kind === "folder" ? item.id === targetFolderId : item.folderId === targetFolderId
  );
}
