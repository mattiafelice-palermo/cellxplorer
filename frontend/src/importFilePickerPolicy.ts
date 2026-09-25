import type { ImportBrowseEntry } from "./api";

export type ImportHeaderHint = {
  path: string;
  source_format: string | null;
  supplier: string | null;
  technique: string | null;
  cycle_count: number | null;
  error: string | null;
};

export type ImportBrowserSortKey =
  | "name"
  | "format"
  | "supplier"
  | "protocol"
  | "cycles"
  | "size"
  | "modified";

export type ImportBrowserSort = {
  key: ImportBrowserSortKey;
  direction: "asc" | "desc";
};

export type ImportBrowserFilters = {
  suppliers: string[];
  formats: string[];
  protocols: string[];
  minCycles: string;
  maxCycles: string;
  minSize: string;
  maxSize: string;
  modifiedAfter: string;
  modifiedBefore: string;
};

export const EMPTY_IMPORT_BROWSER_FILTERS: ImportBrowserFilters = {
  suppliers: [],
  formats: [],
  protocols: [],
  minCycles: "",
  maxCycles: "",
  minSize: "",
  maxSize: "",
  modifiedAfter: "",
  modifiedBefore: "",
};

export function importEntryFormat(entry: ImportBrowseEntry, hint?: ImportHeaderHint): string {
  if (hint?.source_format) return hint.source_format;
  const extension = entry.name.split(".").pop()?.toLowerCase();
  if (extension === "mpr") return "BioLogic EC-Lab";
  if (extension === "xlsx") return "Neware Excel";
  if (extension === "nda") return "Neware NDA";
  if (extension === "ndax") return "Neware NDAX";
  return "Unknown";
}

export function importEntrySupplier(entry: ImportBrowseEntry, hint?: ImportHeaderHint): string {
  if (hint?.supplier) return hint.supplier;
  return entry.name.toLowerCase().endsWith(".mpr") ? "BioLogic" : "Neware";
}

export function filterAndSortImportEntries(
  entries: readonly ImportBrowseEntry[],
  hints: ReadonlyMap<string, ImportHeaderHint>,
  search: string,
  filters: ImportBrowserFilters,
  sort: ImportBrowserSort,
): ImportBrowseEntry[] {
  const query = search.trim().toLocaleLowerCase();
  const minCycles = filters.minCycles.trim() === "" ? null : Number(filters.minCycles);
  const maxCycles = filters.maxCycles.trim() === "" ? null : Number(filters.maxCycles);
  const minSize = filters.minSize.trim() === "" ? null : Number(filters.minSize);
  const maxSize = filters.maxSize.trim() === "" ? null : Number(filters.maxSize);
  const modifiedAfter = filters.modifiedAfter ? Date.parse(`${filters.modifiedAfter}T00:00:00`) : null;
  const modifiedBefore = filters.modifiedBefore ? Date.parse(`${filters.modifiedBefore}T23:59:59.999`) : null;
  const selectedSuppliers = new Set(filters.suppliers);
  const selectedFormats = new Set(filters.formats);
  const selectedProtocols = new Set(filters.protocols);
  const filtered = entries.filter((entry) => {
    if (query && !entry.name.toLocaleLowerCase().includes(query)) return false;
    if (entry.kind === "folder") return true;
    const hint = hints.get(entry.path);
    const format = importEntryFormat(entry, hint);
    const supplier = importEntrySupplier(entry, hint);
    const cycles = hint?.cycle_count ?? null;
    const size = entry.size;
    const modified = entry.modified_at ? Date.parse(entry.modified_at) : null;
    if (selectedSuppliers.size && !selectedSuppliers.has(supplier)) return false;
    if (selectedFormats.size && !selectedFormats.has(format)) return false;
    if (selectedProtocols.size && !selectedProtocols.has(hint?.technique ?? "")) return false;
    if (minCycles !== null && (!Number.isFinite(minCycles) || cycles === null || cycles < minCycles)) return false;
    if (maxCycles !== null && (!Number.isFinite(maxCycles) || cycles === null || cycles > maxCycles)) return false;
    if (minSize !== null && (!Number.isFinite(minSize) || size === null || size < minSize)) return false;
    if (maxSize !== null && (!Number.isFinite(maxSize) || size === null || size > maxSize)) return false;
    if (modifiedAfter !== null && (!Number.isFinite(modifiedAfter) || modified === null || modified < modifiedAfter)) return false;
    if (modifiedBefore !== null && (!Number.isFinite(modifiedBefore) || modified === null || modified > modifiedBefore)) return false;
    return true;
  });

  const folders = filtered.filter((entry) => entry.kind === "folder");
  const files = filtered.filter((entry) => entry.kind === "file");
  const compare = (left: ImportBrowseEntry, right: ImportBrowseEntry): number => {
    const leftHint = hints.get(left.path);
    const rightHint = hints.get(right.path);
    let leftValue: number | string | null;
    let rightValue: number | string | null;
    switch (sort.key) {
      case "name": leftValue = left.name; rightValue = right.name; break;
      case "format": leftValue = importEntryFormat(left, leftHint); rightValue = importEntryFormat(right, rightHint); break;
      case "supplier": leftValue = importEntrySupplier(left, leftHint); rightValue = importEntrySupplier(right, rightHint); break;
      case "protocol": leftValue = leftHint?.technique ?? null; rightValue = rightHint?.technique ?? null; break;
      case "cycles": leftValue = leftHint?.cycle_count ?? null; rightValue = rightHint?.cycle_count ?? null; break;
      case "size": leftValue = left.size; rightValue = right.size; break;
      case "modified":
        leftValue = left.modified_at ? Date.parse(left.modified_at) : null;
        rightValue = right.modified_at ? Date.parse(right.modified_at) : null;
        break;
    }
    const leftMissing = leftValue === null || (typeof leftValue === "number" && !Number.isFinite(leftValue));
    const rightMissing = rightValue === null || (typeof rightValue === "number" && !Number.isFinite(rightValue));
    if (leftMissing || rightMissing) {
      if (leftMissing && !rightMissing) return 1;
      if (rightMissing && !leftMissing) return -1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    }
    const compared = typeof leftValue === "string" && typeof rightValue === "string"
      ? leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" })
      : Number(leftValue) - Number(rightValue);
    return compared === 0
      ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      : sort.direction === "asc" ? compared : -compared;
  };
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  files.sort(compare);
  return [...folders, ...files];
}

export function nextImportBrowserSort(
  current: ImportBrowserSort,
  key: ImportBrowserSortKey,
): ImportBrowserSort {
  if (current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: key === "name" ? "asc" : "desc" };
}
