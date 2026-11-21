export const importedCellHighlightKey = ["imported-cell-highlight"] as const;

export interface ImportedCellHighlight {
  pending: number[];
  reveal: number[];
  expiresAt: number;
}

export function queueImportedCells(previous: ImportedCellHighlight | null | undefined, ids: number[], now: number) {
  const pending = previous && previous.expiresAt > now ? previous.pending : [];
  return {
    pending: [...new Set([...pending, ...ids])],
    reveal: ids,
    expiresAt: now + 60_000,
  };
}

// Prefer a new row on the current page. Otherwise reveal the first matching
// new row in the user's existing sort and filter order.
export function importRevealTarget(
  rows: readonly { cell: { id: number } }[], ids: readonly number[], page: number, size: number,
) {
  const targets = new Set(ids);
  const start = (page - 1) * size;
  const indexOnPage = rows.slice(start, start + size).findIndex(row => targets.has(row.cell.id));
  const index = indexOnPage >= 0 ? start + indexOnPage : rows.findIndex(row => targets.has(row.cell.id));
  return index < 0 ? null : { id: rows[index].cell.id, page: Math.floor(index / size) + 1 };
}
