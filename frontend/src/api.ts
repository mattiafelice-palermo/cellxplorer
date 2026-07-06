// Typed API client for the Cellxplorer backend.
import { addDebugEvent, describeRequestBody } from "./debug";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "msg" in item) return String(item.msg);
        return JSON.stringify(item);
      })
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    if ("message" in detail) return String(detail.message);
    return JSON.stringify(detail);
  }
  return fallback;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData;
  const method = options?.method ?? "GET";
  addDebugEvent("api:request", {
    method,
    url,
    body: describeRequestBody(options?.body),
  });
  const res = await fetch(url, {
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let body: unknown = null;
    try {
      body = await res.json();
      const responseDetail =
        body && typeof body === "object" && "detail" in body
          ? (body as { detail: unknown }).detail
          : undefined;
      detail = errorMessage(responseDetail, detail);
    } catch {
      /* ignore */
    }
    addDebugEvent("api:error", { method, url, status: res.status, detail, body });
    throw new ApiError(res.status, detail);
  }
  addDebugEvent("api:response", { method, url, status: res.status });
  return res.json();
}

export const get = <T>(url: string) => request<T>(url);
export const post = <T>(url: string, body?: unknown) =>
  request<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const postForm = <T>(url: string, body: FormData) =>
  request<T>(url, { method: "POST", body });
export const put = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T>(url: string) => request<T>(url, { method: "DELETE" });

// ------------------------------------------------------------------ types

export interface SourceFile {
  id: number;
  hash: string;
  path: string;
  filename: string;
  size: number;
  ext: string;
  nda_version: string | null;
  device_info: string | null;
  channel: string | null;
  barcode: string | null;
  remarks: string | null;
  start_time: string | null;
  active_mass_mg: number | null;
  location_status: "online" | "offline" | "changed";
  parse_status: "unparsed" | "parsing" | "parsed" | "error";
  parse_error: string | null;
  parser_version: string | null;
  row_count: number | null;
  cycle_count: number | null;
  registered: boolean;
  test_id: number | null;
  test_name: string | null;
  cell_id: number | null;
  cell_name: string | null;
  created_at: string;
}

export interface CellSummary {
  id: number;
  name: string;
  description: string | null;
  archived: boolean;
  cycling_status: "active" | "complete";
  tags: string[];
  metadata: Record<string, string>;
  n_tests: number;
  n_files: number;
  total_cycles: number;
  total_charge_capacity_mah: number | null;
  total_discharge_capacity_mah: number | null;
  has_offline: boolean;
  has_changed: boolean;
  created_at: string;
}

export interface CellDetail extends CellSummary {
  tests: { id: number; name: string; description: string | null; files: SourceFile[] }[];
}

export interface ReplicateGroupSummary {
  id: number;
  name: string;
  description: string | null;
  cell_ids: number[];
  cells: Pick<
    CellSummary,
    | "id"
    | "name"
    | "description"
    | "archived"
    | "total_charge_capacity_mah"
    | "total_discharge_capacity_mah"
  >[];
  average_total_charge_capacity_mah: number | null;
  average_total_discharge_capacity_mah: number | null;
  folder_ids: number[];
  created_at: string;
}

export interface ReplicateGroupPreview {
  quantity: string;
  series: { cell_id: number; cell_name: string; x: number[]; y: number[] }[];
  aggregate: {
    cycle: number[];
    mean: number[];
    median: number[];
    q1: number[];
    q3: number[];
    min: number[];
    max: number[];
    std: (number | null)[];
    count: number[];
  };
  stats: {
    n_cells: number;
    n_plotted_cells: number;
    average_cycle_count: number | null;
    average_initial_capacity: number | null;
    average_max_capacity: number | null;
    average_final_capacity: number | null;
    average_total_charge_capacity: number | null;
    average_total_discharge_capacity: number | null;
  };
}

export interface GroupInfo {
  id: number;
  project_id: number;
  name: string;
  color: string | null;
  position: number;
  cell_ids: number[];
}

export interface ProjectNode {
  id: number;
  type: "project";
  folder_id: number | null;
  name: string;
  description: string | null;
  cell_ids: number[];
  groups: GroupInfo[];
  analyses: { id: number; title: string }[];
}

export interface FolderNode {
  id: number;
  type: "folder";
  name: string;
  parent_id: number | null;
  cell_ids: number[];
  cells: Pick<CellSummary, "id" | "name" | "description" | "archived">[];
  replicate_groups: Pick<
    ReplicateGroupSummary,
    "id" | "name" | "description" | "cell_ids"
  >[];
  children: FolderNode[];
  projects: ProjectNode[];
  analyses: { id: number; title: string }[];
}

export interface Tree {
  folders: FolderNode[];
  projects: ProjectNode[];
}

export interface TagInfo {
  id: number;
  name: string;
  n_cells: number;
  n_analyses: number;
}

