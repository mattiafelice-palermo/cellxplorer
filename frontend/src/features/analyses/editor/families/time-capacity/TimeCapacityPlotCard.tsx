import {
  Accordion,
  Alert,
  Box,
  Center,
  Group,
  LoadingOverlay,
  Paper,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import PlotlyLib from "plotly.js-dist-min";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type AnalysisSpec,
  type BackgroundJob,
  type PlotExportFormat,
  type PlotStyle,
  type SeriesStyleOverride,
  type SeriesStyleRule,
  type TimeCapacityResult,
  type TimeCapacityTrace,
} from "../../../../../api";
import { DebouncedNumberInput, DebouncedTextInput } from "../../../../../components/DebouncedInputs";
import {
  shouldShowVoltageChannelSelector,
  plotlySafeText,
  timeCapacityExportOptions,
  timeCapacityExportMatchesRequest,
  timeCapacityResultMatchesVoltageChannel,
  voltageChannelAvailabilityPublication,
  voltageChannelAvailabilitySignature,
  voltageChannelDataIdentity,
  voltageChannelUnavailable,
  voltageChannelUnavailableMessage,
  voltageChannelLabel,
  voltageChannelSelectorOptions,
  type VoltageChannel,
} from "../../policies/voltageChannelPolicy";
import {
  timeCapacityCompatibilitySignature,
  timeCapacityPlotExportReady,
  timeCapacityPlaceholderData,
} from "../../policies/timeCapacityQueryPolicy";
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
} from "../../plotting/seriesStyling";
import { sourceExportColumns } from "../../plotting/sourceChainPlot";
import { ComputeProgress, PlotHeader } from "../../plotting/PlotHeader";
import { PlotStylePanel } from "../../plotting/PlotStylePanel";
import {
  newTimeCapacityProfileRequestId,
  timeCapacityPerformanceNow,
  timeCapacityPerformanceProfiler,
  timeCapacityProfileResultIsCurrent,
  timeCapacityResolvedCellCount,
  type TimeCapacityPerformanceContext,
} from "../../performance/timeCapacityPerformanceProfile";

export type TimeCapacityConfig = NonNullable<AnalysisSpec["computation"]["time_capacity"]>;
type TimeCapacityCurrentQuantity = TimeCapacityConfig["current_left"];
type TimeCapacityCurrentAxis = TimeCapacityConfig["current_right"];
export type TimeCapacityVoltageChannel = VoltageChannel;

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
};


