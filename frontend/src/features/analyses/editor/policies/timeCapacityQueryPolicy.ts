import type { AnalysisSpec } from "../../../../api";

export type TimeCapacityQueryConfig = NonNullable<
  AnalysisSpec["computation"]["time_capacity"]
>;

type TimeCapacityCompatibilitySpec = Pick<
  AnalysisSpec,
  "selection" | "protocol_segments" | "computation" | "presentation"
>;

/**
 * Build the Time/Capacity scientific request without the Analysis samples
 * display filters. The live spec remains the source of truth for rendering
 * and persistence; this copy is only for the interactive scientific query.
 */
export function timeCapacityScientificRequestSpec<T extends Pick<AnalysisSpec, "selection">>(
  spec: T,
): T {
  return {
    ...spec,
    selection: {
      ...spec.selection,
      exclusions: [],
      hidden_replicate_group_ids: [],
    },
  } as T;
}

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
  const scientificSpec = timeCapacityScientificRequestSpec(spec);
  return JSON.stringify({
    selection: scientificSpec.selection,
    protocol_segments: scientificSpec.protocol_segments ?? [],
    protocol_filter: scientificSpec.computation.protocol_filter ?? {},
    hidden_protocol_segment_ids: scientificSpec.presentation.hidden_protocol_segment_ids ?? [],
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

/**
 * Identity of the compact Time/Capacity data request. Analysis-sample eye
 * state is deliberately excluded here, while selected entries and every
 * scientific/display coordinate input remain part of the identity.
 */
export function timeCapacityDataSignature(
  spec: TimeCapacityCompatibilitySpec,
  config: TimeCapacityQueryConfig,
  viewportWidth: number,
  coordinateOriginCycle: number | null = null,
): string {
  const scientificSpec = timeCapacityScientificRequestSpec(spec);
  return JSON.stringify({
    selection: scientificSpec.selection,
    protocol_segments: scientificSpec.protocol_segments ?? [],
    protocol_filter: scientificSpec.computation.protocol_filter,
    hidden_protocol_segment_ids: scientificSpec.presentation.hidden_protocol_segment_ids ?? [],
    cycles: config.cycles,
    start: config.cycle_start,
    end: config.cycle_end,
    points: config.max_points_per_cell,
    xAxis: config.x_axis,
    timeUnit: config.time_unit,
    displayMode: config.display_mode,
    electrodeArea: config.electrode_area_cm2,
    voltageChannel: config.voltage_channel,
    voltageChannels: config.voltage_channels,
    viewportWidth,
    coordinateOriginCycle,
    derivative: config.view === "voltage_current" ? null : {
      view: config.view,
      phase: config.derivative_phase,
      specific: config.derivative_specific,
      absoluteDischarge: config.derivative_absolute_discharge,
      smoothing: config.smoothing_window,
    },
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
