import type { ImportPreview } from "./api";

export type ImportInspectionFailure = {
  path: string;
  filename: string;
  error: string;
};

type ImportInspectionIdentity = Pick<ImportPreview, "hash" | "source_path" | "import_match">;

function normalizeInspectionPath(path: string): string {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

/** Count only eligible identities introduced by this inspection batch. */
export function countNewImportableInspectionFiles(
  files: readonly ImportInspectionIdentity[],
  existing: readonly ImportInspectionIdentity[],
  append: boolean,
): number {
  const existingHashes = new Set(
    (append ? existing : []).map((file) => file.hash.toLowerCase()).filter(Boolean),
  );
  const existingPaths = new Set(
    (append ? existing : [])
      .map((file) => file.source_path?.trim())
      .filter((path): path is string => Boolean(path))
      .map(normalizeInspectionPath)
  );
  const batchHashes = new Set<string>();
  const batchPaths = new Set<string>();
  let count = 0;

  for (const file of files) {
    const hash = file.hash.toLowerCase();
    const path = file.source_path?.trim() ? normalizeInspectionPath(file.source_path.trim()) : "";
    if (
      (hash && (existingHashes.has(hash) || batchHashes.has(hash)))
      || (path && (existingPaths.has(path) || batchPaths.has(path)))
    ) continue;

    if (hash) batchHashes.add(hash);
    if (path) batchPaths.add(path);
    if (!(file.import_match?.kind === "exact_duplicate" && file.import_match.registered === true)) {
      count += 1;
    }
  }

  return count;
}

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
