import { DISCOVERY_FIELDS, discoverFilters } from "./filterDiscovery.ts";
import type { IndexedFile } from "./importSearch.ts";
export type FilterRange = { min?: number; max?: number; unknown?: "exclude" | "include" | "only" };
export type TextCondition = { field: string; operator: string; value: string; case_sensitive?: boolean };
export type SearchFilters = {
  root_id?: string; extension?: string; supplier?: string; technique?: string;
  ranges?: Record<string, FilterRange>; conditions?: TextCondition[]; match?: "all" | "any";
  registered?: string; analysis_usage?: string; replicate_usage?: string;
  analysis_id?: number; replicate_id?: number; sort?: string;
};
export type SavedSearch = { id: string; name: string; q: string; filters: SearchFilters };
export const FILTER_FIELDS = [
  ["any", "Any searchable field"], ["filename", "Filename"], ["path", "File path"], ["folder", "Folder path"],
  ["barcode", "Header barcode"], ["remarks", "Header remarks"], ["part_number", "Header part number"],
  ["technique", "Header technique"], ["device_info", "Header device"], ["channel", "Header channel"],
  ["cell_name", "Cell name"], ["cell_notes", "Cell notes"], ["cell_metadata", "Cell metadata"],
  ["analysis", "Analysis name"], ["replicate", "Replicate name"],
].map(([value, label]) => ({ value, label }));
export const FILTER_OPERATORS = [
  ["contains", "contains"], ["not_contains", "does not contain"], ["equals", "equals"], ["not_equals", "does not equal"],
  ["starts", "starts with"], ["ends", "ends with"], ["present", "has a value"], ["missing", "is missing"],
].map(([value, label]) => ({ value, label }));
export const FILTER_CATEGORIES = [
  { id: "file", label: "Location and file", aliases: "folder filename filepath format supplier file size bytes mb" },
  { id: "dates", label: "Dates and times", aliases: "creation created modified test started first indexed date time" },
  { id: "header", label: "Source metadata", aliases: "barcode remarks part number technique device channel header" },
  { id: "cycling", label: "Cycling information", aliases: "cycles count active material mass mg nominal capacity mah duration hours chemistry" },
  { id: "app", label: "CellXplorer usage", aliases: "registered database cell analyses analysis replicate group cell name notes metadata" },
  { id: "text", label: "Text conditions", aliases: "contains starts ends equals missing any all case text filename filepath" },
  { id: "regex", label: "Advanced patterns", aliases: "regex regular expression pattern" },
  { id: "folder", label: "Folder context", aliases: "siblings number cycling files count same folder" },
  { id: "saved", label: "Ordering", aliases: "" },
];
export const RANGE_FIELDS = [
  { key: "size", label: "File size", unit: "MB", scale: 1048576, category: "file" },
  { key: "cycle_count", label: "Recorded source cycles", unit: "cycles", scale: 1, category: "cycling" },
  { key: "active_mass_mg", label: "Active material mass", unit: "mg", scale: 1, category: "cycling" },
  { key: "nominal_capacity_mah", label: "Nominal capacity", unit: "mAh", scale: 1, category: "cycling" },
  { key: "duration_s", label: "Recorded test duration", unit: "hours", scale: 3600, category: "cycling" },
  { key: "folder_count", label: "Indexed compatible files in same folder", unit: "files", scale: 1, category: "folder" },
];
export const DATE_FIELDS = [
  { key: "file_created_at", label: "File created" }, { key: "modified_at", label: "File modified" },
  { key: "start_time", label: "Test started (header)" }, { key: "first_indexed_at", label: "First indexed" },
];
export function searchableFilterCategories(query: string) {
  const categories = new Set(discoverFilters(query, DISCOVERY_FIELDS).matches.map((match) => match.field.category));
  return FILTER_CATEGORIES.filter((category) => categories.has(category.id));
}
export function filterExpansion(query: string, expanded: string[]) {
  return query.trim() ? searchableFilterCategories(query).map((section) => section.id) : expanded;
}

