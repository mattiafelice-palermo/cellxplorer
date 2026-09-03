import {
  Accordion,
  Alert,
  Button,
  Box,
  Center,
  Checkbox,
  Combobox,
  Group,
  InputBase,
  LoadingOverlay,
  Paper,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  useCombobox,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PlotlyLib from "plotly.js-dist-min";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  postBlob,
  type AnalysisSpec,
  type BackgroundJob,
  type PlotExportFormat,
  type PlotStyle,
  type SeriesStyleOverride,
  type SeriesStyleRule,
  type TimeCapacityResult,
  type TimeCapacityRefinementResult,
  type TimeCapacityTrace,
} from "../../../../../api";
import { DebouncedNumberInput } from "../../../../../components/DebouncedInputs";
import {
  shouldShowVoltageChannelSelector,
  normalizeVoltageChannels,
  plotlySafeText,
  timeCapacityExportOptions,
  timeCapacityExportMatchesRequest,
  voltageChannelAvailabilityPublication,
  voltageChannelAvailabilitySignature,
  voltageChannelDataIdentity,
  voltageChannelUnavailableMessage,
  voltageChannelLabel,
  voltageChannelSelectionLabel,
  voltageChannelSelectionSummary,
  voltageChannelSelectorOptions,
  voltageChannelsUnavailable,
  voltageChannelsUnavailableMessage,
  timeCapacityResultMatchesVoltageChannels,
  type VoltageChannel,
} from "../../policies/voltageChannelPolicy";
import {
  timeCapacityCompatibilitySignature,
  timeCapacityDataExportSpec,
  timeCapacityDataSignature,
  timeCapacityPlotExportReady,
  timeCapacityPlaceholderData,
  timeCapacityRetainedPanResult,
  timeCapacityScientificRequestSpec,
} from "../../policies/timeCapacityQueryPolicy";
import {
  hiddenSeriesIdsAfterShowAll,
  hiddenSeriesIdsAfterShowOnly,
  isSeriesHidden,
  plotSeriesVisibilityItems,
} from "../../policies/analysisVisibility";
import Plot from "../../../../../components/Plot";
import { getTimeCapacityExplainer } from "../../plotting/plotExplainers";
import {
  axisLayout,
  numericTraceExtent,
} from "../../plotting/plotAxisLayout";
import {
  blobFromDataUrl,
  downloadBlob,
  downloadDataExport,
  exportFigure,
  makeVectorPdf,
  pngWithPpi,
  resolveExportPlan,
  slugFilename,
  tracesToColumns,
} from "../../plotting/plotExport";
import {
  axisGapDelta,
  draggedLegendPoint,
  hoverLabelLayout,
  legendLayout,
  legendMargins,
  tickLayout,
} from "../../plotting/plotLayout";
import {
  interactivePlotTraces,
  newComputeToken,
  useDelayedFlag,
  usePlotSizeSync,
  useZoomMemory,
} from "../../plotting/plotRuntime";
import {
  currentPlotStyle,
  plotPalette,
  writeScopedStyle,
} from "../../plotting/plotStyle";
import { paletteColorAt, paletteOverflowMode } from "../../plotting/paletteDraft";
import {
  decimatePreviewTraces,
  resolveSeriesStyle,
  seriesLegendRanks,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  shortSourceName,
  timeCapacitySeriesDescriptors,
  timeCapacitySeriesDescriptor,
  timeCapacityVoltageSeriesDescriptor,
  type SeriesDescriptor,
} from "../../plotting/seriesStyling";
import { sourceExportColumns, sourceExportColumnsFromPoints } from "../../plotting/sourceChainPlot";
import {
  timeCapacitySourceAt,
  type TimeCapacitySourcePoint,
} from "./timeCapacityProvenance";
import {
  timeCapacitySeriesVisibilityCandidatesForConfig,
  timeCapacityTraceIsHidden,
  timeCapacityVisibilityKey,
  timeCapacityVisibleVoltageChannels,
  timeCapacityVoltageVisibilityKey,
} from "./timeCapacityVisibility";
import {
  consecutiveTimeCapacityExportColumns,
  timeCapacityNativeExportPlan,
} from "./timeCapacityDataExport";
import {
  timeCapacityCycleRangeForViewport,
  timeCapacityOverviewExtent,
  timeCapacityRefinementCanSchedule,
  timeCapacityRefinementDisplayIsCompatible,
  timeCapacityRefinementDisplayIsCurrent,
  timeCapacityRefinementTransitionDuration,
  timeCapacityRefinementTransitionProgress,
  timeCapacityRefinementWorthwhile,
  timeCapacityVisibleCycleRangeForViewport,
  type TimeCapacityViewport,
} from "./timeCapacityRefinementPolicy";
import { TimeCapacityRefinementLifecycle } from "./timeCapacityRefinementLifecycle";
import { TimeCapacityCycleNavigation } from "./TimeCapacityCycleNavigation";
import {
  timeCapacityPreviewCancel,
  timeCapacityPreviewFlushMoving,
  timeCapacityPreviewMaxPoints,
  timeCapacityPreviewOnMove,
  timeCapacityPreviewOnMovingRequestComplete,
  timeCapacityPreviewPromoteOnIdle,
  timeCapacityPreviewRequestIsCurrent,
  timeCapacityPreviewSchedulerInitialState,
  timeCapacityCommittedNavigationCancel,
  timeCapacityCommittedNavigationOnRange,
  timeCapacityCommittedNavigationOnRequestSettled,
  timeCapacityCommittedNavigationRequestIsCurrent,
  timeCapacityCommittedNavigationSchedulerInitialState,
  TIME_CAPACITY_PREVIEW_IDLE_MS,
  TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
  type TimeCapacityCycleRange,
  type TimeCapacityCommittedNavigationRequest,
  type TimeCapacityCommittedNavigationSchedulerState,
  type TimeCapacityPreviewRequest,
  type TimeCapacityPreviewSchedulerState,
} from "./timeCapacityCycleNavigationPolicy";
import {
  buildTimeCapacityCycleXIndex,
  interpolatedXRangeForCycleIndex,
  nextTimeCapacityPanMotion,
  timeCapacityBufferCancel,
  timeCapacityBufferOnFailed,
  timeCapacityBufferOnMove,
  timeCapacityBufferOnRendered,
  timeCapacityBufferOnResponseReady,
  timeCapacityBufferPlanForWindow,
  timeCapacityBufferSchedulerInitialState,
  timeCapacityPanningEnabled,
  yDataOutsideRange,
  TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH,
  type TimeCapacityBufferRequest,
  type TimeCapacityBufferSchedulerDecision,
  type TimeCapacityBufferSchedulerState,
  type TimeCapacityPanMotion,
} from "./timeCapacityViewportBuffer";
import {
  ComputeProgress,
  PlotHeader,
  type PlotDataExportScope,
} from "../../plotting/PlotHeader";
import { PlotStylePanel } from "../../plotting/PlotStylePanel";
import {
  newTimeCapacityProfileRequestId,
  timeCapacityPerformanceNow,
  timeCapacityPerformanceProfiler,
  timeCapacityProfileResultIsCurrent,
  timeCapacityResolvedCellCount,
  type TimeCapacityPerformanceContext,
} from "../../performance/timeCapacityPerformanceProfile";

export type TimeCapacityConfig = Omit<
  NonNullable<AnalysisSpec["computation"]["time_capacity"]>,
  "voltage_channels"
> & {
  voltage_channels: VoltageChannel[];
};
type TimeCapacityCurrentQuantity = TimeCapacityConfig["current_left"];
type TimeCapacityCurrentAxis = TimeCapacityConfig["current_right"];
export type TimeCapacityVoltageChannel = VoltageChannel;

// Vertical double-headed arrow: "expand the y axis to fit".
const TIME_CAPACITY_FIT_Y_MODEBAR_ICON = {
  width: 512,
  height: 512,
  path: "M256 24 L336 128 H288 V384 H336 L256 488 L176 384 H224 V128 H176 Z",
};

const TIME_CAPACITY_GRID_MODEBAR_ICON = {
  width: 512,
  height: 512,
  path: "M64 64h144v144H64zM304 64h144v144H304zM64 304h144v144H64zM304 304h144v144H304z",
};

const TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH = 1200;

function timeCapacitySpecWithPreview(
  spec: AnalysisSpec,
  range: TimeCapacityCycleRange,
  resolution: TimeCapacityPreviewRequest["resolution"],
  maxPointsOverride?: number,
): AnalysisSpec {
  const config = timeCapacityConfig(spec);
  return {
    ...spec,
    computation: {
      ...spec.computation,
      time_capacity: {
        ...config,
        cycle_start: range.start,
        cycle_end: range.end,
        max_points_per_cell:
          maxPointsOverride ??
          timeCapacityPreviewMaxPoints(config.max_points_per_cell, resolution),
      },
    },
  };
}

function timeCapacitySpecWithCycleRange(
  spec: AnalysisSpec,
  range: TimeCapacityCycleRange,
): AnalysisSpec {
  const config = timeCapacityConfig(spec);
  return {
    ...spec,
    computation: {
      ...spec.computation,
      time_capacity: {
        ...config,
        cycle_start: range.start,
        cycle_end: range.end,
      },
    },
  };
}

const CURRENT_AXIS_OPTIONS: { value: TimeCapacityCurrentQuantity; label: string }[] = [
  { value: "current_ma", label: "Current (mA)" },
  { value: "current_density", label: "Current density (mA/cm2)" },
  { value: "c_rate", label: "C-rate (C)" },
];

const CURRENT_RIGHT_AXIS_OPTIONS: { value: TimeCapacityCurrentAxis; label: string }[] = [
  { value: "none", label: "None" },
  ...CURRENT_AXIS_OPTIONS,
];

export const DEFAULT_TIME_CAPACITY: TimeCapacityConfig = {
  x_axis: "time",
  time_unit: "min",
  display_mode: "consecutive",
  stacked: false,
  current_left: "current_ma",
  current_right: "none",
  electrode_area_cm2: null,
  view: "voltage_current",
  derivative_phase: "both",
  derivative_specific: false,
  derivative_absolute_discharge: true,
  smoothing_window: 7,
  cycle_start: 1,
  cycle_end: 3,
  cycles: [],
  max_points_per_cell: 4000,
  voltage_channel: "voltage",
  voltage_channels: ["voltage"],
};


export function timeCapacityConfig(spec: AnalysisSpec): TimeCapacityConfig {
  const saved = spec.computation.time_capacity as
    | NonNullable<AnalysisSpec["computation"]["time_capacity"]>
    | undefined;
  const legacyChannel =
    saved?.voltage_channel === "working_potential" || saved?.voltage_channel === "counter_potential"
      ? saved.voltage_channel
      : "voltage";
  const selectedChannels = normalizeVoltageChannels(saved?.voltage_channels, legacyChannel);
  return {
    ...DEFAULT_TIME_CAPACITY,
    ...saved,
    voltage_channel: selectedChannels[0] ?? legacyChannel,
    voltage_channels: selectedChannels,
  } as TimeCapacityConfig;
}


function numeric(values: (number | null)[]): number[] {
  return values.map((value) => (value === null || Number.isNaN(value) ? NaN : value));
}

function consecutiveX(values: number[]): number[] {
  const out: number[] = [];
  let offset = 0;
  let last = values.find((value) => !Number.isNaN(value)) ?? 0;
  for (const value of values) {
    if (Number.isNaN(value)) {
      out.push(NaN);
      continue;
    }
    if (value < last) offset += last;
    out.push(offset + value);
    last = value;
  }
  const first = out.find((value) => !Number.isNaN(value)) ?? 0;
  return out.map((value) => (Number.isNaN(value) ? value : value - first));
}

function overlapX(values: number[], cycles: (number | null)[], phases: string[], mirrored: boolean): number[] {
  const keys = values.map((_, index) => `${cycles[index] ?? "?"}:${phases[index] ?? "rest"}`);
  const starts = new Map<string, number>();
  const maxes = new Map<string, number>();
  values.forEach((value, index) => {
    if (Number.isNaN(value)) return;
    const key = keys[index];
    if (!starts.has(key)) starts.set(key, value);
    maxes.set(key, Math.max(maxes.get(key) ?? 0, value - (starts.get(key) ?? 0)));
  });
  return values.map((value, index) => {
    if (Number.isNaN(value)) return value;
    const key = keys[index];
    const reset = value - (starts.get(key) ?? 0);
    if (mirrored && phases[index] === "discharge") return (maxes.get(key) ?? 0) - reset;
    return reset;
  });
}

function timeCapacityXAxisTitle(cfg: TimeCapacityConfig): string {
  return cfg.x_axis === "capacity_mah_g"
    ? "Specific capacity (mAh/g)"
    : cfg.x_axis === "capacity_mah_cm2"
    ? "Areal capacity (mAh/cm²)"
    : cfg.x_axis === "capacity_mah"
    ? "Capacity (mAh)"
    : `Time (${cfg.time_unit})`;
}

function timeCapacityX(trace: TimeCapacityTrace, spec: AnalysisSpec): { x: number[]; title: string } {
  const cfg = timeCapacityConfig(spec);
  const title = timeCapacityXAxisTitle(cfg);

  // Compact ordinary responses make display_x authoritative and may omit the
  // redundant raw time array. Check it before touching any alternate x source
  // so rendering, hover and export do not depend on time_s being populated.
  if (trace.display_x?.length === trace.cycle.length) {
    return { x: numeric(trace.display_x), title };
  }

  let raw: number[];
  if (cfg.x_axis === "capacity_mah_g") {
    raw = numeric(trace.capacity_mah_g);
  } else if (cfg.x_axis === "capacity_mah_cm2") {
    raw = numeric(trace.capacity_mah_cm2 ?? []);
  } else if (cfg.x_axis === "capacity_mah") {
    raw = numeric(trace.capacity_mah);
  } else {
    const factor = cfg.time_unit === "h" ? 3600 : cfg.time_unit === "min" ? 60 : 1;
    raw = numeric(trace.time_s).map((value) => value / factor);
  }

  if (cfg.display_mode === "overlap_reset") {
    return { x: overlapX(raw, trace.cycle, trace.phase, false), title };
  }
  if (cfg.display_mode === "overlap_mirror") {
    return { x: overlapX(raw, trace.cycle, trace.phase, true), title };
  }
  return { x: consecutiveX(raw), title };
}

type TimeCapacitySegment = {
  key: string;
  phase: string;
  x: number[];
  cycle: (number | null)[];
  sourceCycle: (number | null)[];
  sources: TimeCapacitySourcePoint[];
  voltage: (number | null)[];
  voltageByChannel: Partial<Record<VoltageChannel, (number | null)[]>>;
  current: (number | null)[];
};

function traceVoltageValues(
  trace: TimeCapacityTrace,
  channel: VoltageChannel,
  fallbackChannel: VoltageChannel,
): (number | null)[] {
  const values = trace.voltage_v_by_channel?.[channel];
  if (Array.isArray(values)) return values;
  return channel === fallbackChannel ? trace.voltage_v : [];
}

function timeCapacitySegments(
  trace: TimeCapacityTrace,
  spec: AnalysisSpec,
  xOverride?: number[],
): TimeCapacitySegment[] {
  const cfg = timeCapacityConfig(spec);
  const selectedChannels = cfg.voltage_channels;
  const voltageValues = new Map(
    selectedChannels.map((channel) => [
      channel,
      traceVoltageValues(trace, channel, cfg.voltage_channel),
    ] as const),
  );
  const x = xOverride ?? timeCapacityX(trace, spec).x;
  const segments: TimeCapacitySegment[] = [];
  let current: TimeCapacitySegment | null = null;

  const flush = () => {
    if (current && current.x.length > 0) segments.push(current);
    current = null;
  };

  for (let index = 0; index < x.length; index += 1) {
    const phase = cfg.display_mode === "consecutive" ? "consecutive" : trace.phase[index] ?? "rest";
    if (cfg.display_mode !== "consecutive" && phase !== "charge" && phase !== "discharge") {
      flush();
      continue;
    }

    const key =
      cfg.display_mode === "consecutive"
        ? "consecutive"
        : `${trace.cycle[index] ?? "unknown"}:${phase}`;
    if (!current || current.key !== key) {
      flush();
      current = {
        key,
        phase,
        x: [],
        cycle: [],
        sourceCycle: [],
        sources: [],
        voltage: [],
        voltageByChannel: Object.fromEntries(
          selectedChannels.map((channel) => [channel, []]),
        ) as Partial<Record<VoltageChannel, (number | null)[]>>,
        current: [],
      };
    }
    current.x.push(x[index]);
    current.cycle.push(trace.cycle[index] ?? null);
    current.sourceCycle.push(trace.source_cycle?.[index] ?? null);
    current.sources.push(timeCapacitySourceAt(trace, index));
    const firstChannel = selectedChannels[0];
    current.voltage.push(
      firstChannel ? voltageValues.get(firstChannel)?.[index] ?? null : null,
    );
    for (const channel of selectedChannels) {
      current.voltageByChannel[channel]?.push(voltageValues.get(channel)?.[index] ?? null);
    }
    current.current.push(trace.current_ma[index] ?? null);
  }
  flush();
  return segments;
}

