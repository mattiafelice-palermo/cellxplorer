import type { AnalysisSpec } from "../../../../api";

export type TimeCapacityQueryConfig = NonNullable<
  AnalysisSpec["computation"]["time_capacity"]
>;

type TimeCapacityCompatibilitySpec = Pick<
  AnalysisSpec,
  "selection" | "protocol_segments" | "computation" | "presentation"
>;

/**
 * Return the identity of the meaning carried by a compact Time/Capacity
 * response. Range, point density, and viewport width are intentionally absent:
 * those fields select which records are returned, but do not relabel the
 * records already on the plot. Every coordinate/series semantic is kept here so placeholder data
 * cannot be shown under a different meaning while a new request is pending.
 */
export function timeCapacityCompatibilitySignature(
  spec: TimeCapacityCompatibilitySpec,
  config: TimeCapacityQueryConfig,
  _viewportWidth: number,
): string {
  return JSON.stringify({
    selection: spec.selection,
    protocol_segments: spec.protocol_segments ?? [],
    protocol_filter: spec.computation.protocol_filter ?? {},
    hidden_protocol_segment_ids: spec.presentation.hidden_protocol_segment_ids ?? [],
    x_axis: config.x_axis,
    time_unit: config.time_unit,
    display_mode: config.display_mode,
    electrode_area_cm2: config.electrode_area_cm2,
    voltage_channel: config.voltage_channel,
    voltage_channels: config.voltage_channels ?? [config.voltage_channel],
    view: config.view,
    derivative_phase: config.derivative_phase,
    derivative_specific: config.derivative_specific,
    derivative_absolute_discharge: config.derivative_absolute_discharge,
    smoothing_window: config.smoothing_window,
  });
}

export function timeCapacityPlaceholderCompatible(
  previousSignature: string | undefined,
  nextSignature: string,
): boolean {
  return previousSignature !== undefined && previousSignature === nextSignature;
}

/**
 * React Query supplies the last query key alongside placeholder data. The
 * compatibility signature is the third key component; the full data
 * signature remains the fourth component and still owns fetching/cache
 * identity for the complete request.
 */
export function timeCapacityPlaceholderData<T>(
  previousData: T | undefined,
  previousQueryKey: readonly unknown[] | undefined,
  analysisId: number,
  nextSignature: string,
): T | undefined {
  if (
    previousData === undefined ||
    previousQueryKey?.[0] !== "time-capacity" ||
    Number(previousQueryKey[1]) !== analysisId
  ) {
    return undefined;
  }
  const previousSignature =
    typeof previousQueryKey[2] === "string" ? previousQueryKey[2] : undefined;
  return timeCapacityPlaceholderCompatible(previousSignature, nextSignature)
    ? previousData
    : undefined;
}

/**
 * Decide whether the currently visible plot can be exported.
 *
 * Ordinary range navigation may temporarily retain the last resolved result
 * while the replacement query is running. That result is still the complete
 * plot shown to the user, so range replacement must not toggle export controls
 * or close their settings menu. The transient flag is reserved for states
 * whose visible result is only a pan/refill fallback.
 */
export function timeCapacityPlotExportReady(
  isTransientRenderState: boolean,
  hasCurrentResult: boolean,
  voltageUnavailable: boolean,
  hasTraces: boolean,
): boolean {
  return !isTransientRenderState && hasCurrentResult && !voltageUnavailable && hasTraces;
}

/** A transient pan/refill must never replace the last valid plot with an empty loader. */
export function timeCapacityRetainedPanResult<T>(
  current: T | undefined,
  lastValid: T | undefined,
  panActive: boolean,
): T | undefined {
  return current ?? (panActive ? lastValid : undefined);
}
