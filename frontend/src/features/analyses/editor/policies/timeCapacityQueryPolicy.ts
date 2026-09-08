import type { AnalysisSpec } from "../../../../api";

export type TimeCapacityQueryConfig = NonNullable<
  AnalysisSpec["computation"]["time_capacity"]
>;

export type TimeCapacityDataExportScope = "full_series" | "plot_range";

export function timeCapacityUsesContinuousTime(config: Partial<TimeCapacityQueryConfig>): boolean {
  return (config.x_axis ?? "time") === "time" &&
    (config.view ?? "voltage_current") === "voltage_current" &&
    (config.display_mode ?? "consecutive") === "consecutive" &&
    config.time_reference === "test_start";
}

/** Continuous time uses all cycles without overwriting the saved navigation range. */
export function timeCapacityEffectiveConfig(config: TimeCapacityQueryConfig): TimeCapacityQueryConfig {
  return timeCapacityUsesContinuousTime(config)
    ? { ...config, cycle_start: null, cycle_end: null, cycles: [] }
    : config;
}

export function timeCapacityDisplayChoice(config: TimeCapacityQueryConfig): string {
  return timeCapacityUsesContinuousTime(config) ? "continuous_time" : config.display_mode;
}

export function timeCapacityWithDisplayChoice(
  config: TimeCapacityQueryConfig,
  choice: string,
): TimeCapacityQueryConfig {
  return {
    ...config,
    display_mode: choice === "continuous_time" ? "consecutive" : choice as TimeCapacityQueryConfig["display_mode"],
    time_reference: choice === "continuous_time" ? "test_start" : "selected_range",
  };
}

function timeCapacityOriginCycle(config: TimeCapacityQueryConfig): number | null {
  if (config.x_axis !== "time" || config.display_mode !== "consecutive") return null;
  return config.time_reference === "test_start" ? 1
    : config.cycles.length > 0 ? Math.min(...config.cycles) : config.cycle_start ?? 1;
}

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
  const computation = (spec as Partial<AnalysisSpec>).computation;
  const config = computation?.time_capacity;
  return {
    ...spec,
    ...(config && timeCapacityUsesContinuousTime(config)
      ? { computation: { ...computation, time_capacity: timeCapacityEffectiveConfig(config) } }
      : {}),
    selection: {
      ...spec.selection,
      exclusions: [],
      hidden_replicate_group_ids: [],
    },
  } as T;
}

/**
 * Build the full-resolution data-export request without mutating the live
 * plot. A full-series export removes only the plot's cycle window; every
 * other scientific setting and the live sample visibility remain intact.
 */
export function timeCapacityDataExportSpec(
  spec: AnalysisSpec,
  config: TimeCapacityQueryConfig,
  scope: TimeCapacityDataExportScope,
): AnalysisSpec {
  return {
    ...spec,
    selection: {
      ...spec.selection,
      entries: [...spec.selection.entries],
      exclusions: [...(spec.selection.exclusions ?? [])],
      hidden_replicate_group_ids: [
        ...(spec.selection.hidden_replicate_group_ids ?? []),
      ],
    },
    computation: {
      ...spec.computation,
      time_capacity: {
        ...config,
        ...(scope === "full_series" || timeCapacityUsesContinuousTime(config)
          ? { cycles: [], cycle_start: null, cycle_end: null }
          : {}),
      },
    },
  };
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
  config = timeCapacityEffectiveConfig(config);
  const scientificSpec = timeCapacityScientificRequestSpec(spec);
  return JSON.stringify({
    // Explicit time references supersede the earlier implicit origin.
    timeCoordinateRevision: config.x_axis === "time" && config.display_mode === "consecutive" ? 3 : null,
    timeReference: config.time_reference ?? "selected_range",
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
  config = timeCapacityEffectiveConfig(config);
  const scientificSpec = timeCapacityScientificRequestSpec(spec);
  return JSON.stringify({
    // Explicit time references supersede the earlier implicit origin.
    timeCoordinateRevision: config.x_axis === "time" && config.display_mode === "consecutive" ? 3 : null,
    timeReference: config.time_reference ?? "selected_range",
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
    coordinateOriginCycle: coordinateOriginCycle ?? timeCapacityOriginCycle(config),
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
