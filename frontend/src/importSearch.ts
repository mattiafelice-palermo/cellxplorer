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
}
export function indexedFileAvailable(file: IndexedFile) {
  return file.recognition === "recognized" && !file.registered;
}
export function indexedFileStatus(file: IndexedFile) {
  if (file.registered) return "Already in Cell Database";
  if (file.recognition === "pending") return file.metadata_state === "unavailable" ? "Refresh to check format" : "Checking format";
  if (file.metadata_state === "pending") return "Indexing metadata";
  if (file.metadata_state === "unavailable") return "Metadata unavailable";
  return "Available";
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
