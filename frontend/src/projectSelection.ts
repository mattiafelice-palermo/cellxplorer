/**
 * Pure selection rules shared by the Projects click and keyboard handlers.
 * Keeping this outside the page prevents the rendered tree and its selection
 * scope rules from drifting apart.
 */

export type ProjectSelectionItem = {
  key: string;
  kind: "folder" | "cell" | "replicate_group" | "analysis";
  folderId: number;
};

export type ProjectSelectionModifiers = {
  range: boolean;
  toggle: boolean;
};

export function projectSelectionScope(item: ProjectSelectionItem): string {
  if (item.kind === "folder") return "folders";
  if (item.kind === "analysis") return `analyses:${item.folderId}`;
  return `samples:${item.folderId}`;
}

export function projectSelectionAfterClick(
  currentKeys: ReadonlySet<string>,
  visibleItems: readonly ProjectSelectionItem[],
  anchorKey: string | null,
  clicked: ProjectSelectionItem,
  modifiers: ProjectSelectionModifiers,
): Set<string> {
  const clickedScope = projectSelectionScope(clicked);
  const byKey = new Map(visibleItems.map((item) => [item.key, item]));
  const compatibleCurrent = [...currentKeys].every((key) => {
    const item = byKey.get(key);
    return item !== undefined && projectSelectionScope(item) === clickedScope;
  });

  if (modifiers.range && anchorKey) {
    const scoped = visibleItems.filter(
      (item) => projectSelectionScope(item) === clickedScope,
    );
    const start = scoped.findIndex((item) => item.key === anchorKey);
    const end = scoped.findIndex((item) => item.key === clicked.key);
    if (start >= 0 && end >= 0) {
      const [from, to] = start < end ? [start, end] : [end, start];
      return new Set(scoped.slice(from, to + 1).map((item) => item.key));
    }
  }

  if (modifiers.toggle && compatibleCurrent) {
    const next = new Set(currentKeys);
    if (next.has(clicked.key)) next.delete(clicked.key);
    else next.add(clicked.key);
    return next;
  }

  return new Set([clicked.key]);
}

export function adjacentProjectSelectionItem<T extends ProjectSelectionItem>(
  visibleItems: readonly T[],
  currentKey: string | null,
  direction: -1 | 1,
): T | null {
  if (!currentKey) return null;
  const current = visibleItems.find((item) => item.key === currentKey);
  if (!current) return null;
  const scope = projectSelectionScope(current);
  const scoped = visibleItems.filter((item) => projectSelectionScope(item) === scope);
  const index = scoped.findIndex((item) => item.key === currentKey);
  return scoped[index + direction] ?? null;
}

export function adjacentListItem<T>(
  items: readonly T[],
  current: T | null,
  direction: -1 | 1,
): T | null {
  if (current === null) return null;
  const index = items.indexOf(current);
  if (index < 0) return null;
  return items[index + direction] ?? null;
}
