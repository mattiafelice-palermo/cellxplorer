/**
 * The plot-style model: defaults, palettes, normalization, and per-tab scoping.
 *
 * Pure by design — no React, no Plotly, no network. This is shared by the
 * settings panel, the series appearance editor, and every trace builder, so it
 * lives outside `AnalysisPage.tsx` where it can be read and unit tested without
 * dragging in the whole analysis page.
 *
 * Extracted verbatim from `AnalysisPage.tsx`; behaviour is unchanged.
 */
import type { AnalysisSpec, AnalysisTabKey, PlotAxisScope, PlotStyle } from "./api";

export const PALETTE = [
  "#12b886",
  "#2E86AB",
  "#E63946",
  "#43AA8B",
  "#F4A261",
  "#7B2D8E",
  "#588157",
  "#BC4749",
  "#3A0CA3",
  "#FB8500",
];

export const PLOT_PALETTES: Record<PlotStyle["palette"], string[]> = {
  app: PALETTE,
  pastel: ["#6ee7b7", "#93c5fd", "#f9a8d4", "#fde68a", "#c4b5fd", "#fdba74", "#99f6e4"],
  publication: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000"],
  presentation: ["#12b886", "#2563eb", "#f97316", "#e11d48", "#7c3aed", "#0f766e", "#ca8a04"],
  okabe_ito: ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"],
  tableau: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
  blues: ["#08306b", "#2171b5", "#4292c6", "#6baed6", "#9ecae1", "#c6dbef"],
  viridis: ["#440154", "#414487", "#2A788E", "#22A884", "#7AD151", "#FDE725"],
  monochrome: ["#111827", "#4b5563", "#6b7280", "#9ca3af", "#d1d5db"],
  custom: PALETTE,
};

export const PALETTE_OPTIONS: { value: PlotStyle["palette"]; label: string }[] = [
  { value: "app", label: "CellXplorer" },
  { value: "pastel", label: "Pastel" },
  { value: "publication", label: "Publication" },
  { value: "presentation", label: "Presentation" },
  { value: "okabe_ito", label: "Okabe-Ito" },
  { value: "tableau", label: "Tableau" },
  { value: "blues", label: "Blues" },
  { value: "viridis", label: "Viridis" },
  { value: "monochrome", label: "Monochrome" },
  { value: "custom", label: "Custom" },
];

const DEFAULT_AXIS: PlotStyle["x_axis"] = {
  mode: "auto",
  min: null,
  max: null,
  tick_mode: "auto",
  dtick: null,
  tick_count: null,
  title_standoff: 14,
  tick_label_standoff: 4,
};

export const DEFAULT_PLOT_STYLE: PlotStyle = {
  palette: "app",
  palette_id: null,
  palette_colors: [],
  custom_colors: {},
  line_width: 2.5,
  line_dash: "solid",
  marker_mode: "none",
  marker_size: 5,
  marker_symbol: "circle",
  marker_open: false,
  individual_opacity: 0.35,
  band_opacity: 0.18,
  low_n_color: "#868e96",
  low_n_marker_symbol: "x",
  low_n_marker_size: 8,
  show_grid: true,
  show_zero_line: false,
  show_frame: false,
  plot_bgcolor: "#ffffff",
  paper_bgcolor: "#ffffff",
  frame_color: "#ced4da",
  frame_width: 1,
  x_title: null,
  y_title: null,
  y2_title: null,
  x_axis: { ...DEFAULT_AXIS },
  y_axis: { ...DEFAULT_AXIS },
  y2_axis: { ...DEFAULT_AXIS },
  axis_scopes: {},
  tick_font_size: 12,
  axis_title_size: 14,
  legend_font_size: 12,
  tick_marks: "none",
  tick_length: 5,
  tick_width: 1,
  ce_custom_colors: {},
  ce_palette_mode: "match",
  ce_palette_id: null,
  ce_palette_colors: [],
  ce_single_color: "#495057",
  ce_line_width: 1.5,
  ce_line_dash: "dot",
  ce_marker_mode: "none",
  ce_marker_size: 5,
  ce_marker_symbol: "circle",
  ce_marker_open: false,
  ce_opacity: 0.7,
  legend_position: "bottom",
  legend_mode: "outside",
  legend_side: "bottom",
  legend_inside_position: "bottom_center",
  legend_orientation: "h",
  legend_entry_width: 0,
  legend_custom_x: 0.5,
  legend_custom_y: 0.5,
  data_export_format: "csv",
  data_precision: "standard",
  data_decimal_separator: "point",
  data_delimiter: "comma",
  export_settings_version: 4,
  export_format: "png",
  export_aspect_ratio: "view",
  export_ppi: 300,
  export_width: 2000,
  export_height: 1250,
  export_scale: 1,
  export_include_title: false,
};

