import {
  benchmarkTimeCapacityPlotStrategies,
  SELECTED_TIME_CAPACITY_PLOT_STRATEGY,
} from "./timeCapacityPlotStrategyBenchmark.ts";

export {
  registerTimeCapacityPlotStrategyBenchmarkInput,
  SELECTED_TIME_CAPACITY_PLOT_STRATEGY,
} from "./timeCapacityPlotStrategyBenchmark.ts";
export type {
  TimeCapacityPlotStrategyBenchmarkInput,
} from "./timeCapacityPlotStrategyBenchmark.ts";

export type TimeCapacityResultCache = "hit" | "miss" | "unknown";
export type TimeCapacityRawAccess =
  | "indexed"
  | "legacy"
  | "mixed"
  | "not_applicable"
  | "unknown";

export type TimeCapacityResponseSource = "http" | "react_query_memory";

export interface TimeCapacityPerformanceContext {
  analysis_id: number;
  selection_count: number;
  cycle_start: number | null;
  cycle_end: number | null;
  explicit_cycle_count: number;
  view: string;
  x_axis: string;
  display_mode: string;
  max_points_per_cell: number;
  compact: true;
  precision: "standard";
}

export interface TimeCapacityBackendProfile {
  profile_version: 1;
  request_id: string;
  result_cache: TimeCapacityResultCache;
  raw_access: TimeCapacityRawAccess;
  backend_total_ms?: number;
  backend_compute_ms?: number;
  backend_serialize_ms?: number;
  response_bytes?: number;
  backend_stages_ms?: Record<string, number>;
  transform_stages?: Record<
    string,
    {
      elapsed_ms: number;
      input_rows: number;
      output_rows: number;
      cells: number;
      consumed_by: string[];
    }
  >;
  derivative_profile?: {
    cells: number;
    input_rows: number;
    segments_processed: number;
    eligible_segments: number;
    finite_input_rows: number;
    output_finite_rows: number;
    output_segments: number;
    phase_rows: Record<string, number>;
    stages_ms: Record<string, number>;
  };
  row_groups_read?: number | "full";
  row_groups_total?: number | "full";
  raw_rows_materialized?: number;
  selected_rows_before_transforms?: number;
  returned_points?: number;
  resolved_cell_count?: number;
}

export interface TimeCapacityInteractionProfile extends TimeCapacityPerformanceContext {
  profile_version: 1;
  request_id: string;
  started_at_ms: number;
  placeholder_was_visible: boolean;
  response_source?: TimeCapacityResponseSource;
  result_cache: TimeCapacityResultCache;
  raw_access: TimeCapacityRawAccess;
  backend_total_ms?: number;
  backend_compute_ms?: number;
  backend_serialize_ms?: number;
  http_round_trip_ms: number;
  response_bytes?: number;
  frontend_result_to_plot_props_ms: number;
  plotly_update_ms: number;
  total_interaction_ms: number;
  backend_stages_ms?: Record<string, number>;
  row_groups_read?: number | "full";
  row_groups_total?: number | "full";
  raw_rows_materialized?: number;
  selected_rows_before_transforms?: number;
  returned_points?: number;
  resolved_cell_count?: number;
  trace_count?: number;
  mode?: "json" | "ndjson";
  stream_request_id?: string;
  stream_total_series?: number;
  stream_series?: Array<{
    index: number;
    total_series: number;
    received_at_ms: number;
    bytes: number;
    visible_at_ms?: number;
    event_to_visible_ms?: number;
    visible_update_id?: number;
    visible_coalesced?: boolean;
  }>;
  stream_first_useful_ms?: number;
  stream_final_series_received_ms?: number;
  stream_final_metadata_received_ms?: number;
  /** @deprecated retained as an alias for older exported captures. */
  stream_final_received_ms?: number;
  partial_plotly_completions?: number;
  partial_update_count?: number;
  plotly_remount_count?: number;
  selected_plot_strategy?: "react_plotly_react" | "plotly_add_traces";
}

export interface TimeCapacityFrontendPreparedDetails {
  resolvedCellCount?: number;
  plotlyTraceCount?: number;
}

export interface TimeCapacityStreamStartDetails {
  streamRequestId: string;
  totalSeries: number;
}

export interface TimeCapacityStreamSeriesDetails {
  index: number;
  totalSeries: number;
  bytes: number;
}

interface ActiveProfile {
  record: TimeCapacityInteractionProfile;
  response_received_at_ms: number | null;
  plot_props_ready_at_ms: number | null;
  plotly_started_at_ms: number | null;
}

