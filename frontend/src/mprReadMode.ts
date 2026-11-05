import type { ImportBrowseEntry, ImportInspectResult, MprReadMode } from "./api";
import { importSourcePathKey } from "./importSourceReadability.ts";

export type MprReadModes = Readonly<Record<string, MprReadMode>>;

/** Offer a retry, never a promise that a structurally unsupported file will decode. */
export function canTryPermissiveMpr(entry: ImportBrowseEntry, blocked: boolean): boolean {
  return entry.kind === "file" && /\.mpr$/i.test(entry.path)
    && entry.read_mode !== "permissive" && blocked;
}

export function mprReadModeForPath(path: string, modes: MprReadModes = {}): MprReadMode {
  return /\.mpr$/i.test(path) && modes[importSourcePathKey(path)] === "permissive" ? "permissive" : "safe";
}

export function withMprReadMode<T extends ImportBrowseEntry>(entry: T, modes: MprReadModes): T {
  return { ...entry, read_mode: mprReadModeForPath(entry.path, modes) };
}

/** Keep mixed-mode requests explicit and retain the user's original source order. */
export async function inspectPathsWithReadModes(
  paths: string[], modes: MprReadModes,
  inspect: (paths: string[], mode: MprReadMode) => Promise<ImportInspectResult>,
): Promise<ImportInspectResult> {
  const result: ImportInspectResult = { files: [], failures: [] };
  for (const mode of ["safe", "permissive"] as const) {
    const group = paths.filter((path) => mprReadModeForPath(path, modes) === mode);
    if (!group.length) continue;
    const response = await inspect(group, mode);
    result.files.push(...response.files);
    result.failures.push(...response.failures);
  }
  const position = (path: string | null) => paths.findIndex((item) => importSourcePathKey(item) === importSourcePathKey(path ?? ""));
  result.files.sort((a, b) => position(a.source_path) - position(b.source_path));
  result.failures.sort((a, b) => position(a.path) - position(b.path));
  return result;
}
