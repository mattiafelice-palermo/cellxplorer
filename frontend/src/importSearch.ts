import type { ImportBrowseEntry } from "./api";
import { importPathsEqual } from "./importPathBreadcrumbs.ts";

export interface SearchRoot { id: string; path: string; enabled: boolean }
export interface FileSearchConfig {
  roots: SearchRoot[]; formats: string[]; metadata_enabled: boolean; refresh_hours: number; paused: boolean;
}
export interface SearchRootState {
  id: string; path: string; status: string; count: number; pending: number;
  last_success: string | null; message: string | null;
}
export interface FileSearchSettings { config: FileSearchConfig; roots: SearchRootState[] }
export interface IndexedFile extends ImportBrowseEntry {
  canonical: string; relative_path: string; root_id: string; root_path: string; root_status: string; extension: string;
  supplier: string; recognition: string; metadata_state: string; metadata: Record<string, string>; registered: boolean;
}
export interface FileSearchResults {
  items: Omit<IndexedFile, "kind">[]; total: number; offset: number; limit: number;
  has_more: boolean; roots: Omit<SearchRootState, "count" | "pending">[];
  techniques?: string[];
}
export function indexedFileAvailable(file: IndexedFile) {
  return file.recognition === "recognized" && !file.registered && file.root_status !== "offline";
}
export function indexedFileStatus(file: IndexedFile) {
  if (file.root_status === "offline") return "Location unavailable";
  if (file.registered) return "Already in Cell Database";
  if (file.recognition === "pending") return file.metadata_state === "unavailable" ? "Refresh to check format" : "Checking format";
  if (file.metadata_state === "pending") return "Indexing metadata";
  if (file.metadata_state === "unavailable") return "Metadata unavailable";
  return "Available";
}

export function searchLocationName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

const METADATA_LABELS: Record<string, string> = {
  barcode: "Barcode", remarks: "Remarks", part_number: "Part number", start_time: "Started", technique: "Technique",
};
/** Match reasons describe source-export fields, never inferred Cell metadata. */
export function indexedMatchExplanation(file: IndexedFile, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\//g, "\\");
  const matches = (value: string) => terms.some((term) => normalize(value).includes(normalize(term)));
  const metadata = Object.entries(file.metadata).filter(([, value]) => matches(value));
  const explanation: string[] = [];
  if (matches(file.name)) explanation.push("Filename");
  explanation.push(...metadata.map(([key, value]) => `File header “${METADATA_LABELS[key] ?? key}”: ${value}`));
  const folder = file.path.replace(/[\\/][^\\/]*$/, "");
  if (terms.some((term) => normalize(folder).includes(normalize(term)) && !normalize(file.name).includes(normalize(term)))) {
    explanation.push(`Folder: ${folder}`);
  } else if (matches(file.canonical) && !matches(file.name) && !matches(folder)) {
    explanation.push(`Resolved source path: ${file.canonical}`);
  }
  if (explanation.length) return `Matched: ${explanation.join(" · ")}`;
  return Object.entries(file.metadata).slice(0, 2).map(([key, value]) => `File header “${METADATA_LABELS[key] ?? key}”: ${value}`).join(" · ");
}

export function searchRootStatus(status: string) {
  return ({ queued: "Waiting to scan", scanning: "Scanning", paused: "Indexing paused", offline: "Location unavailable", needs_attention: "Some files need attention", ready: "Ready" } as Record<string, string>)[status] ?? status;
}
/** Cross-scope staging keeps the existing map keys but coalesces Windows path aliases. */
export function mergeIndexedSelection(current: ReadonlyMap<string, ImportBrowseEntry>, next: ReadonlyMap<string, ImportBrowseEntry>) {
  const result = new Map(current);
  for (const entry of next.values()) {
    const previous = [...result.keys()].find((path) => importPathsEqual(path, entry.path));
    if (previous) result.delete(previous);
    result.set(entry.path, entry);
  }
  return result;
}