export interface TimeCapacityPerformanceProfiler {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  getSnapshot(): TimeCapacityPerformanceSnapshot;
  subscribe(listener: () => void): () => void;
  begin(requestId: string, context: TimeCapacityPerformanceContext): void;
  placeholderVisible(requestId: string, visible: boolean): void;
  response(
    requestId: string,
    backend: TimeCapacityBackendProfile | undefined,
    httpRoundTripMs: number,
  ): void;
  /** Mark the result-to-Plotly preparation boundary for the current request. */
  frontendPrepared(requestId: string, details?: TimeCapacityFrontendPreparedDetails): void;
  /** Mark a result satisfied from React Query memory without reusing server facts. */
  memoryCacheHit(requestId: string): void;
  streamStart(requestId: string, details: TimeCapacityStreamStartDetails): void;
  streamSeries(requestId: string, details: TimeCapacityStreamSeriesDetails): void;
  streamComplete(requestId: string): void;
  partialPlotlyComplete(requestId: string, visibleSeriesIndices?: number[]): void;
  plotlyInitialized(requestId: string, details?: { remounted?: boolean }): void;
  plotlyComplete(requestId: string): void;
  cancel(requestId: string): void;
  records(): TimeCapacityInteractionProfile[];
  reset(): void;
  exportJson(): string;
}

export interface TimeCapacityPerformanceSnapshot {
  enabled: boolean;
  completedRecords: number;
}

type Clock = () => number;

function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function timeCapacityPerformanceNow(): number {
  return monotonicNow();
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}

function copyRecord(record: TimeCapacityInteractionProfile): TimeCapacityInteractionProfile {
  return {
    ...record,
    ...(record.backend_stages_ms
      ? { backend_stages_ms: { ...record.backend_stages_ms } }
      : {}),
  };
}