export function normalizePlotStyle(style: Partial<PlotStyle> | undefined): PlotStyle {
  const legacyExportSettings = style?.export_settings_version !== DEFAULT_PLOT_STYLE.export_settings_version;
  const xAxis = { ...DEFAULT_PLOT_STYLE.x_axis, ...(style?.x_axis ?? {}) };
  const yAxis = { ...DEFAULT_PLOT_STYLE.y_axis, ...(style?.y_axis ?? {}) };
  const y2Axis = { ...DEFAULT_PLOT_STYLE.y2_axis, ...(style?.y2_axis ?? {}) };
  const axisScopes: PlotStyle["axis_scopes"] = {};
  for (const [scope, scoped] of Object.entries(style?.axis_scopes ?? {})) {
    axisScopes[scope as AnalysisTabKey] = {
      ...scoped,
      x_axis: scoped?.x_axis ? { ...DEFAULT_PLOT_STYLE.x_axis, ...scoped.x_axis } : undefined,
      y_axis: scoped?.y_axis ? { ...DEFAULT_PLOT_STYLE.y_axis, ...scoped.y_axis } : undefined,
      y2_axis: scoped?.y2_axis ? { ...DEFAULT_PLOT_STYLE.y2_axis, ...scoped.y2_axis } : undefined,
    };
  }
  const normalized = {
    ...DEFAULT_PLOT_STYLE,
    ...(style ?? {}),
    custom_colors: { ...(style?.custom_colors ?? {}) },
    ce_custom_colors: { ...(style?.ce_custom_colors ?? {}) },
    palette_colors: [...(style?.palette_colors ?? [])],
    ce_palette_colors: [...(style?.ce_palette_colors ?? [])],
    x_axis: xAxis,
    y_axis: yAxis,
    y2_axis: y2Axis,
    axis_scopes: axisScopes,
  };
  // migrate the legacy single-field legend position to mode + side
  if (style && !style.legend_mode && style.legend_position) {
    if (style.legend_position === "inside") {
      normalized.legend_mode = "inside";
      normalized.legend_side = "left";
    } else {
      normalized.legend_mode = "outside";
      normalized.legend_side = style.legend_position;
    }
  }
  if (style?.legend_mode === "custom") {
    normalized.legend_mode = "inside";
    normalized.legend_inside_position = "custom";
  } else if (style?.legend_mode === "inside" && !style.legend_inside_position) {
    normalized.legend_inside_position =
      style.legend_side === "top"
        ? "top_center"
        : style.legend_side === "left"
          ? "center_left"
          : style.legend_side === "right"
            ? "center_right"
            : "bottom_center";
  }
  if (legacyExportSettings) {
    normalized.export_format = DEFAULT_PLOT_STYLE.export_format;
    normalized.export_aspect_ratio = DEFAULT_PLOT_STYLE.export_aspect_ratio;
    normalized.export_ppi = DEFAULT_PLOT_STYLE.export_ppi;
    normalized.export_width = DEFAULT_PLOT_STYLE.export_width;
    normalized.export_height = DEFAULT_PLOT_STYLE.export_height;
    normalized.export_scale = DEFAULT_PLOT_STYLE.export_scale;
    normalized.export_settings_version = DEFAULT_PLOT_STYLE.export_settings_version;
  }
  return normalized;
}

