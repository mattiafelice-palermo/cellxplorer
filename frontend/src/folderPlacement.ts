/**
 * Pure placement-picker state for the additive "Place in folders" dialog.
 * Kept free of React/JSX so node --test can exercise it under type-stripping.
 */

export type PlacementCheckbox = "none" | "some" | "all" | "complete";

export type PlacementItemStatus = "already" | "will_add" | "not_here";

/** Checkbox render state from membership + staging (§6). */
export function placementCheckboxState(
  presentCount: number,
  selectionSize: number,
  staged: boolean,
): PlacementCheckbox {
  if (selectionSize <= 0) return "none";
  if (presentCount >= selectionSize) return "complete";
  if (staged) return "all";
  if (presentCount <= 0) return "none";
  return "some";
}

/** Right-pane status for one selected item in the highlighted folder. */
export function placementItemStatus(
  isPresent: boolean,
  staged: boolean,
): PlacementItemStatus {
  if (isPresent) return "already";
  if (staged) return "will_add";
  return "not_here";
}

/**
 * Footer summary (§5.4).
 * `itemsAdded` = distinct selected items that gain ≥1 new membership.
 * `foldersReceiving` = folders that gain ≥1 item.
 */
export function placementFooterSummary(args: {
  selectionEmpty: boolean;
  itemsAdded: number;
  foldersReceiving: number;
}): string {
  if (args.selectionEmpty) return "Nothing selected";
  if (args.itemsAdded <= 0 || args.foldersReceiving <= 0) {
    return "No folders selected";
  }
  const itemWord = args.itemsAdded === 1 ? "item" : "items";
  const folderWord = args.foldersReceiving === 1 ? "folder" : "folders";
  return `Adding ${args.itemsAdded} ${itemWord} to ${args.foldersReceiving} ${folderWord}`;
}

/** Whether Apply may run (something staged that will actually add membership). */
export function placementCanApply(itemsAdded: number, foldersReceiving: number): boolean {
  return itemsAdded > 0 && foldersReceiving > 0;
}

export function folderContentCount(folder: {
  cells: unknown[];
  replicate_groups: unknown[];
  analyses: unknown[];
}): number {
  return folder.cells.length + folder.replicate_groups.length + folder.analyses.length;
}

/** Collect ancestor ids for every folder that currently holds any of the selection. */
export function ancestorsOfPresentFolders(
  roots: { id: number; parent_id: number | null; children: unknown[] }[],
  presentFolderIds: Set<number>,
): Set<number> {
  const byId = new Map<number, { id: number; parent_id: number | null }>();
  const walk = (nodes: { id: number; parent_id: number | null; children: unknown[] }[]) => {
    for (const node of nodes) {
      byId.set(node.id, node);
      walk(node.children as typeof nodes);
    }
  };
  walk(roots);
  const ancestors = new Set<number>();
  for (const folderId of presentFolderIds) {
    let current = byId.get(folderId)?.parent_id ?? null;
    while (current != null) {
      ancestors.add(current);
      current = byId.get(current)?.parent_id ?? null;
    }
  }
  return ancestors;
}

/** Case-insensitive name match; keep ancestors of matches visible. */
export function folderMatchesSearch(
  name: string,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle);
}
