import type { ImportBrowseEntry } from "./api";

export type ImportSelection = ReadonlyMap<string, ImportBrowseEntry>;

export type ImportRowAction = "navigate" | "toggle";

export type FolderSelectionState = "none" | "some" | "all";

export type ImportSelectionUpdate = {
  selected: Map<string, ImportBrowseEntry>;
  lastSelectedPath: string | null;
};

export type ImportKeyboardAction = ImportRowAction | null;

export type ImportShownSelectionState = {
  entries: ImportBrowseEntry[];
  allSelected: boolean;
  someSelected: boolean;
  disabled: boolean;
};

export const IMPORT_BROWSER_LEFT_PANE_MIN = 200;
export const IMPORT_BROWSER_LEFT_PANE_MAX = 400;
export const IMPORT_BROWSER_RIGHT_PANE_MIN = 560;
export const IMPORT_BROWSER_RESIZE_HANDLE_WIDTH = 12;

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

export function importSelectableEntries(
  visibleEntries: readonly ImportBrowseEntry[],
  isFolderSelectable: (entry: ImportBrowseEntry) => boolean = () => true,
): ImportBrowseEntry[] {
  return visibleEntries.filter(
    (entry) => entry.kind === "file" || isFolderSelectable(entry),
  );
}

function isShownEntrySelected(
  entry: ImportBrowseEntry,
  selected: ImportSelection,
): boolean {
  return entry.kind === "folder"
    ? folderSelectionState(entry, selected) === "all"
    : selected.has(entry.path);
}

export function importShownSelectionState(
  visibleEntries: readonly ImportBrowseEntry[],
  selected: ImportSelection,
  isFolderSelectable: (entry: ImportBrowseEntry) => boolean = () => true,
): ImportShownSelectionState {
  const entries = importSelectableEntries(visibleEntries, isFolderSelectable);
  const selectedCount = entries.filter((entry) => isShownEntrySelected(entry, selected)).length;
  const partiallySelected = entries.some(
    (entry) => entry.kind === "folder" && folderSelectionState(entry, selected) === "some",
  );
  return {
    entries,
    allSelected: entries.length > 0 && selectedCount === entries.length,
    someSelected: selectedCount > 0 || partiallySelected,
    disabled: entries.length === 0,
  };
}

export function toggleImportShownSelection(
  selected: ImportSelection,
  visibleEntries: readonly ImportBrowseEntry[],
  isFolderSelectable: (entry: ImportBrowseEntry) => boolean = () => true,
): Map<string, ImportBrowseEntry> {
  const state = importShownSelectionState(visibleEntries, selected, isFolderSelectable);
  const next = new Map(selected);
  if (state.allSelected) {
    state.entries.forEach((entry) => {
      // Clearing the shown scope must not remove independently selected paths
      // hidden by the current search or directory. A folder's own path is the
      // visible selection representation; its descendants remain untouched.
      next.delete(entry.path);
    });
    return next;
  }
  state.entries.forEach((entry) => {
    if (entry.kind === "folder") {
      const selectedFolder = toggleImportFolderSelection(next, entry);
      next.clear();
      selectedFolder.forEach((value, key) => next.set(key, value));
    } else {
      next.set(entry.path, entry);
    }
  });
  return next;
}

export function maxImportBrowserLeftPaneWidth(containerWidth: number): number {
  return Math.max(
    IMPORT_BROWSER_LEFT_PANE_MIN,
    Math.min(
      IMPORT_BROWSER_LEFT_PANE_MAX,
      Math.floor(containerWidth - IMPORT_BROWSER_RIGHT_PANE_MIN - IMPORT_BROWSER_RESIZE_HANDLE_WIDTH),
    ),
  );
}

export function clampImportBrowserLeftPaneWidth(
  width: number,
  containerWidth = Number.POSITIVE_INFINITY,
): number {
  return Math.min(
    maxImportBrowserLeftPaneWidth(containerWidth),
    Math.max(IMPORT_BROWSER_LEFT_PANE_MIN, Math.round(width)),
  );
}

/** Selecting a folder is represented by its folder path; import selection expands it for review. */
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