function currentAxisLabel(quantity: TimeCapacityCurrentAxis): string {
  if (quantity === "current_density") return "Current density (mA/cm2)";
  if (quantity === "c_rate") return "C-rate (C)";
  if (quantity === "current_ma") return "Current (mA)";
  return "";
}

function currentAxisValues(
  segment: TimeCapacitySegment,
  trace: TimeCapacityTrace,
  quantity: TimeCapacityCurrentAxis,
  cfg: TimeCapacityConfig
): (number | null)[] {
  const area = cfg.electrode_area_cm2 ?? trace.electrode_area_cm2 ?? null;
  const nominal = trace.nominal_capacity_mah ?? null;
  return segment.current.map((value) => {
    if (value === null || !Number.isFinite(value)) return null;
    if (quantity === "current_density") return area && area > 0 ? value / area : null;
    if (quantity === "c_rate") return nominal && nominal > 0 ? value / nominal : null;
    if (quantity === "current_ma") return value;
    return null;
  });
}

function hasFinitePoint(values: (number | null)[]): boolean {
  return values.some((value) => value !== null && Number.isFinite(value));
}

function compactHoverName(name: string): string {
  const compact = shortSourceName(name, 28);
  if (compact.length <= 18) return plotlySafeText(compact);

  // Plotly cannot wrap hover text itself. Keep the cell/source label inside a
  // predictable width while the surrounding <b> tag keeps both lines bold.
  const separator = compact.lastIndexOf("_", 18);
  const splitAt = separator > 0 ? separator + 1 : 18;
  return `${plotlySafeText(compact.slice(0, splitAt))}<br>${plotlySafeText(compact.slice(splitAt))}`;
}

const VOLTAGE_CHANNEL_PALETTE_INDEX: Record<VoltageChannel, number> = {
  voltage: 0,
  working_potential: 1,
  counter_potential: 2,
};

function voltageChannelColor(
  channel: VoltageChannel,
  baseColor: string,
  palette: string[],
  paletteOverflow: "repeat" | "generate",
  multiple: boolean,
): string {
  if (!multiple) return baseColor;
  // Keep a channel's colour stable when another channel is toggled. The
  // canonical channel order also makes the three-electrode default read as
  // three palette entries, while the line style remains shared.
  return paletteColorAt(palette, VOLTAGE_CHANNEL_PALETTE_INDEX[channel], paletteOverflow);
}

/** Primary CellXplorer visibility targets for the current Time/capacity plot. */
export function timeCapacitySeriesVisibilityCandidates(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
): { key: string; label: string }[] {
  const cfg = timeCapacityConfig(spec);
  return timeCapacitySeriesVisibilityCandidatesForConfig(result, spec, cfg);
}

function hasRightCurrentValues(result: TimeCapacityResult | undefined, spec: AnalysisSpec): boolean {
  if (!result) return false;
  const cfg = timeCapacityConfig(spec);
  if (!cfg.stacked || !cfg.current_right || cfg.current_right === "none") return false;
  return result.cell_traces.some((trace) => {
    if (timeCapacityTraceIsHidden(trace, spec)) return false;
    const area = cfg.electrode_area_cm2 ?? trace.electrode_area_cm2 ?? null;
    const nominal = trace.nominal_capacity_mah ?? null;
    return trace.current_ma.some((value, index) => {
      if (value === null || !Number.isFinite(value)) return false;
      if (
        cfg.display_mode !== "consecutive" &&
        trace.phase[index] !== "charge" &&
        trace.phase[index] !== "discharge"
      ) {
        return false;
      }
      if (cfg.current_right === "current_density") return Boolean(area && area > 0);
      if (cfg.current_right === "c_rate") return Boolean(nominal && nominal > 0);
      return true;
    });
  });
}

export function timeCapacityTracesForResult(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  interactiveWebGl = false,
  preserveAnalysisSampleVisibility = false,
): Plotly.Data[] {
  const style = currentPlotStyle(spec, "time_capacity");
  const palette = plotPalette(style);
  const cfg = timeCapacityConfig(spec);
  const selectedVoltageChannels = cfg.voltage_channels;
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  const legendShown = new Set<string>();
  const legendRanks = seriesLegendRanks(
    timeCapacitySeriesDescriptors(
      result.cell_traces,
      cfg.view === "voltage_current" ? selectedVoltageChannels : [],
    ),
    style.series_order,
  );
  const multipleVoltageChannels =
    cfg.view === "voltage_current" && selectedVoltageChannels.length > 1;
  const traceType = interactiveWebGl ? "scattergl" : "scatter";
  const paletteOverflow = paletteOverflowMode(style.palette_overflow_mode);
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key))
      colorFor.set(key, style.custom_colors[key] ?? paletteColorAt(palette, ci++, paletteOverflow));
    return colorFor.get(key)!;
  };
  // Per-series resolution against this tab's own key scheme. The base carries
  // what each trace previously hardcoded, so an unstyled plot is unchanged.
  const resolveTrace = (
    descriptor: SeriesDescriptor,
    color: string,
    lineDash: PlotStyle["line_dash"],
  ) =>
    resolveSeriesStyle(
      {
        color,
        lineWidth: style.line_width,
        lineDash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      },
      descriptor,
      style.series_rules,
      style.series_overrides,
    );

  if (cfg.view !== "voltage_current") {
    for (const trace of result.cell_traces) {
      const analysisSampleHidden = timeCapacityTraceIsHidden(trace, spec);
      if (analysisSampleHidden && !preserveAnalysisSampleVisibility) continue;
      const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
      if (isSeriesHidden(spec, timeCapacityVisibilityKey(seriesKey))) continue;
      const analysisSample = {
        cell_id: trace.cell_id,
        group_id: trace.group_id,
        excluded: trace.excluded,
      };
      const color = pick(seriesKey);
      const baseName = trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label;
      const descriptor = timeCapacitySeriesDescriptor(trace);
      const resolvedByPhase = new Map<string | null, ReturnType<typeof resolveTrace>>();
      let start = 0;
      while (start < trace.derivative_x.length) {
        const cycle = trace.cycle[start];
        const phase = trace.phase[start];
        let end = start + 1;
        while (end < trace.derivative_x.length && trace.cycle[end] === cycle && trace.phase[end] === phase) end += 1;
        const x = trace.derivative_x.slice(start, end);
        const y = trace.derivative_y.slice(start, end);
        if (hasFinitePoint(x) && hasFinitePoint(y)) {
          const cycles = trace.cycle.slice(start, end);
          const sourceCycle = trace.source_cycle?.slice(start, end);
          const sourcePosition = trace.source_position?.slice(start, end);
          const sourceFilename = trace.source_filename?.slice(start, end);
          const sourceHash = trace.source_hash?.slice(start, end);
          let resolved = resolvedByPhase.get(phase);
          if (!resolved) {
            resolved = resolveTrace(
              descriptor,
              color,
              phase === "discharge" ? "dash" : style.line_dash,
            );
            resolvedByPhase.set(phase, resolved);
          }
          if (resolved.hidden) {
            start = end;
            continue;
          }
          const showlegend = !legendShown.has(seriesKey);
          legendShown.add(seriesKey);
          out.push({
            x,
            y,
            name: resolved.name,
            legendgroup: seriesKey,
            showlegend: showlegend && resolved.showInLegend,
            legendrank: legendRanks.get(seriesKey),
            opacity: resolved.opacity,
            line: {
              color: resolved.color,
              width: resolved.lineWidth,
              dash: resolved.lineDash,
              shape: resolved.lineShape,
            },
            marker: {
              color: resolved.color,
              size: resolved.markerSize,
              symbol: seriesPlotlySymbol(resolved),
            },
            mode: seriesPlotlyMode(resolved),
            type: traceType,
            connectgaps: false,
            cellxplorer_analysis_sample: analysisSample,
            meta: `${phase}, cycle ${cycle ?? "?"}`,
            cellxplorer_export_columns: sourceExportColumns(
              baseName,
              cycles,
              sourceCycle,
              sourcePosition,
              sourceFilename,
              sourceHash,
            ),
            hovertemplate:
              `<b>${compactHoverName(resolved.name)}</b><br>` +
              "value %{y:.5g}<br>x %{x:.5g}<br>%{meta}<extra></extra>",
          } as Plotly.Data);
        }
        start = end;
      }
    }
    return out;
  }

  for (const trace of result.cell_traces) {
    const analysisSampleHidden = timeCapacityTraceIsHidden(trace, spec);
    if (analysisSampleHidden && !preserveAnalysisSampleVisibility) continue;
    const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
    if (!multipleVoltageChannels && isSeriesHidden(spec, timeCapacityVisibilityKey(seriesKey))) {
      continue;
    }
    const analysisSample = {
      cell_id: trace.cell_id,
      group_id: trace.group_id,
      excluded: trace.excluded,
    };
    const color = pick(seriesKey);
    const descriptor = timeCapacitySeriesDescriptor(trace);
    const resolved = resolveTrace(
      descriptor,
      color,
      style.line_dash,
    );
    if (resolved.hidden) continue;
    const name = resolved.name;
    const fullX = timeCapacityX(trace, spec).x;
    const channelStyles = selectedVoltageChannels.map((channel) => {
      const channelKey = `${seriesKey}|${channel}`;
      const channelDescriptor = multipleVoltageChannels
        ? timeCapacityVoltageSeriesDescriptor(trace, channel)
        : descriptor;
      const channelColor = multipleVoltageChannels
        ? style.custom_colors[channelKey] ??
          style.custom_colors[seriesKey] ??
          voltageChannelColor(channel, resolved.color, palette, paletteOverflow, true)
        : resolved.color;
      const channelResolved = multipleVoltageChannels
        ? resolveTrace(channelDescriptor, channelColor, style.line_dash)
        : resolved;
      return {
        channel,
        channelLabel: voltageChannelLabel(channel, result.voltage_channels),
        channelKey,
        channelResolved,
        legendKey: multipleVoltageChannels ? channelKey : seriesKey,
        visibilityKey: multipleVoltageChannels
          ? timeCapacityVoltageVisibilityKey(seriesKey, channel)
          : timeCapacityVisibilityKey(seriesKey),
      };
    });
    const visibleVoltageChannels = new Set(
      timeCapacityVisibleVoltageChannels(
        spec,
        seriesKey,
        selectedVoltageChannels,
        multipleVoltageChannels,
      ),
    );
    for (const segment of timeCapacitySegments(trace, spec, fullX)) {
      const visibleChannelStyles = channelStyles.filter(
        (channelStyle) =>
          visibleVoltageChannels.has(channelStyle.channel) &&
          hasFinitePoint(segment.voltageByChannel[channelStyle.channel] ?? []),
      );
      if (visibleChannelStyles.length === 0) continue;
      const segmentCustomdata = segment.x.map((_, index) => [
        segment.cycle[index] ?? "",
        segment.sourceCycle[index] ?? "",
      ]);
      for (const channelStyle of visibleChannelStyles) {
        const voltage = segment.voltageByChannel[channelStyle.channel] ?? [];
        const { channelLabel, channelKey, channelResolved, legendKey } = channelStyle;
        if (channelResolved.hidden) continue;
        const channelName = channelResolved.name;
        const showlegend = !legendShown.has(legendKey) && channelResolved.showInLegend;
        legendShown.add(legendKey);
        out.push({
          x: segment.x,
          y: voltage,
          name: channelName,
          legendgroup: seriesKey,
          showlegend,
          legendrank: legendRanks.get(legendKey),
          opacity: channelResolved.opacity,
          line: {
            color: channelResolved.color,
            width: channelResolved.lineWidth,
            dash: channelResolved.lineDash,
            shape: channelResolved.lineShape,
          },
          marker: {
            color: channelResolved.color,
            size: channelResolved.markerSize,
            symbol: seriesPlotlySymbol(channelResolved),
          },
          mode: seriesPlotlyMode(channelResolved),
          type: traceType,
          connectgaps: false,
          cellxplorer_analysis_sample: analysisSample,
          customdata: segmentCustomdata,
          cellxplorer_export_columns: sourceExportColumnsFromPoints(
            channelName,
            segment.cycle,
            segment.sourceCycle,
            segment.sources,
          ),
          meta: channelLabel.replace(/\s*\(V\)$/, ""),
          cellxplorer_export_axis_labels: {
            y: style.y_title ?? channelLabel,
          },
          hovertemplate:
            `<b>${compactHoverName(channelName)}</b><br>` +
            `${plotlySafeText(channelLabel.replace(/\s*\(V\)$/, ""))}: %{y:.4f} V<br>` +
            "time: %{x:.4f}<br>cycle: %{customdata[0]} · local %{customdata[1]}<extra></extra>",
        } as Plotly.Data);
      }
      if (cfg.stacked) {
        const left = cfg.current_left ?? "current_ma";
        const leftValues = currentAxisValues(segment, trace, left, cfg);
        if (hasFinitePoint(leftValues)) {
          out.push({
            x: segment.x,
            y: leftValues,
            name: `${name} ${currentAxisLabel(left)}`,
            xaxis: "x2",
            yaxis: "y2",
            legendgroup: seriesKey,
            line: { color, width: Math.max(1, style.line_width - 0.6), dash: "dot" },
            mode: "lines",
            type: traceType,
            connectgaps: false,
            cellxplorer_analysis_sample: analysisSample,
            showlegend: false,
            opacity: 0.85,
            meta: `cycle ${segment.cycle.find((cycle) => cycle !== null) ?? "?"}`,
            hovertemplate:
              `<b>${compactHoverName(name)}</b><br>` +
              `${plotlySafeText(currentAxisLabel(left))}: %{y:.4f}<br>` +
              "time: %{x:.4f}<br>%{meta}<extra></extra>",
          } as Plotly.Data);
        }
        if (cfg.current_right && cfg.current_right !== "none") {
          const rightValues = currentAxisValues(segment, trace, cfg.current_right, cfg);
          if (hasFinitePoint(rightValues)) {
            out.push({
              x: segment.x,
              y: rightValues,
              name: `${name} ${currentAxisLabel(cfg.current_right)}`,
              xaxis: "x2",
              yaxis: "y3",
              legendgroup: seriesKey,
              line: { color, width: Math.max(1, style.line_width - 0.6), dash: "dash" },
              mode: "lines",
              type: traceType,
              connectgaps: false,
              cellxplorer_analysis_sample: analysisSample,
              showlegend: false,
              opacity: 0.75,
              meta: `cycle ${segment.cycle.find((cycle) => cycle !== null) ?? "?"}`,
              hovertemplate:
                `<b>${compactHoverName(name)}</b><br>` +
                `${plotlySafeText(currentAxisLabel(cfg.current_right))}: %{y:.4f}<br>` +
                "time: %{x:.4f}<br>%{meta}<extra></extra>",
            } as Plotly.Data);
          }
        }
      }
    }
    const boundaryChannel = channelStyles.find(
      (channelStyle) =>
        visibleVoltageChannels.has(channelStyle.channel) &&
        hasFinitePoint(traceVoltageValues(trace, channelStyle.channel, cfg.voltage_channel)),
    )?.channel;
    const boundaryVoltage = boundaryChannel
      ? traceVoltageValues(trace, boundaryChannel, cfg.voltage_channel)
      : [];
    const boundaryPoints = (trace.source_descriptors ?? [])
      .filter((descriptor) => descriptor.source_position > 1 && descriptor.status !== "missing")
      .map((descriptor) => {
        const index = fullX.findIndex(
          (value, candidate) =>
            timeCapacitySourceAt(trace, candidate).position === descriptor.source_position &&
            Number.isFinite(value) &&
            Number.isFinite(boundaryVoltage[candidate] ?? NaN) &&
            (cfg.display_mode === "consecutive" ||
              trace.phase[candidate] === "charge" ||
              trace.phase[candidate] === "discharge")
        );
        return index >= 0 ? { index, descriptor } : null;
      })
      .filter((value): value is { index: number; descriptor: NonNullable<TimeCapacityTrace["source_descriptors"]>[number] } => value !== null);
    if (boundaryPoints.length) {
      out.push({
        x: boundaryPoints.map(({ index }) => fullX[index]),
        y: boundaryPoints.map(({ index }) => boundaryVoltage[index]),
        name: "Source boundary",
        type: traceType,
        mode: "markers",
        cellxplorer_analysis_sample: analysisSample,
        marker: {
          color,
          size: Math.max(style.marker_size + 2, 7),
          symbol: "diamond-open",
          line: { color: style.paper_bgcolor, width: 1.2 },
        },
        showlegend: false,
        customdata: boundaryPoints.map(({ index }) => [
          trace.cycle[index] ?? "",
          trace.source_cycle?.[index] ?? "",
        ]),
        hovertemplate:
          "<b>Source boundary</b><br>cycle %{customdata[0]} · local %{customdata[1]}<extra></extra>",
      } as Plotly.Data);
    }
  }
  return out;
}

