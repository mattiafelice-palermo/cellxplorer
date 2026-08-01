export type LibrarySelectionScope = {
  allPageSelected: boolean;
  allMatchingSelected: boolean;
  showSelectAllMatchingPrompt: boolean;
};

export function getLibrarySelectionScope(
  pageIds: readonly number[],
  matchingIds: readonly number[],
  selectedIds: ReadonlySet<number>,
): LibrarySelectionScope {
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const allMatchingSelected =
    matchingIds.length > 0 && matchingIds.every((id) => selectedIds.has(id));
  return {
    allPageSelected,
    allMatchingSelected,
    showSelectAllMatchingPrompt:
      allPageSelected &&
      matchingIds.length > pageIds.length &&
      !allMatchingSelected,
  };
}

export function selectAllMatchingCellIds(matchingIds: readonly number[]): Set<number> {
  return new Set(matchingIds);
}

export function hasActiveCellLibraryFilters(
  searchQuery: string,
  filters: Record<string, unknown>,
): boolean {
  if (searchQuery.trim()) return true;
  return Object.values(filters).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== null && value !== undefined;
  });
}
