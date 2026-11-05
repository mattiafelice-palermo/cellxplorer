import { importPathsEqual } from "./importPathBreadcrumbs.ts";

/** Successful folder locations only; refresh and failed requests never add a visit. */
export function recordImportFolderVisit(
  history: readonly string[],
  path: string,
  backTarget: string | null = null,
): readonly string[] {
  const current = history[history.length - 1];
  if (current && importPathsEqual(current, path)) return history;
  if (backTarget && importPathsEqual(backTarget, path)
    && history.length > 1 && importPathsEqual(history[history.length - 2], path)) {
    return history.slice(0, -1);
  }
  return [...history, path].slice(-100);
}

export function previousImportFolder(history: readonly string[]): string | null {
  return history.length > 1 ? history[history.length - 2] : null;
}
