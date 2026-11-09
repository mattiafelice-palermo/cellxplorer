import type { QueryClient } from "@tanstack/react-query";
export type ImportedCell = { id: number; name: string };
export function importedSourceLabel(cells: readonly ImportedCell[] = []): string {
  return cells.length ? `Already imported as ${cells.map(cell => `‘${cell.name}’`).join(", ")}.`
    : "Already imported; no current cell association.";
}
export function renamedImportedCells(cells: readonly ImportedCell[] | undefined, names: ReadonlyMap<number, string>) {
  return cells?.map(cell => names.has(cell.id) ? { ...cell, name: names.get(cell.id)! } : cell);
}
/** Existing library query updates carry names; never hash or parse on hover. */
export function subscribeImportedCellNames(client: QueryClient, onNames: (names: Map<number, string>) => void) {
  return client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const key = event.query.queryKey[0];
    if (key !== "cell" && key !== "cells") return;
    const data = event.query.state.data;
    const rows = Array.isArray(data) ? data : [data];
    const names = new Map<number, string>();
    for (const row of rows) if (row && typeof row.id === "number" && typeof row.name === "string") names.set(row.id, row.name);
    if (names.size) onNames(names);
  });
}
