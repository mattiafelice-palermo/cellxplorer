export interface ImportNameDraft {
  cell_name: string;
  filename: string;
  staged_name: string;
}

export interface ImportNameConflict {
  name: string;
  drafts: ImportNameDraft[];
}

export function defaultImportCellName(file: {
  barcode?: string | null;
  filename: string;
}): string {
  return file.barcode || file.filename.replace(/\.[^.\\/]+$/, "");
}

/** Return trimmed Cell-name collisions without changing the user's draft text. */
export function importNameConflicts(
  drafts: readonly ImportNameDraft[],
): ImportNameConflict[] {
  const grouped = new Map<string, ImportNameDraft[]>();
  for (const draft of drafts) {
    const name = draft.cell_name.trim();
    if (!name) continue;
    const entries = grouped.get(name) ?? [];
    entries.push(draft);
    grouped.set(name, entries);
  }
  return Array.from(grouped, ([name, groupedDrafts]) => ({ name, drafts: groupedDrafts }))
    .filter((conflict) => conflict.drafts.length > 1);
}

export function hasImportNameConflicts(drafts: readonly ImportNameDraft[]): boolean {
  return importNameConflicts(drafts).length > 0;
}