function scopedTitle(
  scoped: PlotAxisScope | undefined,
  key: "x_title" | "y_title" | "y2_title",
  fallback: string | null
): string | null {
  return scoped && key in scoped ? scoped[key] ?? null : fallback;
}

// Each plot tab owns a fully independent style. New specs store them in
// presentation.plot_styles[tab]; older specs migrate on read from the legacy
// shared plot_style (+ per-tab axis_scopes overlay).
function legacyScopedStyle(spec: AnalysisSpec, scope: AnalysisTabKey): PlotStyle {
  const base = normalizePlotStyle(spec.presentation.plot_style);
  const scoped = base.axis_scopes?.[scope];
  const axisFallback = scope === "cycles" ? base : DEFAULT_PLOT_STYLE;
  if (!scoped && scope === "cycles") return base;
  return {
    ...base,
    x_title: scopedTitle(scoped, "x_title", axisFallback.x_title),
    y_title: scopedTitle(scoped, "y_title", axisFallback.y_title),
    y2_title: scopedTitle(scoped, "y2_title", axisFallback.y2_title),
    x_axis: { ...axisFallback.x_axis, ...(scoped?.x_axis ?? {}) },
    y_axis: { ...axisFallback.y_axis, ...(scoped?.y_axis ?? {}) },
    y2_axis: { ...axisFallback.y2_axis, ...(scoped?.y2_axis ?? {}) },
  };
}

export function currentPlotStyle(spec: AnalysisSpec, scope: AnalysisTabKey = "cycles"): PlotStyle {
  const scopedStyle = spec.presentation.plot_styles?.[scope];
  if (scopedStyle) return normalizePlotStyle(scopedStyle);
  return legacyScopedStyle(spec, scope);
}

// Write a style change to ONE tab only. The first write to a tab snapshots
// its current (possibly legacy-derived) style so tabs never share state.
export function writeScopedStyle(
  spec: AnalysisSpec,
  scope: AnalysisTabKey,
  fn: (style: PlotStyle) => void,
): void {
  const next = currentPlotStyle(spec, scope);
  fn(next);
  spec.presentation.plot_styles = {
    ...(spec.presentation.plot_styles ?? {}),
    [scope]: next,
  };
}

export function plotPalette(style: PlotStyle): string[] {
  return style.palette_colors?.length
    ? style.palette_colors
    : PLOT_PALETTES[style.palette] ?? PLOT_PALETTES.app;
}

export function cePalette(style: PlotStyle): string[] {
  return style.ce_palette_colors?.length ? style.ce_palette_colors : PLOT_PALETTES.app;
}

export function plotMode(style: PlotStyle): "lines" | "markers" | "lines+markers" {
  if (style.marker_mode === "points") return "markers";
  if (style.marker_mode === "lines_points") return "lines+markers";
  return "lines";
}

export function markerSymbol(style: PlotStyle): string {
  return style.marker_open ? `${style.marker_symbol}-open` : style.marker_symbol;
}

export function cePlotMode(style: PlotStyle): "lines" | "markers" | "lines+markers" {
  if (style.ce_marker_mode === "points") return "markers";
  if (style.ce_marker_mode === "lines_points") return "lines+markers";
  return "lines";
}

export function ceMarkerSymbol(style: PlotStyle): string {
  const symbol = style.ce_marker_symbol ?? "circle";
  return style.ce_marker_open ? `${symbol}-open` : symbol;
}

export function hexToRgba(color: string, alpha: number): string {
  const normalized = color.trim();
  const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (normalized.startsWith("rgb(")) return normalized.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
  return normalized;
}
