import type { ImportFolderFile } from "./api";

export const LARGE_IMPORT_WARNING_THRESHOLD = 30;

export type ImportSelectionRootSummary = {
  key: string;
  label: string;
  path: string | null;
  fileCount: number;
  totalBytes: number;
};

export type ImportSelectionSummary = {
  fileCount: number;
  totalBytes: number;
  roots: ImportSelectionRootSummary[];
  isLarge: boolean;
};

export function formatImportBytes(value: number): string {
  const bytes = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const rounded = amount >= 10 ? amount.toFixed(0) : amount.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll("/", "\\").replace(/[\\]+$/, "").toLocaleLowerCase();
}

function rootFor(candidate: ImportFolderFile): {
  key: string;
  label: string;
  path: string | null;
} {
  const root = candidate.selection_root;
  if (!root) {
    return {
      key: `legacy:${candidate.relative_path}`,
      label: candidate.relative_path.split(/[\\/]/)[0] || "Selected files",
      path: null,
    };
  }
  if (root.kind === "file") {
    return { key: "file:loose-files", label: root.label || "Loose files", path: null };
  }
  const path = root.path || null;
  return {
    key: `folder:${normalizedPath(root.path)}`,
    label: root.label || root.path,
    path,
  };
}

export function summarizeImportSelection(
  candidates: readonly ImportFolderFile[],
  selectedKeys?: ReadonlySet<string>,
): ImportSelectionSummary {
  const roots = new Map<string, ImportSelectionRootSummary>();
  let fileCount = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    const key = candidate.path ?? candidate.relative_path;
    if (selectedKeys && !selectedKeys.has(key)) continue;
    const bytes = Number.isFinite(candidate.size) && candidate.size >= 0 ? Math.round(candidate.size) : 0;
    const root = rootFor(candidate);
    const existing = roots.get(root.key);
    if (existing) {
      existing.fileCount += 1;
      existing.totalBytes += bytes;
    } else {
      roots.set(root.key, {
        ...root,
        fileCount: 1,
        totalBytes: bytes,
      });
    }
    fileCount += 1;
    totalBytes += bytes;
  }
  return {
    fileCount,
    totalBytes,
    roots: [...roots.values()],
    isLarge: fileCount > LARGE_IMPORT_WARNING_THRESHOLD,
  };
}

export const importSelectionSummary = summarizeImportSelection;
