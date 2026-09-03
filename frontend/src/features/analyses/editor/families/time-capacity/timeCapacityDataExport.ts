import type { AnalysisSpec, PlotStyle, TimeCapacityResult, TimeCapacityTrace } from "../../../../../api.ts";
import type { DataColumn, PlotDataXRange } from "../../plotting/plotExport.ts";
import { isSeriesHidden } from "../../policies/analysisVisibility.ts";
import { voltageChannelLabel, type VoltageChannel } from "../../policies/voltageChannelPolicy.ts";
import { plotPalette } from "../../plotting/plotStyle.ts";
import { paletteColorAt, paletteOverflowMode } from "../../plotting/paletteDraft.ts";
import {
  resolveSeriesStyle,
  timeCapacitySeriesDescriptor,
  timeCapacityVoltageSeriesDescriptor,
} from "../../plotting/seriesStyling.ts";
import { timeCapacitySourceAt } from "./timeCapacityProvenance.ts";
import {
  timeCapacityTraceIsHidden,
  timeCapacityVisibilityKey,
  timeCapacityVisibleVoltageChannels,
} from "./timeCapacityVisibility.ts";

type ExportCurrentQuantity = "current_ma" | "current_density" | "c_rate";

export type TimeCapacityExportConfig = {
  view: string;
  x_axis: string;
  time_unit: string;
  display_mode: string;
  stacked: boolean;
  current_left: ExportCurrentQuantity;
  current_right: "none" | ExportCurrentQuantity;
  electrode_area_cm2: number | null;
  voltage_channel: VoltageChannel;
  voltage_channels: VoltageChannel[];
};

function xAxisTitle(config: TimeCapacityExportConfig): string {
  if (config.x_axis === "capacity_mah_g") return "Specific capacity (mAh/g)";
  if (config.x_axis === "capacity_mah_cm2") return "Areal capacity (mAh/cm²)";
  if (config.x_axis === "capacity_mah") return "Capacity (mAh)";
  return `Time (${config.time_unit})`;
}

function currentAxisLabel(quantity: ExportCurrentQuantity): string {
  if (quantity === "current_density") return "Current density (mA/cm2)";
  if (quantity === "c_rate") return "C-rate (C)";
  return "Current (mA)";
}

function selectedIndices(values: readonly number[], range: PlotDataXRange | null): number[] | null {
  if (!range) return null;
  const low = Math.min(range[0], range[1]);
  const high = Math.max(range[0], range[1]);
  const indices: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value) && value >= low && value <= high) indices.push(index);
  }
  return indices;
}

function take<T>(values: readonly T[], indices: readonly number[] | null): T[] {
  return indices === null ? (values as T[]) : indices.map((index) => values[index]);
}

function sourceColumns(
  name: string,
  trace: TimeCapacityTrace,
  indices: readonly number[] | null,
): DataColumn[] {
  const count = indices?.length ?? trace.cycle.length;
  const positions: (number | null)[] = new Array(count);
  const filenames: (string | null)[] = new Array(count);
  const hashes: (string | null)[] = new Array(count);
  for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
    const pointIndex = indices?.[outputIndex] ?? outputIndex;
    const source = timeCapacitySourceAt(trace, pointIndex);
    positions[outputIndex] = source.position;
    filenames[outputIndex] = source.filename;
    hashes[outputIndex] = source.hash;
  }
  return [
    { header: "Cell", values: Array(count).fill(name) },
    { header: "Global cycle", values: take(trace.cycle, indices) },
    { header: "Local cycle", values: take(trace.source_cycle ?? [], indices) },
    { header: "Source position", values: positions },
    { header: "Source file", values: filenames },
    { header: "Source hash", values: hashes },
  ];
}

function voltageValues(
  trace: TimeCapacityTrace,
  channel: VoltageChannel,
  fallback: VoltageChannel,
): (number | null)[] {
  const selected = trace.voltage_v_by_channel?.[channel];
  if (Array.isArray(selected)) return selected;
  return channel === fallback ? trace.voltage_v : [];
}

function currentValues(
  trace: TimeCapacityTrace,
  quantity: ExportCurrentQuantity,
  config: TimeCapacityExportConfig,
  indices: readonly number[] | null,
): (number | null)[] {
  const area = config.electrode_area_cm2 ?? trace.electrode_area_cm2 ?? null;
  const nominal = trace.nominal_capacity_mah ?? null;
  return take(trace.current_ma, indices).map((value) => {
    if (value === null || !Number.isFinite(value)) return null;
    if (quantity === "current_density") return area && area > 0 ? value / area : null;
    if (quantity === "c_rate") return nominal && nominal > 0 ? value / nominal : null;
    return value;
  });
}