export function timeCapacityConfig(spec: AnalysisSpec): TimeCapacityConfig {
  return { ...DEFAULT_TIME_CAPACITY, ...(spec.computation.time_capacity ?? {}) };
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

function timeCapacityX(trace: TimeCapacityTrace, spec: AnalysisSpec): { x: number[]; title: string } {
  const cfg = timeCapacityConfig(spec);
  let raw: number[];
  let title: string;
  if (cfg.x_axis === "capacity_mah_g") {
    raw = numeric(trace.capacity_mah_g);
    title = "Specific capacity (mAh/g)";
  } else if (cfg.x_axis === "capacity_mah_cm2") {
    raw = numeric(trace.capacity_mah_cm2 ?? []);
    title = "Areal capacity (mAh/cm²)";
  } else if (cfg.x_axis === "capacity_mah") {
    raw = numeric(trace.capacity_mah);
    title = "Capacity (mAh)";
  } else {
    const factor = cfg.time_unit === "h" ? 3600 : cfg.time_unit === "min" ? 60 : 1;
    raw = numeric(trace.time_s).map((value) => value / factor);
    title = `Time (${cfg.time_unit})`;
  }

  if (trace.display_x?.length === trace.cycle.length) {
    return { x: numeric(trace.display_x), title };
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
  sourcePosition: (number | null)[];
  sourceFilename: (string | null)[];
  sourceHash: (string | null)[];
  voltage: (number | null)[];
  current: (number | null)[];
};

function timeCapacitySegments(trace: TimeCapacityTrace, spec: AnalysisSpec): TimeCapacitySegment[] {
  const cfg = timeCapacityConfig(spec);
  const { x } = timeCapacityX(trace, spec);
  const segments: TimeCapacitySegment[] = [];
  let current: TimeCapacitySegment | null = null;

  const flush = () => {
    if (current && current.x.length > 0) segments.push(current);
    current = null;
  };

  for (let index = 0; index < x.length; index += 1) {
    const phase = trace.phase[index] ?? "rest";
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
        sourcePosition: [],
        sourceFilename: [],
        sourceHash: [],
        voltage: [],
        current: [],
      };
    }
    current.x.push(x[index]);
    current.cycle.push(trace.cycle[index] ?? null);
    current.sourceCycle.push(trace.source_cycle?.[index] ?? null);
    current.sourcePosition.push(trace.source_position?.[index] ?? null);
    current.sourceFilename.push(trace.source_filename?.[index] ?? null);
    current.sourceHash.push(trace.source_hash?.[index] ?? null);
    current.voltage.push(trace.voltage_v[index] ?? null);
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

function hasRightCurrentValues(result: TimeCapacityResult | undefined, spec: AnalysisSpec): boolean {
  if (!result) return false;
  const cfg = timeCapacityConfig(spec);
  if (!cfg.stacked || !cfg.current_right || cfg.current_right === "none") return false;
  return result.cell_traces.some((trace) => {
    if (trace.excluded) return false;
    return timeCapacitySegments(trace, spec).some((segment) =>
      hasFinitePoint(currentAxisValues(segment, trace, cfg.current_right, cfg))
    );
  });
}

export function timeCapacityTracesForResult(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  interactiveWebGl = false
): Plotly.Data[] {
  const style = currentPlotStyle(spec, "time_capacity");
  const palette = plotPalette(style);
  const cfg = timeCapacityConfig(spec);
  const selectedVoltageLabel = voltageChannelLabel(cfg.voltage_channel, result.voltage_channels);
  const selectedVoltageHoverLabel = plotlySafeText(
    selectedVoltageLabel.replace(/\s*\(V\)$/, "")
  );
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  const legendShown = new Set<string>();
  const legendRanks = seriesLegendRanks(
    timeCapacitySeriesDescriptors(result.cell_traces),
    style.series_order,
  );
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
    trace: TimeCapacityTrace,
    label: string,
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
      timeCapacitySeriesDescriptor(trace),
      style.series_rules,
      style.series_overrides,
    );

  if (cfg.view !== "voltage_current") {
    for (const trace of result.cell_traces) {
      if (trace.excluded) continue;
      const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
      const color = pick(seriesKey);
      const baseName = trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label;
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
          const resolved = resolveTrace(
            trace,
            baseName,
            color,
            phase === "discharge" ? "dash" : style.line_dash,
          );
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
            meta: `${phase}, cycle ${cycle ?? "?"}`,
            cellxplorer_export_columns: sourceExportColumns(
              baseName,
              cycles,
              sourceCycle,
              sourcePosition,
              sourceFilename,
              sourceHash,
            ),
            hovertemplate: "%{y:.5g}<br>%{x:.5g}<br>%{meta}<extra>%{fullData.name}</extra>",
          } as Plotly.Data);
        }
        start = end;
      }
    }
    return out;
  }

  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
    const color = pick(seriesKey);
    const baseLabel = trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label;
    const resolved = resolveTrace(trace, baseLabel, color, style.line_dash);
    if (resolved.hidden) continue;
    const name = resolved.name;
    const fullX = timeCapacityX(trace, spec).x;
    for (const segment of timeCapacitySegments(trace, spec)) {
      if (!hasFinitePoint(segment.voltage)) continue;
      const showlegend = !legendShown.has(seriesKey) && resolved.showInLegend;
      const segmentCustomdata = segment.x.map((_, index) => [
        segment.cycle[index] ?? "",
        segment.sourceCycle[index] ?? "",
        segment.sourcePosition[index] ?? "",
        shortSourceName(String(segment.sourceFilename[index] ?? "")),
      ]);
      legendShown.add(seriesKey);
      out.push({
        x: segment.x,
        y: segment.voltage,
        name,
         legendgroup: seriesKey,
         showlegend,
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
         customdata: segmentCustomdata,
         cellxplorer_export_columns: sourceExportColumns(
          name,
          segment.cycle,
          segment.sourceCycle,
          segment.sourcePosition,
           segment.sourceFilename,
           segment.sourceHash,
         ),
         meta: selectedVoltageHoverLabel,
         cellxplorer_export_axis_labels: {
           y: style.y_title ?? selectedVoltageLabel,
         },
         hovertemplate:
           "%{meta} %{y:.4f} V<br>%{x:.4f}<br>global cycle %{customdata[0]}<br>" +
           "local cycle %{customdata[1]}<br>%{customdata[3]} (source %{customdata[2]})" +
           "<extra>%{fullData.name}</extra>",
       } as Plotly.Data);
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
            showlegend: false,
            opacity: 0.85,
            meta: `cycle ${segment.cycle.find((cycle) => cycle !== null) ?? "?"}`,
            hovertemplate: `%{y:.4f}<br>%{x:.4f}<br>%{meta}<extra>${currentAxisLabel(left)}</extra>`,
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
              showlegend: false,
              opacity: 0.75,
              meta: `cycle ${segment.cycle.find((cycle) => cycle !== null) ?? "?"}`,
              hovertemplate: `%{y:.4f}<br>%{x:.4f}<br>%{meta}<extra>${currentAxisLabel(cfg.current_right)}</extra>`,
            } as Plotly.Data);
          }
        }
      }
    }
    const boundaryPoints = (trace.source_descriptors ?? [])
      .filter((descriptor) => descriptor.source_position > 1 && descriptor.status !== "missing")
      .map((descriptor) => {
        const index = fullX.findIndex(
          (value, candidate) =>
            trace.source_position?.[candidate] === descriptor.source_position &&
            Number.isFinite(value) &&
            Number.isFinite(trace.voltage_v[candidate] ?? NaN) &&
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
        y: boundaryPoints.map(({ index }) => trace.voltage_v[index]),
        name: "Source boundary",
        type: traceType,
        mode: "markers",
        marker: {
          color,
          size: Math.max(style.marker_size + 2, 7),
          symbol: "diamond-open",
          line: { color: style.paper_bgcolor, width: 1.2 },
        },
        showlegend: false,
        customdata: boundaryPoints.map(({ index, descriptor }) => [
          trace.cycle[index] ?? "",
          trace.source_cycle?.[index] ?? "",
          descriptor.source_position,
          descriptor.filename,
        ]),
        hovertemplate:
          "source boundary<br>global cycle %{customdata[0]}<br>local cycle %{customdata[1]}<br>" +
          "%{customdata[3]} (source %{customdata[2]})<extra></extra>",
      } as Plotly.Data);
    }
  }
  return out;
}

