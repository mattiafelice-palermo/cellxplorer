import type { TimeCapacityResult, TimeCapacityTrace } from "../../../../../api";

export interface TimeCapacityStreamStart {
  type: "start";
  stream_version: 1;
  request_id: string;
  total_series: number;
  data_signature: string;
  source_data_signature: string;
  cache_status: "miss";
}

export interface TimeCapacityStreamSeries {
  type: "series";
  stream_version: 1;
  request_id: string;
  index: number;
  total_series: number;
  trace: TimeCapacityTrace;
}

export interface TimeCapacityStreamComplete {
  type: "complete";
  stream_version: 1;
  request_id: string;
  total_series: number;
  metadata: Omit<TimeCapacityResult, "cell_traces">;
}

export interface TimeCapacityStreamError {
  type: "error";
  stream_version: 1;
  request_id: string;
  error: { code: string; message: string };
}

export type TimeCapacityStreamEvent =
  | TimeCapacityStreamStart
  | TimeCapacityStreamSeries
  | TimeCapacityStreamComplete
  | TimeCapacityStreamError;

export type TimeCapacityProgressStatus = "starting" | "partial" | "complete" | "error";

export interface TimeCapacityProgressState {
  generation: string;
  requestId: string;
  status: TimeCapacityProgressStatus;
  totalSeries: number;
  traces: TimeCapacityTrace[];
  result?: TimeCapacityResult;
  error?: string;
  dataSignature?: string;
  sourceDataSignature?: string;
  partialUpdateCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Progressive response field ${name} is invalid.`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Progressive response field ${name} is invalid.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const number = requiredNonNegativeInteger(value, name);
  if (number < 1) throw new Error(`Progressive response field ${name} is invalid.`);
  return number;
}

function validateTrace(value: unknown): TimeCapacityTrace {
  if (!isRecord(value) || typeof value.cell_id !== "number" || !Array.isArray(value.cycle)) {
    throw new Error("Progressive response trace is invalid.");
  }
  return value as unknown as TimeCapacityTrace;
}

/** Validate the wire contract before any event reaches progressive state. */
export function parseTimeCapacityStreamEvent(value: unknown): TimeCapacityStreamEvent {
  if (!isRecord(value) || value.stream_version !== 1) {
    throw new Error("Progressive response has an unsupported stream version.");
  }
  const requestId = requiredString(value.request_id, "request_id");
  switch (value.type) {
    case "start":
      if (value.cache_status !== "miss") {
        throw new Error("Progressive start event must describe a cache miss.");
      }
      return {
        type: "start",
        stream_version: 1,
        request_id: requestId,
        total_series: requiredNonNegativeInteger(value.total_series, "total_series"),
        data_signature: requiredString(value.data_signature, "data_signature"),
        source_data_signature: requiredString(
          value.source_data_signature,
          "source_data_signature",
        ),
        cache_status: "miss",
      };
    case "series": {
      const totalSeries = requiredNonNegativeInteger(value.total_series, "total_series");
      const index = requiredPositiveInteger(value.index, "index");
      if (index > totalSeries) throw new Error("Progressive series index is out of range.");
      return {
        type: "series",
        stream_version: 1,
        request_id: requestId,
        index,
        total_series: totalSeries,
        trace: validateTrace(value.trace),
      };
    }
    case "complete": {
      const totalSeries = requiredNonNegativeInteger(value.total_series, "total_series");
      if (!isRecord(value.metadata) || "cell_traces" in value.metadata) {
        throw new Error("Progressive complete metadata is invalid.");
      }
      return {
        type: "complete",
        stream_version: 1,
        request_id: requestId,
        total_series: totalSeries,
        metadata: value.metadata as unknown as Omit<TimeCapacityResult, "cell_traces">,
      };
    }
    case "error":
      if (!isRecord(value.error)) throw new Error("Progressive error payload is invalid.");
      return {
        type: "error",
        stream_version: 1,
        request_id: requestId,
        error: {
          code: requiredString(value.error.code, "error.code"),
          message: requiredString(value.error.message, "error.message"),
        },
      };
    default:
      throw new Error("Progressive response contains an unknown event type.");
  }
}

export function beginTimeCapacityProgress(
  generation: string,
  event: TimeCapacityStreamStart,
): TimeCapacityProgressState {
  return {
    generation,
    requestId: event.request_id,
    status: "starting",
    totalSeries: event.total_series,
    traces: [],
    dataSignature: event.data_signature,
    sourceDataSignature: event.source_data_signature,
    partialUpdateCount: 0,
  };
}

/**
 * Apply an event only to its own request. Series are intentionally accepted
 * only in canonical one-based order; no partial result is ever a React Query
 * result or a persistent cache value.
 */
export function applyTimeCapacityProgress(
  state: TimeCapacityProgressState | null,
  generation: string,
  event: TimeCapacityStreamEvent,
): TimeCapacityProgressState | null {
  if (event.type === "start") {
    return beginTimeCapacityProgress(generation, event);
  }
  if (!state || state.generation !== generation || state.requestId !== event.request_id) {
    return state;
  }
  if (event.type === "series") {
    if (event.total_series !== state.totalSeries || event.index !== state.traces.length + 1) {
      throw new Error("Progressive series events are not in canonical order.");
    }
    return {
      ...state,
      status: "partial",
      traces: [...state.traces, event.trace],
      partialUpdateCount: state.partialUpdateCount + 1,
    };
  }
  if (event.type === "complete") {
    if (event.total_series !== state.totalSeries || state.traces.length !== state.totalSeries) {
      throw new Error("Progressive complete event arrived before all series.");
    }
    return {
      ...state,
      status: "complete",
      result: { ...event.metadata, cell_traces: state.traces },
    };
  }
  return {
    ...state,
    status: "error",
    traces: [],
    error: event.error.message,
  };
}

export function timeCapacityProgressCue(state: TimeCapacityProgressState | null): string | null {
  if (!state || (state.status !== "starting" && state.status !== "partial")) return null;
  return `${state.traces.length} of ${state.totalSeries} series loaded · calculating…`;
}