function applyBackendProfile(
  record: TimeCapacityInteractionProfile,
  backend: TimeCapacityBackendProfile | undefined,
): void {
  if (!backend) {
    record.result_cache = "unknown";
    record.raw_access = "unknown";
    return;
  }
  if (backend.request_id !== record.request_id) return;
  record.result_cache = backend.result_cache;
  record.raw_access = backend.raw_access;
  for (const key of [
    "backend_total_ms",
    "backend_compute_ms",
    "backend_serialize_ms",
    "response_bytes",
    "row_groups_read",
    "row_groups_total",
    "raw_rows_materialized",
    "selected_rows_before_transforms",
    "returned_points",
    "resolved_cell_count",
  ] as const) {
    const value = backend[key];
    if (value !== undefined) {
      (record as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (backend.backend_stages_ms) {
    record.backend_stages_ms = { ...backend.backend_stages_ms };
  }
}

function clearBackendFacts(record: TimeCapacityInteractionProfile): void {
  record.result_cache = "unknown";
  record.raw_access = "not_applicable";
  delete record.backend_total_ms;
  delete record.backend_compute_ms;
  delete record.backend_serialize_ms;
  delete record.response_bytes;
  delete record.backend_stages_ms;
  delete record.row_groups_read;
  delete record.row_groups_total;
  delete record.raw_rows_materialized;
  delete record.selected_rows_before_transforms;
  delete record.returned_points;
  delete record.resolved_cell_count;
}

/**
 * The React Query JSON identity and backend data_signature are different
 * namespaces. Only the current query identity and non-placeholder result may
 * authorize the frontend completion boundary.
 */
export function timeCapacityProfileResultIsCurrent(
  currentQuerySignature: string | null,
  profileQuerySignature: string | null,
  result: { data_signature?: string } | null | undefined,
  isPlaceholderData: boolean,
): boolean {
  return (
    currentQuerySignature !== null &&
    currentQuerySignature === profileQuerySignature &&
    Boolean(result) &&
    !isPlaceholderData
  );
}

export function timeCapacityResolvedCellCount(
  traces: ReadonlyArray<{ cell_id: number }>,
): number {
  const cellIds = new Set<number>();
  for (const trace of traces) {
    if (typeof trace.cell_id === "number" && Number.isFinite(trace.cell_id)) {
      cellIds.add(trace.cell_id);
    }
  }
  return cellIds.size;
}

export function createTimeCapacityPerformanceProfiler(
  clock: Clock = monotonicNow,
  maxRecords = 100,
): TimeCapacityPerformanceProfiler {
  const retention = Math.max(1, Math.floor(maxRecords));
  let enabled = false;
  let completed: TimeCapacityInteractionProfile[] = [];
  const active = new Map<string, ActiveProfile>();
  const listeners = new Set<() => void>();
  let snapshot: TimeCapacityPerformanceSnapshot = { enabled: false, completedRecords: 0 };

  const publish = () => {
    snapshot = { enabled, completedRecords: completed.length };
    for (const listener of listeners) listener();
  };

  const profiler: TimeCapacityPerformanceProfiler = {
    enable() {
      if (enabled) return;
      enabled = true;
      publish();
    },
    disable() {
      const changed = enabled || active.size > 0;
      enabled = false;
      active.clear();
      if (changed) publish();
    },
    isEnabled() {
      return enabled;
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin(requestId, context) {
      if (!enabled) return;
      if (active.has(requestId)) return;
      // A data-signature change supersedes the previous request. Removing it
      // also makes late HTTP or Plotly callbacks harmless.
      active.clear();
      const record: TimeCapacityInteractionProfile = {
        ...context,
        profile_version: 1,
        request_id: requestId,
        started_at_ms: clock(),
        placeholder_was_visible: false,
        result_cache: "unknown",
        raw_access: "unknown",
        http_round_trip_ms: 0,
        frontend_result_to_plot_props_ms: 0,
        plotly_update_ms: 0,
        total_interaction_ms: 0,
      };
      active.set(requestId, {
        record,
        response_received_at_ms: null,
        plot_props_ready_at_ms: null,
        plotly_started_at_ms: null,
      });
    },
    placeholderVisible(requestId, visible) {
      const current = active.get(requestId);
      if (current && visible) current.record.placeholder_was_visible = true;
    },
    response(requestId, backend, httpRoundTripMs) {
      const current = active.get(requestId);
      if (!current) return;
      if (backend && backend.request_id !== requestId) return;
      current.record.response_source = "http";
      applyBackendProfile(current.record, backend);
      current.record.http_round_trip_ms = nonNegative(httpRoundTripMs);
      current.response_received_at_ms = clock();
    },
    memoryCacheHit(requestId) {
      const current = active.get(requestId);
      if (!current) return;
      current.record.response_source = "react_query_memory";
      clearBackendFacts(current.record);
      current.record.http_round_trip_ms = 0;
      current.response_received_at_ms = clock();
    },
    streamStart(requestId, details) {
      const current = active.get(requestId);
      if (!current) return;
      current.record.mode = "ndjson";
      current.record.stream_request_id = details.streamRequestId;
      current.record.stream_total_series = details.totalSeries;
      current.record.selected_plot_strategy = SELECTED_TIME_CAPACITY_PLOT_STRATEGY;
      current.record.stream_series = [];
      current.record.stream_first_useful_ms = undefined;
      current.record.stream_final_series_received_ms = undefined;
      current.record.stream_final_metadata_received_ms = undefined;
      current.record.stream_final_received_ms = undefined;
    },
    streamSeries(requestId, details) {
      const current = active.get(requestId);
      if (!current) return;
      current.record.mode = "ndjson";
      const receivedAt = clock();
      const series = current.record.stream_series ?? [];
      // The profiler is opt-in and bounded just like the retained records;
      // retain the first 200 unit boundaries rather than raw trace data.
      if (series.length < 200) {
        series.push({
          index: details.index,
          total_series: details.totalSeries,
          received_at_ms: receivedAt,
          bytes: Math.max(0, Math.floor(details.bytes)),
        });
      }
      current.record.stream_series = series;
      current.record.stream_total_series = details.totalSeries;
      if (details.index === details.totalSeries) {
        current.record.stream_final_series_received_ms = nonNegative(
          receivedAt - current.record.started_at_ms,
        );
      }
    },
    streamComplete(requestId) {
      const current = active.get(requestId);
      if (!current) return;
      current.record.mode = "ndjson";
      const receivedAt = nonNegative(clock() - current.record.started_at_ms);
      current.record.stream_final_metadata_received_ms = receivedAt;
      current.record.stream_final_received_ms = receivedAt;
    },
    partialPlotlyComplete(requestId, visibleSeriesIndices = []) {
      const current = active.get(requestId);
      if (!current) return;
      const completedAt = clock();
      const visibleAt = nonNegative(completedAt - current.record.started_at_ms);
      const updateId = (current.record.partial_plotly_completions ?? 0) + 1;
      current.record.partial_plotly_completions = updateId;
      current.record.partial_update_count = (current.record.partial_update_count ?? 0) + 1;
      if (current.record.stream_first_useful_ms === undefined && visibleSeriesIndices.length > 0) {
        current.record.stream_first_useful_ms = visibleAt;
      }
      const coalesced = visibleSeriesIndices.length > 1;
      for (const index of visibleSeriesIndices) {
        const series = current.record.stream_series?.find((entry) => entry.index === index);
        if (!series || series.visible_at_ms !== undefined) continue;
        series.visible_at_ms = visibleAt;
        series.event_to_visible_ms = nonNegative(completedAt - series.received_at_ms);
        series.visible_update_id = updateId;
        series.visible_coalesced = coalesced;
      }
    },
    plotlyInitialized(requestId, details) {
      const current = active.get(requestId);
      if (!current || !details?.remounted) return;
      current.record.plotly_remount_count = (current.record.plotly_remount_count ?? 0) + 1;
    },
    frontendPrepared(requestId, details) {
      const current = active.get(requestId);
      if (!current || current.response_received_at_ms === null) return;
      if (current.plot_props_ready_at_ms === null) {
        current.plot_props_ready_at_ms = clock();
        current.plotly_started_at_ms = current.plot_props_ready_at_ms;
        current.record.frontend_result_to_plot_props_ms = nonNegative(
          current.plot_props_ready_at_ms - current.response_received_at_ms,
        );
      }
      if (details?.resolvedCellCount !== undefined) {
        current.record.resolved_cell_count = details.resolvedCellCount;
      }
      if (details?.plotlyTraceCount !== undefined) {
        current.record.trace_count = details.plotlyTraceCount;
      }
    },
    plotlyComplete(requestId) {
      const current = active.get(requestId);
      if (!current || current.plot_props_ready_at_ms === null || current.plotly_started_at_ms === null) {
        return;
      }
      const completedAt = clock();
      current.record.plotly_update_ms = nonNegative(
        completedAt - current.plotly_started_at_ms,
      );
      current.record.total_interaction_ms = nonNegative(
        completedAt - current.record.started_at_ms,
      );
      completed = [...completed, copyRecord(current.record)].slice(-retention);
      active.delete(requestId);
      publish();
    },
    cancel(requestId) {
      active.delete(requestId);
    },
    records() {
      return completed.map(copyRecord);
    },
    reset() {
      completed = [];
      active.clear();
      publish();
    },
    exportJson() {
      return JSON.stringify(completed.map(copyRecord), null, 2);
    },
  };
  return profiler;
}

let requestSequence = 0;

export function newTimeCapacityProfileRequestId(): string {
  requestSequence += 1;
  return `time-capacity-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export const timeCapacityPerformanceProfiler = createTimeCapacityPerformanceProfiler();

type TimeCapacityRecordingController = Pick<
  TimeCapacityPerformanceProfiler,
  "enable" | "disable" | "isEnabled" | "records" | "reset" | "exportJson"
>;

export interface TimeCapacityRecordingExport {
  filename: string;
  payload: string;
  recordCount: number;
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function timeCapacityProfileFilename(now = new Date()): string {
  const date = [
    now.getFullYear(),
    padTimePart(now.getMonth() + 1),
    padTimePart(now.getDate()),
  ].join("");
  const time = [
    padTimePart(now.getHours()),
    padTimePart(now.getMinutes()),
    padTimePart(now.getSeconds()),
  ].join("");
  return `cellxplorer-time-capacity-profile-${date}-${time}.json`;
}

export function startTimeCapacityRecording(
  profiler: TimeCapacityRecordingController = timeCapacityPerformanceProfiler,
): void {
  profiler.reset();
  profiler.enable();
}

export function stopTimeCapacityRecording(
  profiler: TimeCapacityRecordingController = timeCapacityPerformanceProfiler,
  now = new Date(),
): TimeCapacityRecordingExport {
  profiler.disable();
  const records = profiler.records();
  return {
    filename: timeCapacityProfileFilename(now),
    payload: profiler.exportJson(),
    recordCount: records.length,
  };
}

export interface TimeCapacityPerformanceWindowApi {
  enable(): void;
  disable(): void;
  reset(): void;
  records(): TimeCapacityInteractionProfile[];
  exportJson(): string;
  benchmarkStrategies(): Promise<import("./timeCapacityPlotStrategyBenchmark").TimeCapacityPlotStrategyBenchmarkResult>;
}

declare global {
  interface Window {
    cellxplorerPerformance?: {
      timeCapacity?: TimeCapacityPerformanceWindowApi;
    };
  }
}

if (typeof window !== "undefined") {
  window.cellxplorerPerformance ??= {};
  window.cellxplorerPerformance.timeCapacity ??= {
    enable: () => timeCapacityPerformanceProfiler.enable(),
    disable: () => timeCapacityPerformanceProfiler.disable(),
    reset: () => timeCapacityPerformanceProfiler.reset(),
    records: () => timeCapacityPerformanceProfiler.records(),
    exportJson: () => timeCapacityPerformanceProfiler.exportJson(),
    benchmarkStrategies: () => benchmarkTimeCapacityPlotStrategies(),
  };
}
