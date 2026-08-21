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
}

export interface TimeCapacityFrontendPreparedDetails {
  resolvedCellCount?: number;
  plotlyTraceCount?: number;
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
  plotlyComplete(requestId: string): void;
  cancel(requestId: string): void;
  records(): TimeCapacityInteractionProfile[];
  reset(): void;
  exportJson(): string;
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

  const profiler: TimeCapacityPerformanceProfiler = {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      active.clear();
    },
    isEnabled() {
      return enabled;
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

export interface TimeCapacityPerformanceWindowApi {
  enable(): void;
  disable(): void;
  reset(): void;
  records(): TimeCapacityInteractionProfile[];
  exportJson(): string;
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
  };
}