type TimeCapacityAnalysisSampleReference = Pick<
  TimeCapacityTrace,
  "cell_id" | "group_id" | "excluded"
>;

function timeCapacityTraceVisibleForSpec(trace: Plotly.Data, spec: AnalysisSpec): boolean {
  const sample = (trace as Plotly.Data & {
    cellxplorer_analysis_sample?: TimeCapacityAnalysisSampleReference;
  }).cellxplorer_analysis_sample;
  return sample ? !timeCapacityTraceIsHidden(sample, spec) : true;
}

type RefinementTransition = {
  from: Plotly.Data[];
  to: Plotly.Data[];
};

function refinementTransitionTraces(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
): Plotly.Data[] {
  return interactivePlotTraces(timeCapacityTracesForResult(result, spec));
}

function transitionTraceOpacity(
  trace: Plotly.Data,
  factor: number,
  hideInteraction: boolean,
): Plotly.Data {
  const baseOpacity = Number((trace as { opacity?: unknown }).opacity);
  const opacity = Number.isFinite(baseOpacity) ? baseOpacity * factor : factor;
  return {
    ...trace,
    opacity,
    ...(hideInteraction ? { showlegend: false, hoverinfo: "skip" } : {}),
  } as Plotly.Data;
}

function refinementTransitionCanReveal(from: Plotly.Data[], to: Plotly.Data[]): boolean {
  return [...from, ...to].every((trace) => {
    const opacity = Number((trace as { opacity?: unknown }).opacity);
    return !Number.isFinite(opacity) || opacity >= 0.999;
  });
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function timeCapacityLayout(
  result: TimeCapacityResult | undefined,
  spec: AnalysisSpec,
  traces: Plotly.Data[] = []
): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "time_capacity");
  const cfg = timeCapacityConfig(spec);
  const xTitle = result?.cell_traces[0] ? timeCapacityXAxisTitle(cfg) : "Time (min)";
  const leftCurrentLabel = currentAxisLabel(cfg.current_left ?? "current_ma");
  const rightCurrentLabel = currentAxisLabel(cfg.current_right ?? "none");
  const hasRightCurrent = hasRightCurrentValues(result, spec);
  const lm = legendMargins(style, spec.presentation.legend);
  const leftGap = axisGapDelta(style.y_axis);
  const bottomGap = axisGapDelta(style.x_axis);
  const rightGap = hasRightCurrent ? axisGapDelta(style.y2_axis) : 0;
  const rightMargin = Math.max(
    (hasRightCurrent ? 84 : 28) + rightGap,
    lm.r ? lm.r + 24 : 0
  );
  const baseAxis = (axis: PlotStyle["x_axis"]) => ({
    showgrid: style.show_grid,
    gridcolor: "#e9ecef",
    zeroline: style.show_zero_line,
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    ...tickLayout(style, axis),
  });
  const titleFont = { size: style.axis_title_size };
  const xRange = numericTraceExtent(traces, "x", ["x", "x2"]);
  const yRange = numericTraceExtent(traces, "y", ["y"]);
  const y2Range = numericTraceExtent(traces, "y", ["y2", "y3"]);
  if (cfg.view !== "voltage_current") {
    const specific = cfg.derivative_specific;
    const xTitle = cfg.view === "dqdv" ? "Voltage (V)" : specific ? "Specific capacity (mAh/g)" : "Capacity (mAh)";
    const yTitle =
      cfg.view === "dqdv"
        ? specific ? "dQ/dV (mAh/g/V)" : "dQ/dV (mAh/V)"
        : specific ? "dV/dQ (V/(mAh/g))" : "dV/dQ (V/mAh)";
    return {
      height: 560,
      hovermode: "closest",
      // Search the whole plot in the cross-axis direction. The old 20 px
      // radius made hover disappear whenever the pointer was between lines or
      // below the lowest series, even though the x position was meaningful.
      hoverdistance: -1,
      hoverlabel: hoverLabelLayout(style),
      margin: {
        l: 78 + lm.l + leftGap,
        r: Math.max(28, lm.r ? lm.r + 24 : 0),
        t: 20 + lm.t,
        b: 58 + lm.b + bottomGap,
      },
      paper_bgcolor: style.paper_bgcolor,
      plot_bgcolor: style.plot_bgcolor,
      font: { size: style.tick_font_size },
      showlegend: spec.presentation.legend,
      legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
      xaxis: {
        ...baseAxis(style.x_axis),
        title: { text: style.x_title ?? xTitle, font: titleFont, standoff: style.x_axis.title_standoff },
        ...axisLayout(style.x_axis, xRange),
      },
      yaxis: {
        ...baseAxis(style.y_axis),
        title: { text: style.y_title ?? yTitle, font: titleFont, standoff: style.y_axis.title_standoff },
        ...axisLayout(style.y_axis, yRange),
      },
    };
  }
  return {
    height: cfg.stacked ? 620 : 560,
    hovermode: "closest",
    // Keep one compact nearest-point label while allowing the pointer to
    // land anywhere in the plot, including the lower half away from a line.
    hoverdistance: -1,
    margin: {
      l: 70 + lm.l + leftGap,
      r: rightMargin,
      t: 20 + lm.t,
      b: 58 + lm.b + bottomGap,
    },
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size },
    hoverlabel: hoverLabelLayout(style),
    // uirevision together with `matches` axes is a documented plotly.js
    // infinite-relayout trap — stacked refinement restores its accepted
    // viewport explicitly below. In flat mode, key the revision to the
    // x-axis semantics so changing the x quantity/unit/display resets the
    // view instead of keeping stale ranges.
    ...(cfg.stacked
      ? {}
      : {
          // A refreshed/cached result must not reset a user's local zoom.
          // X semantics or an explicit cycle-navigation commit do start a new
          // automatic viewport.
          uirevision: `${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}|${cfg.cycle_start ?? ""}|${
            cfg.cycle_end ?? ""
          }|${(cfg.cycles ?? []).join(",")}`,
        }),
    showlegend: spec.presentation.legend,
    legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
    xaxis: {
      ...baseAxis(style.x_axis),
      title: {
        text: cfg.stacked ? "" : style.x_title ?? xTitle,
        font: titleFont,
        standoff: style.x_axis.title_standoff,
      },
      domain: [0, 1],
      anchor: "y",
      showticklabels: !cfg.stacked,
      ticks: cfg.stacked ? "" : tickLayout(style, style.x_axis).ticks,
      // same vertical grid as the bottom subplot so the gridlines run
      // contiguously through both (they align because the axes match)
      showgrid: style.show_grid,
      zeroline: cfg.stacked ? false : style.show_zero_line,
      // in stacked mode all per-axis frame lines are OFF; one rect shape
      // draws a single contiguous border around both subplots instead
      // (per-axis mirrors drew a spurious line at the subplot boundary
      // and left the top edge open)
      showline: cfg.stacked ? false : style.show_frame,
      mirror: cfg.stacked ? false : style.show_frame,
      ...(cfg.stacked ? { matches: "x2" as const } : {}),
      ...(cfg.stacked ? {} : axisLayout(style.x_axis, xRange)),
    },
    yaxis: {
      ...baseAxis(style.y_axis),
      title: {
        // Keep the shared voltage axis compact when several independent
        // voltage channels are selected. Channel identity remains visible in
        // the legend, hover card, and export labels.
        text: plotlySafeText(style.y_title ?? "Voltage (V)"),
        font: titleFont,
        standoff: style.y_axis.title_standoff,
      },
      domain: cfg.stacked ? [0.39, 1] : [0, 1],
      ...(cfg.stacked ? { showline: false, mirror: false } : {}),
      ...axisLayout(style.y_axis, yRange),
    },
    ...(cfg.stacked
      ? {
          xaxis2: {
            ...baseAxis(style.x_axis),
            title: {
              text: style.x_title ?? xTitle,
              font: titleFont,
              standoff: style.x_axis.title_standoff,
            },
            domain: [0, 1],
            anchor: "y2",
            showline: false,
            mirror: false,
            ...axisLayout(style.x_axis, xRange),
          },
          yaxis2: {
            ...baseAxis(style.y2_axis),
            title: {
              text: style.y2_title ?? leftCurrentLabel,
              font: titleFont,
              standoff: style.y2_axis.title_standoff,
            },
            domain: [0, 0.39],
            anchor: "x2",
            showline: false,
            mirror: false,
            ...axisLayout(style.y2_axis, y2Range),
          },
          ...(hasRightCurrent
            ? {
                yaxis3: {
                  ...baseAxis(style.y2_axis),
                  title: {
                    text: rightCurrentLabel,
                    font: titleFont,
                    standoff: style.y2_axis.title_standoff,
                  },
                  overlaying: "y2" as const,
                  side: "right" as const,
                  anchor: "x2",
                  showgrid: false,
                  showline: false,
                  mirror: false,
                  ...axisLayout(style.y2_axis, y2Range),
                },
              }
            : {}),
          ...(style.show_frame
            ? {
                shapes: [
                  {
                    type: "rect" as const,
                    xref: "paper" as const,
                    yref: "paper" as const,
                    x0: 0,
                    x1: 1,
                    y0: 0,
                    y1: 1,
                    line: { color: style.frame_color, width: style.frame_width },
                    fillcolor: "rgba(0,0,0,0)",
                    layer: "above" as const,
                  },
                ],
              }
            : {}),
        }
      : {}),
  };
}

function TimeCapacityVoltageChannelSelector({
  options,
  value,
  voltageChannels,
  onChange,
}: {
  options: { value: VoltageChannel; label: string }[];
  value: VoltageChannel[];
  voltageChannels?: TimeCapacityResult["voltage_channels"];
  onChange: (value: VoltageChannel[]) => void;
}) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const allSelected = options.length > 0 && options.every((option) => value.includes(option.value));
  const toggleChannel = (channel: VoltageChannel) => {
    onChange(
      value.includes(channel)
        ? value.filter((selected) => selected !== channel)
        : [...value, channel],
    );
  };

  return (
    <Combobox
      store={combobox}
      withinPortal
      onOptionSubmit={(channel) => toggleChannel(channel as VoltageChannel)}
    >
      <Combobox.Target targetType="button" withExpandedAttribute>
        <InputBase
          component="button"
          type="button"
          label="Voltage quantities"
          pointer
          rightSection={<Combobox.Chevron />}
          onClick={() => combobox.toggleDropdown()}
          style={{ minWidth: 0 }}
        >
          <Text size="sm" truncate title={voltageChannelSelectionSummary(value, voltageChannels)}>
            {voltageChannelSelectionSummary(value, voltageChannels)}
          </Text>
        </InputBase>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Header>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed">
              {value.length} selected
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={(event) => {
                event.stopPropagation();
                onChange(allSelected ? [] : options.map((option) => option.value));
              }}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </Button>
          </Group>
        </Combobox.Header>
        <Combobox.Options>
          {options.map((option) => {
            const checked = value.includes(option.value);
            return (
              <Combobox.Option
                key={option.value}
                value={option.value}
                active={checked}
                aria-selected={checked}
              >
                <Group gap="xs" wrap="nowrap">
                  <Checkbox checked={checked} readOnly tabIndex={-1} size="xs" />
                  <Text size="sm" truncate title={option.label} style={{ minWidth: 0 }}>
                    {option.label}
                  </Text>
                </Group>
              </Combobox.Option>
            );
          })}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}


