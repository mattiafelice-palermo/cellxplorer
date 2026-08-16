import type { PlotAxisStyle, PlotStyle } from "../../../../api";

function preserveAxisFields(
  applied: PlotAxisStyle,
  current: PlotAxisStyle,
  applyRanges: boolean,
  applyTicks: boolean,
): PlotAxisStyle {
  return {
    ...applied,
    ...(applyRanges
      ? {}
      : {
          mode: current.mode,
          min: current.min,
          max: current.max,
        }),
    ...(applyTicks
      ? {}
      : {
          tick_mode: current.tick_mode,
          dtick: current.dtick,
          tick_count: current.tick_count,
        }),
  };
}

export function applyPlotStylePreset(
  current: PlotStyle,
  preset: PlotStyle,
  applyRanges: boolean,
  applyTicks: boolean,
): PlotStyle {
  return {
    ...preset,
    custom_colors: { ...preset.custom_colors },
    ce_custom_colors: { ...preset.ce_custom_colors },
    palette_colors: [...(preset.palette_colors ?? [])],
    ce_palette_colors: [...(preset.ce_palette_colors ?? [])],
    // Series ordering is presentation state tied to the current plot, not a
    // palette/style preset. Applying a preset must not erase it.
    series_order: current.series_order
      ? [...current.series_order]
      : preset.series_order
        ? [...preset.series_order]
        : undefined,
    axis_scopes: { ...(preset.axis_scopes ?? {}) },
    x_axis: preserveAxisFields(preset.x_axis, current.x_axis, applyRanges, applyTicks),
    y_axis: preserveAxisFields(preset.y_axis, current.y_axis, applyRanges, applyTicks),
    y2_axis: preserveAxisFields(preset.y2_axis, current.y2_axis, applyRanges, applyTicks),
  };
}