export function timeCapacityLayout(
  result: TimeCapacityResult | undefined,
  spec: AnalysisSpec,
  traces: Plotly.Data[] = []
): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "time_capacity");
  const cfg = timeCapacityConfig(spec);
  const xTitle = result?.cell_traces[0] ? timeCapacityX(result.cell_traces[0], spec).title : "Time (min)";
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
      hoverdistance: 20,
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
    hoverdistance: 20,
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
    // infinite-relayout trap — skip zoom persistence in stacked mode. In
    // flat mode, key the revision to the x-axis semantics so changing the
    // x quantity/unit/display resets the view instead of keeping stale ranges.
    ...(cfg.stacked
      ? {}
      : {
          // A refreshed/cached result must not reset a user's local zoom.
          // Only a change in X semantics should start a new viewport.
          uirevision: `${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`,
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
        text: plotlySafeText(
          style.y_title ?? voltageChannelLabel(cfg.voltage_channel, result?.voltage_channels)
        ),
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
  const cyclesText = (cfg.cycles ?? []).join(", ");
  // Only offer electrode potentials that actually have data for the current
  // selection — never a disabled/greyed entry that merely advertises a
  // feature no selected source has (spec 040.4). An ordinary two-electrode
  // selection therefore renders no extra option and this control does not
  // appear at all, matching pre-040.4 behavior exactly. The decision itself
  // is a pure, independently-tested function (voltageChannelPolicy.ts) —
  // see frontend/tests/voltageChannelPolicy.test.ts — rather than logic
  // that lives only in this component.
  const voltageChannelOptions = voltageChannelSelectorOptions(cfg.voltage_channel, voltageChannels);
  const selectedVoltageLabel = voltageChannelLabel(cfg.voltage_channel, voltageChannels);
  const showVoltageChannelSelector = shouldShowVoltageChannelSelector(voltageChannelOptions);
  const needsArea = cfg.current_left === "current_density" || cfg.current_right === "current_density";
  const updateTime = (fn: (cfg: TimeCapacityConfig) => void) =>
    update((s) => {
      const next = {
        ...DEFAULT_TIME_CAPACITY,
        ...(s.computation.time_capacity ?? {}),
      };
      fn(next);
      s.computation.time_capacity = next;
    });

  const parseCycles = (value: string) =>
    value
      .split(/[,\s]+/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

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
                    const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
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
                <Select
                  label="Voltage quantity"
                  data={voltageChannelOptions}
                  value={cfg.voltage_channel}
                  title={selectedVoltageLabel}
                  styles={{ input: { textOverflow: "ellipsis" } }}
                  renderOption={({ option }) => (
                    <Tooltip label={option.label} withArrow>
                      <Text component="span" size="sm" truncate title={option.label}>
                        {option.label}
                      </Text>
                    </Tooltip>
                  )}
                  onChange={(value) =>
                    value &&
                    updateTime(
                      (next) => void (next.voltage_channel = value as TimeCapacityVoltageChannel)
                    )
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
                    const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
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
                      const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
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
                    const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
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
              Cycles
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Group grow>
                <DebouncedNumberInput
                  label="From"
                  min={1}
                  value={cfg.cycle_start}
                  onCommit={(value) => updateTime((next) => void (next.cycle_start = value))}
                />
                <DebouncedNumberInput
                  label="To"
                  min={1}
                  value={cfg.cycle_end}
                  onCommit={(value) => updateTime((next) => void (next.cycle_end = value))}
                />
              </Group>
              <DebouncedTextInput
                label="Specific cycles"
                placeholder="e.g. 1, 2, 5, 10"
                value={cyclesText}
                onCommit={(value) => updateTime((next) => void (next.cycles = parseCycles(value)))}
              />
              <DebouncedNumberInput
                label="Max points per cell"
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
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const [computeToken, setComputeToken] = useState<string | null>(null);
  const [dataExporting, setDataExporting] = useState(false);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const cfg = timeCapacityConfig(spec);
  // Keep cache identity stable across restarts, window sizes and style-panel
  // changes. Point density is controlled solely by max_points_per_cell.
  const viewportWidth = 1200;
  // Keep this separate from dataSignature. Range and point-density changes
  // may retain the old compact result while the replacement is fetched, but
  // a semantic/display change must never relabel that result temporarily.
  const compatibilitySignature = timeCapacityCompatibilitySignature(
    spec,
    cfg,
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
      JSON.stringify({
        selection: spec.selection,
        protocol_segments: spec.protocol_segments ?? [],
        protocol_filter: spec.computation.protocol_filter,
        hidden_protocol_segment_ids: spec.presentation.hidden_protocol_segment_ids ?? [],
        cycles: cfg.cycles,
        start: cfg.cycle_start,
        end: cfg.cycle_end,
        points: cfg.max_points_per_cell,
        xAxis: cfg.x_axis,
        timeUnit: cfg.time_unit,
        displayMode: cfg.display_mode,
        electrodeArea: cfg.electrode_area_cm2,
        voltageChannel: cfg.voltage_channel,
        viewportWidth,
        derivative: cfg.view === "voltage_current" ? null : {
          view: cfg.view,
          phase: cfg.derivative_phase,
          specific: cfg.derivative_specific,
          absoluteDischarge: cfg.derivative_absolute_discharge,
          smoothing: cfg.smoothing_window,
        },
      }),
    [
      spec.selection,
      spec.protocol_segments,
      spec.computation.protocol_filter,
      spec.presentation.hidden_protocol_segment_ids,
      cfg.cycles,
      cfg.cycle_start,
      cfg.cycle_end,
      cfg.max_points_per_cell,
      cfg.x_axis,
      cfg.time_unit,
      cfg.display_mode,
      cfg.electrode_area_cm2,
      cfg.voltage_channel,
      cfg.view,
      cfg.derivative_phase,
      cfg.derivative_specific,
      cfg.derivative_absolute_discharge,
      cfg.smoothing_window,
      viewportWidth,
    ]
  );
  const dataSignatureRef = useRef(dataSignature);
  // Keep the latest request identity synchronous with render. A passive
  // effect leaves a narrow window in which a delayed full-resolution export
  // can resolve after a channel switch but before this ref catches up.
  dataSignatureRef.current = dataSignature;
  const voltageChannelRef = useRef(cfg.voltage_channel);
  voltageChannelRef.current = cfg.voltage_channel;
  const profileEnabled = timeCapacityPerformanceProfiler.isEnabled();
  const profileContext = useMemo<TimeCapacityPerformanceContext>(
    () => ({
      analysis_id: analysisId,
      selection_count: spec.selection.entries.length,
      cycle_start: cfg.cycle_start,
      cycle_end: cfg.cycle_end,
      explicit_cycle_count: cfg.cycles.length,
      view: cfg.view,
      x_axis: cfg.x_axis,
      display_mode: cfg.display_mode,
      max_points_per_cell: cfg.max_points_per_cell,
      compact: true,
      precision: "standard",
    }),
    [
      analysisId,
      cfg.cycle_end,
      cfg.cycle_start,
      cfg.cycles.length,
      cfg.display_mode,
      cfg.max_points_per_cell,
      cfg.view,
      cfg.x_axis,
      spec.selection.entries.length,
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
      const token = newComputeToken();
      setComputeToken(token);
      if (profileRequest) {
        timeCapacityPerformanceProfiler.begin(profileRequest.requestId, profileContext);
      }
      const httpStarted = profileRequest ? timeCapacityPerformanceNow() : 0;
      try {
        const result = await post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
          spec,
          job_token: token,
          viewport_width: viewportWidth,
          precision: "standard",
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
        window.setTimeout(
          () => setComputeToken((current) => (current === token ? null : current)),
          300
        );
      }
    },
    placeholderData: (previous, previousQuery) =>
      timeCapacityPlaceholderData(
        previous,
        previousQuery?.queryKey,
        analysisId,
        compatibilitySignature,
      ),
    enabled: spec.selection.entries.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
  });
  useLayoutEffect(() => {
    if (!profileRequest || spec.selection.entries.length === 0) return;
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
    spec.selection.entries.length,
    timeResult.data,
    timeResult.isFetching,
    timeResult.isPlaceholderData,
  ]);
  const currentResult = timeCapacityResultMatchesVoltageChannel(
    timeResult.data,
    cfg.voltage_channel
  )
    ? timeResult.data
    : undefined;
  const selectedVoltageUnavailable = voltageChannelUnavailable(
    cfg.voltage_channel,
    currentResult?.voltage_channels
  );
  const voltageDataIdentity = voltageChannelDataIdentity(currentResult);
  const lastVoltageDataIdentityRef = useRef<string | undefined>(undefined);
  const effectiveVoltageDataIdentity =
    voltageDataIdentity ?? lastVoltageDataIdentityRef.current;
  const voltageCapabilitySignature = useMemo(
    () => voltageChannelAvailabilitySignature(spec, effectiveVoltageDataIdentity),
    [effectiveVoltageDataIdentity, spec.selection]
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
    timeResult.isLoading || (timeResult.isFetching && !currentResult)
  );
  const loadingWithoutResult = timeResult.isLoading || (timeResult.isFetching && !currentResult);
  useEffect(() => {
    onReadyChange?.(!timeResult.isLoading && !timeResult.isFetching);
  }, [onReadyChange, timeResult.isFetching, timeResult.isLoading]);
  // Rebuild traces/layout only for fields they actually read (see cycles card).
  const viewSignature = useMemo(
    () =>
      JSON.stringify({
        cfg,
        legend: spec.presentation.legend,
        style: currentPlotStyle(spec, "time_capacity"),
      }),
    [spec]
  );
  const exportTraces = useMemo(
    () =>
      currentResult && !selectedVoltageUnavailable
        ? timeCapacityTracesForResult(currentResult, spec)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentResult, selectedVoltageUnavailable, viewSignature]
  );
  const plotExportReady = timeCapacityPlotExportReady(
    timeResult.isPlaceholderData,
    Boolean(currentResult),
    selectedVoltageUnavailable,
    exportTraces.length > 0,
  );
  const traces = useMemo(() => interactivePlotTraces(exportTraces), [exportTraces]);
  const zoomSignature = `${analysisId}|${cfg.view}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`;
  const zoom = useZoomMemory(zoomSignature, cfg.view !== "voltage_current" || !cfg.stacked);
  const layout = useMemo(
    () => zoom.apply(timeCapacityLayout(currentResult, spec, exportTraces)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentResult, viewSignature, exportTraces]
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
  const updatePlotStyle = (fn: (style: PlotStyle) => void) => {
    update((s) => writeScopedStyle(s, "time_capacity", fn));
  };
  const handlePlotRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    zoom.onRelayout(event);
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
  const getExportPreview = async (): Promise<string | null> => {
    if (!plotExportReady || !plotDivRef.current || exportTraces.length === 0) return null;
    const plan = resolveExportPlan(style, currentViewSize(), layout);
    const toImage = (
      PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
    ).toImage;
    const previewTraces = style.export_format === "png" ? traces : exportTraces;
    return toImage(exportFigure(previewTraces, layout, style, plotName, plan), {
      format: "png",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      scale: Math.min(1, 420 / plan.layoutWidth),
    });
  };

  const handleDataExport = async (baseName: string) => {
    if (!currentResult || selectedVoltageUnavailable || exportTraces.length === 0 || dataExporting) return;
    const requestedSignature = dataSignature;
    const requestedVoltageChannel = cfg.voltage_channel;
    const requestedSourceDataIdentity = voltageChannelDataIdentity(currentResult);
    setDataExporting(true);
    try {
      const fullResult = await post<TimeCapacityResult>(
        `/api/analyses/${analysisId}/time-capacity`,
        {
          spec,
          ...timeCapacityExportOptions(viewportWidth),
        }
      );
      if (
        !timeCapacityExportMatchesRequest(
          dataSignatureRef.current,
          requestedSignature,
          voltageChannelRef.current,
          requestedVoltageChannel,
          fullResult,
          requestedSourceDataIdentity
        )
      ) {
        throw new Error("The plot changed while the full-resolution export was prepared. Please try again.");
      }
      if (voltageChannelUnavailable(requestedVoltageChannel, fullResult.voltage_channels)) {
        throw new Error(voltageChannelUnavailableMessage(requestedVoltageChannel));
      }
      const fullTraces = timeCapacityTracesForResult(fullResult, spec);
      if (fullTraces.length === 0) {
        throw new Error("No data is available for the selected voltage quantity.");
      }
      await downloadDataExport(tracesToColumns(fullTraces, layout), style, baseName);
    } catch (e) {
      notifications.show({ message: e instanceof Error ? e.message : "Data export failed.", color: "red" });
    } finally {
      setDataExporting(false);
    }
  };

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    if (!plotExportReady || !plotDivRef.current || !currentResult || selectedVoltageUnavailable) return;
    try {
      const plan = resolveExportPlan(style, currentViewSize(), layout);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(baseName);
      const outputTraces = format === "png" ? traces : exportTraces;
      const figure = exportFigure(outputTraces, layout, style, plotName, plan);
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
            style.export_aspect_ratio
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
        ...spec,
        presentation: {
          ...spec.presentation,
          plot_styles: {
            ...(spec.presentation.plot_styles ?? {}),
            time_capacity: {
              ...currentPlotStyle(spec, "time_capacity"),
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
     [currentResult, selectedVoltageUnavailable, spec],
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
               ? `${voltageChannelLabel(cfg.voltage_channel, currentResult?.voltage_channels)} and current`
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
          getExportPreview={getExportPreview}
          style={style}
          updateStyle={updatePlotStyle}
          viewSize={plotSize}
          layout={layout}
          canExport={Boolean(currentResult) && !selectedVoltageUnavailable && !dataExporting && exportTraces.length > 0}
          canPlotExport={plotExportReady && !dataExporting}
          edited={edited}
          onNewPlot={onNewPlot}
          newPlotEnabled={newPlotEnabled}
          onUpdatePlot={onUpdatePlot}
          updatePlotEnabled={updatePlotEnabled}
          updatePlotLabel={updatePlotLabel}
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
               {selectedVoltageUnavailable
                 ? voltageChannelUnavailableMessage(cfg.voltage_channel)
                 : "Add cells or replicates, then choose cycles to plot raw voltage and current."}
             </Text>
          </Center>
        ) : (
          <Box
            ref={containerRef}
            onPointerDownCapture={zoom.armOnPointerDown}
            style={{
              width: "100%",
              minWidth: 0,
              opacity: timeResult.isFetching ? 0.42 : 1,
              transition: "opacity 160ms ease",
            }}
          >
            <Plot
              // remount at the stacked↔flat boundary: diffing a matched-axes
              // subplot layout into a single-axis one is Plotly's slowest
              // path; a clean newPlot is far cheaper and predictable
              key={cfg.stacked ? "tc-stacked" : "tc-flat"}
              data={traces}
              layout={layout}
              config={{
                displaylogo: false,
                edits: { legendPosition: style.legend_mode !== "outside" },
              }}
              style={{ width: "100%" }}
              onRelayout={handlePlotRelayout}
              onInitialized={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                completeTimeCapacityProfile();
              }}
              onUpdate={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                completeTimeCapacityProfile();
              }}
            />
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
         yTitlePlaceholder={voltageChannelLabel(cfg.voltage_channel, currentResult?.voltage_channels)}
      />
    </Group>
  );
}

export const TimeCapacityPlotCard = memo(TimeCapacityPlotCardView);

/** Per-tab draft card with the same thumbnail pipeline as saved plots. */