export function TimeCapacitySettings({
  spec,
  update,
  resetAxis,
  voltageChannels,
}: {
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
  resetAxis: (spec: AnalysisSpec, axis: "x_axis" | "y_axis") => void;
  /** Live per-selection availability from the current Time/Capacity result. */
  voltageChannels?: TimeCapacityResult["voltage_channels"];
}) {
  const cfg = timeCapacityConfig(spec);
  // Only offer electrode potentials that actually have data for the current
  // selection — never a disabled/greyed entry that merely advertises a
  // feature no selected source has (spec 040.4). An ordinary two-electrode
  // selection therefore renders no extra option and this control does not
  // appear at all, matching pre-040.4 behavior exactly. The decision itself
  // is a pure, independently-tested function (voltageChannelPolicy.ts) —
  // see frontend/tests/voltageChannelPolicy.test.ts — rather than logic
  // that lives only in this component.
  const voltageChannelOptions = voltageChannelSelectorOptions(cfg.voltage_channels, voltageChannels);
  const showVoltageChannelSelector = shouldShowVoltageChannelSelector(voltageChannelOptions);
  const needsArea = cfg.current_left === "current_density" || cfg.current_right === "current_density";
  const updateTime = (fn: (cfg: TimeCapacityConfig) => void) =>
    update((s) => {
      const next = timeCapacityConfig(s);
      fn(next);
      s.computation.time_capacity = next;
    });

  return (
    <Paper p="sm" withBorder>
      <Accordion multiple defaultValue={["axis", "cycles"]}>
        <Accordion.Item value="axis">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Time / capacity
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Select
                label="Plot"
                data={[
                  { value: "voltage_current", label: "Voltage / current" },
                  { value: "dqdv", label: "Incremental capacity (dQ/dV)" },
                  { value: "dvdq", label: "Differential voltage (dV/dQ)" },
                ]}
                value={cfg.view}
                onChange={(value) =>
                  value &&
                  update((s) => {
                    const next = timeCapacityConfig(s);
                    next.view = value as TimeCapacityConfig["view"];
                    s.computation.time_capacity = next;
                    resetAxis(s, "x_axis");
                    resetAxis(s, "y_axis");
                  })
                }
              />
              {cfg.view === "voltage_current" ? (
                <>
              {showVoltageChannelSelector && (
                <TimeCapacityVoltageChannelSelector
                  options={voltageChannelOptions}
                  value={cfg.voltage_channels}
                  voltageChannels={voltageChannels}
                  onChange={(value) =>
                    updateTime((next) => {
                      next.voltage_channels = value;
                      next.voltage_channel = value[0] ?? "voltage";
                    })
                  }
                />
              )}
              <Select
                label="X axis"
                data={[
                  { value: "time", label: "Time" },
                  { value: "capacity_mah", label: "Capacity (mAh)" },
                  { value: "capacity_mah_g", label: "Specific capacity (mAh/g)" },
                  { value: "capacity_mah_cm2", label: "Areal capacity (mAh/cm2)" },
                ]}
                value={cfg.x_axis}
                onChange={(value) =>
                  value &&
                  update((s) => {
                    const next = timeCapacityConfig(s);
                    next.x_axis = value as TimeCapacityConfig["x_axis"];
                    s.computation.time_capacity = next;
                    // manual x-range belongs to the previous x quantity's scale
                    resetAxis(s, "x_axis");
                  })
                }
              />
              {cfg.x_axis === "capacity_mah_cm2" && (
                <DebouncedNumberInput
                  label="Electrode area (cm2)"
                  description="Leave blank to use each cell's metadata area; set a value to override or supply a missing one."
                  min={0}
                  step={0.05}
                  value={cfg.electrode_area_cm2}
                  onCommit={(value) =>
                    updateTime(
                      (next) => void (next.electrode_area_cm2 = value && value > 0 ? value : null)
                    )
                  }
                />
              )}
              {cfg.x_axis === "time" && (
                <Select
                  label="Time unit"
                  data={[
                    { value: "s", label: "Seconds" },
                    { value: "min", label: "Minutes" },
                    { value: "h", label: "Hours" },
                  ]}
                  value={cfg.time_unit}
                  onChange={(value) =>
                  value &&
                  update((s) => {
                    const next = timeCapacityConfig(s);
                    next.time_unit = value as TimeCapacityConfig["time_unit"];
                      s.computation.time_capacity = next;
                      resetAxis(s, "x_axis");
                    })
                  }
                />
              )}
              <Select
                label="Display"
                data={[
                  { value: "consecutive", label: "Consecutive" },
                  { value: "overlap_reset", label: "Overlap, reset each half-cycle" },
                  { value: "overlap_mirror", label: "Overlap, mirrored discharge" },
                ]}
                value={cfg.display_mode}
                onChange={(value) =>
                  value &&
                  update((s) => {
                    const next = timeCapacityConfig(s);
                    next.display_mode = value as TimeCapacityConfig["display_mode"];
                    s.computation.time_capacity = next;
                    resetAxis(s, "x_axis");
                  })
                }
              />
              <Switch
                label="Stack current below voltage"
                checked={cfg.stacked}
                onChange={(event) => updateTime((next) => void (next.stacked = event.currentTarget.checked))}
              />
              {cfg.stacked && (
                <>
                  <Select
                    label="Left current axis"
                    data={CURRENT_AXIS_OPTIONS}
                    value={cfg.current_left}
                    onChange={(value) =>
                      value &&
                      updateTime(
                        (next) => void (next.current_left = value as TimeCapacityCurrentQuantity)
                      )
                    }
                  />
                  <Select
                    label="Right current axis"
                    data={CURRENT_RIGHT_AXIS_OPTIONS}
                    value={cfg.current_right}
                    onChange={(value) =>
                      value &&
                      updateTime((next) => void (next.current_right = value as TimeCapacityCurrentAxis))
                    }
                  />
                  {needsArea && cfg.x_axis !== "capacity_mah_cm2" && (
                    <DebouncedNumberInput
                      label="Electrode area (cm2)"
                      description="Leave blank to use each cell's metadata area."
                      min={0}
                      step={0.05}
                      value={cfg.electrode_area_cm2}
                      onCommit={(value) =>
                        updateTime((next) => void (next.electrode_area_cm2 = value && value > 0 ? value : null))
                      }
                    />
                  )}
                </>
              )}
                </>
              ) : (
                <>
                  <SegmentedControl
                    fullWidth
                    data={[
                      { value: "both", label: "Both" },
                      { value: "charge", label: "Charge" },
                      { value: "discharge", label: "Discharge" },
                    ]}
                    value={cfg.derivative_phase}
                    onChange={(value) =>
                      updateTime((next) =>
                        void (next.derivative_phase = value as TimeCapacityConfig["derivative_phase"])
                      )
                    }
                  />
                  <Switch
                    label="Normalize capacity by g"
                    checked={cfg.derivative_specific}
                    onChange={(event) =>
                      updateTime((next) => void (next.derivative_specific = event.currentTarget.checked))
                    }
                  />
                  <Switch
                    label="Absolute discharge derivative"
                    checked={cfg.derivative_absolute_discharge}
                    onChange={(event) =>
                      updateTime(
                        (next) => void (next.derivative_absolute_discharge = event.currentTarget.checked)
                      )
                    }
                  />
                  <DebouncedNumberInput
                    label="Smoothing window (points)"
                    min={1}
                    max={101}
                    step={2}
                    value={cfg.smoothing_window}
                    onCommit={(value) =>
                      updateTime((next) => {
                        const window = Math.max(1, Math.min(101, Math.round(value ?? 7)));
                        next.smoothing_window = window % 2 === 0 ? window + 1 : window;
                      })
                    }
                  />
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cycles">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Adaptive rendering
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <DebouncedNumberInput
                label="Adaptive display point budget"
                description="Limits interactive preview density only. Data exports always use full resolution."
                min={100}
                step={500}
                value={cfg.max_points_per_cell}
                onCommit={(value) =>
                  updateTime((next) => void (next.max_points_per_cell = value ?? 4000))
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}



function TimeCapacityPlotCardView({
  analysisId,
  analysisTitle,
  plotName,
  subtitle,
  spec,
  update,
  onReadyChange,
  onVoltageChannelsChange,
  edited = false,
  onNewPlot,
  newPlotEnabled = false,
  onUpdatePlot,
  updatePlotEnabled = false,
  updatePlotLabel = "Update",
  active = true,
  maxAvailableCycle,
  isVirginNavigation = false,
  navigationResetKey,
}: {
  analysisId: number;
  analysisTitle: string;
  plotName: string;
  subtitle: string;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
  onReadyChange?: (ready: boolean) => void;
  /** Bubbles the live result's per-selection voltage-channel availability up
   * so the sample-panel settings (rendered as a sibling, not a child) can
   * show the same options the plot itself just computed. */
  onVoltageChannelsChange?: (channels: TimeCapacityResult["voltage_channels"]) => void;
  edited?: boolean;
  onNewPlot?: () => void;
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  updatePlotEnabled?: boolean;
  updatePlotLabel?: string;
  /** The parent keeps this expensive card mounted after first visit. */
  active?: boolean;
  maxAvailableCycle: number | null;
  isVirginNavigation?: boolean;
  navigationResetKey?: string | number;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const [computeToken, setComputeToken] = useState<string | null>(null);
  const [dataExporting, setDataExporting] = useState(false);
  const [dataExportStage, setDataExportStage] = useState<
    "requesting" | "formatting" | "saving" | null
  >(null);
  const [dataExportFormat, setDataExportFormat] = useState<PlotStyle["data_export_format"] | null>(null);
  const [refinedResult, setRefinedResult] = useState<TimeCapacityRefinementResult | null>(null);
  const [refinementTransition, setRefinementTransition] = useState<RefinementTransition | null>(null);
  const [refinementTransitionProgress, setRefinementTransitionProgress] = useState(1);
  const refinementTimerRef = useRef<number | null>(null);
  const refinementAbortRef = useRef<AbortController | null>(null);
  const refinementTransitionFrameRef = useRef<number | null>(null);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const cfg = timeCapacityConfig(spec);
  const panningEnabled = useMemo(() => timeCapacityPanningEnabled(), []);
  const queryClient = useQueryClient();
  const [cyclePreviewRange, setCyclePreviewRange] = useState<TimeCapacityCycleRange | null>(null);
  const [plotViewportCycleRange, setPlotViewportCycleRange] =
    useState<TimeCapacityCycleRange | null>(null);
  const [plotViewportChangeKey, setPlotViewportChangeKey] = useState(0);
  useEffect(() => setPlotViewportCycleRange(null), [navigationResetKey]);
  const [panWarmRange, setPanWarmRange] = useState<TimeCapacityCycleRange | null>(null);
  const [previewRequest, setPreviewRequest] = useState<TimeCapacityPreviewRequest | null>(null);
  const [committedNavigationRequest, setCommittedNavigationRequest] =
    useState<TimeCapacityCommittedNavigationRequest | null>(null);
  const committedNavigationSchedulerRef = useRef<TimeCapacityCommittedNavigationSchedulerState>(
    timeCapacityCommittedNavigationSchedulerInitialState(),
  );
  // Navigation changes still pass through the parent update callback so they
  // remain dirty until the user explicitly saves or discards them. This
  // context signature lets the request admission layer coalesce only range
  // changes while immediately abandoning it for a real plot-setting change.
  const committedNavigationContextSignature = useMemo(
    () => JSON.stringify({
      navigationResetKey: navigationResetKey ?? "",
      compatibility: timeCapacityCompatibilitySignature(
        spec,
        cfg,
        TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH,
      ),
      cycles: cfg.cycles,
      max_points_per_cell: cfg.max_points_per_cell,
    }),
    [cfg, navigationResetKey, spec],
  );
  const cancelCommittedNavigation = useCallback(() => {
    committedNavigationSchedulerRef.current = timeCapacityCommittedNavigationCancel(
      committedNavigationSchedulerRef.current,
    );
    setCommittedNavigationRequest(null);
  }, []);
  const scheduleCommittedNavigationRange = useCallback(
    (range: TimeCapacityCycleRange) => {
      const decision = timeCapacityCommittedNavigationOnRange(
        committedNavigationSchedulerRef.current,
        range,
        committedNavigationContextSignature,
      );
      committedNavigationSchedulerRef.current = decision.state;
      if (decision.request) setCommittedNavigationRequest(decision.request);
    },
    [committedNavigationContextSignature],
  );
  const [panRequest, setPanRequest] = useState<TimeCapacityBufferRequest | null>(null);
  const panSchedulerRef = useRef<TimeCapacityBufferSchedulerState>(
    timeCapacityBufferSchedulerInitialState(),
  );
  const panMotionRef = useRef<TimeCapacityPanMotion | null>(null);
  const panActiveRef = useRef(false);
  const panLiveWindowRef = useRef<TimeCapacityCycleRange | null>(null);
  const panLivePositionRef = useRef<number | null>(null);
  const panSettlingWindowRef = useRef<TimeCapacityCycleRange | null>(null);
  const panVisualUpdateRef = useRef<(
    range: TimeCapacityCycleRange | null,
    continuousStart?: number | null,
  ) => void>(() => {});
  const panIdleTimerRef = useRef<number | null>(null);
  const previewSchedulerRef = useRef<TimeCapacityPreviewSchedulerState>(
    timeCapacityPreviewSchedulerInitialState(),
  );
  const previewMovingTimerRef = useRef<number | null>(null);
  const previewIdleTimerRef = useRef<number | null>(null);
  const clearPreviewMovingTimer = useCallback(() => {
    if (previewMovingTimerRef.current !== null) {
      window.clearTimeout(previewMovingTimerRef.current);
      previewMovingTimerRef.current = null;
    }
  }, []);
  const clearPreviewIdleTimer = useCallback(() => {
    if (previewIdleTimerRef.current !== null) {
      window.clearTimeout(previewIdleTimerRef.current);
      previewIdleTimerRef.current = null;
    }
  }, []);
  const clearPreviewTimers = useCallback(() => {
    clearPreviewMovingTimer();
    clearPreviewIdleTimer();
  }, [clearPreviewIdleTimer, clearPreviewMovingTimer]);
  const cancelPreviewScheduler = useCallback(() => {
    clearPreviewTimers();
    previewSchedulerRef.current = timeCapacityPreviewCancel(previewSchedulerRef.current);
    setPreviewRequest(null);
  }, [clearPreviewTimers]);
  const applyPanDecision = useCallback((decision: TimeCapacityBufferSchedulerDecision) => {
    panSchedulerRef.current = decision.state;
    if (decision.request) {
      setPanRequest(decision.request);
    }
  }, []);
  const clearPanIdleTimer = useCallback(() => {
    if (panIdleTimerRef.current !== null) {
      window.clearTimeout(panIdleTimerRef.current);
      panIdleTimerRef.current = null;
    }
  }, []);
  const cancelPanScheduler = useCallback(() => {
    clearPanIdleTimer();
    panActiveRef.current = false;
    panLiveWindowRef.current = null;
    panLivePositionRef.current = null;
    panMotionRef.current = null;
    panVisualUpdateRef.current(null);
    panSchedulerRef.current = timeCapacityBufferCancel(panSchedulerRef.current);
    setPanRequest(null);
  }, [clearPanIdleTimer]);
  useEffect(() => {
    const scheduler = committedNavigationSchedulerRef.current;
    if (
      scheduler.contextSignature !== null &&
      scheduler.contextSignature !== committedNavigationContextSignature
    ) {
      cancelCommittedNavigation();
    }
  }, [cancelCommittedNavigation, committedNavigationContextSignature]);
  const panPlanFor = useCallback(
    (range: TimeCapacityCycleRange, motion: TimeCapacityPanMotion | null) => {
      if (!maxAvailableCycle) return null;
      const windowPoints = timeCapacityPreviewMaxPoints(cfg.max_points_per_cell, "moving");
      return timeCapacityBufferPlanForWindow(range, maxAvailableCycle, windowPoints, motion);
    },
    [cfg.max_points_per_cell, maxAvailableCycle],
  );
  const panWarmPlan = useMemo(
    () => (panWarmRange ? panPlanFor(panWarmRange, null) : null),
    [panPlanFor, panWarmRange],
  );
  const panWarmSpec = useMemo(
    () =>
      panWarmPlan
        ? timeCapacitySpecWithPreview(
            spec,
            panWarmPlan.buffer,
            "moving",
            panWarmPlan.maxPoints,
          )
        : null,
    [panWarmPlan, spec],
  );
  const panWarmQuery = useMemo(() => {
    if (!panWarmSpec || !panWarmPlan) return null;
    const scientificSpec = timeCapacityScientificRequestSpec(panWarmSpec);
    const warmCfg = timeCapacityConfig(scientificSpec);
    return {
      queryKey: [
        "time-capacity",
        analysisId,
        timeCapacityCompatibilitySignature(
          scientificSpec,
          warmCfg,
          TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH,
        ),
        timeCapacityDataSignature(
          scientificSpec,
          warmCfg,
          TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH,
          panWarmPlan.window.start,
        ),
      ] as const,
      spec: scientificSpec,
      origin: panWarmPlan.window.start,
    };
  }, [analysisId, panWarmPlan, panWarmSpec]);
  useEffect(() => {
    if (
      !panWarmQuery ||
      !panningEnabled ||
      active === false ||
      cfg.cycles.length > 0 ||
      cfg.display_mode !== "consecutive" ||
      spec.selection.entries.length === 0
    ) return;
    // Hover/focus opens the slider before pointer-down. Populate the exact
    // React Query key the first pan request will observe, so grabbing the
    // handle does not spend its first frames waiting for a buffer.
    void queryClient.prefetchQuery({
      queryKey: panWarmQuery.queryKey,
      queryFn: ({ signal }) =>
        post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
          spec: panWarmQuery.spec,
          viewport_width: TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH,
          precision: "standard",
          compact: true,
          persist: false,
          background: true,
          absolute_time_origin_cycle: panWarmQuery.origin,
        }, { signal }),
      staleTime: 30 * 60_000,
      gcTime: 30 * 60_000,
    });
  }, [
    active,
    analysisId,
    cfg.cycles.length,
    cfg.display_mode,
    panWarmQuery,
    panningEnabled,
    queryClient,
    spec.selection.entries.length,
  ]);
  const schedulePanIdlePromotion = useCallback(
    (range: TimeCapacityCycleRange) => {
      clearPanIdleTimer();
      panIdleTimerRef.current = window.setTimeout(() => {
        panIdleTimerRef.current = null;
        if (!panActiveRef.current || !maxAvailableCycle) return;
        const live = panLiveWindowRef.current;
        if (!live || live.start !== range.start || live.end !== range.end) return;
        const previous = panMotionRef.current;
        const settledMotion: TimeCapacityPanMotion = {
          centerCycle: (live.start + live.end) / 2,
          sampledAtMs: window.performance.now(),
          extentVelocityPerSecond: 0,
          direction: previous?.direction ?? 0,
          tier: "slow",
        };
        panMotionRef.current = settledMotion;
        const plan = panPlanFor(live, settledMotion);
        if (plan) {
          applyPanDecision(
            timeCapacityBufferOnMove(panSchedulerRef.current, plan, maxAvailableCycle),
          );
        }
      }, TIME_CAPACITY_PREVIEW_IDLE_MS);
    },
    [applyPanDecision, clearPanIdleTimer, maxAvailableCycle, panPlanFor],
  );
  const scheduleMovingPreviewFlush = useCallback((delayMs: number) => {
    clearPreviewMovingTimer();
    previewMovingTimerRef.current = window.setTimeout(() => {
      previewMovingTimerRef.current = null;
      const decision = timeCapacityPreviewFlushMoving(
        previewSchedulerRef.current,
        window.performance.now(),
        TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
      );
      previewSchedulerRef.current = decision.state;
      if (decision.request) setPreviewRequest(decision.request);
      if (decision.waitMs !== null) scheduleMovingPreviewFlush(decision.waitMs);
    }, Math.max(0, Math.ceil(delayMs)));
  }, []);
  const scheduleIdlePreviewPromotion = useCallback((generation: number) => {
    clearPreviewIdleTimer();
    previewIdleTimerRef.current = window.setTimeout(() => {
      previewIdleTimerRef.current = null;
      const decision = timeCapacityPreviewPromoteOnIdle(
        previewSchedulerRef.current,
        generation,
        window.performance.now(),
        TIME_CAPACITY_PREVIEW_IDLE_MS,
      );
      previewSchedulerRef.current = decision.state;
      if (decision.request) {
        clearPreviewMovingTimer();
        setPreviewRequest(decision.request);
      } else if (decision.waitMs !== null) {
        scheduleIdlePreviewPromotion(generation);
      }
    }, TIME_CAPACITY_PREVIEW_IDLE_MS);
  }, [clearPreviewIdleTimer, clearPreviewMovingTimer]);
  useEffect(() => {
    setCyclePreviewRange(null);
    setPanWarmRange(null);
    panSettlingWindowRef.current = null;
    cancelPreviewScheduler();
    cancelPanScheduler();
    cancelCommittedNavigation();
  }, [
    cancelCommittedNavigation,
    cancelPanScheduler,
    cancelPreviewScheduler,
    navigationResetKey,
  ]);
  useEffect(
    () => () => {
      clearPreviewTimers();
      clearPanIdleTimer();
    },
    [clearPanIdleTimer, clearPreviewTimers],
  );
  const handleCyclePreviewRange = useCallback((
    range: TimeCapacityCycleRange | null,
    continuousStart?: number | null,
  ) => {
    if (range === null) {
      setCyclePreviewRange(null);
      cancelPreviewScheduler();
      cancelPanScheduler();
      return;
    }
    // A pointer preview owns the request boundary while the slider is open.
    // Abandon any ordinary committed navigation request so it cannot compete
    // with the existing moving/buffered preview schedulers.
    cancelCommittedNavigation();
    if (panningEnabled && maxAvailableCycle) {
      cancelPreviewScheduler();
      panSettlingWindowRef.current = null;
      panLiveWindowRef.current = { ...range };
      const livePosition = Number.isFinite(continuousStart)
        ? Number(continuousStart)
        : range.start;
      panLivePositionRef.current = livePosition;
      panVisualUpdateRef.current(range, livePosition);
      const startingSession = !panActiveRef.current;
      const sampledAtMs = window.performance.now();
      if (startingSession) {
        panActiveRef.current = true;
        // This state is a session sentinel only. Subsequent pointer positions
        // stay in refs so the full plot card does not rerender every frame.
        setCyclePreviewRange(range);
      }
      const motion = nextTimeCapacityPanMotion(
        panMotionRef.current,
        {
          start: livePosition,
          end: livePosition + (range.end - range.start),
        },
        sampledAtMs,
        maxAvailableCycle,
      );
      panMotionRef.current = motion;
      const plan = panPlanFor(range, motion);
      if (plan) {
        applyPanDecision(
          timeCapacityBufferOnMove(panSchedulerRef.current, plan, maxAvailableCycle),
        );
      }
      schedulePanIdlePromotion(range);
      return;
    }
    setCyclePreviewRange(range);
    clearPreviewMovingTimer();
    clearPreviewIdleTimer();
    const decision = timeCapacityPreviewOnMove(
      previewSchedulerRef.current,
      range,
      window.performance.now(),
      TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
    );
    previewSchedulerRef.current = decision.state;
    if (decision.request) setPreviewRequest(decision.request);
    if (decision.waitMs !== null) scheduleMovingPreviewFlush(decision.waitMs);
    scheduleIdlePreviewPromotion(decision.state.generation);
  }, [
    cancelPreviewScheduler,
    cancelPanScheduler,
    cancelCommittedNavigation,
    clearPreviewIdleTimer,
    clearPreviewMovingTimer,
    applyPanDecision,
    maxAvailableCycle,
    panPlanFor,
    panningEnabled,
    scheduleIdlePreviewPromotion,
    scheduleMovingPreviewFlush,
    schedulePanIdlePromotion,
  ]);
  // Buffered panning has its own request boundary. The live pointer stays in a
  // ref; `panRequest` changes only when the latest-wins scheduler admits a new
  // directional buffer, so fast movement cannot cancel every refill.
  const panActive = panningEnabled && cyclePreviewRange !== null;
  const panBufferRequestActive = panActive && panRequest !== null;
  const committedNavigationRange =
    committedNavigationRequest?.contextSignature === committedNavigationContextSignature
      ? committedNavigationRequest.range
      : null;

  const requestSpec = useMemo(() => {
    if (panBufferRequestActive && panRequest) {
      return timeCapacitySpecWithPreview(
        spec,
        panRequest.buffer,
        "moving",
        panRequest.maxPoints,
      );
    }
    if (previewRequest) {
      return timeCapacitySpecWithPreview(spec, previewRequest.range, previewRequest.resolution);
    }
    if (cyclePreviewRange === null && committedNavigationRange) {
      return timeCapacitySpecWithCycleRange(spec, committedNavigationRange);
    }
    return spec;
  }, [
    committedNavigationRange,
    cyclePreviewRange,
    panBufferRequestActive,
    panRequest,
    previewRequest,
    spec,
  ]);
  // Analysis-sample visibility is a saved-plot display edit, not a scientific
  // input for the ordinary Time/Capacity request. Keep the live requestSpec
  // for rendering, then use this neutral copy consistently for both query
  // identity and the request body.
  const scientificRequestSpec = useMemo(
    () => timeCapacityScientificRequestSpec(requestSpec),
    [requestSpec],
  );
  const previewQueryRange = previewRequest?.range ?? null;
  // Read alongside `requestSpec` so the value the query body sends always
  // describes the same request the query key was built from.
  const previewResolution = previewRequest?.resolution ?? null;
  const transientPreviewRequest = panBufferRequestActive || previewResolution === "moving";
  const requestCfg = timeCapacityConfig(scientificRequestSpec);
  const refinementLifecycleRef = useRef<TimeCapacityRefinementLifecycle | null>(null);
  if (refinementLifecycleRef.current === null) {
    refinementLifecycleRef.current = new TimeCapacityRefinementLifecycle();
  }
  const refinementLifecycle = refinementLifecycleRef.current;
  const stackedModeRef = useRef(cfg.stacked);
  const stackedModeChanged = stackedModeRef.current !== cfg.stacked;
  stackedModeRef.current = cfg.stacked;
  // Keep cache identity stable across restarts, window sizes and style-panel
  // changes. Point density is controlled solely by max_points_per_cell.
  const viewportWidth = panBufferRequestActive
    ? TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH
    : TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH;
  // Keep this separate from dataSignature. Range and point-density changes
  // may retain the old compact result while the replacement is fetched, but
  // a semantic/display change must never relabel that result temporarily.
  const compatibilitySignature = timeCapacityCompatibilitySignature(
    scientificRequestSpec,
    requestCfg,
    viewportWidth,
  );
  // Refetch when fields that change the returned data change. The compact
  // response ships only the canonical `display_x` (and the one raw array) for
  // the *currently selected* x axis, so the x quantity, its unit, the display
  // mode and the electrode area (areal capacity is area-normalised server-side)
  // are all baked into the result and must be part of the identity — otherwise
  // switching axis changes only the title while the plotted data stays stale.
  // Purely client-side renderings (stacked, current axes) stay out.
  const dataSignature = useMemo(
    () =>
      timeCapacityDataSignature(
        scientificRequestSpec,
        requestCfg,
        viewportWidth,
        panBufferRequestActive && panRequest ? panRequest.window.start : null,
      ),
    [panBufferRequestActive, panRequest, scientificRequestSpec, viewportWidth],
  );
  const dataSignatureRef = useRef(dataSignature);
  // Keep the latest request identity synchronous with render. A passive
  // effect leaves a narrow window in which a delayed full-resolution export
  // can resolve after a channel switch but before this ref catches up.
  dataSignatureRef.current = dataSignature;
  const voltageChannelRef = useRef<VoltageChannel[]>(requestCfg.voltage_channels);
  voltageChannelRef.current = requestCfg.voltage_channels;
  const profileEnabled = timeCapacityPerformanceProfiler.isEnabled();
  const profileContext = useMemo<TimeCapacityPerformanceContext>(
    () => ({
      analysis_id: analysisId,
      selection_count: requestSpec.selection.entries.length,
      cycle_start: requestCfg.cycle_start,
      cycle_end: requestCfg.cycle_end,
      explicit_cycle_count: requestCfg.cycles.length,
      view: requestCfg.view,
      x_axis: requestCfg.x_axis,
      display_mode: requestCfg.display_mode,
      max_points_per_cell: requestCfg.max_points_per_cell,
      compact: true,
      precision: "standard",
    }),
    [
      analysisId,
      requestCfg.cycle_end,
      requestCfg.cycle_start,
      requestCfg.cycles.length,
      requestCfg.display_mode,
      requestCfg.max_points_per_cell,
      requestCfg.view,
      requestCfg.x_axis,
      requestSpec.selection.entries.length,
    ],
  );
  const profileRequest = useMemo(
    () =>
      profileEnabled
        ? { dataSignature, requestId: newTimeCapacityProfileRequestId() }
        : null,
    [dataSignature, profileEnabled],
  );
  const timeResult = useQuery({
    queryKey: ["time-capacity", analysisId, compatibilitySignature, dataSignature],
    queryFn: async ({ signal }) => {
      // The server opens an activity entry only if the cache misses, so send a
      // token instead of pre-creating a job: a cached load costs one request
      // and leaves no spurious "Preparing..." entry behind.
      // Moving previews never persist and therefore never open a backend job.
      // Do not churn local token state or poll for a job that cannot exist on
      // every buffer refill.
      const token = transientPreviewRequest ? null : newComputeToken();
      if (token) setComputeToken(token);
      if (profileRequest) {
        timeCapacityPerformanceProfiler.begin(profileRequest.requestId, profileContext);
      }
      const httpStarted = profileRequest ? timeCapacityPerformanceNow() : 0;
      try {
        const result = await post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
          spec: scientificRequestSpec,
          ...(token ? { job_token: token } : {}),
          viewport_width: viewportWidth,
          precision: "standard",
          // Spec 052.3 Stage 3: a moving preview is a range the user is
          // dragging past, so it must not populate the analysis result cache —
          // persisting each one cost a write under the global cache lock and
          // evicted genuinely reusable entries. Idle-promoted full previews and
          // committed ranges persist exactly as before. Reads are unaffected:
          // a moving preview that happens to hit an entry still serves it.
          ...(transientPreviewRequest ? { persist: false } : {}),
          // Anchor each resident chunk at the viewport that requested it. A
          // cycle-1 origin accumulates hundreds of cycles of per-Cell duration
          // drift; a local viewport origin matches the exact comparison at
          // admission and limits drift to the buffer's refill distance.
          ...(panBufferRequestActive && panRequest
            ? { absolute_time_origin_cycle: panRequest.window.start }
            : {}),
          ...(profileRequest
            ? {
                profile: true,
                profile_request_id: profileRequest.requestId,
              }
            : {}),
          compact: true,
        }, { signal });
        if (profileRequest) {
          timeCapacityPerformanceProfiler.response(
            profileRequest.requestId,
            result.profiling,
            timeCapacityPerformanceNow() - httpStarted,
          );
        }
        return result;
      } catch (error) {
        if (profileRequest) {
          timeCapacityPerformanceProfiler.cancel(profileRequest.requestId);
        }
        throw error;
      } finally {
        if (token) {
          window.setTimeout(
            () => setComputeToken((current) => (current === token ? null : current)),
            300
          );
        }
      }
    },
    placeholderData: (previous, previousQuery) =>
      timeCapacityPlaceholderData(
        previous,
        previousQuery?.queryKey,
        analysisId,
        compatibilitySignature,
      ),
    enabled: requestSpec.selection.entries.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
  });
  useEffect(() => {
    if (
      !previewRequest ||
      previewRequest.resolution !== "moving" ||
      timeResult.isFetching
    ) return;
    const scheduler = previewSchedulerRef.current;
    if (
      !scheduler.inFlight ||
      !timeCapacityPreviewRequestIsCurrent(scheduler, previewRequest)
    ) return;
    // React Query keeps one moving request observed until it settles. Once it
    // settles, admit only the latest pending range; this prevents a 40 ms
    // cadence from cancelling every high-latency moving request.
    const decision = timeCapacityPreviewOnMovingRequestComplete(
      scheduler,
      previewRequest,
      window.performance.now(),
      TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
    );
    previewSchedulerRef.current = decision.state;
    if (decision.request) setPreviewRequest(decision.request);
    if (decision.waitMs !== null) scheduleMovingPreviewFlush(decision.waitMs);
  }, [previewRequest, scheduleMovingPreviewFlush, timeResult.isFetching]);
  useEffect(() => {
    if (!panActive || !panRequest || timeResult.isFetching) return;
    if (timeResult.isError) {
      const decision = timeCapacityBufferOnFailed(panSchedulerRef.current, panRequest);
      applyPanDecision(decision);
      if (!decision.request && decision.state.resident) {
        setPanRequest(decision.state.resident);
      }
      return;
    }
    if (timeResult.isPlaceholderData || !timeResult.data) return;
    const ready = timeCapacityBufferOnResponseReady(
      panSchedulerRef.current,
      panRequest,
    );
    panSchedulerRef.current = ready;
  }, [
    applyPanDecision,
    panActive,
    panRequest,
    timeResult.data,
    timeResult.isError,
    timeResult.isFetching,
    timeResult.isPlaceholderData,
  ]);
  useLayoutEffect(() => {
    if (!profileRequest || requestSpec.selection.entries.length === 0) return;
    // Run before the later plot-props layout effect so a React Query memory
    // hit (which has no queryFn/HTTP callback) still has a response boundary
    // before Plotly's own update effect can fire.
    timeCapacityPerformanceProfiler.begin(profileRequest.requestId, profileContext);
    timeCapacityPerformanceProfiler.placeholderVisible(
      profileRequest.requestId,
      Boolean(timeResult.isPlaceholderData),
    );
    // React Query can satisfy a newly selected key from its in-memory cache,
    // so no queryFn/HTTP callback runs. Treat that path as a zero-HTTP
    // interaction, without reusing the prior result's server profiling facts.
    const data = timeResult.data;
    const dataIsCurrent = timeCapacityProfileResultIsCurrent(
      dataSignature,
      profileRequest.dataSignature,
      data,
      Boolean(timeResult.isPlaceholderData),
    );
    if (
      dataIsCurrent &&
      data &&
      !timeResult.isFetching &&
      !timeResult.isPlaceholderData &&
      data.profiling?.request_id !== profileRequest.requestId
    ) {
      timeCapacityPerformanceProfiler.memoryCacheHit(profileRequest.requestId);
    }
  }, [
    dataSignature,
    profileContext,
    profileRequest,
    requestSpec.selection.entries.length,
    timeResult.data,
    timeResult.isFetching,
    timeResult.isPlaceholderData,
  ]);
  const queryResult = timeCapacityResultMatchesVoltageChannels(
    timeResult.data,
    requestCfg.voltage_channels,
  )
    ? timeResult.data
    : undefined;
  useEffect(() => {
    const request = committedNavigationRequest;
    if (
      !request ||
      request.contextSignature !== committedNavigationContextSignature ||
      !timeCapacityCommittedNavigationRequestIsCurrent(
        committedNavigationSchedulerRef.current,
        request,
      ) ||
      timeResult.isFetching
    ) return;
    // A cache hit has no queryFn boundary, so the settled query state is the
    // completion signal for both cached and HTTP responses. Do not promote a
    // placeholder-only frame; it still belongs to the previous range.
    if (!timeResult.isError && (timeResult.isPlaceholderData || !queryResult)) return;
    const decision = timeCapacityCommittedNavigationOnRequestSettled(
      committedNavigationSchedulerRef.current,
      request,
    );
    committedNavigationSchedulerRef.current = decision.state;
    setCommittedNavigationRequest(decision.request);
  }, [
    committedNavigationContextSignature,
    committedNavigationRequest,
    queryResult,
    timeResult.isError,
    timeResult.isFetching,
    timeResult.isPlaceholderData,
  ]);
  const lastValidResultRef = useRef<{
    compatibilitySignature: string;
    result: TimeCapacityResult;
  } | null>(null);
  if (queryResult) {
    lastValidResultRef.current = { compatibilitySignature, result: queryResult };
  }
  const retainPanResult = panActive || panSettlingWindowRef.current !== null;
  // Match the same compatibility boundary used by placeholderData. React
  // Query's observer can briefly have no data while a compatible key is
  // admitted (notably when a visibility edit overlaps range/refinement
  // settlement). The resident overview remains scientifically valid in that
  // interval and must not be replaced by the compute-progress surface.
  const compatibleResultFallback =
    !queryResult &&
    !retainPanResult &&
    lastValidResultRef.current?.compatibilitySignature === compatibilitySignature
      ? lastValidResultRef.current.result
      : undefined;
  const retainedQueryResult = timeCapacityRetainedPanResult(
    queryResult ?? compatibleResultFallback,
    lastValidResultRef.current?.result,
    retainPanResult,
  );
  const currentResult = retainedQueryResult;
  const resultIsCompatibleFallback = !queryResult && Boolean(compatibleResultFallback);
  const resultIsRetainedPanFallback =
    !queryResult && !resultIsCompatibleFallback && Boolean(retainedQueryResult);
  const resolvedPlotSpecRef = useRef<AnalysisSpec>(spec);
  const renderSpecBase =
    timeResult.isPlaceholderData || resultIsCompatibleFallback || resultIsRetainedPanFallback
      ? resolvedPlotSpecRef.current
      : requestSpec;
  // A retained/placeholder result deliberately keeps its old data and display
  // range while a replacement request is in flight. Visibility is a local
  // draft concern, though, so carry the current selection into that retained
  // render spec and let the plot hide the toggled trace immediately.
  const renderSpec =
    renderSpecBase === spec
      ? renderSpecBase
      : {
          ...renderSpecBase,
          selection: spec.selection,
          // A retained/placeholder result may still use the previous request's
          // computation, but display-only visibility belongs to the current
          // draft and must respond immediately to a menu action.
          presentation: {
            ...renderSpecBase.presentation,
            hidden_series_ids: spec.presentation.hidden_series_ids,
          },
        };
  const renderCfg = timeCapacityConfig(renderSpec);
  useEffect(() => {
    if (!timeResult.isPlaceholderData && queryResult) {
      resolvedPlotSpecRef.current = requestSpec;
    }
  }, [queryResult, requestSpec, timeResult.isPlaceholderData]);
  const currentResultRef = useRef<TimeCapacityResult | undefined>(undefined);
  currentResultRef.current = currentResult;
  const cancelPendingRefinement = useCallback(() => {
    refinementLifecycle.cancelPending();
    if (refinementTimerRef.current !== null) {
      window.clearTimeout(refinementTimerRef.current);
      refinementTimerRef.current = null;
    }
    refinementAbortRef.current?.abort();
    refinementAbortRef.current = null;
  }, [refinementLifecycle]);
  const cancelRefinementTransition = useCallback(() => {
    if (refinementTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(refinementTransitionFrameRef.current);
      refinementTransitionFrameRef.current = null;
    }
    setRefinementTransition(null);
    setRefinementTransitionProgress(1);
  }, []);
  const clearDisplayedRefinement = useCallback(() => {
    refinementLifecycle.clearDisplayed();
    setRefinedResult(null);
  }, [refinementLifecycle]);
  const invalidateRefinement = useCallback(() => {
    cancelPendingRefinement();
    cancelRefinementTransition();
    clearDisplayedRefinement();
  }, [cancelPendingRefinement, cancelRefinementTransition, clearDisplayedRefinement]);
  useEffect(() => {
    if (!refinementTransition) return;
    const duration = timeCapacityRefinementTransitionDuration(prefersReducedMotion());
    if (duration <= 0) {
      setRefinementTransitionProgress(1);
      setRefinementTransition(null);
      return;
    }
    const startedAt = window.performance.now();
    const tick = (now: number) => {
      const progress = timeCapacityRefinementTransitionProgress(now - startedAt, duration);
      setRefinementTransitionProgress(progress);
      if (progress >= 1) {
        refinementTransitionFrameRef.current = null;
        setRefinementTransition(null);
        return;
      }
      refinementTransitionFrameRef.current = window.requestAnimationFrame(tick);
    };
    refinementTransitionFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (refinementTransitionFrameRef.current !== null) {
        window.cancelAnimationFrame(refinementTransitionFrameRef.current);
        refinementTransitionFrameRef.current = null;
      }
    };
  }, [refinementTransition]);
  useEffect(() => {
    invalidateRefinement();
  }, [invalidateRefinement, currentResult?.data_signature, dataSignature]);
  useLayoutEffect(() => {
    if (stackedModeChanged) invalidateRefinement();
  }, [cfg.stacked, invalidateRefinement, stackedModeChanged]);
  useEffect(() => {
    if (!active) {
      cancelPendingRefinement();
      cancelRefinementTransition();
      clearDisplayedRefinement();
    }
  }, [active, cancelPendingRefinement, cancelRefinementTransition, clearDisplayedRefinement]);
  useEffect(() => cancelPendingRefinement, [cancelPendingRefinement]);
  const selectedVoltageUnavailable = voltageChannelsUnavailable(
    cfg.voltage_channels,
    currentResult?.voltage_channels,
  );
  const voltageDataIdentity = voltageChannelDataIdentity(currentResult);
  const lastVoltageDataIdentityRef = useRef<string | undefined>(undefined);
  const effectiveVoltageDataIdentity =
    voltageDataIdentity ?? lastVoltageDataIdentityRef.current;
  const voltageCapabilitySignature = useMemo(
    () => voltageChannelAvailabilitySignature(scientificRequestSpec, effectiveVoltageDataIdentity),
    [effectiveVoltageDataIdentity, scientificRequestSpec]
  );
  const voltageCapabilitySignatureRef = useRef(voltageCapabilitySignature);
  useEffect(() => {
    const publication = voltageChannelAvailabilityPublication(
      voltageCapabilitySignatureRef.current,
      voltageCapabilitySignature,
      currentResult?.voltage_channels,
    );
    if (voltageDataIdentity !== undefined) {
      lastVoltageDataIdentityRef.current = voltageDataIdentity;
    }
    if (publication.reset) {
      voltageCapabilitySignatureRef.current = voltageCapabilitySignature;
      onVoltageChannelsChange?.(undefined);
    }
    if (publication.channels !== undefined) {
      onVoltageChannelsChange?.(publication.channels);
    }
  }, [
    currentResult?.voltage_channels,
    onVoltageChannelsChange,
    voltageCapabilitySignature,
    voltageDataIdentity,
  ]);
  const computeJob = useQuery({
    queryKey: ["background-job-token", computeToken],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${computeToken}`),
    enabled: computeToken !== null,
    // null means the compute was served from cache and never opened a job.
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 300 : false,
  });
  const showComputeProgress = useDelayedFlag(
    (timeResult.isLoading || timeResult.isFetching) && !currentResult,
    // Channel selection changes the render/cache identity and therefore makes
    // one compact request even when the indexed data is warm. Keep the normal
    // sub-second path silent; a genuinely slow miss can still explain the
    // otherwise empty plot.
    700,
    450,
  );
  const loadingWithoutResult =
    (timeResult.isLoading || timeResult.isFetching) && !currentResult;
  const readyForParent = !loadingWithoutResult;
  useEffect(() => {
    // Background replacement of an already visible buffer is still ready.
    // Flipping this false for every refill rerenders the entire analysis
    // editor, including the live Plotly surface, while the pointer is moving.
    onReadyChange?.(readyForParent);
  }, [onReadyChange, readyForParent]);
  // Rebuild traces/layout only for fields they actually read (see cycles card).
  const viewSignature = useMemo(
    () =>
      JSON.stringify({
        cfg: renderCfg,
        legend: renderSpec.presentation.legend,
        visibility: renderSpec.presentation.hidden_series_ids ?? [],
        style: currentPlotStyle(renderSpec, "time_capacity"),
      }),
    [renderSpec]
  );
  // The interactive figure must not change its data-array length when the
  // Analysis-sample eye changes. Keep a visibility-neutral render spec stable
  // across that display-only edit; the live selection is applied below with a
  // lightweight Plotly restyle operation.
  const scientificRenderSpec = useMemo(
    () => timeCapacityScientificRequestSpec(renderSpec),
    [dataSignature, viewSignature],
  );
  const activeRefinedResult =
    !panActive &&
    timeCapacityRefinementDisplayIsCurrent(
      refinedResult,
      currentResult,
      refinementLifecycle.displayed?.compatibilitySignature ?? null,
      compatibilitySignature,
    )
    ? refinedResult
    : null;
  const plotResult = activeRefinedResult ?? currentResult;
  const plotTraces = useMemo(
    () =>
      plotResult && !selectedVoltageUnavailable
        ? timeCapacityTracesForResult(plotResult, scientificRenderSpec, false, true)
        : [],
    [plotResult, scientificRenderSpec, selectedVoltageUnavailable]
  );
  const plotTraceVisibility = useMemo(
    () => plotTraces.map((trace) => timeCapacityTraceVisibleForSpec(trace, spec)),
    [plotTraces, spec],
  );
  const visiblePlotTraces = useMemo(
    () => plotTraces.filter((_, index) => plotTraceVisibility[index] !== false),
    [plotTraceVisibility, plotTraces],
  );
  const exportTraces = useMemo(
    () => {
      if (!currentResult || selectedVoltageUnavailable) return [];
      // The ordinary view keeps hidden samples in its stable Plotly data
      // array, so exports use the separately filtered visible view. A viewport
      // refinement is the only case in which the plot is showing a different
      // result from the export source.
      if (plotResult === currentResult) return visiblePlotTraces;
      return timeCapacityTracesForResult(currentResult, renderSpec);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentResult, plotResult, renderSpec, selectedVoltageUnavailable, viewSignature, visiblePlotTraces]
  );
  // One shared WebGL subplot is the performance boundary. Each resident
  // buffer is re-zeroed near its own start, which avoids the large per-Cell
  // phase drift of a cycle-1 origin without creating one expensive subplot per
  // Cell. Pointer pixels interpolate between adjacent cycle windows below.
  const panCycleXIndex = useMemo(
    () => buildTimeCapacityCycleXIndex(plotResult?.cell_traces),
    [plotResult],
  );
  const panLiveXRef = useRef<[number, number] | null>(null);
  const livePanWindow = panLiveWindowRef.current;
  const livePanPosition = panLivePositionRef.current ?? livePanWindow?.start ?? null;
  const deliveredPanRange =
    panActive && livePanWindow
      ? interpolatedXRangeForCycleIndex(
          panCycleXIndex,
          livePanPosition ?? livePanWindow.start,
          livePanWindow.end - livePanWindow.start + 1,
        )
      : null;
  if (deliveredPanRange) panLiveXRef.current = deliveredPanRange;
  const settlingWindow = panSettlingWindowRef.current;
  const committedRangeHasSettled = Boolean(
    !panActive &&
      settlingWindow &&
      cfg.cycle_start === settlingWindow.start &&
      cfg.cycle_end === settlingWindow.end &&
      !timeResult.isFetching &&
      !timeResult.isPlaceholderData &&
      queryResult,
  );
  if (committedRangeHasSettled) {
    panSettlingWindowRef.current = null;
    panLiveXRef.current = null;
  } else if (!panActive && !settlingWindow) {
    panLiveXRef.current = null;
  }
  const panPresentationActive = Boolean(
    (panActive || panSettlingWindowRef.current) &&
      panLiveXRef.current,
  );
  const transitionTraces = useMemo(() => {
    if (panPresentationActive || cfg.stacked || !refinementTransition) return null;
    // Keep the old line at its exact visual weight. The new LoD is revealed
    // over it; this avoids alpha-compositing two copies of the same line,
    // which otherwise produces a brief lightness/thickness blink.
    const oldOpacity = 1;
    const newOpacity = refinementTransitionProgress;
    return [
      ...refinementTransition.from.map((trace) =>
        transitionTraceOpacity(trace, oldOpacity, true),
      ),
      ...refinementTransition.to.map((trace) =>
        transitionTraceOpacity(trace, newOpacity, false),
      ),
    ];
  }, [cfg.stacked, panPresentationActive, refinementTransition, refinementTransitionProgress]);
  // A committed range replacement keeps the last complete result/spec pair
  // visible while its query resolves. It must not make the export controls
  // flash or close their settings popover. Active pan/refill fallback remains
  // blocked because it is not a stable export target.
  const plotExportReady = timeCapacityPlotExportReady(
    panActive || resultIsRetainedPanFallback,
    Boolean(currentResult),
    selectedVoltageUnavailable,
    exportTraces.length > 0,
  );
  const traces = useMemo(
    () => transitionTraces ?? interactivePlotTraces(plotTraces),
    [plotTraces, transitionTraces],
  );
  const traceVisibility = useMemo(
    () => traces.map((trace) => timeCapacityTraceVisibleForSpec(trace, spec)),
    [spec, traces],
  );
  const exportInteractiveTraces = useMemo(
    () => interactivePlotTraces(exportTraces),
    [exportTraces],
  );
  const zoomSignature = `${analysisId}|${cfg.view}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`;
  const zoom = useZoomMemory(zoomSignature, cfg.view !== "voltage_current" || !cfg.stacked);
  const zoomResetRef = useRef(zoom.reset);
  zoomResetRef.current = zoom.reset;

  // Spec 052.8: y is frozen for the duration of one drag. Letting Plotly
  // reautoscale y as each buffer landed made the whole plot rescale and blink
  // mid-pan. Captured from the live axis when panning begins.
  const [frozenY, setFrozenY] = useState<[number, number] | null>(null);
  const panFrozenYRef = useRef<[number, number] | null>(null);
  panFrozenYRef.current = frozenY;
  const panWasActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = panWasActiveRef.current;
    panWasActiveRef.current = panActive;
    if (!panActive || wasActive) return;
    // Freeze at the axis the user is looking at as the drag begins, and keep
    // it after release: rescaling on release would reintroduce the blink.
    const range = (
      plotDivRef.current as unknown as { _fullLayout?: { yaxis?: { range?: number[] } } } | null
    )?._fullLayout?.yaxis?.range;
    if (Array.isArray(range) && range.length === 2 && range.every((v) => Number.isFinite(v))) {
      setFrozenY([range[0], range[1]]);
    }
  }, [panActive]);
  // A change that redefines the y quantity makes a retained window meaningless.
  useEffect(() => {
    setFrozenY(null);
  }, [cfg.view, cfg.x_axis, cfg.voltage_channel, cfg.voltage_channels.join("|"), cfg.stacked, cfg.display_mode]);
  const fitYAxis = useCallback(() => setFrozenY(null), []);

  const resetPlotViewportForNavigation = useCallback(() => {
    setPlotViewportCycleRange(null);
    zoomResetRef.current();
    invalidateRefinement();
    const graphDiv = plotDivRef.current;
    if (!graphDiv) return;
    const relayout = {
      "xaxis.autorange": true,
      ...(cfg.stacked ? { "xaxis2.autorange": true } : {}),
    };
    void Promise.resolve(
      (PlotlyLib as unknown as {
        relayout: (element: HTMLElement, update: Record<string, unknown>) => unknown;
      }).relayout(graphDiv, relayout),
    ).catch(() => {
      // The plot may unmount while a navigation event is being committed.
    });
  }, [cfg.stacked, invalidateRefinement]);

  const layout = useMemo(() => {
    // Use the same neutral scientific spec as the stable figure data. The
    // live Analysis-sample selection is applied by Plotly restyle, so an eye
    // edit does not rebuild axes or margins either.
    const base = zoom.apply(timeCapacityLayout(plotResult, scientificRenderSpec, plotTraces));
    const retainedY = panFrozenYRef.current;
    const next = { ...base } as Record<string, unknown>;
    // Stacked layouts intentionally omit uirevision because Plotly can enter
    // a relayout loop when matched x axes use it. Preserve the accepted
    // refinement viewport explicitly while replacing the coarse result so the
    // new high-resolution data cannot reset the user's visible window.
    const refinementViewport =
      cfg.stacked && activeRefinedResult
        ? refinementLifecycle.displayed?.viewport ?? null
        : null;
    if (refinementViewport) {
      const range = [refinementViewport.min, refinementViewport.max];
      next.xaxis = { ...(base.xaxis ?? {}), range: [...range], autorange: false };
      next.xaxis2 = { ...(base.xaxis2 ?? {}), range: [...range], autorange: false };
    }
    const liveX = panPresentationActive ? panLiveXRef.current : null;
    if (liveX) {
      next.xaxis = { ...(base.xaxis ?? {}), range: [...liveX], autorange: false };
      if (cfg.stacked) {
        next.xaxis2 = { ...(base.xaxis2 ?? {}), range: [...liveX], autorange: false };
      }
    }
    if (!retainedY) return next as typeof base;
    next.yaxis = { ...(base.yaxis ?? {}), range: [...retainedY], autorange: false };
    return next as typeof base;
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      plotResult,
      scientificRenderSpec,
      plotTraces,
      panPresentationActive,
      cfg.stacked,
      frozenY,
      activeRefinedResult,
      refinementLifecycle,
    ]
  );

  // Coalesce twice: first to one requestAnimationFrame, then across Plotly's
  // asynchronous relayout itself. The old code cleared the RAF guard before
  // relayout completed, so fast input could queue stale Plotly work faster
  // than it rendered. This keeps one relayout in flight and retains only the
  // newest target -- actual frame dropping at the rendering boundary.
  const panFrameRef = useRef<number | null>(null);
  const panRelayoutInFlightRef = useRef(false);
  const panPendingRef = useRef<[number, number] | null>(null);
  const panCycleXIndexRef = useRef(panCycleXIndex);
  const panStackedRef = useRef(cfg.stacked);
  panCycleXIndexRef.current = panCycleXIndex;
  panStackedRef.current = cfg.stacked;
  const queuePanFrameRef = useRef<() => void>(() => {});
  const queuePanFrame = useCallback(() => {
    if (
      panFrameRef.current !== null ||
      panRelayoutInFlightRef.current ||
      !panPendingRef.current
    ) return;
    panFrameRef.current = window.requestAnimationFrame(() => {
      panFrameRef.current = null;
      if (panRelayoutInFlightRef.current) return;
      const target = panPendingRef.current;
      panPendingRef.current = null;
      const div = plotDivRef.current;
      if (!target || !div) return;
      panRelayoutInFlightRef.current = true;
      const finish = () => {
        panRelayoutInFlightRef.current = false;
        if (panPendingRef.current) queuePanFrameRef.current();
      };
      try {
        const update: Record<string, unknown> = {
          "xaxis.range": [...target],
          "xaxis.autorange": false,
        };
        if (panStackedRef.current) {
          update["xaxis2.range"] = [...target];
          update["xaxis2.autorange"] = false;
        }
        if (panFrozenYRef.current) {
          update["yaxis.range"] = [...panFrozenYRef.current];
          update["yaxis.autorange"] = false;
        }
        const result = PlotlyLib.relayout(div as never, update as never) as unknown;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          void (result as Promise<unknown>).then(finish, finish);
        } else {
          finish();
        }
      } catch {
        // A relayout can land after teardown/remount. The next React render
        // restores the latest viewport from `layout`.
        finish();
      }
    });
  }, []);
  queuePanFrameRef.current = queuePanFrame;
  const schedulePanRelayout = useCallback((
    range: TimeCapacityCycleRange | null,
    continuousStart?: number | null,
  ) => {
    if (!range) {
      panPendingRef.current = null;
      return;
    }
    const position = Number.isFinite(continuousStart)
      ? Number(continuousStart)
      : range.start;
    const target = interpolatedXRangeForCycleIndex(
      panCycleXIndexRef.current,
      position,
      range.end - range.start + 1,
    );
    // Outside the resident buffer: retain the last valid frame. The scheduler
    // is already fetching the newest desired buffer and will jump directly to
    // that position when it renders, dropping obsolete intermediate frames.
    if (!target) return;
    panLiveXRef.current = target;
    panPendingRef.current = target;
    queuePanFrame();
  }, [queuePanFrame]);
  panVisualUpdateRef.current = schedulePanRelayout;
  useLayoutEffect(() => {
    if (panActive && panLiveWindowRef.current) {
      schedulePanRelayout(panLiveWindowRef.current, panLivePositionRef.current);
    }
  }, [panActive, panCycleXIndex, schedulePanRelayout]);
  useEffect(
    () => () => {
      if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
      panPendingRef.current = null;
    },
    [],
  );
  const profileResultIsCurrent = Boolean(
    timeCapacityProfileResultIsCurrent(
      dataSignature,
      profileRequest?.dataSignature ?? null,
      currentResult,
      Boolean(timeResult.isPlaceholderData),
    ),
  );
  useLayoutEffect(() => {
    if (!profileRequest || !profileResultIsCurrent) return;
    timeCapacityPerformanceProfiler.frontendPrepared(
      profileRequest.requestId,
      {
        resolvedCellCount: currentResult
          ? timeCapacityResolvedCellCount(currentResult.cell_traces)
          : undefined,
        plotlyTraceCount: traces.length,
      },
    );
  }, [currentResult, profileRequest, profileResultIsCurrent, traces.length]);
  const style = currentPlotStyle(spec, "time_capacity");
  const seriesVisibilityCandidates = useMemo(
    () => (currentResult ? timeCapacitySeriesVisibilityCandidates(currentResult, spec) : []),
    [currentResult, spec],
  );
  const seriesVisibilityItems = useMemo(
    () => plotSeriesVisibilityItems(seriesVisibilityCandidates, spec),
    [seriesVisibilityCandidates, spec],
  );
  const showOnlySeries = useCallback(
    (key: string) =>
      update((draft) => {
        draft.presentation.hidden_series_ids = hiddenSeriesIdsAfterShowOnly(
          draft.presentation.hidden_series_ids,
          seriesVisibilityCandidates,
          key,
        );
      }),
    [seriesVisibilityCandidates, update],
  );
  const showAllSeries = useCallback(
    () =>
      update((draft) => {
        draft.presentation.hidden_series_ids = hiddenSeriesIdsAfterShowAll(
          draft.presentation.hidden_series_ids,
          seriesVisibilityCandidates,
        );
      }),
    [seriesVisibilityCandidates, update],
  );
  const updatePlotStyle = useCallback(
    (fn: (style: PlotStyle) => void) => {
      update((s) => writeScopedStyle(s, "time_capacity", fn));
    },
    [update],
  );
  // Spec 052.8: with y frozen, the position the user settles on may hold data
  // above or below the retained window. Rather than silently clipping it, the
  // modebar is pinned open and a highlighted control offers to refit.
  const yOutOfView = useMemo(
    () =>
      yDataOutsideRange(
        plotTraces as never,
        panPresentationActive ? panLiveXRef.current : null,
        frozenY,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plotTraces, frozenY, panActive, panPresentationActive],
  );
  const fitYModebarButton = useMemo<Plotly.ModeBarButton>(
    () => ({
      name: "time-capacity-fit-y",
      title: "Fit Y axis to visible data",
      icon: TIME_CAPACITY_FIT_Y_MODEBAR_ICON,
      click: () => fitYAxis(),
    }),
    [fitYAxis],
  );
  const gridModebarButton = useMemo<Plotly.ModeBarButton>(
    () => ({
      name: "time-capacity-grid",
      title: style.show_grid ? "Hide grid" : "Show grid",
      icon: TIME_CAPACITY_GRID_MODEBAR_ICON,
      click: () => updatePlotStyle((next) => void (next.show_grid = !next.show_grid)),
    }),
    [style.show_grid, updatePlotStyle],
  );
  // react-plotly.js treats a changed config reference as a full Plotly.react
  // update, even when data and layout are unchanged. Keep it stable across
  // parent/state renders so a visibility edit cannot queue a redundant plot
  // rebuild behind the actual trace update.
  const plotConfig = useMemo(
    () => ({
      displaylogo: false,
      edits: { legendPosition: style.legend_mode !== "outside" },
      // Keep Plotly's normal hover-to-reveal modebar available even
      // when the Y-range hint is not active.
      displayModeBar: "hover" as const,
      modeBarButtonsToAdd: yOutOfView
        ? [fitYModebarButton, gridModebarButton]
        : [gridModebarButton],
    }),
    [fitYModebarButton, gridModebarButton, style.legend_mode, yOutOfView],
  );
  const explainer = getTimeCapacityExplainer(
    cfg.x_axis,
    cfg.stacked ? (cfg.current_right !== "none" ? cfg.current_right : cfg.current_left) : "none",
    cfg.view,
    cfg.derivative_specific,
    cfg.smoothing_window
  );
  const rememberPlotDiv = (graphDiv: unknown) => {
    const element = graphDiv as HTMLElement;
    plotDivRef.current = element;
    const rect = element.getBoundingClientRect();
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    setPlotSize((current) =>
      current && current.width === next.width && current.height === next.height ? current : next
    );
  };
  const acknowledgePanRender = useCallback(() => {
    if (
      !panActive ||
      !panRequest ||
      !maxAvailableCycle ||
      timeResult.isFetching ||
      timeResult.isPlaceholderData ||
      !timeResult.data
    ) return;
    const ready = timeCapacityBufferOnResponseReady(panSchedulerRef.current, panRequest);
    const decision = timeCapacityBufferOnRendered(ready, panRequest, maxAvailableCycle);
    applyPanDecision(decision);
    if (panLiveWindowRef.current) {
      panVisualUpdateRef.current(panLiveWindowRef.current, panLivePositionRef.current);
    }
  }, [
    applyPanDecision,
    maxAvailableCycle,
    panActive,
    panRequest,
    timeResult.data,
    timeResult.isFetching,
    timeResult.isPlaceholderData,
  ]);
  const commitCycleRange = useCallback(
    (range: TimeCapacityCycleRange) => {
      resetPlotViewportForNavigation();
      if (panActiveRef.current) {
        panSettlingWindowRef.current = { ...range };
        panLiveWindowRef.current = { ...range };
        panLivePositionRef.current = range.start;
        panVisualUpdateRef.current(range, range.start);
      }
      // Keep the parent update for the intentional dirty-state semantics, but
      // admit committed data requests latest-wins so rapid buttons cannot
      // cancel every request before one produces a frame.
      scheduleCommittedNavigationRange(range);
      update((s) => {
        const next = timeCapacityConfig(s);
        next.cycle_start = range.start;
        next.cycle_end = range.end;
        s.computation.time_capacity = next;
      });
    },
    [resetPlotViewportForNavigation, scheduleCommittedNavigationRange, update],
  );
  const commitSpecificCycles = useCallback(
    (cycles: number[]) => {
      resetPlotViewportForNavigation();
      update((s) => {
        const next = timeCapacityConfig(s);
        next.cycles = cycles;
        if (cycles.length > 0) {
          next.cycle_start = Math.min(...cycles);
          next.cycle_end = Math.max(...cycles);
        }
        s.computation.time_capacity = next;
      });
    },
    [resetPlotViewportForNavigation, update],
  );
  const handlePlotRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    const pointerDriven = zoom.onRelayout(event);
    if (pointerDriven) setPlotViewportChangeKey((current) => current + 1);
    const relayout = event as Record<string, unknown>;
    const axisPrefixes = cfg.stacked ? ["xaxis", "xaxis2"] : ["xaxis"];
    const readRange = (prefix: string): TimeCapacityViewport | null => {
      const direct = relayout[`${prefix}.range`];
      if (Array.isArray(direct) && direct.length >= 2) {
        const min = Number(direct[0]);
        const max = Number(direct[1]);
        return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
      }
      const min = Number(relayout[`${prefix}.range[0]`]);
      const max = Number(relayout[`${prefix}.range[1]`]);
      return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    };
    const viewport = axisPrefixes.map(readRange).find((value) => value !== null) ?? null;
    if (axisPrefixes.some((prefix) => relayout[`${prefix}.autorange`] === true)) {
      if (pointerDriven) setPlotViewportCycleRange(null);
      cancelPendingRefinement();
      cancelRefinementTransition();
      clearDisplayedRefinement();
    } else {
      if (pointerDriven && viewport) {
        const visibleCycleRange = timeCapacityVisibleCycleRangeForViewport(
          currentResultRef.current,
          viewport,
        );
        setPlotViewportCycleRange((current) =>
          current?.start === visibleCycleRange?.start && current?.end === visibleCycleRange?.end
            ? current
            : visibleCycleRange,
        );
      }
      if (
        !cyclePreviewRange &&
        !previewQueryRange &&
        timeCapacityRefinementCanSchedule(active, spec)
      ) {
        const previousViewport = refinementLifecycle.requestedViewport;
      const sameViewport =
        viewport !== null &&
        previousViewport !== null &&
        Math.abs(viewport.min - previousViewport.min) < 1e-9 &&
        Math.abs(viewport.max - previousViewport.max) < 1e-9;
      if (viewport && !sameViewport) {
        const overview = timeCapacityOverviewExtent(currentResultRef.current);
        const cycleRange = timeCapacityCycleRangeForViewport(currentResultRef.current, viewport);
        const keepDisplayedRefinement = timeCapacityRefinementDisplayIsCompatible(
          refinedResult,
          currentResultRef.current,
          refinementLifecycle.displayed?.viewport ?? null,
          viewport,
        );
        cancelPendingRefinement();
        cancelRefinementTransition();
        if (!keepDisplayedRefinement) clearDisplayedRefinement();
        if (
          timeCapacityRefinementWorthwhile(overview, viewport) &&
          cycleRange &&
          currentResultRef.current?.data_signature
        ) {
          const generation = refinementLifecycle.beginRequest(viewport);
          refinementTimerRef.current = window.setTimeout(() => {
            refinementTimerRef.current = null;
            const controller = new AbortController();
            refinementAbortRef.current = controller;
            void post<TimeCapacityRefinementResult>(
              `/api/analyses/${analysisId}/time-capacity/refine`,
              {
                // Refinement is another scientific Time/Capacity boundary.
                // Analysis-sample eyes remain live render state and must not
                // alter the cells read by this ephemeral high-resolution path.
                spec: scientificRenderSpec,
                viewport_x_min: viewport.min,
                viewport_x_max: viewport.max,
                viewport_width: viewportWidth,
                cycle_start: cycleRange.start,
                cycle_end: cycleRange.end,
                request_generation: generation,
              },
              { signal: controller.signal },
            )
              .then((response) => {
                if (refinementLifecycle.acceptResponse(
                  response,
                  currentResultRef.current,
                  generation,
                  viewport,
                  compatibilitySignature,
                )) {
                  const previousDisplayedResult = activeRefinedResult ?? currentResultRef.current;
                  const transitionDuration = timeCapacityRefinementTransitionDuration(
                    prefersReducedMotion(),
                  );
                  const fromTraces = previousDisplayedResult
                    ? refinementTransitionTraces(previousDisplayedResult, scientificRenderSpec)
                    : [];
                  const toTraces = refinementTransitionTraces(response, scientificRenderSpec);
                  if (
                    previousDisplayedResult &&
                    transitionDuration > 0 &&
                    refinementTransitionCanReveal(fromTraces, toTraces)
                  ) {
                    setRefinementTransitionProgress(0);
                    setRefinementTransition({
                      from: fromTraces,
                      to: toTraces,
                    });
                  } else {
                    cancelRefinementTransition();
                  }
                  setRefinedResult(response);
                }
              })
              .catch(() => {
                // Refinement is opportunistic; the stable overview remains
                // visible when a request is aborted or unavailable.
              });
          }, 150);
        }
        }
      }
    }
    if (style.legend_mode === "outside") return;
    const point = draggedLegendPoint(event);
    if (!point) return;
    updatePlotStyle((next) => {
      next.legend_mode = "inside";
      next.legend_inside_position = "custom";
      next.legend_custom_x = point.x;
      next.legend_custom_y = point.y;
    });
  };

  const completeTimeCapacityProfile = () => {
    if (!profileRequest || !profileResultIsCurrent) return;
    // react-plotly.js invokes onInitialized/onUpdate after the underlying
    // newPlot/react promise completes. The callback is therefore the Plotly
    // boundary; the identity guard prevents an obsolete callback from closing
    // a newer range request.
    timeCapacityPerformanceProfiler.plotlyComplete(profileRequest.requestId);
  };

  const currentViewSize = () => {
    if (!plotDivRef.current) return plotSize;
    const rect = plotDivRef.current.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };

  // faithful mini-render of the export output for the settings popover
  const getExportPreview = async (exportStyle: PlotStyle = style): Promise<string | null> => {
    if (!plotExportReady || !plotDivRef.current || exportTraces.length === 0) return null;
    const plan = resolveExportPlan(exportStyle, currentViewSize(), layout);
    const toImage = (
      PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
    ).toImage;
    const previewTraces = exportStyle.export_format === "png" ? exportInteractiveTraces : exportTraces;
    return toImage(exportFigure(previewTraces, layout, exportStyle, plotName, plan), {
      format: "png",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      scale: Math.min(1, 420 / plan.layoutWidth),
    });
  };

  const handleDataExport = async (
    baseName: string,
    exportStyle: PlotStyle = style,
    scope: PlotDataExportScope = "full_series",
  ) => {
    if (!currentResult || selectedVoltageUnavailable || exportTraces.length === 0 || dataExporting) return;
    const requestedSignature = dataSignature;
    const requestedVoltageChannels = requestCfg.voltage_channels;
    const requestedSourceDataIdentity = voltageChannelDataIdentity(currentResult);
    const exportSpec = timeCapacityDataExportSpec(spec, timeCapacityConfig(spec), scope);
    const livePlotXRange = (() => {
      if (scope !== "plot_range") return null;
      const range = (
        plotDivRef.current as unknown as {
          _fullLayout?: { xaxis?: { range?: unknown[] } };
        } | null
      )?._fullLayout?.xaxis?.range;
      if (!Array.isArray(range) || range.length < 2) return null;
      const first = Number(range[0]);
      const second = Number(range[1]);
      return Number.isFinite(first) && Number.isFinite(second)
        ? ([first, second] as const)
        : null;
    })();
    const exportStarted = performance.now();
    const exportTimings: Record<string, number> = {};
    let saveStarted: number | null = null;
    const markExportStage = (name: string, started: number) => {
      exportTimings[name] = performance.now() - started;
    };
    const exportFormat = exportStyle.data_export_format.toUpperCase();
    setDataExportFormat(exportStyle.data_export_format);
    setDataExportStage("requesting");
    setDataExporting(true);
    try {
      const exportConfig = timeCapacityConfig(exportSpec);
      const nativePlan =
        exportStyle.data_export_format === "csv" || exportStyle.data_export_format === "parquet"
          ? timeCapacityNativeExportPlan(
              currentResult,
              exportSpec,
              exportConfig,
              currentPlotStyle(exportSpec, "time_capacity"),
            )
          : null;
      if (scope === "plot_range" && livePlotXRange === null) {
        throw new Error("The current plot range is unavailable. Please reset or adjust the plot and try again.");
      }
      if (nativePlan !== null) {
        const requestStarted = performance.now();
        const blob = await postBlob(
          `/api/analyses/${analysisId}/time-capacity/export`,
          {
            spec: exportSpec,
            viewport_width: viewportWidth,
            format: exportStyle.data_export_format,
            data_precision: exportStyle.data_precision,
            decimal_separator: exportStyle.data_decimal_separator,
            delimiter: exportStyle.data_delimiter,
            x_range: livePlotXRange,
            plan: nativePlan,
          },
        );
        markExportStage("native_request_and_format_ms", requestStarted);
        if (
          !timeCapacityExportMatchesRequest(
            dataSignatureRef.current,
            requestedSignature,
            voltageChannelRef.current,
            requestedVoltageChannels,
            currentResult,
            requestedSourceDataIdentity,
          )
        ) {
          throw new Error("The plot changed while the full-resolution export was prepared. Please try again.");
        }
        setDataExportStage("saving");
        saveStarted = performance.now();
        await downloadBlob(blob, `${baseName}.${exportStyle.data_export_format}`);
        markExportStage("save_ms", saveStarted);
        markExportStage("total_ms", exportStarted);
        if (import.meta.env.DEV) {
          console.debug("[Time/Capacity data export]", {
            format: exportFormat,
            scope,
            path: "native_file",
            bytes: blob.size,
            ...exportTimings,
          });
        }
        return;
      }
      const requestStarted = performance.now();
      const fullResult = await post<TimeCapacityResult>(
        `/api/analyses/${analysisId}/time-capacity`,
        {
          spec: exportSpec,
          ...timeCapacityExportOptions(viewportWidth),
        }
      );
      markExportStage("full_request_ms", requestStarted);
      if (
        !timeCapacityExportMatchesRequest(
          dataSignatureRef.current,
          requestedSignature,
          voltageChannelRef.current,
          requestedVoltageChannels,
          fullResult,
          requestedSourceDataIdentity
        )
      ) {
        throw new Error("The plot changed while the full-resolution export was prepared. Please try again.");
      }
      if (voltageChannelsUnavailable(requestedVoltageChannels, fullResult.voltage_channels)) {
        const unavailableChannel = requestedVoltageChannels.find((channel) =>
          voltageChannelsUnavailable([channel], fullResult.voltage_channels),
        );
        throw new Error(
          unavailableChannel
            ? voltageChannelUnavailableMessage(unavailableChannel)
            : "A selected voltage quantity is unavailable for the current selection.",
        );
      }
      const columnStarted = performance.now();
      const directColumns = consecutiveTimeCapacityExportColumns(
        fullResult,
        exportSpec,
        exportConfig,
        currentPlotStyle(exportSpec, "time_capacity"),
        livePlotXRange,
      );
      let traceCount = 0;
      let columns = directColumns;
      if (columns === null) {
        const traceStarted = performance.now();
        const fullTraces = timeCapacityTracesForResult(fullResult, exportSpec);
        traceCount = fullTraces.length;
        markExportStage("trace_build_ms", traceStarted);
        columns = tracesToColumns(fullTraces, layout, livePlotXRange);
      }
      markExportStage("column_build_ms", columnStarted);
      if (columns.length === 0) {
        throw new Error("No data is available for the selected voltage quantity.");
      }
      const fileStarted = performance.now();
      await downloadDataExport(
        columns,
        exportStyle,
        baseName,
        (stage) => {
          setDataExportStage(stage);
          if (stage === "saving") {
            markExportStage("formatting_ms", fileStarted);
            saveStarted = performance.now();
          }
        },
      );
      if (saveStarted !== null) markExportStage("save_ms", saveStarted);
      markExportStage("file_and_save_ms", fileStarted);
      markExportStage("total_ms", exportStarted);
      if (import.meta.env.DEV) {
        console.debug("[Time/Capacity data export]", {
          format: exportFormat,
          scope,
          path: directColumns === null ? "plotly_traces" : "direct_columns",
          trace_count: traceCount,
          column_count: columns.length,
          row_count: columns.reduce((max, column) => Math.max(max, column.values.length), 0),
          ...exportTimings,
        });
      }
    } catch (e) {
      notifications.show({ message: e instanceof Error ? e.message : "Data export failed.", color: "red" });
    } finally {
      setDataExporting(false);
      setDataExportStage(null);
      setDataExportFormat(null);
    }
  };

  const statusFormat = (dataExportFormat ?? style.data_export_format).toUpperCase();
  const dataExportStatus =
    dataExportStage === "requesting"
      ? `Preparing full-resolution ${statusFormat}…`
      : dataExportStage === "formatting"
        ? `Creating ${statusFormat} file…`
        : dataExportStage === "saving"
          ? `Saving ${statusFormat} file…`
          : undefined;

  const exportPlot = async (
    format: PlotExportFormat,
    baseName: string,
    exportStyle: PlotStyle = style,
  ) => {
    if (!plotExportReady || !plotDivRef.current || !currentResult || selectedVoltageUnavailable) return;
    try {
      const plan = resolveExportPlan(exportStyle, currentViewSize(), layout);
      const ppi = Math.max(36, exportStyle.export_ppi ?? 96);
      const filename = slugFilename(baseName);
      const outputTraces = format === "png" ? exportInteractiveTraces : exportTraces;
      const figure = exportFigure(outputTraces, layout, exportStyle, plotName, plan);
      const toImage = (
        PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
      ).toImage;

      if (format === "pdf") {
        const svgUrl = await toImage(figure, {
          format: "svg",
          width: plan.layoutWidth,
          height: plan.layoutHeight,
        });
        await downloadBlob(
          await makeVectorPdf(
            svgUrl,
            plan.pixelWidth / plan.pixelHeight,
            exportStyle.export_aspect_ratio
          ),
          `${filename}.pdf`
        );
        return;
      }
      const dataUrl = await toImage(figure, {
        format,
        width: plan.layoutWidth,
        height: plan.layoutHeight,
        scale: plan.scale,
      });
      const blob = format === "png" ? pngWithPpi(dataUrl, ppi) : blobFromDataUrl(dataUrl, "image/svg+xml");
      await downloadBlob(blob, `${filename}.${format}`);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Plot export failed.",
        color: "red",
      });
    }
  };

  /**
   * The preview is the real plot: the same trace and layout builders, called
   * with the draft overrides applied. Rebuilding a simplified version here
   * would let the preview drift from the result.
   */
  const buildSeriesPreview = useCallback(
    (draft: { overrides: Record<string, SeriesStyleOverride>; rules: SeriesStyleRule[]; styleOverlay?: Partial<PlotStyle> }) => {
      if (!currentResult || selectedVoltageUnavailable) {
        return { data: [] as Plotly.Data[], layout: {} as Partial<Plotly.Layout> };
      }
      // A shallow spec with only the scoped style swapped. structuredClone here
      // copied the whole selection, protocol segments and saved-plot state on
      // every keystroke, for the sake of two fields.
      const draftSpec: AnalysisSpec = {
        ...renderSpec,
        presentation: {
          ...renderSpec.presentation,
          plot_styles: {
            ...(renderSpec.presentation.plot_styles ?? {}),
            time_capacity: {
              ...currentPlotStyle(renderSpec, "time_capacity"),
              ...(draft.styleOverlay ?? {}),
              series_overrides: draft.overrides,
              series_rules: draft.rules,
            },
          },
        },
      };
       const data = decimatePreviewTraces(timeCapacityTracesForResult(currentResult, draftSpec));
       return { data, layout: timeCapacityLayout(currentResult, draftSpec, data) };
     },
     [currentResult, renderSpec, selectedVoltageUnavailable],
   );

  return (
    <Group align="stretch" wrap="nowrap">
      <Paper
        p="sm"
        withBorder
        style={{ minHeight: 590, position: "relative", flex: 1, minWidth: 520, overflow: "hidden" }}
      >
        {/* spinner only when there is nothing to show yet — background
            refetches of cached data keep the subtle opacity dim instead */}
        <LoadingOverlay
          visible={timeResult.isFetching && traces.length === 0 && !timeResult.isLoading}
          overlayProps={{ blur: 1.5, backgroundOpacity: 0.18 }}
          loaderProps={{ size: "sm" }}
        />
        <PlotHeader
          analysisTitle={analysisTitle}
          tabName="Time / capacity"
          plotName={plotName}
          subtitle={subtitle}
          quantityName={
             cfg.view === "voltage_current"
               ? `${voltageChannelSelectionLabel(cfg.voltage_channels, currentResult?.voltage_channels)}${cfg.stacked ? " and current" : ""}`
              : cfg.view === "dqdv"
                ? "dQ/dV"
                : "dV/dQ"
          }
          xAxisName={
            cfg.x_axis === "time"
              ? `Time (${cfg.time_unit})`
              : cfg.x_axis === "capacity_mah_g"
                ? "Specific capacity (mAh/g)"
                : cfg.x_axis === "capacity_mah_cm2"
                  ? "Areal capacity (mAh/cm²)"
                  : "Capacity (mAh)"
          }
          sampleSummary={`${spec.selection.entries.length} ${
            spec.selection.entries.length === 1 ? "sample" : "samples"
          }`}
          explainer={explainer}
          onExport={exportPlot}
          onDataExport={handleDataExport}
          dataExportScopeEnabled
          getExportPreview={getExportPreview}
          style={style}
          viewSize={plotSize}
          layout={layout}
          canExport={!panActive && Boolean(currentResult) && !selectedVoltageUnavailable && !dataExporting && exportTraces.length > 0}
          dataExporting={dataExporting}
          dataExportStatus={dataExportStatus}
          canPlotExport={plotExportReady && !dataExporting}
          edited={edited}
          onNewPlot={onNewPlot}
          newPlotEnabled={newPlotEnabled}
          onUpdatePlot={onUpdatePlot}
          updatePlotEnabled={updatePlotEnabled}
          updatePlotLabel={updatePlotLabel}
        />
        <TimeCapacityCycleNavigation
          config={cfg}
          maxAvailableCycle={maxAvailableCycle}
          viewportCycleRange={plotViewportCycleRange}
          isVirgin={isVirginNavigation}
          navigationResetKey={navigationResetKey}
          viewportChangeKey={plotViewportChangeKey}
          onCommitRange={commitCycleRange}
          onCommitSpecificCycles={commitSpecificCycles}
          onResetViewport={resetPlotViewportForNavigation}
          onPreviewRangeChange={handleCyclePreviewRange}
          onWarmRange={panningEnabled ? setPanWarmRange : undefined}
          spec={spec}
        />
        {timeResult.isError && (
          <Alert color="red">{(timeResult.error as Error).message || "Time/capacity compute failed"}</Alert>
        )}
         {loadingWithoutResult ? (
          // Hold the space silently until the load is slow enough to mention.
          <Center h={500}>
            {showComputeProgress ? (
              <ComputeProgress job={computeJob.data ?? undefined} label="Preparing time/capacity plot" />
            ) : null}
          </Center>
         ) : traces.length === 0 ? (
           <Center h={500}>
             <Text size="sm" c="dimmed">
               {cfg.voltage_channels.length === 0
                 ? "Select at least one voltage quantity to plot."
                 : selectedVoltageUnavailable
                 ? voltageChannelsUnavailableMessage(cfg.voltage_channels, currentResult?.voltage_channels)
                 : "Add cells or replicates, then choose cycles to plot raw voltage and current."}
             </Text>
          </Center>
        ) : (
          <Box
            ref={containerRef}
            onPointerDownCapture={zoom.armOnPointerDown}
            data-tc-fit-y-hint={yOutOfView ? "on" : undefined}
            style={{
              width: "100%",
              minWidth: 0,
              position: "relative",
            }}
          >
            {yOutOfView && (
              /* Plotly owns the modebar DOM, so the highlight is applied by
                 selector rather than by prop. Scoped to this card. */
              <style>{`
                [data-tc-fit-y-hint="on"] .modebar-btn[data-title="Fit Y axis to visible data"] {
                  background: var(--mantine-color-yellow-light, rgba(250, 176, 5, 0.15));
                  border-radius: 4px;
                }
                [data-tc-fit-y-hint="on"] .modebar-btn[data-title="Fit Y axis to visible data"] .icon path {
                  fill: var(--mantine-color-yellow-6, #fab005) !important;
                }
              `}</style>
            )}
            <Plot
              // remount at the stacked↔flat boundary: diffing a matched-axes
              // subplot layout into a single-axis one is Plotly's slowest
              // path; a clean newPlot is far cheaper and predictable
              key={`${cfg.stacked ? "tc-stacked" : "tc-flat"}|grid-${style.show_grid ? "on" : "off"}`}
              data={traces}
              layout={layout}
              config={plotConfig}
              traceVisibility={traceVisibility}
              style={{ width: "100%" }}
              onViewportIntent={zoom.armOnPointerDown}
              onRelayout={handlePlotRelayout}
              onInitialized={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                completeTimeCapacityProfile();
                acknowledgePanRender();
              }}
              onUpdate={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                completeTimeCapacityProfile();
                acknowledgePanRender();
              }}
            />
            {yOutOfView && (
              <Alert color="yellow" variant="light" mt="xs" p="xs" role="status">
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  <Text size="xs" style={{ lineHeight: 1.35 }}>
                    Some data is outside the current Y range.
                  </Text>
                  <Button size="compact-xs" variant="light" color="yellow" onClick={fitYAxis}>
                    Fit Y axis
                  </Button>
                </Group>
              </Alert>
            )}
          </Box>
        )}
      </Paper>
      <PlotStylePanel
        opened={stylePanelOpen}
        spec={spec}
         result={currentResult}
        update={update}
        onToggle={() => setStylePanelOpen((open) => !open)}
        axisScope="time_capacity"
        buildSeriesPreview={buildSeriesPreview}
        timeCapacityStacked={cfg.stacked}
         yTitlePlaceholder={voltageChannelSelectionLabel(cfg.voltage_channels, currentResult?.voltage_channels)}
      />
    </Group>
  );
}

export const TimeCapacityPlotCard = memo(TimeCapacityPlotCardView);

/** Per-tab draft card with the same thumbnail pipeline as saved plots. */

