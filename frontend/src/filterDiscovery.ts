/** Small, explicit vocabulary for discovering controls, never result data or operators. */
export type DiscoveryField = { key: string; category: string; label: string; aliases?: string[]; options?: string[] };
export type DiscoveryMatch = { field: DiscoveryField; kind: "title" | "plural" | "synonym" | "option" | "fuzzy"; term: string; option: boolean; highlight: string[]; distance: number };
const words = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const singular = (word: string) => ({ analyses: "analysis", indices: "index" } as Record<string, string>)[word]
  ?? (word.endsWith("ies") && word.length > 4 ? word.slice(0, -3) + "y" : word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("is") && word.length > 3 ? word.slice(0, -1) : word);
const excluded = new Set("contains contain equal equals equality starts ends with does not has value missing unknown any all yes no and or".split(" "));
// Optimal-string-alignment distance handles a common adjacent-key transposition.
function distance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i ? j ? 0 : i : j));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
function candidate(query: string[], text: string, fuzzy: boolean) {
  const tokens = words(text);
  let cost = 0;
  for (const term of query) {
    if (tokens.some((word) => word.includes(term) || singular(word) === singular(term))) continue;
    if (!fuzzy || term.length < 3) return null;
    const best = Math.min(...tokens.filter((word) => Math.abs(word.length - term.length) <= 2).map((word) => distance(singular(term), singular(word))));
    const bound = term.length >= 7 ? 2 : 1;
    if (best > bound) return null;
    cost += best;
  }
  return cost;
}
export function discoverFilters(query: string, fields: DiscoveryField[]) {
  const terms = words(query).slice(0, 12).map((word) => word.slice(0, 80));
  if (!terms.length) return { matches: fields.map((field): DiscoveryMatch => ({ field, kind: "title", term: field.label, option: false, highlight: [], distance: 0 })), suggestion: null };
  if (terms.every((term) => excluded.has(term))) return { matches: [] as DiscoveryMatch[], suggestion: null };
  const find = (fuzzy: boolean) => fields.flatMap((field): DiscoveryMatch[] => {
    const choices = [{ text: field.label, kind: "title" as const }, ...(field.aliases ?? []).map((text) => ({ text, kind: "synonym" as const })), ...(field.options ?? []).filter((text) => text.trim() && !words(text).every((word) => excluded.has(word))).map((text) => ({ text, kind: "option" as const }))];
    const ranked = choices.map((choice, index) => ({ ...choice, index, cost: candidate(terms, choice.text, fuzzy) })).filter((choice) => choice.cost !== null).sort((a, b) => a.cost! - b.cost! || a.index - b.index);
    const hit = ranked[0];
    if (!hit) return [];
    const titleWords = words(field.label).filter((word) => terms.some((term) => word.includes(term)));
    const kind = hit.cost ? "fuzzy" : hit.kind === "title" && !terms.every((term) => words(field.label).some((word) => word.includes(term))) ? "plural" : hit.kind;
    return [{ field, kind, term: hit.text, option: hit.kind === "option", highlight: kind === "title" ? titleWords : [], distance: hit.cost! }];
  });
  const direct = find(false);
  if (direct.length) return { matches: direct, suggestion: null };
  const approximate = find(true);
  const best = Math.min(...approximate.map((match) => match.distance));
  const matches = approximate.filter((match) => match.distance === best);
  return { matches, suggestion: matches[0]?.term ?? null };
}
export const DISCOVERY_FIELDS: DiscoveryField[] = [
  { key: "root_id", category: "file", label: "Search location", aliases: ["root", "directory", "network drive"] },
  { key: "extension", category: "file", label: "File format", aliases: ["extension", "file type"], options: [".nda", ".ndax", ".xlsx", ".mpr"] },
  { key: "supplier", category: "file", label: "Supplier", aliases: ["manufacturer", "vendor", "instrument maker"], options: ["Neware", "BioLogic"] },
  { key: "size", category: "file", label: "File size", aliases: ["bytes", "MB", "megabytes", "storage size"] },
  { key: "file_created_at", category: "dates", label: "File created", aliases: ["creation date", "date created", "creation time"] },
  { key: "modified_at", category: "dates", label: "File modified", aliases: ["modification date", "last changed", "date modified"] },
  { key: "start_time", category: "dates", label: "Test started (header)", aliases: ["start date", "start time", "experiment date", "testing date"] },
  { key: "first_indexed_at", category: "dates", label: "First indexed", aliases: ["index date", "discovery date", "catalogued date"] },
  { key: "technique", category: "header", label: "Technique", aliases: ["protocol", "method"] },
  { key: "header_condition", category: "header", label: "Add a header condition", aliases: ["source metadata"], options: ["Header barcode", "Header remarks", "Header part number", "Header device", "Header channel"] },
  { key: "cycle_count", category: "cycling", label: "Recorded source cycles", aliases: ["cycle count", "number of cycles", "total cycles", "cycling"] },
  { key: "active_mass_mg", category: "cycling", label: "Active material mass", aliases: ["weight", "mass mg", "loading"] },
  { key: "nominal_capacity_mah", category: "cycling", label: "Nominal capacity", aliases: ["rated capacity", "capacity mah"] },
  { key: "duration_s", category: "cycling", label: "Recorded test duration", aliases: ["elapsed time", "hours", "cycling duration", "test length"] },
  { key: "registered", category: "app", label: "Already in Cell Database", aliases: ["registered", "imported", "library", "database membership"] },
  { key: "analysis_usage", category: "app", label: "Used in an analysis", aliases: ["analysis membership"] },
  { key: "replicate_usage", category: "app", label: "In a replicate group", aliases: ["replicate membership"] },
  { key: "analysis_id", category: "app", label: "Specific analysis" },
  { key: "replicate_id", category: "app", label: "Specific replicate group" },
  { key: "cell_condition", category: "app", label: "Add a Cell condition", aliases: ["curated metadata"], options: ["Cell name", "Cell notes", "Cell metadata"] },
  { key: "text_condition", category: "text", label: "Text condition", aliases: ["text filter", "keyword"], options: ["Filename", "File path", "Folder path", "Header barcode", "Header remarks", "Header part number", "Header technique", "Header device", "Header channel", "Cell name", "Cell notes", "Cell metadata", "Analysis name", "Replicate name"] },
  { key: "regex", category: "regex", label: "Regular expression", aliases: ["regex", "pattern"] },
  { key: "folder_count", category: "folder", label: "Indexed compatible files in same folder", aliases: ["siblings", "folder file count", "number of neighbouring files"] },
  { key: "sort", category: "saved", label: "Sort results", aliases: ["order results", "ordering"] },
];
