import type { ImportFolderWatchDraft, ImportPreview, SourceMonitoringSettings } from "./api";

export type FolderTrackingEligibility = {
  eligible: boolean;
  reason: string | null;
  folderPath: string | null;
  extensions: string[];
  sourceFormats: string[];
  defaultWatch: ImportFolderWatchDraft | null;
};

export type FolderTrackingOrderInput = {
  filename: string;
  start_time?: string | null;
  hash: string;
};

function normalizedPath(value: string | null | undefined): string {
  return (value ?? "").trim().replaceAll("/", "\\").replace(/[\\]+$/, "").toLocaleLowerCase();
}

function parentPath(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().replaceAll("/", "\\");
  const index = normalized.lastIndexOf("\\");
  return index > 0 ? normalized.slice(0, index) : null;
}

function extensionOf(draft: Pick<ImportPreview, "ext" | "filename">): string {
  const parts = draft.filename.split(".");
  return (draft.ext || parts[parts.length - 1] || "").replace(/^\./, "").toLocaleLowerCase();
}

function formatKey(draft: Pick<ImportPreview, "ext" | "filename" | "source_format">): string {
  return (draft.source_format || "").trim().toLocaleLowerCase();
}

/** Decide whether the staged selection can seed a per-Cell folder watch. */
export function folderTrackingEligibility(
  drafts: readonly ImportPreview[],
): FolderTrackingEligibility {
  if (drafts.length === 0) {
    return { eligible: false, reason: "Select at least one source first.", folderPath: null, extensions: [], sourceFormats: [], defaultWatch: null };
  }
  const folderPath = parentPath(drafts[0]?.source_path);
  if (!folderPath || drafts.some((draft) => !draft.source_path)) {
    return { eligible: false, reason: "Folder tracking needs source files from one local folder.", folderPath, extensions: [], sourceFormats: [], defaultWatch: null };
  }
  if (drafts.some((draft) => parentPath(draft.source_path) === null || normalizedPath(parentPath(draft.source_path)) !== normalizedPath(folderPath))) {
    return { eligible: false, reason: "Folder tracking is available only when all selected files share one parent folder.", folderPath, extensions: [], sourceFormats: [], defaultWatch: null };
  }
  const extensions = [...new Set(drafts.map(extensionOf).filter(Boolean))].sort();
  const sourceFormats = [...new Set(drafts.map(formatKey).filter(Boolean))].sort();
  if (extensions.length === 0) {
    return { eligible: false, reason: "Folder tracking needs supported source files.", folderPath, extensions, sourceFormats, defaultWatch: null };
  }
  return {
    eligible: true,
    reason: null,
    folderPath,
    extensions,
    sourceFormats,
    defaultWatch: {
      enabled: true,
      folder_path: folderPath,
      pattern_kind: "glob",
      pattern: "*",
      extensions,
      source_formats: sourceFormats,
      ordering_rule: "timestamp_filename_hash",
    },
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const source = [...pattern].map((character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return escapeRegex(character);
  }).join("");
  return new RegExp(`^${source}$`, "i");
}

export function validateFolderTrackingPattern(
  patternKind: ImportFolderWatchDraft["pattern_kind"],
  pattern: string,
): string | null {
  const value = pattern.trim();
  if (!value) return "A filename pattern is required.";
  if (patternKind === "regex") {
    try {
      new RegExp(value);
    } catch (error) {
      return error instanceof Error ? `Invalid regular expression: ${error.message}` : "Invalid regular expression.";
    }
  }
  return null;
}

export function folderTrackingPatternMatches(
  filename: string,
  patternKind: ImportFolderWatchDraft["pattern_kind"],
  pattern: string,
): boolean {
  try {
    return patternKind === "regex"
      ? new RegExp(pattern, "i").test(filename)
      : globToRegExp(pattern).test(filename);
  } catch {
    return false;
  }
}

function naturalParts(filename: string): Array<number | string> {
  return filename.split(/(\d+)/).filter(Boolean).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLocaleLowerCase());
}

function compareNatural(left: string, right: string): number {
  const a = naturalParts(left);
  const b = naturalParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index];
    const rightPart = b[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    const leftText = String(leftPart);
    const rightText = String(rightPart);
    return leftText < rightText ? -1 : 1;
  }
  return 0;
}

function parsedTimestamp(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Match the backend timestamp -> natural filename -> hash candidate ordering. */
export function compareFolderTrackingCandidates(
  left: FolderTrackingOrderInput,
  right: FolderTrackingOrderInput,
  orderingRule: ImportFolderWatchDraft["ordering_rule"] = "timestamp_filename_hash",
): number {
  if (orderingRule === "timestamp_filename_hash") {
    const leftTime = parsedTimestamp(left.start_time);
    const rightTime = parsedTimestamp(right.start_time);
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  }
  const filenameOrder = compareNatural(left.filename, right.filename);
  if (filenameOrder !== 0) return filenameOrder;
  const leftHash = left.hash.toLocaleLowerCase();
  const rightHash = right.hash.toLocaleLowerCase();
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
}

export function folderTrackingInlineSummary(
  watch: Pick<ImportFolderWatchDraft, "folder_path" | "extensions">,
): string {
  const folderName = watch.folder_path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || watch.folder_path;
  const extensions = watch.extensions.map((extension) => `.${extension}`).join(", ");
  return `${folderName} · matching ${extensions || "supported source"} files`;
}

function cadenceText(value: number, unit: string): string {
  const numericValue = Number.isFinite(value) ? value : 1;
  const singular = numericValue === 1 ? unit.replace(/s$/, "") : unit;
  return numericValue === 1 ? singular : `${numericValue} ${singular}`;
}

/** Render the inherited source-monitor cadence without adding a local schedule control. */
export function formatFolderTrackingCadence(
  settings: Pick<
    SourceMonitoringSettings,
    "schedule_mode" | "interval_value" | "interval_unit" | "scheduled_every_value" | "scheduled_every_unit"
  > | undefined,
): string {
  if (!settings) return "Loading global source-monitor cadence…";
  if (settings.schedule_mode === "scheduled") {
    return `on the global schedule (every ${cadenceText(settings.scheduled_every_value, settings.scheduled_every_unit)})`;
  }
  return `every ${cadenceText(settings.interval_value, settings.interval_unit)}`;
}
