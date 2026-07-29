// Typed API client for the CellXplorer backend.
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

let desktopApiBase: Promise<string> | null = null;

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function apiUrl(url: string): Promise<string> {
  if (/^https?:\/\//i.test(url)) return url;
  const host = window.location.hostname;
  const isLocalhost = host === "127.0.0.1" || host === "localhost";
  const isViteDev = Boolean(
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
  );
  const servedByBackend =
    isLocalhost && window.location.port === "8642";
  const servedByVite =
    isViteDev && isLocalhost && window.location.port !== "8642";
  if (servedByBackend || servedByVite) return url;

  if (isTauriRuntime()) {
    desktopApiBase ??= import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("backend_api_base"))
      .then((value) => value.replace(/\/$/, ""))
      .catch((error) => {
        desktopApiBase = null;
        throw error;
      });
    return `${await desktopApiBase}${url}`;
  }
  return `http://127.0.0.1:8642${url}`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const targetUrl = await apiUrl(url);
  const isFormData = options?.body instanceof FormData;
  const method = options?.method ?? "GET";
  addDebugEvent("api:request", {
    method,
    url: targetUrl,
    body: describeRequestBody(options?.body),
  });
  const res = await fetch(targetUrl, {
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
    addDebugEvent("api:error", { method, url: targetUrl, status: res.status, detail, body });
    throw new ApiError(res.status, detail);
  }
  addDebugEvent("api:response", { method, url: targetUrl, status: res.status });
  return res.json();
}

async function requestBlob(url: string, options?: RequestInit): Promise<Blob> {
  const targetUrl = await apiUrl(url);
  const method = options?.method ?? "GET";
  addDebugEvent("api:request", {
    method,
    url: targetUrl,
    body: describeRequestBody(options?.body),
  });
  const res = await fetch(targetUrl, {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = errorMessage(
        body && typeof body === "object" && "detail" in body
          ? (body as { detail: unknown }).detail
          : undefined,
        detail,
      );
    } catch {
      /* ignore */
    }
    addDebugEvent("api:error", { method, url: targetUrl, status: res.status, detail });
    throw new ApiError(res.status, detail);
  }
  addDebugEvent("api:response", { method, url: targetUrl, status: res.status });
  return res.blob();
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
export const getBlob = (url: string) => requestBlob(url, { method: "GET" });
export const postBlob = (url: string, body?: unknown) =>
  requestBlob(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export interface DownloadSettings {
  download_mode: "ask" | "folder";
  download_folder: string | null;
  export_filename_template: string;
}

export interface CacheSettings {
  warmup_enabled: boolean;
  only_when_hidden: boolean;
  idle_seconds: number;
  scientific_limit_bytes: number | null;
  analysis_limit_bytes: number | null;
}

export interface CacheCategoryStats {
  files: number;
  bytes: number;
  last_used_at: string | null;
}

export interface CacheOffender {
  kind: "scientific" | "analysis_artifacts";
  id: string;
  label: string;
  bytes: number;
  files: number;
  last_used_at: string | null;
  source_available: boolean;
  source_path?: string | null;
  cell_id?: number | null;
  analysis_id?: number | null;
}

export interface CacheInventory {
  policy: CacheSettings;
  categories: Record<string, CacheCategoryStats>;
  total_bytes: number;
  free_bytes: number;
  offenders: CacheOffender[];
}

export interface CacheWarmupTask {
  id: string;
  analysis_id: number;
  analysis_title: string;
  plot_id: string;
  plot_title: string;
  tab: AnalysisTabKey;
  analysis_modified_at: string | null;
  expected_data_signature: string;
}

export interface DatabaseStatus {
  status:
    | "ready"
    | "migration_failed"
    | "database_too_new"
    | "database_unrecognized"
    | "database_corrupt";
  compatible: boolean;
  app_version: string;
  schema_revision: string | null;
  supported_revision: string;
  previous_revision: string | null;
  migration_performed: boolean;
  legacy_database: boolean;
  backup_path: string | null;
  message: string;
  database_instance_id: string | null;
}

export interface BetaBootstrapStatus {
  channel: "beta";
  setupState?: "choice-required" | "complete" | "blocked-error";
  decision: "copied" | "empty" | "current" | null;
  needsChoice: boolean;
  betaPristine: boolean;
  betaHasExistingLibrary: boolean;
  acknowledgedAppVersion?: string | null;
  acknowledgedInstallInstanceId?: string | null;
  stableDatabaseExists: boolean;
  stableDatabaseCompatible: boolean;
  stableDatabasePath: string;
  copyBlockingReason?: string | null;
  setupError?: string | null;
  blockingReason: string | null;
  outstandingStageToken?: string | null;
  applyFailureMessage?: string | null;
}

export interface BetaBootstrapStageCopyResult {
  token: string;
  sourceDatabaseInstanceId: string | null;
  sourceSchemaRevision: string | null;
  copiedImports: number;
  externalSourcePaths: number;
  replaceExistingBeta: boolean;
  restartRequired: boolean;
}

export interface BetaBootstrapStartEmptyResult {
  decision: "empty" | "copied" | "current";
  restartRequired: boolean;
}

export interface BetaBootstrapDiscardResult {
  discarded: boolean;
  token: string;
}

export interface ElectrodeAreaPreset {
  id: string;
  name: string;
  area_cm2: number;
  description: string | null;
  is_default: boolean;
}

export interface ElectrodeAreaPresetSettings {
  presets: ElectrodeAreaPreset[];
}

export interface ActiveMaterialPreset {
  id: string;
  name: string;
  specific_capacity_mah_g: number;
  description: string | null;
  is_default: boolean;
}

export interface ActiveMaterialPresetSettings {
  presets: ActiveMaterialPreset[];
}

export interface PlotStylePreset {
  id: string;
  name: string;
  plot_family: "all" | "cycles" | "time_capacity";
  style: Partial<PlotStyle>;
  is_default: boolean;
}

export interface PlotStylePresetSettings {
  presets: PlotStylePreset[];
}

export interface ColorPalette {
  id: string;
  name: string;
  kind: "categorical" | "sequential";
  colors: string[];
}

export interface ColorPaletteSettings {
  palettes: ColorPalette[];
}

export interface SourceMonitoringSettings {
  enabled: boolean;
  schedule_mode: "interval" | "scheduled";
  interval_value: number;
  interval_unit: "minutes" | "hours" | "days";
  scheduled_every_value: number;
  scheduled_every_unit: "days" | "weeks";
  daily_time: string;
  auto_update: boolean;
  scan_batch_size: number;
  stability_value: number;
  stability_unit: "seconds" | "minutes";
  retry_count: number;
  retry_delay_value: number;
  retry_delay_unit: "seconds" | "minutes" | "hours";
  next_run_at: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
}

export interface AutomationPauseState {
  paused: boolean;
  paused_until: string | null;
  seconds_remaining: number | null;
}

export interface DownloadEntry {
  id: string;
  filename: string;
  path: string;
  kind: string;
  bytes: number | null;
  created_at: string;
  exists: boolean;
  seen: boolean;
}

export interface SavedDownload {
  saved: boolean;
  filename: string;
  path: string;
  entry?: DownloadEntry;
}

export type SourceCheckFileStatus =
  | "queued"
  | "checking"
  | "online"
  | "changed"
  | "updating"
  | "ready"
  | "deferred"
  | "waiting_retry"
  | "offline"
  | "error"
  | "failed";

export interface SourceCheckJob {
  id: number;
  status: "running" | "completed" | "failed";
  total: number;
  completed: number;
  online: number;
  changed: number;
  offline: number;
  deferred?: number;
  errors: number;
  hashed?: number;
  skipped_complete: number;
  changed_file_ids: number[];
  phase?: "checking" | "retry_wait" | "retrying" | "updating" | "completed";
  update_after_check?: boolean;
  update_total?: number;
  update_completed?: number;
  updated?: number;
  updated_file_ids?: number[];
  ready_cell_ids?: number[];
  update_errors?: { file_id: number; filename: string; error: string }[];
  requested_cell_ids: number[];
  workers: number;
  scan_mode?: "checksum" | "metadata";
  trigger?: "manual" | "tray" | "scheduled";
  retry_count?: number;
  retry_delay_seconds?: number;
  retry_attempt?: number;
  retry_total?: number;
  retry_completed?: number;
  retry_next_at?: string | null;
  files: {
    file_id: number;
    filename: string;
    status: SourceCheckFileStatus;
    error: string | null;
  }[];
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

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
  nominal_capacity_mah: number | null;
  location_status: "online" | "offline" | "changed" | "changing";
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
  scientific_metadata: Record<
    "active_mass_mg" | "nominal_capacity_mah" | "electrode_area_cm2",
    {
      source_value: number | null;
      override_value: number | null;
      legacy_value: number | null;
      effective_value: number | null;
    }
  >;
  scientific_presets: {
    active_material: {
      preset_id: string | null;
      name: string | null;
      specific_capacity_mah_g: number | null;
    };
    electrode_area_preset_id: string | null;
    electrode_area_preset_name: string | null;
  };
  n_tests: number;
  n_files: number;
  total_cycles: number;
  total_charge_capacity_mah: number | null;
  total_discharge_capacity_mah: number | null;
  max_specific_discharge_capacity_mah_g: number | null;
  has_offline: boolean;
  has_changed: boolean;
  has_changing: boolean;
  has_parsing: boolean;
  has_summary_pending: boolean;
  has_summary_error: boolean;
  created_at: string;
}

export interface CellDetail extends CellSummary {
  metadata: Record<string, string>;
  tests: { id: number; name: string; description: string | null; files: SourceFile[] }[];
}

export interface ProtocolStep {
  number: number;
  type_id: number;
  type: string;
  direction: "charge" | "discharge" | "rest" | "control" | "other";
  current_ma: number | null;
  c_rate: number | null;
  c_rate_source: "explicit" | "inferred" | null;
  target_voltage_v: number | null;
  stop_voltage_v: number | null;
  stop_current_ma: number | null;
  stop_c_rate: number | null;
  stop_c_rate_source: "inferred" | null;
  time_limit_s: number | null;
  record_interval_s: number | null;
  record_voltage_delta_v: number | null;
  protection_upper_v: number | null;
  protection_lower_v: number | null;
  loop_start_step: number | null;
  loop_count: number | null;
  summary: string;
  /** The same settings as `summary`, split into labelled values for display. */
  facts?: { key: string; label: string; value: string; note: string | null }[];
  /**
   * Limit conditions exactly as the file states them. Often the only thing
   * distinguishing steps that share a rate and a cutoff.
   */
  conditions?: {
    expression: string;
    name: string | null;
    value: number | null;
    comparator_id: number | null;
    jump_step: number | null;
  }[];
}

export interface ProtocolGroup {
  id: string;
  kind: "sequence" | "repeated_block";
  label: string;
  start_step: number;
  end_step: number;
  repeat_count: number;
  control_step: number | null;
  /** How deeply this block is nested; 0 is the outermost tier. */
  depth: number;
  /** Steps this node owns directly. Nested blocks own the rest. */
  step_numbers: number[];
  /** Everything the node runs, including nested blocks — use this to select it. */
  all_step_numbers: number[];
  children: ProtocolGroup[];
  summary: string;
}

export interface FileProtocol {
  signature: string;
  n_steps: number;
  n_executable_steps: number;
  steps: ProtocolStep[];
  /** Nested block structure: loops contain the blocks and sequences they run. */
  groups: ProtocolGroup[];
  /** The basis for every C-rate shown, so a reader can convert back to mA. */
  nominal_capacity_mah?: number | null;
  nominal_capacity_inferred?: boolean;
  summary: {
    charge_cutoffs: { voltage_v: number; step_count: number }[];
    discharge_cutoffs: { voltage_v: number; step_count: number }[];
    protection_windows: { lower_v: number | null; upper_v: number | null }[];
    record_intervals_s: number[];
  };
  warnings: string[];
}

export interface CellProtocol {
  cell_id: number;
  cell_name: string;
  tests: {
    id: number;
    name: string;
    files: {
      id: number;
      filename: string;
      path: string;
      hash: string;
      /** Transitional alias used by older/local protocol payloads. */
      source_hash?: string;
      observed_steps: {
        step_index: number;
        execution_count: number;
        cycle_count: number;
        cycles: number[];
      }[];
      protocol: FileProtocol;
    }[];
  }[];
}

export interface ProtocolSegmentTarget {
  protocol_signature: string;
  step_indices: number[];
}

export interface ProtocolSegment {
  id: string;
  name: string;
  targets: ProtocolSegmentTarget[];
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

// ------------------------------------------------- analyses (spec v4)

export interface SelectionEntry {
  kind: "cell" | "replicate_group";
  ref_id: number;
  label_override?: string | null;
}

export interface Exclusion {
  cell_id: number;
  /** Missing on legacy entries, which apply to every occurrence of the cell. */
  entry_kind?: SelectionEntry["kind"] | null;
  entry_ref_id?: number | null;
  reason?: string | null;
  excluded_at?: string;
}

export interface StepsSeriesSpec {
  id: string;
  cell_id: number;
  segment_id: string;
}

export interface StepsViewSpec {
  quantity: "time" | "cv_charge_time" | "voltage" | "capacity" | "block_duration";
  direction: "charge" | "discharge" | "total";
  include_rest: boolean;
  x_axis: "occurrence" | "cycle" | "time";
}

export interface DcirSegmentTarget {
  protocol_signature: string;
  rest_step_index: number;
  pulse_step_index: number;
  direction: "charge" | "discharge";
  current_ma: number | null;
  c_rate: number | null;
  rest_duration_s: number | null;
  pulse_duration_s: number | null;
}

export interface DcirSegment {
  id: string;
  name: string;
  targets: DcirSegmentTarget[];
}

export interface DcirSeriesSpec {
  id: string;
  cell_id: number;
  segment_id: string;
}

export interface DcirCandidateFilter {
  min_rest_s: number;
  max_pulse_s: number;
  min_ratio: number;
}

export interface DcirViewSpec {
  quantity: "absolute" | "relative";
  x_axis: "occurrence" | "cycle" | "time";
  candidate_filter: DcirCandidateFilter;
}

export interface ChargeabilityComputationSpec {
  initial_soc_max_pct: number;
  final_soc_min_pct: number;
  min_current_ceiling_c: number;
  soc_tolerance_pct: number;
}

export interface ChargeabilityViewSpec {
  x_axis:
    | "time"
    | "soc_pct"
    | "capacity_mah"
    | "capacity_mah_g"
    | "capacity_mah_cm2";
  y_axis:
    | "c_rate"
    | "current_ma"
    | "current_ma_g"
    | "current_ma_cm2";
  time_unit: "s" | "min" | "h";
}

export interface RateCapabilityFamilyPatternSpec {
  enabled: boolean;
  charge_structure: "auto" | "cc_cv" | "cccv" | "cc";
  fixed_rate_c: number | null;
  selected_rates_c: number[];
  monotonic: "ignore" | "prefer" | "require";
  scaffold: "ignore" | "prefer" | "require";
}

export interface RateCapabilityComputationSpec {
  min_points: number;
  cutoff_tolerance_v: number;
  rate_tolerance_fraction: number;
  families: {
    charge: RateCapabilityFamilyPatternSpec;
    discharge: RateCapabilityFamilyPatternSpec;
  };
}

export interface RateCapabilityViewSpec {
  x_axis: "c_rate" | "current_ma" | "current_ma_g" | "current_ma_cm2";
  y_axis:
    | "capacity_mah"
    | "capacity_mah_g"
    | "capacity_mah_cm2"
    | "retention_pct"
    | "asymmetry_ratio";
  show_charge: boolean;
  show_discharge: boolean;
  x_spacing: "equal" | "proportional";
  visualization: "line" | "bar";
}

export const ANALYSIS_TAB_KEYS = [
  "time_capacity",
  "cycles",
  "steps",
  "polarization",
  "crate",
  "chargeability",
  "dcir",
  "recap",
  "settings",
] as const;

export type AnalysisTabKey = (typeof ANALYSIS_TAB_KEYS)[number];

export interface SavedAnalysisPlot {
  id: string;
  tab: AnalysisTabKey;
  name: string;
  subtitle: string;
  description: string | null;
  /** Saved plots store visibility only; analysis-level sample entries remain global. */
  selection: {
    entries: SelectionEntry[];
    exclusions: Exclusion[];
    hidden_replicate_group_ids?: number[];
  };
  computation: AnalysisSpec["computation"];
  aggregation: AnalysisSpec["aggregation"];
  presentation: AnalysisSpec["presentation"];
  created_at: string;
  modified_at: string;
}

export type PlotPaletteKey =
  | "app"
  | "pastel"
  | "publication"
  | "presentation"
  | "okabe_ito"
  | "tableau"
  | "blues"
  | "viridis"
  | "monochrome"
  | "custom";

export type PlotExportFormat = "png" | "svg" | "pdf";
export type PlotAspectRatioKey =
  | "view"
  | "square"
  | "four_three"
  | "sixteen_nine"
  | "a4_portrait"
  | "a4_landscape"
  | "custom";

export interface PlotAxisStyle {
  mode: "auto" | "manual";
  min: number | null;
  max: number | null;
  tick_mode: "auto" | "step" | "count";
  dtick: number | null;
  tick_count: number | null;
  title_standoff: number;
  tick_label_standoff: number;
}

export interface PlotAxisScope {
  x_title?: string | null;
  y_title?: string | null;
  y2_title?: string | null;
  x_axis?: Partial<PlotAxisStyle>;
  y_axis?: Partial<PlotAxisStyle>;
  y2_axis?: Partial<PlotAxisStyle>;
}

export interface PlotStyle {
  palette: PlotPaletteKey;
  palette_id?: string | null;
  palette_colors?: string[];
  custom_colors: Record<string, string>;
  line_width: number;
  line_dash: "solid" | "dot" | "dash" | "longdash";
  marker_mode: "none" | "points" | "lines_points";
  marker_size: number;
  marker_symbol: "circle" | "square" | "diamond" | "triangle-up" | "cross" | "x";
  /** Draw markers as open (outline only) rather than filled. */
  marker_open: boolean;
  individual_opacity: number;
  band_opacity: number;
  low_n_color: string;
  low_n_marker_symbol: "circle" | "square" | "diamond" | "cross" | "x" | "triangle-up";
  low_n_marker_size: number;
  show_grid: boolean;
  show_zero_line: boolean; // y axis only — an x zero line is meaningless on cycle plots
  show_frame: boolean;
  plot_bgcolor: string;
  paper_bgcolor: string;
  frame_color: string;
  frame_width: number;
  x_title: string | null;
  y_title: string | null;
  y2_title: string | null; // CE overlay axis
  x_axis: PlotAxisStyle;
  y_axis: PlotAxisStyle;
  y2_axis: PlotAxisStyle;
  axis_scopes?: Partial<Record<AnalysisTabKey, PlotAxisScope>>;
  tick_font_size: number;
  axis_title_size: number;
  legend_font_size: number;
  tick_marks: "none" | "outside" | "inside";
  tick_length: number;
  tick_width: number;
  /** CE overlay trace styling (cycles tab right axis). */
  ce_custom_colors: Record<string, string>;
  ce_palette_mode?: "match" | "secondary" | "single";
  ce_palette_id?: string | null;
  ce_palette_colors?: string[];
  ce_single_color?: string;
  ce_line_width: number;
  ce_line_dash: "solid" | "dot" | "dash" | "longdash";
  ce_marker_mode: "none" | "points" | "lines_points";
  ce_marker_size: number;
  ce_marker_symbol: "circle" | "square" | "diamond" | "triangle-up" | "cross" | "x";
  ce_marker_open: boolean;
  ce_opacity: number;
  /** Legacy single-field position; superseded by legend_mode/side/custom. */
  legend_position: "bottom" | "right" | "top" | "inside";
  legend_mode: "outside" | "inside" | "custom";
  legend_side: "top" | "bottom" | "left" | "right";
  legend_inside_position:
    | "top_left"
    | "top_center"
    | "top_right"
    | "center_left"
    | "center"
    | "center_right"
    | "bottom_left"
    | "bottom_center"
    | "bottom_right"
    | "custom";
  legend_orientation: "h" | "v";
  /** Width allocated to each horizontal legend entry; 0 lets Plotly size it. */
  legend_entry_width: number;
  /** Paper coordinates (0..1) of the legend center when legend_mode=custom. */
  legend_custom_x: number;
  legend_custom_y: number;
  /** Data (CSV/XLSX) export preferences. */
  data_export_format: "csv" | "xlsx";
  data_precision: "standard" | "full";
  data_decimal_separator: "point" | "comma";
  data_delimiter: "comma" | "semicolon" | "tab";
  export_settings_version: number;
  export_format: PlotExportFormat;
  export_aspect_ratio: PlotAspectRatioKey;
  export_ppi: number;
  export_width: number;
  export_height: number;
  export_scale: number;
  export_include_title: boolean;
}

export interface AnalysisSpec {
  spec_version: number;
  type: string; // "cycling" for now; protocol-specific types come later
  title: string;
  created_at: string;
  modified_at: string;
  selection: {
    entries: SelectionEntry[];
    exclusions: Exclusion[];
    hidden_replicate_group_ids?: number[];
  };
  protocol_segments?: ProtocolSegment[];
  /** DCIR-only rest/pulse definitions. Never shared with other analysis tabs. */
  dcir_segments?: DcirSegment[];
  computation: {
    cycle_range: { start: number | null; end: number | null };
    exclude_check_cycles_every_n: number;
    retention_reference: { mode: "max_first_n" | "cycle"; n: number; cycle: number | null };
    formation_cycles: number;
    polarization: {
      method:
        | "mean"
        | "first_first"
        | "last_last"
        | "last_charge_first_discharge"
        | "first_charge_last_discharge";
      direction: "charge_minus_discharge" | "discharge_minus_charge";
    };
    protocol_filter?: {
      excluded_segment_ids: string[];
      only_segment_ids: string[];
    };
    time_capacity?: {
      x_axis: "time" | "capacity_mah" | "capacity_mah_g" | "capacity_mah_cm2";
      time_unit: "s" | "min" | "h";
      display_mode: "consecutive" | "overlap_reset" | "overlap_mirror";
      stacked: boolean;
      current_left: "current_ma" | "current_density" | "c_rate";
      current_right: "none" | "current_ma" | "current_density" | "c_rate";
      electrode_area_cm2: number | null;
      view: "voltage_current" | "dqdv" | "dvdq";
      derivative_phase: "both" | "charge" | "discharge";
      derivative_specific: boolean;
      derivative_absolute_discharge: boolean;
      smoothing_window: number;
      cycle_start: number | null;
      cycle_end: number | null;
      cycles: number[];
      max_points_per_cell: number;
    };
    steps?: {
      series: StepsSeriesSpec[];
      mode: "union" | "contiguous";
      /** Legacy single-segment setting, normalized by the Steps UI/backend. */
      segment_id?: string | null;
    };
    dcir?: {
      series: DcirSeriesSpec[];
    };
    chargeability?: ChargeabilityComputationSpec;
    rate_capability?: RateCapabilityComputationSpec;
  };
  aggregation: {
    mode: "replicate_mean" | "none";
    dispersion: "std" | "sem" | "minmax" | "percentile";
    min_n_for_band: number;
  };
  presentation: {
    quantity: string;
    normalize_by_mass?: boolean;
    ce_overlay: boolean;
    show_individual_cells: boolean;
    legend: boolean;
    hidden_protocol_segment_ids?: string[];
    /**
     * Display-only visibility for the series-based tabs (DCIR, steps). Kept out
     * of the compute cache key (see analysis_cache._scientific_spec) so toggling
     * a line on or off never triggers a recompute.
     */
    hidden_series_ids?: string[];
    /** Display-only: segment ids hidden across DCIR/steps series (all cells). */
    hidden_analysis_segment_ids?: string[];
    steps_view?: StepsViewSpec;
    dcir_view?: DcirViewSpec;
    chargeability_view?: ChargeabilityViewSpec;
    rate_capability_view?: RateCapabilityViewSpec;
    /**
     * Hide protocol diagnostic cycles (DCIR pulses, rate checks) detected from
     * cycle durations. Presentation-only: the computed result and every export
     * keep the full data, so the choice is always reversible.
     */
    hide_diagnostic_cycles?: boolean;
    /**
     * With diagnostic cycles hidden, also close the gaps they leave: drop the
     * points from the axis and renumber the survivors 1..N (display only).
     */
    reindex_diagnostic_cycles?: boolean;
    /** Deviation from the local baseline that marks a cycle as diagnostic. */
    diagnostic_tolerance?: number;
    /** Legacy single style shared by all tabs; superseded by plot_styles. */
    plot_style?: PlotStyle;
    /** One fully independent style per plot tab. */
    plot_styles?: Partial<Record<AnalysisTabKey, Partial<PlotStyle>>>;
  };
  saved_plots?: SavedAnalysisPlot[];
  /**
   * At most one unsaved draft plot per plot tab. Kept outside `saved_plots` so
   * warmup, the command palette, and portable export cannot pick them up.
   */
  draft_plots?: Partial<Record<AnalysisTabKey, AnalysisDraftPlot>> | null;
  /** @deprecated Migrated into `draft_plots` on load. */
  draft_plot?: AnalysisDraftPlot | null;
}

/** Session-only draft snapshot (thumbnails / save dialog). Not persisted. */
export interface AnalysisDraftPlot {
  tab: AnalysisTabKey;
  name: string | null;
  selection: SavedAnalysisPlot["selection"];
  computation: AnalysisSpec["computation"];
  aggregation: AnalysisSpec["aggregation"];
  presentation: AnalysisSpec["presentation"];
  updated_at: string;
}

export interface AnalysisSavedPlotSummary {
  id: string;
  name: string;
  tab: string;
  subtitle: string;
  quantity: string;
}

export interface AnalysisEntryRef {
  kind: string;
  ref_id: number;
}

export interface AnalysisSummary {
  id: number;
  title: string;
  type: string;
  folder: { id: number; name: string } | null;
  n_entries: number;
  n_cells: number;
  n_replicate_groups: number;
  n_exclusions: number;
  quantity: string | null;
  saved_plots: AnalysisSavedPlotSummary[];
  entry_refs: AnalysisEntryRef[];
  has_provenance: boolean;
  /** A source file changed after this analysis was last computed. */
  sources_changed: boolean;
  computed_at: string | null;
  parser_version: string | null;
  calc_version: string | null;
  created_at: string;
  modified_at: string;
}

export interface AnalysisUsageMatchedRef {
  kind: "cell" | "replicate_group" | string;
  ref_id: number;
  name: string;
}

export interface AnalysisUsagePlot {
  id: string;
  name: string;
  tab: string;
  affected: boolean;
}

export interface AnalysisUsageItem {
  id: number;
  title: string;
  matched: AnalysisUsageMatchedRef[];
  remaining_entry_count: number;
  becomes_empty: boolean;
  plots: AnalysisUsagePlot[];
}

export interface AnalysisUsageResponse {
  analyses: AnalysisUsageItem[];
  empty_after: number[];
}

export interface AnalysisFull extends AnalysisSummary {
  spec: AnalysisSpec;
  provenance: Provenance | null;
  selection_cells: Pick<CellSummary, "id" | "name" | "description" | "archived">[];
  selection_groups: {
    id: number;
    name: string;
    description: string | null;
    cell_ids: number[];
    cells: Pick<CellSummary, "id" | "name" | "description" | "archived">[];
  }[];
}

export interface PortableAnalysisEstimate {
  cells: number;
  sources: number;
  cache_bytes: number;
  runtime_bytes: number;
  runtime_embedded_bytes: number;
  plot_count: number;
  report_shell_bytes: number;
  estimated_per_plot_bytes: number;
  original_bytes: number;
  missing_originals: number;
  estimated_without_originals: number;
  estimated_with_originals: number;
}

export type PortableSourcePreflightStatus =
  | "current"
  | "changed"
  | "unavailable"
  | "changing"
  | "error";

export interface PortableSourcePreflightItem {
  source_id: number;
  filename: string;
  path: string;
  cell_id: number;
  cell_name: string;
  status: PortableSourcePreflightStatus;
  expected_size: number | null;
  expected_mtime_ns: string | null;
  message: string | null;
}

export interface PortableSourcePreflight {
  ready: boolean;
  sources: PortableSourcePreflightItem[];
  current: number;
  changed: number;
  unavailable: number;
  changing: number;
  error: number;
  affected_analysis_ids: number[];
  affected_analyses: number;
}

export interface PortableSourceUpdateResult {
  updated: number;
  updated_source_ids: number[];
  updated_cell_ids: number[];
  errors: { source_id: number; filename: string; error: string }[];
  preflight: PortableSourcePreflight;
}

export interface PortableAnalysisImportResult {
  analysis: AnalysisFull;
  warnings: string[];
}

export interface PortableSourceCandidate {
  source_file_id: number;
  filename: string;
  path: string;
  hash: string;
  cell_id: number | null;
  cell_name: string | null;
  matched_on: string[];
  comparison: "library_newer" | "embedded_newer" | "unknown";
  cycle_count: number | null;
  row_count: number | null;
  size: number;
  location_status: string;
}

export interface PortableSourceReview {
  source_id: string;
  filename: string;
  hash: string;
  status: "exact" | "possible_update" | "new";
  embedded: boolean;
  cycle_count: number | null;
  row_count: number | null;
  size: number;
  message: string;
  exact_match: PortableSourceCandidate | null;
  candidates: PortableSourceCandidate[];
  suggested_action: "use_library" | "import_embedded";
  suggested_library_source_id?: number;
}

export interface PortableCellReview {
  cell_id: string;
  name: string;
  status: "reuse" | "review" | "add";
  sources: PortableSourceReview[];
}

export interface PortableAnalysisInspection {
  token: string;
  filename?: string;
  analysis_title: string;
  created_at: string | null;
  includes_original_files: boolean;
  plot_count: number;
  cells: PortableCellReview[];
  sources: PortableSourceReview[];
  requires_resolution: boolean;
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

export interface CellMetrics {
  n_cycles: number;
  max_discharge_capacity_mah?: number | null;
  mean_discharge_capacity_mah?: number | null;
  first_cycle_ce_pct?: number | null;
  mean_ce_pct?: number | null;
  mean_ee_pct?: number | null;
  mean_ve_pct?: number | null;
  last_cycle?: number;
  retention_last_pct?: number | null;
  discharge_loss_mah_per_cycle?: number | null;
  charge_loss_mah_per_cycle?: number | null;
  discharge_loss_pct_per_cycle?: number | null;
  cycles_to_80_pct?: number | null;
  total_duration_h?: number | null;
  mean_cycle_duration_h?: number | null;
  mean_charge_time_h?: number | null;
  mean_discharge_time_h?: number | null;
  cv_reached_cycles?: number | null;
  cv_reached_pct?: number | null;
  cv_charge_event_count?: number | null;
  mean_cv_charge_time_h?: number | null;
  median_cv_charge_time_h?: number | null;
  mean_cv_charge_capacity_mah?: number | null;
  median_cv_charge_capacity_mah?: number | null;
  mean_cv_charge_fraction_pct?: number | null;
}

export interface CellSeries {
  cell_id: number;
  cell_name: string;
  label: string;
  group_id: number | null;
  group_name: string | null;
  excluded: boolean;
  exclusion_reason: string | null;
  archived: boolean;
  x: number[];
  quantities: Record<string, (number | null)[]>;
  metrics: CellMetrics;
  retention_reference_mah: number | null;
  active_mass_mg: number | null;
  segments: { file_hash: string; segment: number; cycle_start: number; cycle_end: number }[];
}

export interface AggregateSeries {
  group_id: number;
  group_name: string;
  x: number[];
  quantities: Record<
    string,
    { mean: (number | null)[]; band_low: (number | null)[]; band_high: (number | null)[]; n: number[] }
  >;
  max_n: number;
  dispersion: string;
  min_n_for_band: number;
}

export interface GroupMetrics {
  group_id: number;
  group_name: string;
  metrics: Record<string, { mean: number; sd: number | null; n: number } | number>;
}

export interface QuantityInfo {
  key: string;
  column: string;
  label: string;
}

export interface ComputeResult {
  computed_at: string;
  type: string;
  parser_version: string;
  calc_version: string;
  current_parser_version: string;
  current_calc_version: string;
  quantities: QuantityInfo[];
  cell_series: CellSeries[];
  aggregates: AggregateSeries[];
  group_metrics: GroupMetrics[];
  badges: Badge[];
  sources: Provenance["sources"];
  cache_status?: "hit" | "miss";
}

export interface TimeCapacityTrace {
  cell_id: number;
  cell_name: string;
  label: string;
  group_id: number | null;
  group_name: string | null;
  excluded: boolean;
  active_mass_mg: number | null;
  nominal_capacity_mah: number | null;
  electrode_area_cm2: number | null;
  cycle: (number | null)[];
  /** Canonical plotted x coordinates calculated before display sampling. */
  display_x?: (number | null)[];
  time_s: (number | null)[];
  capacity_mah: (number | null)[];
  capacity_mah_g: (number | null)[];
  capacity_mah_cm2?: (number | null)[];
  voltage_v: (number | null)[];
  current_ma: (number | null)[];
  phase: string[];
  status: (string | null)[];
  derivative_x: (number | null)[];
  derivative_y: (number | null)[];
}

export interface TimeCapacityResult {
  computed_at: string;
  type: string;
  parser_version: string;
  calc_version: string;
  current_parser_version: string;
  current_calc_version: string;
  settings: NonNullable<AnalysisSpec["computation"]["time_capacity"]>;
  cell_traces: TimeCapacityTrace[];
  badges: Badge[];
  cache_status?: "hit" | "miss";
  rendering?: {
    viewport_width: number;
    configured_max_points_per_cell: number;
    max_points_per_cell: number;
    total_points: number;
    precision: "standard" | "full";
    compact: boolean;
  };
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

export interface ActivityEvent {
  id: number;
  category: string;
  action: string;
  message: string;
  severity: "info" | "warning" | "error" | string;
  entity_type: string | null;
  entity_id: number | null;
  details: Record<string, unknown>;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export interface BackgroundJobItem {
  id: string;
  label: string;
  status: "queued" | "processing" | "ready" | "changed" | "offline" | "failed" | string;
  detail: string | null;
  error: string | null;
}

export interface BackgroundJob {
  id: number;
  kind: "capacity_summary" | "source_check" | "import_cache" | string;
  title: string;
  description: string;
  status: "running" | "paused" | "completed" | "failed";
  total: number;
  completed: number;
  counters: Record<string, number>;
  items: BackgroundJobItem[];
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AppSession {
  id: number;
  startup_mode: "manual" | "startup" | "development" | string;
  status: "running" | "closed" | "interrupted" | string;
  app_version: string | null;
  backend_pid: number | null;
  exit_reason: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface DiagnosticsHealth {
  sampled_at: string;
  backend: { status: string; pid: number; database_ok: boolean };
  database: DatabaseStatus | null;
  storage: {
    data_path: string;
    log_path: string;
    database_bytes: number;
    cache_bytes: number;
    free_bytes: number;
    total_bytes: number;
    data_writable: boolean;
    cache_writable: boolean;
    logs_writable: boolean;
  };
  jobs: { running: number; failed: number };
  session: AppSession | null;
}

export interface DiagnosticsResources {
  sampled_at: string;
  process_count: number;
  cpu_percent: number;
  memory_bytes: number;
  read_bytes: number;
  written_bytes: number;
  uptime_seconds: number;
  processes: {
    pid: number;
    name: string;
    memory_bytes: number;
    read_bytes: number;
    written_bytes: number;
  }[];
}

export interface DiagnosticsLogs {
  backend: string[];
  crash: string[];
}

export interface Meta {
  app_version: string;
  database_schema_revision: string | null;
  supported_database_schema_revision: string;
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
  nominal_capacity_mah: number | null;
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

export interface ImportFolderFile {
  path: string | null;
  relative_path: string;
  filename: string;
  size: number;
}

export interface ImportFolderSelectionResult {
  root_path: string | null;
  root_name: string | null;
  files: ImportFolderFile[];
}

export interface ImportBrowseEntry {
  path: string;
  name: string;
  kind: "folder" | "file";
  size: number | null;
  modified_at: string | null;
}

export interface ImportBrowseResult {
  current_path: string;
  parent_path: string | null;
  roots: { path: string; name: string }[];
  quick_access: ImportQuickAccessItem[];
  entries: ImportBrowseEntry[];
}

export interface ImportQuickAccessItem {
  path: string;
  label: string;
  section: "quick" | "pinned" | "recent";
  pinned: boolean;
  available: boolean;
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