export const SORT_FIELDS = [
  ...RANGE_FIELDS.map((field) => ({ value: field.key, label: field.label, numeric: true })),
  ...DATE_FIELDS.map((field) => ({ value: field.key, label: field.label, numeric: true })),
  ...FILTER_FIELDS.filter((field) => !["any", "cell_name", "cell_notes", "cell_metadata", "analysis", "replicate"].includes(field.value))
    .map((field) => ({ ...field, numeric: false })),
  { value: "extension", label: "File format", numeric: false },
  { value: "supplier", label: "Supplier", numeric: false },
];
export function normalizedSearchSort(sort = "relevance") {
  return ({ name: "filename_asc", modified: "modified_at_desc", created: "file_created_at_desc",
    indexed: "first_indexed_at_desc", started: "start_time_desc" } as Record<string, string>)[sort] ?? sort;
}
export const SORT_OPTIONS = [{ value: "relevance", label: "Relevance" }, ...SORT_FIELDS.flatMap((field) => [
  { value: `${field.value}_asc`, label: `${field.label}: ${field.numeric ? "lowest first" : "A–Z"}` },
  { value: `${field.value}_desc`, label: `${field.label}: ${field.numeric ? "highest first" : "Z–A"}` },
])];
export function chipSortField(filters: SearchFilters, key: string) {
  const field = key.startsWith("range:") ? key.slice(6)
    : key.startsWith("condition:") ? filters.conditions?.[Number(key.slice(10))]?.field : key;
  return SORT_FIELDS.find((candidate) => candidate.value === field);
}
export function toggleSearchSort(filters: SearchFilters, field: string, direction: "asc" | "desc"): SearchFilters {
  const sort = `${field}_${direction}`;
  return { ...filters, sort: normalizedSearchSort(filters.sort) === sort ? "relevance" : sort };
}
export function filterCategory(key: string) {
  if (key === "root_id" || key === "extension" || key === "supplier") return "file";
  if (key === "technique") return "header";
  if (key === "sort") return "saved";
  if (["registered", "analysis_usage", "replicate_usage", "analysis_id", "replicate_id"].includes(key)) return "app";
  return RANGE_FIELDS.find((f) => f.key === key)?.category ?? (DATE_FIELDS.some((f) => f.key === key) ? "dates" : "text");
}
export function filterChips(filters: SearchFilters) {
  const chips: { key: string; label: string; category: string }[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === "any" || value === "relevance" || ["ranges", "conditions", "match"].includes(key)) continue;
    const labels: Record<string, string> = { root_id: "Location", extension: "Format", supplier: "Supplier", technique: "Technique", registered: "In Cell Database", analysis_usage: "Used in analysis", replicate_usage: "In replicate", analysis_id: "Analysis", replicate_id: "Replicate", sort: "Sort" };
    chips.push({ key, label: `${labels[key] ?? key}: ${key === "sort" ? SORT_OPTIONS.find((option) => option.value === normalizedSearchSort(String(value)))?.label ?? value : value}`, category: filterCategory(key) });
  }
  for (const [key, value] of Object.entries(filters.ranges ?? {})) {
    if (value.min == null && value.max == null && !["only", "exclude"].includes(value.unknown ?? "")) continue;
    const field = RANGE_FIELDS.find((f) => f.key === key);
    const date = DATE_FIELDS.find((f) => f.key === key);
    const format = (n: number) => date ? new Date(n * 1000).toLocaleString() : `${Number((n / (field?.scale ?? 1)).toFixed(4))} ${field?.unit ?? ""}`;
    const bounds = value.unknown === "only" ? "Unknown only" : value.min == null && value.max == null ? "Known values only" : `${value.min == null ? "" : `≥ ${format(value.min)}`}${value.min != null && value.max != null ? ", " : ""}${value.max == null ? "" : `≤ ${format(value.max)}`}${value.unknown === "include" ? " (includes unknown)" : ""}`;
    chips.push({ key: `range:${key}`, label: `${field?.label ?? date?.label ?? key}: ${bounds}`, category: filterCategory(key) });
  }
  (filters.conditions ?? []).forEach((c, i) => {
    if (!["present", "missing"].includes(c.operator) && !c.value.trim()) return;
    chips.push({ key: `condition:${i}`, category: c.operator === "regex" ? "regex" : "text", label: `${FILTER_FIELDS.find((f) => f.value === c.field)?.label ?? c.field} ${c.operator === "regex" ? "matches pattern" : FILTER_OPERATORS.find((o) => o.value === c.operator)?.label ?? c.operator} ${c.value}` });
  });
  if (filters.match === "any" && (filters.conditions?.length ?? 0) > 1) chips.push({ key: "match", category: "text", label: "Match any text condition" });
  const sort = normalizedSearchSort(filters.sort);
  const sortField = sort.slice(0, sort.lastIndexOf("_"));
  // The selected arrow already identifies ordering on its filter chip.
  // Show a standalone sort chip only when no matching applied filter exists.
  return chips.some((chip) => chipSortField(filters, chip.key)?.value === sortField)
    ? chips.filter((chip) => chip.key !== "sort") : chips;
}
export function removeSearchFilter(filters: SearchFilters, key: string): SearchFilters {
  if (key.startsWith("range:")) { const ranges = { ...filters.ranges }; delete ranges[key.slice(6)]; return { ...filters, ranges }; }
  if (key.startsWith("condition:")) return { ...filters, conditions: filters.conditions?.filter((_, i) => i !== Number(key.slice(10))) };
  const next = { ...filters }; delete next[key as keyof SearchFilters]; return next;
}
export function activeSearchFilters(filters: SearchFilters): SearchFilters {
  return { ...filters, conditions: filters.conditions?.filter((c) => ["present", "missing"].includes(c.operator) || c.value.trim()),
    ranges: Object.fromEntries(Object.entries(filters.ranges ?? {}).filter(([, r]) => r.min != null || r.max != null || ["only", "exclude"].includes(r.unknown ?? ""))) };
}
export function localDateInput(timestamp?: number) {
  if (timestamp == null) return "";
  const date = new Date(timestamp * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function filterMatchExplanation(file: IndexedFile, filters: SearchFilters) {
  const reasons = (file.matched_conditions ?? []).map((index) => {
    const condition = filters.conditions?.[index];
    if (!condition) return "";
    const label = FILTER_FIELDS.find((field) => field.value === condition.field)?.label ?? condition.field;
    const value = file.condition_values?.[String(index)] ?? condition.value;
    const operator = condition.operator === "regex" ? "matches pattern" : FILTER_OPERATORS.find((op) => op.value === condition.operator)?.label;
    return `${label} ${operator}${condition.value ? ` “${condition.value}”` : ""}${value ? `: ${value}` : ""}`;
  }).filter(Boolean);
  for (const key of Object.keys(filters.ranges ?? {})) {
    const field = RANGE_FIELDS.find((value) => value.key === key);
    const date = DATE_FIELDS.find((value) => value.key === key);
    const value = file.indexed_values?.[key];
    reasons.push(`${field?.label ?? date?.label ?? key}: ${value == null ? "Unknown" : date ? new Date(value * 1000).toLocaleString() : `${Number((value / (field?.scale ?? 1)).toFixed(4))} ${field?.unit ?? ""}`}`);
  }
  if (filters.supplier) reasons.push(`Supplier: ${file.supplier}`);
  if (filters.extension) reasons.push(`Format: ${file.extension}`);
  if (filters.technique) reasons.push(`Header technique: ${file.metadata.technique ?? "Unknown"}`);
  if (filters.registered && filters.registered !== "any") reasons.push(file.registered ? `In Cell Database: ${file.cells?.map((cell) => cell.name).join(", ") || "Registered source"}` : "Not in Cell Database at this known path");
  if (filters.analysis_id || (filters.analysis_usage && filters.analysis_usage !== "any")) reasons.push(`Analyses: ${file.analyses?.map((entry) => entry.name).join(", ") || "None"}`);
  if (filters.replicate_id || (filters.replicate_usage && filters.replicate_usage !== "any")) reasons.push(`Replicates: ${file.replicates?.map((entry) => entry.name).join(", ") || "None"}`);
  return reasons.join(" · ");
}