export interface CollectionInfo {
  id: number;
  name: string;
  n_analyses: number;
}

export interface SelectionEntry {
  kind: "cell" | "group";
  ref_id: number;
  label_override?: string | null;
  color?: string | null;
}

export interface Exclusion {
  cell_id: number;
  reason?: string | null;
  excluded_at?: string;
}

export interface AnalysisSpec {
  spec_version: number;
  title: string;
  created_at: string;
  modified_at: string;
  selection: {
    entries: SelectionEntry[];
    exclusions: Exclusion[];
    refresh_suggestion: { query: RefreshQuery; last_applied_at?: string | null } | null;
  };
  computation: {
    quantity: string;
    x_axis: string;
    cycle_range: { start: number | null; end: number | null };
    cycle_alignment: string;
    filters: { kind: string; params: Record<string, unknown> }[];
    normalization: { kind: string; params: Record<string, unknown> };
  };
  aggregation: {
    mode: "group_mean" | "none";
    dispersion: "std" | "sem" | "minmax" | "percentile";
    min_n_for_band: number;
    fade_low_n: boolean;
  };
  presentation: {
    show_individual_cells: boolean;
    series_style: Record<string, { color?: string }>;
    axis_labels: { x: string | null; y: string | null };
    legend: boolean;
  };
}

export interface RefreshQuery {
  name_contains?: string;
  tags_all?: string[];
  metadata?: Record<string, string>;
}

export interface AnalysisSummary {
  id: number;
  title: string;
  filed_in: { node_type: "project" | "folder"; node_id: number; name: string } | null;
  tags: string[];
  collections: { id: number; name: string }[];
  n_entries: number;
  n_exclusions: number;
  quantity: string | null;
  has_provenance: boolean;
  computed_at: string | null;
  parser_version: string | null;
  calc_version: string | null;
  created_at: string;
  modified_at: string;
}

export interface AnalysisFull extends AnalysisSummary {
  spec: AnalysisSpec;
  provenance: Provenance | null;
}

export interface Provenance {
  computed_at: string;
  parser_version: string;
  calc_version: string;
  sources: { cell_id: number; test_ids: number[]; file_hashes: string[] }[];
}

export interface Badge {
  kind: string;
  detail: string;
  cell_id?: number;
  cell_name?: string;
  file?: string;
  added_cell_ids?: number[];
  removed_cell_ids?: number[];
}

export interface CellSeries {
  cell_id: number;
  cell_name: string;
  label: string;
  group_id: number | null;
  group_name: string | null;
  color: string | null;
  excluded: boolean;
  exclusion_reason: string | null;
  archived: boolean;
  x: number[];
  y: (number | null)[];
}

export interface AggregateSeries {
  group_id: number;
  group_name: string;
  color: string | null;
  x: number[];
  mean: (number | null)[];
  band_low: (number | null)[];
  band_high: (number | null)[];
  n: number[];
  max_n: number;
  dispersion: string;
  min_n_for_band: number;
}

export interface ComputeResult {
  computed_at: string;
  parser_version: string;
  calc_version: string;
  current_parser_version: string;
  current_calc_version: string;
  quantity: string;
  quantity_label: string;
  y_label: string;
  normalized: boolean;
  cell_series: CellSeries[];
  aggregates: AggregateSeries[];
  badges: Badge[];
  sources: Provenance["sources"];
}

export interface ScanJob {
  id: number;
  kind: string;
  root: string;
  status: "running" | "completed" | "failed";
  found: number;
  done: number;
  new: number;
  relinked: number;
  changed: number;
  errors: string[];
  started_at: string;
}

export interface Meta {
  parser_version: string;
  calc_version: string;
  quantities: { value: string; label: string }[];
}

export interface ImportPreview {
  staged_name: string;
  source_path: string | null;
  filename: string;
  size: number;
  ext: string;
  hash: string;
  barcode: string | null;
  remarks: string | null;
  device_info: string | null;
  channel: string | null;
  start_time: string | null;
  active_mass_mg: number | null;
  nda_version: string | null;
  metadata: Record<string, string>;
  raw_metadata: Record<string, string>;
  metadata_error: string | null;
  import_match: {
    kind: "exact_duplicate" | "possible_update";
    matched_on: string[];
    source_file_id: number;
    filename: string;
    path: string;
    hash: string;
    cell_id: number | null;
    cell_name: string | null;
    test_id: number | null;
    test_name: string | null;
    registered: boolean;
    location_status: string;
    parse_status: string;
  } | null;
  capacity_preview: {
    x: number[];
    y: number[];
    quantity: string;
    label: string;
  } | null;
  preview_error: string | null;
}

export interface ImportInspectResult {
  files: ImportPreview[];
}

export interface ImportPreviewResult {
  capacity_preview: ImportPreview["capacity_preview"];
  preview_error: string | null;
}

export interface ImportRawDataResult {
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  total_rows: number;
  offset: number;
  limit: number;
}
