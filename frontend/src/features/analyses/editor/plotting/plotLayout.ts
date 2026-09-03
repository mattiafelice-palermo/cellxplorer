import type { AnalysisSpec, PlotStyle } from "../../../../api";
import { APP_BRANDING } from "../../../../appChannel.ts";
import { axisLayout, numericTraceExtent } from "./plotAxisLayout.ts";

const HOVER_LABEL_CHANNEL_COLORS = {
  stable: "#e6fcf5",
  beta: "#eef7ff",
  alpha: "#f3f0ff",
} as const;
const HOVER_LABEL_TEXT_COLOR = "#343a40";
const HOVER_LABEL_BORDER_COLOR = "#495057";

export function plotAxisStyle(
  style: PlotStyle,
  opts: { zeroLine?: boolean; axis?: PlotStyle["x_axis"] } = {}
): Partial<Plotly.LayoutAxis> {
  const zeroLine = opts.zeroLine ?? false;
  const axis = opts.axis;
  return {
    showgrid: style.show_grid,
    gridcolor: "#edf2f7",
    zeroline: zeroLine && style.show_zero_line,
    zerolinecolor: "#adb5bd",
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    // Tick marks + tick-label font, so the style panel's tick and font
    // controls reach these simpler tabs too (not just the cycle tab).
    ticks: style.tick_marks === "none" ? "" : style.tick_marks,
    ticklen: style.tick_length,
    tickwidth: style.tick_width,
    tickcolor: style.frame_color,
    tickfont: { size: style.tick_font_size },
    ...(axis ? { ticklabelstandoff: axis.tick_label_standoff } : {}),
  };
}

/**
 * Layout-level style shared by the simpler plot tabs: base tick font, legend
 * visibility + font, and backgrounds. Axis titles still get their own font
 * (`axisTitleFont`) at the call site since they carry the title text too.
 */
export function plotLayoutStyle(
  style: PlotStyle,
  spec: AnalysisSpec
): Partial<Plotly.Layout> {
  return {
    font: { size: style.tick_font_size },
    showlegend: spec.presentation.legend,
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
  };
}

/** The font Plotly wants on an axis `title` object. */
export function axisTitleFont(style: PlotStyle) {
  return { size: style.axis_title_size };
}

// Shared tick-mark + tick-label styling for all axes.
export function tickLayout(style: PlotStyle, axis: PlotStyle["x_axis"]) {
  return {
    ticks: style.tick_marks === "none" ? ("" as const) : style.tick_marks,
    ticklen: style.tick_length,
    tickwidth: style.tick_width,
    tickcolor: style.frame_color,
    tickfont: { size: style.tick_font_size },
    ticklabelstandoff: axis.tick_label_standoff,
  };
}

export function axisGapDelta(axis: PlotStyle["x_axis"]): number {
  return axis.title_standoff + axis.tick_label_standoff - 18;
}

const INSIDE_LEGEND_CHROME = {
  bgcolor: "rgba(255, 255, 255, 0.82)",
  bordercolor: "#dee2e6",
  borderwidth: 1,
} as const;

export function legendLayout(style: PlotStyle): Partial<Plotly.Layout["legend"]> {
  const horizontalSizing =
    style.legend_entry_width > 0
      ? { entrywidth: style.legend_entry_width, entrywidthmode: "pixels" as const }
      : {};
  if (style.legend_mode === "custom" || style.legend_inside_position === "custom") {
    return {
      orientation: style.legend_orientation,
      x: style.legend_custom_x,
      y: style.legend_custom_y,
      xanchor: "center",
      yanchor: "middle",
      ...(style.legend_orientation === "h" ? horizontalSizing : {}),
      ...INSIDE_LEGEND_CHROME,
    };
  }
  if (style.legend_mode === "inside") {
    const position = style.legend_inside_position ?? "bottom_center";
    const [vertical, horizontal] = position === "center"
      ? ["center", "center"]
      : position.split("_");
    const x = horizontal === "left" ? 0.01 : horizontal === "right" ? 0.99 : 0.5;
    const y = vertical === "top" ? 0.99 : vertical === "bottom" ? 0.01 : 0.5;
    const xanchor = horizontal === "left" ? "left" : horizontal === "right" ? "right" : "center";
    const yanchor = vertical === "top" ? "top" : vertical === "bottom" ? "bottom" : "middle";
    const orientation = horizontal === "center" ? "h" : "v";
    return {
      orientation,
      x,
      xanchor,
      y,
      yanchor,
      ...(orientation === "h" ? horizontalSizing : {}),
      ...INSIDE_LEGEND_CHROME,
    };
  }
  // outside
  switch (style.legend_side) {
    case "right":
      return { orientation: "v", x: 1.02, xanchor: "left", y: 1, yanchor: "top" };
    case "left":
      return { orientation: "v", x: -0.08, xanchor: "right", y: 1, yanchor: "top" };
    case "top":
      return { orientation: "h", x: 0, y: 1.13, ...horizontalSizing };
    default: // bottom
      return { orientation: "h", x: 0.5, xanchor: "center", y: -0.22, ...horizontalSizing };
  }
}

