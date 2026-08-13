export type ImportInspectionFailure = {
  path: string;
  filename: string;
  error: string;
};

export function importInspectionFailurePathSet(
  failures: readonly ImportInspectionFailure[],
): Set<string> {
  return new Set(failures.map((failure) => failure.path.toLocaleLowerCase()));
}

export function importSelectableInspectionPaths(
  paths: readonly string[],
  failures: readonly ImportInspectionFailure[],
): string[] {
  const failed = importInspectionFailurePathSet(failures);
  return paths.filter((path) => !failed.has(path.toLocaleLowerCase()));
}

export function mergeImportInspectionFailures(
  existing: readonly ImportInspectionFailure[],
  incoming: readonly ImportInspectionFailure[],
): ImportInspectionFailure[] {
  const merged = new Map<string, ImportInspectionFailure>();
  for (const failure of [...existing, ...incoming]) {
    const key = failure.path.toLocaleLowerCase();
    if (!merged.has(key)) merged.set(key, failure);
  }
  return [...merged.values()];
}

export function importInspectionCandidateMatchesSearch(
  filename: string,
  relativePath: string,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return filename.toLocaleLowerCase().includes(normalized)
    || relativePath.toLocaleLowerCase().includes(normalized);
}
