import type { ImportBrowseEntry } from "./api";

export type ImportSelection = ReadonlyMap<string, ImportBrowseEntry>;

export type ImportRowAction = "navigate" | "toggle";

export type FolderSelectionState = "none" | "some" | "all";

export type ImportSelectionUpdate = {
  selected: Map<string, ImportBrowseEntry>;
  lastSelectedPath: string | null;
};

export type ImportKeyboardAction = ImportRowAction | null;

function normalizedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && /:\/$/.test(normalized)) return normalized.toLocaleLowerCase();
  return normalized.replace(/\/$/, "").toLocaleLowerCase();
}

export function isImportPathDescendant(folderPath: string, candidatePath: string): boolean {
  const folder = normalizedPath(folderPath);
  const candidate = normalizedPath(candidatePath);
  if (folder === candidate) return false;
  if (folder === "/") return candidate.startsWith("/");
  return candidate.startsWith(`${folder}/`);
}

function selectedPaths(selected: ImportSelection): Set<string> {
  return new Set([...selected.keys()].map(normalizedPath));
}

export function folderSelectionState(
  folder: ImportBrowseEntry,
  selected: ImportSelection,
  knownDescendantPaths: readonly string[] = [],
): FolderSelectionState {
  if (folder.kind !== "folder") return "none";

  const selectedPathSet = selectedPaths(selected);
  const folderSelected = selectedPathSet.has(normalizedPath(folder.path));
  const descendants = knownDescendantPaths.filter((path) =>
    isImportPathDescendant(folder.path, path),
  );
  const selectedDescendants = descendants.filter((path) => selectedPathSet.has(normalizedPath(path)));
  if (folderSelected || (descendants.length > 0 && selectedDescendants.length === descendants.length)) {
    return "all";
  }
  if (
    selectedDescendants.length > 0 ||
    [...selectedPathSet].some((path) => isImportPathDescendant(folder.path, path))
  ) {
    return "some";
  }
  return "none";
}

export function isImportFolderCheckboxDisabled(
  folder: ImportBrowseEntry,
  knownDescendantPaths: readonly string[] | boolean | undefined,
): boolean {
  if (folder.kind !== "folder") return true;
  if (typeof knownDescendantPaths === "boolean") return !knownDescendantPaths;
  return knownDescendantPaths !== undefined && knownDescendantPaths.length === 0;
}

/** Selecting a folder is represented by its folder path; the backend expands it recursively. */
export function toggleImportFolderSelection(
  selected: ImportSelection,
  folder: ImportBrowseEntry,
  knownDescendantEntries: readonly ImportBrowseEntry[] = [],
): Map<string, ImportBrowseEntry> {
  const next = new Map(selected);
  const descendants = knownDescendantEntries.filter(
    (entry) => entry.kind === "file" && isImportPathDescendant(folder.path, entry.path),
  );
  const state = folderSelectionState(
    folder,
    selected,
    descendants.map((entry) => entry.path),
  );
  if (state === "all") {
    next.delete(folder.path);
    [...next.keys()]
      .filter((path) => isImportPathDescendant(folder.path, path))
      .forEach((path) => next.delete(path));
  } else {
    next.set(folder.path, folder);
  }
  return next;
}

export function importRowAction(entry: ImportBrowseEntry): ImportRowAction {
  return entry.kind === "folder" ? "navigate" : "toggle";
}

export function importKeyboardAction(
  entry: ImportBrowseEntry,
  key: string,
): ImportKeyboardAction {
  if (key !== "Enter" && key !== " ") return null;
  return importRowAction(entry);
}

export function toggleImportFileSelection(
  entry: ImportBrowseEntry,
  visibleEntries: readonly ImportBrowseEntry[],
  selected: ImportSelection,
  lastSelectedPath: string | null,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): ImportSelectionUpdate {
  if (entry.kind !== "file") return { selected: new Map(selected), lastSelectedPath };

  const next = new Map(selected);
  const visibleFiles = visibleEntries.filter((candidate) => candidate.kind === "file");
  if (modifiers.shiftKey && lastSelectedPath) {
    const from = visibleFiles.findIndex((item) => item.path === lastSelectedPath);
    const to = visibleFiles.findIndex((item) => item.path === entry.path);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      const shouldSelect = !next.has(entry.path);
      visibleFiles.slice(start, end + 1).forEach((candidate) =>
        shouldSelect ? next.set(candidate.path, candidate) : next.delete(candidate.path),
      );
      return { selected: next, lastSelectedPath: entry.path };
    }
  }

  if (next.has(entry.path)) next.delete(entry.path);
  else next.set(entry.path, entry);
  return { selected: next, lastSelectedPath: entry.path };
}

export function resetImportBrowserNavigation(): {
  search: string;
  lastSelectedPath: null;
} {
  return { search: "", lastSelectedPath: null };
}