// Extra plot margins each legend placement needs so it never overlaps axes.
// A hidden legend reserves nothing â€” the plot reclaims the full area.
export function legendMargins(style: PlotStyle, visible: boolean): { l: number; r: number; t: number; b: number } {
  if (!visible || style.legend_mode !== "outside") return { l: 0, r: 0, t: 0, b: 0 };
  switch (style.legend_side) {
    case "right":
      return { l: 0, r: 116, t: 0, b: 0 };
    case "left":
      return { l: 150, r: 0, t: 0, b: 0 };
    case "top":
      return { l: 0, r: 0, t: 36, b: 0 };
    default: // bottom
      return { l: 0, r: 0, t: 0, b: 54 };
  }
}

export function draggedLegendPoint(event: Readonly<Plotly.PlotRelayoutEvent>): { x: number; y: number } | null {
  const values = event as unknown as Record<string, unknown>;
  const x = typeof values["legend.x"] === "number" ? values["legend.x"] : null;
  const y = typeof values["legend.y"] === "number" ? values["legend.y"] : null;
  if (x === null || y === null) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

export function hoverLabelLayout(style: PlotStyle) {
  const channelColors = HOVER_LABEL_CHANNEL_COLORS[APP_BRANDING.channel];
  return {
    bgcolor: channelColors,
    bordercolor: HOVER_LABEL_BORDER_COLOR,
    borderwidth: 1,
    font: {
      size: Math.max(10, style.tick_font_size - 1),
      family: "inherit",
      color: HOVER_LABEL_TEXT_COLOR,
      weight: 400,
    },
    align: "left" as const,
    // Plotly cannot wrap hover text. Keep the fallback name lane bounded for
    // plot families that still use `<extra>` and use compact static names in
    // Time/Capacity templates themselves.
    namelength: 20,
  };
}

export interface SimpleCartesianLayoutOptions {
  traces: Plotly.Data[];
  xTitle: string;
  yTitle: string;
  /** Extra X-axis settings such as a category axis or a reference range mode. */
  xAxis?: Partial<Plotly.LayoutAxis>;
  /** Extra Y-axis settings such as a bar range mode or formatted tick labels. */
  yAxis?: Partial<Plotly.LayoutAxis>;
  /** Trace axis names to include when deriving the observed X extent. */
  xAxisNames?: string[];
  /** Trace axis names to include when deriving the observed Y extent. */
  yAxisNames?: string[];
  /** Numeric range/tick controls are not meaningful for a categorical X axis. */
  xAxisNumeric?: boolean;
  /** Base margins before legend and title/label standoffs are added. */
  baseMargin?: { l: number; r: number; t: number; b: number };
  /** Additional layout fields owned by the family, for example bar settings or shapes. */
  extra?: Partial<Plotly.Layout>;
}

/**
 * Complete layout for the simple single-X/single-Y analysis families.
 *
 * Keeping this in one helper prevents the smaller plot cards from drifting
 * away from the shared axis, legend, and margin policy used by cycles and
 * time/capacity. The family still supplies its labels and any view-specific
 * axis fields, while all persisted style controls are applied here.
 */
export function simpleCartesianLayout(
  style: PlotStyle,
  spec: AnalysisSpec,
  options: SimpleCartesianLayoutOptions,
): Partial<Plotly.Layout> {
  const {
    traces,
    xTitle,
    yTitle,
    xAxis = {},
    yAxis = {},
    xAxisNames = ["x"],
    yAxisNames = ["y"],
    xAxisNumeric = true,
    baseMargin = { l: 72, r: 20, t: 12, b: 56 },
    extra = {},
  } = options;
  const legend = legendMargins(style, spec.presentation.legend);
  const xRange = xAxisNumeric
    ? numericTraceExtent(traces, "x", xAxisNames)
    : undefined;
  const yRange = numericTraceExtent(traces, "y", yAxisNames);
  const leftGap = axisGapDelta(style.y_axis);
  const bottomGap = axisGapDelta(style.x_axis);

  return {
    ...plotLayoutStyle(style, spec),
    ...extra,
    margin: {
      l: baseMargin.l + legend.l + leftGap,
      r: Math.max(baseMargin.r, legend.r ? legend.r + 24 : 0),
      t: baseMargin.t + legend.t,
      b: baseMargin.b + legend.b + bottomGap,
    },
    xaxis: {
      ...plotAxisStyle(style, { axis: style.x_axis }),
      ...xAxis,
      title: {
        text: style.x_title ?? xTitle,
        font: axisTitleFont(style),
        standoff: style.x_axis.title_standoff,
      },
      ...(xAxisNumeric ? axisLayout(style.x_axis, xRange) : {}),
    },
    yaxis: {
      ...plotAxisStyle(style, { zeroLine: true, axis: style.y_axis }),
      ...yAxis,
      title: {
        text: style.y_title ?? yTitle,
        font: axisTitleFont(style),
        standoff: style.y_axis.title_standoff,
      },
      ...axisLayout(style.y_axis, yRange),
    },
    showlegend: spec.presentation.legend,
    legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
    hovermode: "closest",
  };
}
