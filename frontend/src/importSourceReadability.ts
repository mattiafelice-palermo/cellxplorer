import type { ImportBrowseEntry } from "./api";

export type SourceRejectionKind = "unsupported" | "invalid";
export type ImportSourceRejection = {
  path: string;
  version: string;
  error: string;
  kind: SourceRejectionKind;
  requestGeneration?: number;
};

export class ImportSourceRejectedError extends Error {
  readonly sourceErrorKind: SourceRejectionKind;
  constructor(message: string, sourceErrorKind: SourceRejectionKind) {
    super(message);
    this.sourceErrorKind = sourceErrorKind;
  }
}

export function importSourceVersion(entry: Pick<ImportBrowseEntry, "size" | "modified_at">): string {
  return `${entry.size ?? "unknown"}:${entry.modified_at ?? "unknown"}`;
}

export function importSourcePathKey(path: string): string {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

export function importSourceRejection(
  entry: ImportBrowseEntry, rejections: ReadonlyMap<string, ImportSourceRejection>,
): ImportSourceRejection | undefined {
  if (entry.kind !== "file") return undefined;
  const rejection = rejections.get(importSourcePathKey(entry.path));
  if (!rejection) return undefined;
  // Unknown staged identities cannot establish that a known-bad path changed.
  return rejection.version === importSourceVersion(entry)
    || (entry.size == null && entry.modified_at == null) ? rejection : undefined;
}

export function recordImportSourceRejection(
  rejections: ReadonlyMap<string, ImportSourceRejection>, rejection: ImportSourceRejection,
  currentEntry: ImportBrowseEntry | undefined,
  currentGeneration?: number,
): Map<string, ImportSourceRejection> {
  const next = new Map(rejections);
  if ((currentGeneration !== undefined && rejection.requestGeneration !== currentGeneration)
    || !currentEntry || currentEntry.kind !== "file"
    || rejection.version !== importSourceVersion(currentEntry)) return next;
  const key = importSourcePathKey(rejection.path);
  next.delete(key);
  next.set(key, rejection);
  while (next.size > 1024) next.delete(next.keys().next().value!);
  return next;
}

export function pruneRejectedImportSelection(
  selected: ReadonlyMap<string, ImportBrowseEntry>, rejections: ReadonlyMap<string, ImportSourceRejection>,
): Map<string, ImportBrowseEntry> {
  return new Map([...selected].filter(([, entry]) => !importSourceRejection(entry, rejections)));
}

/** Refresh rechecks server identity even when size/modified time were preserved. */
export function resetImportSourceRejections(
  rejections: ReadonlyMap<string, ImportSourceRejection>, paths: readonly string[],
): Map<string, ImportSourceRejection> {
  const keys = new Set(paths.map(importSourcePathKey));
  return new Map([...rejections].filter(([key]) => !keys.has(key)));
}