function hasFinite(values: readonly (number | null)[]): boolean {
  return values.some((value) => value !== null && Number.isFinite(value));
}

/**
 * Build export columns directly from a full-resolution consecutive
 * voltage/current result. This avoids allocating Plotly hover, segment, and
 * marker objects for hundreds of thousands of points that are never rendered.
 * Unsupported layouts return null and retain the established trace path.
 */
export function consecutiveTimeCapacityExportColumns(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  config: TimeCapacityExportConfig,
  style: PlotStyle,
  range: PlotDataXRange | null,
): DataColumn[] | null {
  if (config.view !== "voltage_current" || config.display_mode !== "consecutive") return null;
  if (
    result.cell_traces.some((trace) =>
      (trace.source_descriptors ?? []).some(
        (source) => source.source_position > 1 && source.status !== "missing",
      ),
    )
  ) {
    // Preserve the established source-boundary marker export for multi-source
    // traces until that presentation-only column is retired explicitly.
    return null;
  }

  const columns: DataColumn[] = [];
  const palette = plotPalette(style);
  const paletteOverflow = paletteOverflowMode(style.palette_overflow_mode);
  const selectedChannels = config.voltage_channels;
  const multipleChannels = selectedChannels.length > 1;
  const xTitle = style.x_title ?? xAxisTitle(config);
  let colorIndex = 0;

  for (const trace of result.cell_traces) {
    if (timeCapacityTraceIsHidden(trace, spec)) continue;
    const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
    if (!multipleChannels && isSeriesHidden(spec, timeCapacityVisibilityKey(seriesKey))) continue;
    const color = style.custom_colors[seriesKey] ??
      paletteColorAt(palette, colorIndex++, paletteOverflow);
    const descriptor = timeCapacitySeriesDescriptor(trace);
    const resolved = resolveSeriesStyle(
      {
        color,
        lineWidth: style.line_width,
        lineDash: style.line_dash,
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
    if (resolved.hidden) continue;
    if (trace.display_x?.length !== trace.cycle.length) return null;
    const x = trace.display_x.map((value) => value ?? Number.NaN);
    const indices = selectedIndices(x, range);
    if (indices !== null && indices.length === 0) continue;
    const selectedX = take(x, indices);
    const visibleChannels = new Set(
      timeCapacityVisibleVoltageChannels(
        spec,
        seriesKey,
        selectedChannels,
        multipleChannels,
      ),
    );

    for (const channel of selectedChannels) {
      if (!visibleChannels.has(channel)) continue;
      const channelDescriptor = multipleChannels
        ? timeCapacityVoltageSeriesDescriptor(trace, channel)
        : descriptor;
      const channelKey = `${seriesKey}|${channel}`;
      const channelResolved = multipleChannels
        ? resolveSeriesStyle(
            { ...resolved, color: style.custom_colors[channelKey] ?? resolved.color },
            channelDescriptor,
            style.series_rules,
            style.series_overrides,
          )
        : resolved;
      if (channelResolved.hidden) continue;
      const y = take(voltageValues(trace, channel, config.voltage_channel), indices);
      if (!hasFinite(y)) continue;
      columns.push(
        ...sourceColumns(channelResolved.name, trace, indices),
        { header: `${channelResolved.name} | ${xTitle}`, values: selectedX },
        {
          header: `${channelResolved.name} | ${style.y_title ?? voltageChannelLabel(channel, result.voltage_channels)}`,
          values: y,
        },
      );
    }

    if (!config.stacked) continue;
    const left = config.current_left;
    const leftValues = currentValues(trace, left, config, indices);
    if (hasFinite(leftValues)) {
      const label = `${resolved.name} ${currentAxisLabel(left)}`;
      columns.push(
        { header: `${label} | ${xTitle}`, values: selectedX },
        { header: `${label} | ${currentAxisLabel(left)}`, values: leftValues },
      );
    }
    if (config.current_right !== "none") {
      const right = config.current_right;
      const rightValues = currentValues(trace, right, config, indices);
      if (hasFinite(rightValues)) {
        const label = `${resolved.name} ${currentAxisLabel(right)}`;
        columns.push(
          { header: `${label} | ${xTitle}`, values: selectedX },
          { header: `${label} | ${currentAxisLabel(right)}`, values: rightValues },
        );
      }
    }
  }
  return columns;
}
