// Analysis editor. Saved plots snapshot their exact samples and view state,
// while the current workspace stays fluid for quick plotting.
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  ColorInput,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  NumberInput,
  Paper,
  Popover,
  ScrollArea,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconActivity,
  IconBolt,
  IconChartLine,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDatabase,
  IconDeviceFloppy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconGauge,
  IconLayersIntersect,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTable,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import PlotlyLib from "plotly.js-dist-min";
import { useNavigate, useParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSpec,
  AnalysisTabKey,
  Badge as ApiBadge,
  CellMetrics,
  CellSummary,
  ComputeResult,
  del,
  FolderNode,
  get,
  post,
  put,
  PlotAspectRatioKey,
  PlotExportFormat,
  ReplicateGroupSummary,
  SavedAnalysisPlot,
  SelectionEntry,
  PlotStyle,
  PlotAxisScope,
  TimeCapacityResult,
  TimeCapacityTrace,
  Tree,
} from "../api";
import Plot from "../components/Plot";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "../navigationEvents";

const PALETTE = [
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

const PLOT_PALETTES: Record<PlotStyle["palette"], string[]> = {
  app: PALETTE,
  pastel: ["#6ee7b7", "#93c5fd", "#f9a8d4", "#fde68a", "#c4b5fd", "#fdba74", "#99f6e4"],
  publication: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000"],
  presentation: ["#12b886", "#2563eb", "#f97316", "#e11d48", "#7c3aed", "#0f766e", "#ca8a04"],
  okabe_ito: ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"],
  tableau: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
  viridis: ["#440154", "#414487", "#2A788E", "#22A884", "#7AD151", "#FDE725"],
  monochrome: ["#111827", "#4b5563", "#6b7280", "#9ca3af", "#d1d5db"],
  custom: PALETTE,
};

const PALETTE_OPTIONS: { value: PlotStyle["palette"]; label: string }[] = [
  { value: "app", label: "CellXplorer" },
  { value: "pastel", label: "Pastel" },
  { value: "publication", label: "Publication" },
  { value: "presentation", label: "Presentation" },
  { value: "okabe_ito", label: "Okabe-Ito" },
  { value: "tableau", label: "Tableau" },
  { value: "viridis", label: "Viridis" },
  { value: "monochrome", label: "Monochrome" },
  { value: "custom", label: "Custom" },
];

const ASPECT_RATIO_OPTIONS: { value: PlotAspectRatioKey; label: string }[] = [
  { value: "view", label: "Current view" },
  { value: "square", label: "1:1 square" },
  { value: "four_three", label: "4:3" },
  { value: "sixteen_nine", label: "16:9" },
  { value: "a4_landscape", label: "A4 landscape" },
  { value: "a4_portrait", label: "A4 portrait" },
  { value: "custom", label: "Custom" },
];

const EXPORT_FORMAT_OPTIONS: { value: PlotExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
];

const COLOR_SWATCHES = Array.from(
  new Set(Object.entries(PLOT_PALETTES).filter(([key]) => key !== "custom").flatMap(([, colors]) => colors))
);

const CAPACITY_KEYS = new Set(["discharge_capacity", "charge_capacity"]);
const CAPACITY_LIKE_KEYS = new Set([
  "discharge_capacity",
  "charge_capacity",
  "discharge_capacity_specific",
  "charge_capacity_specific",
]);

const NORMALIZED_QUANTITY_MAP: Record<string, { column: string; label: string }> = {
  discharge_capacity: { column: "discharge_capacity_mah_g", label: "Discharge capacity (mAh/g)" },
  charge_capacity: { column: "charge_capacity_mah_g", label: "Charge capacity (mAh/g)" },
  discharge_energy: { column: "discharge_energy_mwh_g", label: "Discharge energy (mWh/g)" },
  charge_energy: { column: "charge_energy_mwh_g", label: "Charge energy (mWh/g)" },
  discharge_capacity_loss: {
    column: "discharge_capacity_loss_mah_g_cycle",
    label: "Discharge capacity loss (mAh/g/cycle)",
  },
  charge_capacity_loss: {
    column: "charge_capacity_loss_mah_g_cycle",
    label: "Charge capacity loss (mAh/g/cycle)",
  },
};

const LEGACY_NORMALIZED_QUANTITY_MAP: Record<string, string> = {
  discharge_capacity_specific: "discharge_capacity",
  charge_capacity_specific: "charge_capacity",
  discharge_energy_specific: "discharge_energy",
  charge_energy_specific: "charge_energy",
  discharge_capacity_loss_specific: "discharge_capacity_loss",
  charge_capacity_loss_specific: "charge_capacity_loss",
};

const POLARIZATION_METHOD_OPTIONS: {
  value: AnalysisSpec["computation"]["polarization"]["method"];
  label: string;
}[] = [
  { value: "mean", label: "Mean charge - mean discharge" },
  { value: "first_first", label: "First charge - first discharge" },
  { value: "last_last", label: "Last charge - last discharge" },
  { value: "last_charge_first_discharge", label: "Last charge - first discharge" },
  { value: "first_charge_last_discharge", label: "First charge - last discharge" },
];

const POLARIZATION_DIRECTION_OPTIONS: {
  value: AnalysisSpec["computation"]["polarization"]["direction"];
  label: string;
}[] = [
  { value: "charge_minus_discharge", label: "Charge - discharge" },
  { value: "discharge_minus_charge", label: "Discharge - charge" },
];

const TAB_DEFS: {
  value: AnalysisTabKey;
  label: string;
  icon: typeof IconChartLine;
  plotTab: boolean;
}[] = [
  { value: "time_capacity", label: "Time / capacity", icon: IconClock, plotTab: true },
  { value: "cycles", label: "Cycles", icon: IconChartLine, plotTab: true },
  { value: "crate", label: "C-rate", icon: IconGauge, plotTab: true },
  { value: "chargeability", label: "Chargeability", icon: IconBolt, plotTab: true },
  { value: "dcir", label: "DCIR", icon: IconActivity, plotTab: true },
  { value: "recap", label: "Recap", icon: IconTable, plotTab: true },
  { value: "settings", label: "Settings", icon: IconSettings, plotTab: false },
];

type TimeCapacityConfig = NonNullable<AnalysisSpec["computation"]["time_capacity"]>;
type TimeCapacityCurrentQuantity = TimeCapacityConfig["current_left"];
type TimeCapacityCurrentAxis = TimeCapacityConfig["current_right"];

const CURRENT_AXIS_OPTIONS: { value: TimeCapacityCurrentQuantity; label: string }[] = [
  { value: "current_ma", label: "Current (mA)" },
  { value: "current_density", label: "Current density (mA/cm2)" },
  { value: "c_rate", label: "C-rate (C)" },
];

const CURRENT_RIGHT_AXIS_OPTIONS: { value: TimeCapacityCurrentAxis; label: string }[] = [
  { value: "none", label: "None" },
  ...CURRENT_AXIS_OPTIONS,
];

const DEFAULT_TIME_CAPACITY: TimeCapacityConfig = {
  x_axis: "time",
  time_unit: "min",
  display_mode: "consecutive",
  stacked: false,
  current_left: "current_ma",
  current_right: "none",
  electrode_area_cm2: null,
  cycle_start: 1,
  cycle_end: 3,
  cycles: [],
  max_points_per_cell: 4000,
};

function timeCapacityConfig(spec: AnalysisSpec): TimeCapacityConfig {
  return { ...DEFAULT_TIME_CAPACITY, ...(spec.computation.time_capacity ?? {}) };
}

const DEFAULT_COMPUTATION: AnalysisSpec["computation"] = {
  cycle_range: { start: 1, end: null },
  exclude_check_cycles_every_n: 0,
  retention_reference: { mode: "max_first_n", n: 5, cycle: null },
  formation_cycles: 3,
  polarization: {
    method: "mean",
    direction: "charge_minus_discharge",
  },
  time_capacity: DEFAULT_TIME_CAPACITY,
};

const DEFAULT_AGGREGATION: AnalysisSpec["aggregation"] = {
  mode: "replicate_mean",
  dispersion: "std",
  min_n_for_band: 2,
};

const DEFAULT_PLOT_STYLE: PlotStyle = {
  palette: "app",
  custom_colors: {},
  line_width: 2.5,
  line_dash: "solid",
  marker_mode: "none",
  marker_size: 5,
  individual_opacity: 0.35,
  band_opacity: 0.18,
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
  x_axis: { mode: "auto", min: null, max: null, dtick: null },
  y_axis: { mode: "auto", min: null, max: null, dtick: null },
  y2_axis: { mode: "auto", min: null, max: null, dtick: null },
  axis_scopes: {},
  tick_font_size: 12,
  axis_title_size: 14,
  legend_font_size: 12,
  tick_marks: "none",
  tick_length: 5,
  tick_width: 1,
  ce_line_width: 1.5,
  ce_line_dash: "dot",
  ce_opacity: 0.7,
  legend_position: "bottom",
  export_settings_version: 2,
  export_format: "png",
  export_aspect_ratio: "view",
  export_ppi: 96,
  export_width: 900,
  export_height: 560,
  export_scale: 1,
  export_include_title: false,
};

const DEFAULT_PRESENTATION: AnalysisSpec["presentation"] = {
  quantity: "discharge_capacity",
  normalize_by_mass: false,
  ce_overlay: true,
  show_individual_cells: true,
  legend: true,
  plot_style: DEFAULT_PLOT_STYLE,
};

const METRIC_COLUMNS: { key: keyof CellMetrics; label: string; digits: number }[] = [
  { key: "n_cycles", label: "Cycles", digits: 0 },
  { key: "max_discharge_capacity_mah", label: "Max Qd", digits: 2 },
  { key: "mean_discharge_capacity_mah", label: "Mean Qd", digits: 2 },
  { key: "first_cycle_ce_pct", label: "1st CE", digits: 2 },
  { key: "mean_ce_pct", label: "CE", digits: 3 },
  { key: "mean_ee_pct", label: "EE", digits: 2 },
  { key: "mean_ve_pct", label: "VE", digits: 2 },
  { key: "retention_last_pct", label: "SoH last", digits: 1 },
  { key: "discharge_loss_mah_per_cycle", label: "Fade Qd/cyc", digits: 4 },
  { key: "discharge_loss_pct_per_cycle", label: "Fade %/cyc", digits: 4 },
  { key: "cycles_to_80_pct", label: "Cyc to 80%", digits: 0 },
  { key: "total_duration_h", label: "Total h", digits: 1 },
  { key: "mean_cycle_duration_h", label: "Cycle h", digits: 2 },
  { key: "mean_charge_time_h", label: "Chg h", digits: 2 },
  { key: "mean_discharge_time_h", label: "Dchg h", digits: 2 },
];

const FALLBACK_QUANTITY_LABELS: Record<string, string> = {
  discharge_capacity: "Discharge capacity (mAh)",
  charge_capacity: "Charge capacity (mAh)",
  coulombic_efficiency: "Coulombic efficiency (%)",
  discharge_energy: "Discharge energy (mWh)",
  charge_energy: "Charge energy (mWh)",
  energy_efficiency: "Energy efficiency (%)",
  mean_charge_voltage: "Mean charge voltage (V)",
  mean_discharge_voltage: "Mean discharge voltage (V)",
  polarization: "Polarization ΔV (V)",
  polarization_pct: "Polarization ΔV/V (%)",
  discharge_capacity_specific: "Discharge capacity (mAh/g)",
  charge_capacity_specific: "Charge capacity (mAh/g)",
  discharge_energy_specific: "Discharge energy (mWh/g)",
  charge_energy_specific: "Charge energy (mWh/g)",
  cycle_duration: "Cycle duration (h)",
  charge_time: "Charge time (h)",
  discharge_time: "Discharge time (h)",
  voltaic_efficiency: "Voltaic efficiency (%)",
  capacity_retention: "Capacity retention / SoH (%)",
  discharge_capacity_loss: "Discharge capacity loss (mAh/cycle)",
  charge_capacity_loss: "Charge capacity loss (mAh/cycle)",
  discharge_capacity_loss_specific: "Discharge capacity loss (mAh/g/cycle)",
  charge_capacity_loss_specific: "Charge capacity loss (mAh/g/cycle)",
};

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return v.toFixed(digits);
}

function tabLabel(tab: AnalysisTabKey): string {
  return TAB_DEFS.find((t) => t.value === tab)?.label ?? tab;
}

function quantityLabel(result: ComputeResult | undefined, spec: AnalysisSpec): string {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  return resolvedQuantity(result, spec).label;
}

function isMassNormalizableQuantity(quantity: string): boolean {
  return quantity in NORMALIZED_QUANTITY_MAP;
}

function resolvedQuantity(result: ComputeResult | undefined, spec: AnalysisSpec) {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const baseInfo = result?.quantities.find((q) => q.key === quantity);
  if (spec.presentation.normalize_by_mass && isMassNormalizableQuantity(quantity)) {
    const normalized = NORMALIZED_QUANTITY_MAP[quantity];
    return {
      key: quantity,
      column: normalized.column,
      label: normalized.label,
    };
  }
  return {
    key: quantity,
    column: baseInfo?.column ?? "discharge_capacity_mah",
    label: baseInfo?.label ?? FALLBACK_QUANTITY_LABELS[quantity] ?? quantity.replace(/_/g, " "),
  };
}

function plotSubtitle(tab: AnalysisTabKey, result: ComputeResult | undefined, spec: AnalysisSpec): string {
  if (tab === "time_capacity") {
    const cfg = timeCapacityConfig(spec);
    const axis =
      cfg.x_axis === "capacity_mah_g"
        ? "specific capacity (mAh/g)"
        : cfg.x_axis === "capacity_mah"
        ? "capacity (mAh)"
        : `time (${cfg.time_unit})`;
    return `Voltage${cfg.stacked ? " and current" : ""} vs ${axis}`;
  }
  if (tab === "cycles") return `${quantityLabel(result, spec)} vs cycle`;
  if (tab === "recap") return "Recap table";
  if (tab === "settings") return "Analysis settings";
  return `${tabLabel(tab)} view`;
}

function isPolarizationQuantity(quantity: string): boolean {
  return quantity === "polarization" || quantity === "polarization_pct";
}

function suggestedPlotName(tab: AnalysisTabKey, result: ComputeResult | undefined, spec: AnalysisSpec): string {
  if (tab === "time_capacity") return "Time / capacity comparison";
  return tab === "cycles" ? `${quantityLabel(result, spec)} comparison` : `${tabLabel(tab)} view`;
}

function normalizePlotStyle(style: Partial<PlotStyle> | undefined): PlotStyle {
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
    x_axis: xAxis,
    y_axis: yAxis,
    y2_axis: y2Axis,
    axis_scopes: axisScopes,
  };
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

function currentPlotStyle(spec: AnalysisSpec, scope: AnalysisTabKey = "cycles"): PlotStyle {
  const scopedStyle = spec.presentation.plot_styles?.[scope];
  if (scopedStyle) return normalizePlotStyle(scopedStyle);
  return legacyScopedStyle(spec, scope);
}

// Write a style change to ONE tab only. The first write to a tab snapshots
// its current (possibly legacy-derived) style so tabs never share state.
function writeScopedStyle(spec: AnalysisSpec, scope: AnalysisTabKey, fn: (style: PlotStyle) => void): void {
  const next = currentPlotStyle(spec, scope);
  fn(next);
  spec.presentation.plot_styles = {
    ...(spec.presentation.plot_styles ?? {}),
    [scope]: next,
  };
}

function hexToRgba(color: string, alpha: number): string {
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

function plotMode(style: PlotStyle): "lines" | "markers" | "lines+markers" {
  if (style.marker_mode === "points") return "markers";
  if (style.marker_mode === "lines_points") return "lines+markers";
  return "lines";
}

type AxisOverrides = {
  autorange?: boolean;
  range?: [number, number];
  dtick?: number;
  autorangeoptions?: { minallowed?: number; maxallowed?: number };
};

// Returns ONLY the keys that should override Plotly's defaults. In auto mode
// this is empty on purpose: passing `range: undefined, autorange: true` on a
// layout-only re-render (grid/zero-line/border toggles) made Plotly.react
// fall back to its empty-plot ranges (x [-1, 6], y [-1, 4]) without
// recomputing from data. One-sided manual bounds clamp the autorange.
function axisLayout(axis: PlotStyle["x_axis"]): AxisOverrides {
  const out: AxisOverrides = {};
  if (axis.dtick !== null && axis.dtick !== undefined && axis.dtick > 0) out.dtick = axis.dtick;
  if (axis.mode !== "manual") return out;
  const hasMin = axis.min !== null && axis.min !== undefined;
  const hasMax = axis.max !== null && axis.max !== undefined;
  if (hasMin && hasMax) {
    out.autorange = false;
    out.range = [axis.min!, axis.max!];
  } else if (hasMin || hasMax) {
    out.autorange = true;
    out.autorangeoptions = {
      ...(hasMin ? { minallowed: axis.min! } : {}),
      ...(hasMax ? { maxallowed: axis.max! } : {}),
    };
  }
  return out;
}

// Shared tick-mark + tick-label styling for all axes.
function tickLayout(style: PlotStyle) {
  return {
    ticks: style.tick_marks === "none" ? ("" as const) : style.tick_marks,
    ticklen: style.tick_length,
    tickwidth: style.tick_width,
    tickcolor: style.frame_color,
    tickfont: { size: style.tick_font_size },
  };
}

function legendLayout(style: PlotStyle): Partial<Plotly.Layout["legend"]> {
  if (style.legend_position === "right") return { orientation: "v", x: 1.02, y: 1 };
  if (style.legend_position === "top") return { orientation: "h", x: 0, y: 1.13 };
  if (style.legend_position === "inside") {
    return {
      orientation: "v",
      x: 0.02,
      y: 0.98,
      bgcolor: "rgba(255, 255, 255, 0.82)",
      bordercolor: "#dee2e6",
      borderwidth: 1,
    };
  }
  return { orientation: "h", y: -0.22 };
}

function slugFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "analysis-plot"
  );
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobFromDataUrl(dataUrl: string, fallbackType: string): Blob {
  const [metadata, payload = ""] = dataUrl.split(",");
  const mime = metadata.match(/^data:([^;,]+)/)?.[1] ?? fallbackType;
  const bytes = metadata.includes(";base64")
    ? bytesFromDataUrl(dataUrl)
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes as BlobPart], { type: mime });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32Bytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function pngWithPpi(dataUrl: string, ppi: number): Blob {
  const png = bytesFromDataUrl(dataUrl);
  if (png.length < 33) return blobFromDataUrl(dataUrl, "image/png");
  const ppm = Math.max(1, Math.round(ppi / 0.0254));
  const type = new TextEncoder().encode("pHYs");
  const data = new Uint8Array(9);
  data.set(uint32Bytes(ppm), 0);
  data.set(uint32Bytes(ppm), 4);
  data[8] = 1;
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, type.length);
  const chunk = new Uint8Array(4 + type.length + data.length + 4);
  chunk.set(uint32Bytes(data.length), 0);
  chunk.set(type, 4);
  chunk.set(data, 8);
  chunk.set(uint32Bytes(crc32(crcInput)), 17);
  return new Blob([png.slice(0, 33) as BlobPart, chunk as BlobPart, png.slice(33) as BlobPart], {
    type: "image/png",
  });
}

// Parse a Plotly SVG data URL into a live <svg> element for vector export.
function svgElementFromDataUrl(dataUrl: string): SVGSVGElement {
  const marker = "data:image/svg+xml,";
  const raw = dataUrl.startsWith(marker)
    ? decodeURIComponent(dataUrl.slice(marker.length))
    : dataUrl.includes(";base64,")
      ? new TextDecoder().decode(bytesFromDataUrl(dataUrl))
      : dataUrl;
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  return doc.documentElement as unknown as SVGSVGElement;
}

// Render a Plotly SVG into a real vector PDF (no rasterization) via
// jsPDF + svg2pdf. Page size in points is derived from the export pixel
// size and PPI so the physical dimensions match the raster exports.
async function makeVectorPdf(
  svgDataUrl: string,
  pixelWidth: number,
  pixelHeight: number,
  ppi: number
): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const svg = svgElementFromDataUrl(svgDataUrl);
  const pageWidth = (pixelWidth * 72) / ppi;
  const pageHeight = (pixelHeight * 72) / ppi;
  const pdf = new jsPDF({
    orientation: pageWidth >= pageHeight ? "landscape" : "portrait",
    unit: "pt",
    format: [pageWidth, pageHeight],
  });
  await (
    pdf as unknown as {
      svg: (el: Element, opts: { x: number; y: number; width: number; height: number }) => Promise<void>;
    }
  ).svg(svg, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  return pdf.output("blob");
}

function aspectRatioValue(aspect: PlotAspectRatioKey, fallback: number): number {
  if (aspect === "square") return 1;
  if (aspect === "four_three") return 4 / 3;
  if (aspect === "sixteen_nine") return 16 / 9;
  if (aspect === "a4_landscape") return Math.SQRT2;
  if (aspect === "a4_portrait") return 1 / Math.SQRT2;
  return fallback;
}

function resolveExportPlan(
  style: PlotStyle,
  plotDiv: HTMLElement
): { layoutWidth: number; layoutHeight: number; pixelWidth: number; pixelHeight: number; scale: number } {
  const rect = plotDiv.getBoundingClientRect();
  const viewWidth = Math.max(320, Math.round(rect.width || style.export_width));
  const viewHeight = Math.max(240, Math.round(rect.height || style.export_height));
  const aspect = style.export_aspect_ratio ?? "view";
  const viewRatio = viewWidth / viewHeight;
  const ratio =
    aspect === "custom"
      ? Math.max(0.1, (style.export_width || viewWidth) / (style.export_height || viewHeight))
      : aspectRatioValue(aspect, viewRatio);
  const layoutWidth = viewWidth;
  const layoutHeight = Math.max(240, Math.round(layoutWidth / ratio));
  const pixelWidth = Math.max(320, Math.round(style.export_width || viewWidth));
  const pixelHeight = Math.max(240, Math.round(pixelWidth / ratio));
  return {
    layoutWidth,
    layoutHeight,
    pixelWidth,
    pixelHeight,
    scale: Math.max(1, pixelWidth / layoutWidth),
  };
}


function normalizeSavedPlot(plot: SavedAnalysisPlot, base: AnalysisSpec): SavedAnalysisPlot {
  const presentation = {
    ...DEFAULT_PRESENTATION,
    ...(plot.presentation ?? {}),
    plot_style: normalizePlotStyle(plot.presentation?.plot_style),
  };
  const legacyNormalized = LEGACY_NORMALIZED_QUANTITY_MAP[presentation.quantity];
  if (legacyNormalized) {
    presentation.quantity = legacyNormalized;
    presentation.normalize_by_mass = true;
  }
  return {
    ...plot,
    presentation,
    subtitle: plot.subtitle || plotSubtitle(plot.tab, undefined, {
      ...base,
      selection: clone(plot.selection),
      computation: clone(plot.computation),
      aggregation: clone(plot.aggregation),
      presentation: clone(presentation),
    }),
  };
}

function normalizeSpec(input: AnalysisSpec): AnalysisSpec {
  const spec = clone(input);
  spec.selection = {
    entries: spec.selection?.entries ?? [],
    exclusions: spec.selection?.exclusions ?? [],
  };
  spec.computation = {
    ...DEFAULT_COMPUTATION,
    ...(spec.computation ?? {}),
    cycle_range: {
      ...DEFAULT_COMPUTATION.cycle_range,
      ...(spec.computation?.cycle_range ?? {}),
    },
    retention_reference: {
      ...DEFAULT_COMPUTATION.retention_reference,
      ...(spec.computation?.retention_reference ?? {}),
    },
    polarization: {
      ...DEFAULT_COMPUTATION.polarization,
      ...(spec.computation?.polarization ?? {}),
    },
    time_capacity: {
      ...DEFAULT_TIME_CAPACITY,
      ...(spec.computation?.time_capacity ?? {}),
    },
  };
  spec.aggregation = { ...DEFAULT_AGGREGATION, ...(spec.aggregation ?? {}) };
  spec.presentation = {
    ...DEFAULT_PRESENTATION,
    ...(spec.presentation ?? {}),
    plot_style: normalizePlotStyle(spec.presentation?.plot_style),
  };
  const legacyNormalized = LEGACY_NORMALIZED_QUANTITY_MAP[spec.presentation.quantity];
  if (legacyNormalized) {
    spec.presentation.quantity = legacyNormalized;
    spec.presentation.normalize_by_mass = true;
  }
  spec.saved_plots = (spec.saved_plots ?? []).map((plot) => normalizeSavedPlot(plot, spec));
  return spec;
}

function specForSavedPlot(base: AnalysisSpec, plot: SavedAnalysisPlot): AnalysisSpec {
  const next = normalizeSpec(base);
  next.selection = clone(plot.selection);
  next.computation = clone(plot.computation);
  next.aggregation = clone(plot.aggregation);
  next.presentation = clone(plot.presentation);
  return next;
}

function snapshotSignature(spec: AnalysisSpec): string {
  return JSON.stringify({
    selection: spec.selection,
    computation: spec.computation,
    aggregation: spec.aggregation,
    presentation: spec.presentation,
  });
}

function findMatchingSavedPlot(spec: AnalysisSpec, tab: AnalysisTabKey): SavedAnalysisPlot | null {
  const current = snapshotSignature(spec);
  return (
    (spec.saved_plots ?? []).find(
      (plot) => plot.tab === tab && snapshotSignature(specForSavedPlot(spec, plot)) === current
    ) ?? null
  );
}

function computeSignature(spec: AnalysisSpec | null): string {
  if (!spec) return "no-spec";
  return JSON.stringify({
    selection: spec.selection,
    computation: spec.computation,
    aggregation: spec.aggregation,
  });
}

function savedPlotFromSpec(
  spec: AnalysisSpec,
  tab: AnalysisTabKey,
  name: string,
  subtitle: string,
  description: string | null,
  existing?: SavedAnalysisPlot
): SavedAnalysisPlot {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? uid(),
    tab,
    name: name.trim() || "Untitled plot",
    subtitle,
    description: description?.trim() || null,
    selection: clone(spec.selection),
    computation: clone(spec.computation),
    aggregation: clone(spec.aggregation),
    presentation: clone(spec.presentation),
    created_at: existing?.created_at ?? now,
    modified_at: now,
  };
}

function flattenFolders(tree: Tree | undefined): { value: string; label: string }[] {
  if (!tree) return [];
  const out: { value: string; label: string }[] = [{ value: "none", label: "Unfiled" }];
  const walk = (folders: FolderNode[], depth: number) => {
    for (const folder of folders) {
      out.push({ value: String(folder.id), label: `${"-- ".repeat(depth)}${folder.name}` });
      walk(folder.children, depth + 1);
    }
  };
  walk(tree.folders, 0);
  return out;
}

function findFolderInTree(folders: FolderNode[], folderId: number | null): FolderNode | null {
  if (folderId === null) return null;
  for (const folder of folders) {
    if (folder.id === folderId) return folder;
    const child = findFolderInTree(folder.children, folderId);
    if (child) return child;
  }
  return null;
}

function collectFiledReferences(
  folders: FolderNode[],
  cellIds: Set<number>,
  groupIds: Set<number>
) {
  for (const folder of folders) {
    folder.cells.forEach((cell) => cellIds.add(cell.id));
    folder.replicate_groups.forEach((group) => groupIds.add(group.id));
    collectFiledReferences(folder.children, cellIds, groupIds);
  }
}

// ---------------------------------------------------------------------------
// Debounced inputs: keep keystrokes/drags in local state and commit to the
// spec only after a pause (or blur/Enter). Committing per keystroke re-built
// the whole spec, re-rendered the Plotly figure and (for computation fields)
// fired a compute request per character — that was the typing lag.
const COMMIT_DELAY_MS = 450;

function useDebouncedCommit<T>(value: T, onCommit: (value: T) => void) {
  const [local, setLocal] = useState<T>(value);
  const focusedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const change = (next: T) => {
    setLocal(next);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commitRef.current(next);
    }, COMMIT_DELAY_MS);
  };
  const flush = () => {
    clearTimer();
    commitRef.current(local);
  };
  return { local, change, flush, focusedRef };
}

function DebouncedTextInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
  ComponentProps<typeof TextInput>,
  "value" | "onChange"
>) {
  const { local, change, flush, focusedRef } = useDebouncedCommit(value, onCommit);
  return (
    <TextInput
      {...props}
      value={local}
      onChange={(e) => change(e.currentTarget.value)}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
        props.onKeyDown?.(e);
      }}
    />
  );
}

function DebouncedNumberInput({
  value,
  onCommit,
  ...props
}: { value: number | null; onCommit: (value: number | null) => void } & Omit<
  ComponentProps<typeof NumberInput>,
  "value" | "onChange"
>) {
  const { local, change, flush, focusedRef } = useDebouncedCommit<number | "">(
    value ?? "",
    (v) => onCommit(typeof v === "number" ? v : null)
  );
  return (
    <NumberInput
      {...props}
      value={local}
      onChange={(v) => change(typeof v === "number" ? v : "")}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
        props.onKeyDown?.(e);
      }}
    />
  );
}

function DebouncedColorInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
  ComponentProps<typeof ColorInput>,
  "value" | "onChange"
>) {
  const { local, change, focusedRef } = useDebouncedCommit(value, onCommit);
  return (
    <ColorInput
      {...props}
      value={local}
      onChange={change}
      onFocus={() => (focusedRef.current = true)}
      onBlur={() => (focusedRef.current = false)}
    />
  );
}

function BadgeBar({ badges }: { badges: ApiBadge[] }) {
  if (badges.length === 0) return null;
  const colors: Record<string, string> = {
    source_offline: "orange",
    source_changed: "yellow",
    cache_missing: "gray",
    cell_archived: "gray",
    newer_parser: "blue",
    newer_calc: "blue",
    selection_drift: "grape",
    new_data: "cyan",
    missing_reference: "red",
  };
  return (
    <Group gap={6}>
      {badges.map((b, i) => (
        <Tooltip key={i} label={b.detail} multiline w={320}>
          <Badge color={colors[b.kind] ?? "gray"} variant="light" size="sm">
            {b.kind.replace(/_/g, " ")}
            {b.cell_name ? `: ${b.cell_name}` : ""}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}

function AddEntriesModal({
  opened,
  onClose,
  onAdd,
  existing,
  currentFolderId,
}: {
  opened: boolean;
  onClose: () => void;
  onAdd: (entries: SelectionEntry[]) => void;
  existing: SelectionEntry[];
  currentFolderId: number | null;
}) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"replicate_group" | "cell">("replicate_group");
  const [branchOnly, setBranchOnly] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const cells = useQuery({
    queryKey: ["cells", "analysis-picker"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
    enabled: opened,
  });
  const groups = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
    enabled: opened,
  });
  const tree = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
    enabled: opened,
  });
  const needle = search.trim().toLowerCase();
  const matches = (value: string) => !needle || value.toLowerCase().includes(needle);
  const folderRoot = currentFolderId ? findFolderInTree(tree.data?.folders ?? [], currentFolderId) : null;
  const visibleFolders = branchOnly && folderRoot ? [folderRoot] : tree.data?.folders ?? [];
  const filedCellIds = new Set<number>();
  const filedGroupIds = new Set<number>();
  collectFiledReferences(tree.data?.folders ?? [], filedCellIds, filedGroupIds);
  const unfiledCells = (cells.data ?? []).filter(
    (cell) => !filedCellIds.has(cell.id) && matches(cell.name)
  );
  const unfiledGroups = (groups.data ?? []).filter(
    (group) => !filedGroupIds.has(group.id) && matches(group.name)
  );

  const keyOf = (entry: SelectionEntry) => `${entry.kind}:${entry.ref_id}`;
  const entryOf = (key: string): SelectionEntry => {
    const [kind, id] = key.split(":");
    return { kind: kind as SelectionEntry["kind"], ref_id: Number(id) };
  };
  const has = (entry: SelectionEntry) =>
    existing.some((e) => e.kind === entry.kind && e.ref_id === entry.ref_id);

  const folderEntries = (folder: FolderNode): SelectionEntry[] => {
    const own =
      mode === "cell"
        ? folder.cells
            .filter((cell) => matches(cell.name))
            .map((cell) => ({ kind: "cell" as const, ref_id: cell.id }))
        : folder.replicate_groups
            .filter((group) => matches(group.name))
            .map((group) => ({ kind: "replicate_group" as const, ref_id: group.id }));
    return [...own, ...folder.children.flatMap(folderEntries)].filter((entry) => !has(entry));
  };

  const visibleEntryKeys = [
    ...visibleFolders.flatMap(folderEntries).map(keyOf),
    ...((!branchOnly || !currentFolderId)
      ? mode === "cell"
        ? unfiledCells.map((cell) => keyOf({ kind: "cell", ref_id: cell.id }))
        : unfiledGroups.map((group) => keyOf({ kind: "replicate_group", ref_id: group.id }))
      : []),
  ];

  const toggleEntry = (entry: SelectionEntry, event?: ReactMouseEvent) => {
    if (has(entry)) return;
    const key = keyOf(entry);
    setSelected((current) => {
      const next = new Set(current);
      if (event?.shiftKey && lastSelectedKey) {
        const start = visibleEntryKeys.indexOf(lastSelectedKey);
        const end = visibleEntryKeys.indexOf(key);
        if (start >= 0 && end >= 0) {
          const [from, to] = start < end ? [start, end] : [end, start];
          visibleEntryKeys.slice(from, to + 1).forEach((candidate) => next.add(candidate));
        }
      } else {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      }
      return next;
    });
    setLastSelectedKey(key);
  };

  const toggleFolder = (folder: FolderNode) => {
    const keys = folderEntries(folder).map(keyOf);
    if (!keys.length) return;
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = keys.every((key) => next.has(key));
      keys.forEach((key) => {
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  const selectedEntries = Array.from(selected)
    .filter((key) => visibleEntryKeys.includes(key))
    .map(entryOf)
    .filter((entry) => !has(entry));

  const renderFolderRows = (folder: FolderNode, depth: number): ReactNode[] => {
    const entries = folderEntries(folder);
    const selectedCount = entries.filter((entry) => selected.has(keyOf(entry))).length;
    const rows: ReactNode[] = [
      <Table.Tr key={`folder-${folder.id}`} style={{ cursor: entries.length ? "pointer" : "default" }}>
        <Table.Td w={42}>
          <Checkbox
            checked={entries.length > 0 && selectedCount === entries.length}
            indeterminate={selectedCount > 0 && selectedCount < entries.length}
            disabled={!entries.length}
            onChange={() => toggleFolder(folder)}
          />
        </Table.Td>
        <Table.Td>
          <Group gap={6} pl={depth * 16}>
            <IconFolder size={14} color="var(--mantine-color-teal-6)" />
            <Text size="xs" fw={700} c="dimmed">
              {folder.name}
            </Text>
            {entries.length > 0 && (
              <Badge size="xs" variant="light">
                {entries.length}
              </Badge>
            )}
          </Group>
        </Table.Td>
      </Table.Tr>,
    ];
    if (mode === "cell") {
      folder.cells
        .filter((cell) => matches(cell.name))
        .forEach((cell) => {
          const entry: SelectionEntry = { kind: "cell", ref_id: cell.id };
          const key = keyOf(entry);
          const added = has(entry);
          rows.push(
            <Table.Tr
              key={`cell-${folder.id}-${cell.id}`}
              bg={selected.has(key) ? "teal.0" : undefined}
              style={{ cursor: added ? "default" : "pointer" }}
              onClick={(event) => toggleEntry(entry, event)}
            >
              <Table.Td w={42}>
                <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
              </Table.Td>
              <Table.Td>
                <Group gap={6} pl={(depth + 1) * 16}>
                  <IconDatabase size={14} color="var(--mantine-color-gray-6)" />
                  <Text size="sm" fw={600} truncate>
                    {cell.name}
                  </Text>
                  {added && (
                    <Badge size="xs" variant="light" color="gray">
                      Added
                    </Badge>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        });
    } else {
      folder.replicate_groups
        .filter((group) => matches(group.name))
        .forEach((group) => {
          const entry: SelectionEntry = { kind: "replicate_group", ref_id: group.id };
          const key = keyOf(entry);
          const added = has(entry);
          rows.push(
            <Table.Tr
              key={`group-${folder.id}-${group.id}`}
              bg={selected.has(key) ? "teal.0" : undefined}
              style={{ cursor: added ? "default" : "pointer" }}
              onClick={(event) => toggleEntry(entry, event)}
            >
              <Table.Td w={42}>
                <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
              </Table.Td>
              <Table.Td>
                <Group gap={6} pl={(depth + 1) * 16}>
                  <IconLayersIntersect size={14} color="var(--mantine-color-teal-6)" />
                  <div>
                    <Text size="sm" fw={600} truncate>
                      {group.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {group.cell_ids.length} cells
                    </Text>
                  </div>
                  {added && (
                    <Badge size="xs" variant="light" color="gray">
                      Added
                    </Badge>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        });
    }
    folder.children.forEach((child) => rows.push(...renderFolderRows(child, depth + 1)));
    return rows;
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add to plot" size="xl">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(value) => setMode(value as "replicate_group" | "cell")}
            data={[
              { value: "replicate_group", label: "Replicates" },
              { value: "cell", label: "Cells" },
            ]}
          />
          <Switch
            size="sm"
            label="Current branch only"
            checked={branchOnly}
            disabled={!currentFolderId}
            onChange={(event) => setBranchOnly(event.currentTarget.checked)}
          />
        </Group>
        <TextInput
          leftSection={<IconSearch size={15} />}
          placeholder={mode === "cell" ? "Search cells" : "Search replicates"}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <ScrollArea h={420} type="auto">
          <Table highlightOnHover>
            <Table.Tbody>
              {visibleFolders.flatMap((folder) => renderFolderRows(folder, 0))}
              {(!branchOnly || !currentFolderId) && (
                <Table.Tr>
                  <Table.Td colSpan={2}>
                    <Group gap={6}>
                      <IconFolder size={14} color="var(--mantine-color-gray-6)" />
                      <Text size="xs" fw={700} c="dimmed">
                        Outside folders
                      </Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              )}
              {(!branchOnly || !currentFolderId) &&
                mode === "cell" &&
                unfiledCells.map((cell) => {
                  const entry: SelectionEntry = { kind: "cell", ref_id: cell.id };
                  const key = keyOf(entry);
                  const added = has(entry);
                  return (
                    <Table.Tr
                      key={`unfiled-cell-${cell.id}`}
                      bg={selected.has(key) ? "teal.0" : undefined}
                      style={{ cursor: added ? "default" : "pointer" }}
                      onClick={(event) => toggleEntry(entry, event)}
                    >
                      <Table.Td w={42}>
                        <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} pl={16}>
                          <IconDatabase size={14} color="var(--mantine-color-gray-6)" />
                          <Text size="sm" fw={600} truncate>
                            {cell.name}
                          </Text>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              {(!branchOnly || !currentFolderId) &&
                mode === "replicate_group" &&
                unfiledGroups.map((group) => {
                  const entry: SelectionEntry = { kind: "replicate_group", ref_id: group.id };
                  const key = keyOf(entry);
                  const added = has(entry);
                  return (
                    <Table.Tr
                      key={`unfiled-group-${group.id}`}
                      bg={selected.has(key) ? "teal.0" : undefined}
                      style={{ cursor: added ? "default" : "pointer" }}
                      onClick={(event) => toggleEntry(entry, event)}
                    >
                      <Table.Td w={42}>
                        <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} pl={16}>
                          <IconLayersIntersect size={14} color="var(--mantine-color-teal-6)" />
                          <Text size="sm" fw={600} truncate>
                            {group.name}
                          </Text>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {selectedEntries.length} selected
          </Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
            <Button
              disabled={selectedEntries.length === 0}
              leftSection={<IconPlus size={14} />}
              onClick={() => {
                onAdd(selectedEntries);
                setSelected(new Set());
              }}
            >
              Add selected
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function bandSegmentTraces(
  x: number[],
  low: (number | null)[],
  high: (number | null)[],
  color: string,
  opacity: number,
  name: string
): Plotly.Data[] {
  const traces: Plotly.Data[] = [];
  let start: number | null = null;
  const flush = (endExclusive: number) => {
    if (start === null || endExclusive - start < 2) {
      start = null;
      return;
    }
    const xs = x.slice(start, endExclusive);
    const lows = low.slice(start, endExclusive) as number[];
    const highs = high.slice(start, endExclusive) as number[];
    traces.push({
      x: [...xs, ...[...xs].reverse()],
      y: [...highs, ...[...lows].reverse()],
      fill: "toself",
      fillcolor: hexToRgba(color, opacity),
      line: { width: 0 },
      hoverinfo: "skip",
      showlegend: false,
      name,
      type: "scatter",
    } as Plotly.Data);
    start = null;
  };

  for (let index = 0; index < x.length; index += 1) {
    const valid = low[index] !== null && high[index] !== null;
    if (valid && start === null) start = index;
    if (!valid) flush(index);
  }
  flush(x.length);
  return traces;
}

function tracesForResult(result: ComputeResult, spec: AnalysisSpec, compact = false): Plotly.Data[] {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const { column } = resolvedQuantity(result, spec);
  const showCeOverlay = !compact && (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const style = currentPlotStyle(spec, "cycles");
  const palette = PLOT_PALETTES[style.palette] ?? PLOT_PALETTES.app;
  const mode = compact ? "lines" : plotMode(style);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) colorFor.set(key, style.custom_colors[key] ?? palette[ci++ % palette.length]);
    return colorFor.get(key)!;
  };

  for (const agg of result.aggregates) {
    const color = pick(`g${agg.group_id}`);
    const q = agg.quantities[column];
    if (!q) continue;
    if (!compact) {
      out.push(
        ...bandSegmentTraces(
          agg.x,
          q.band_low,
          q.band_high,
          color,
          style.band_opacity,
          `${agg.group_name} band`
        )
      );
    }
    out.push({
      x: agg.x,
      y: q.mean,
      name: compact ? agg.group_name : `${agg.group_name} mean`,
      line: { color, width: compact ? 2 : style.line_width, dash: compact ? "solid" : style.line_dash },
      marker: { color, size: compact ? 3 : style.marker_size },
      type: "scatter",
      mode,
      customdata: q.n,
      hovertemplate: compact
        ? undefined
        : `cycle %{x}: %{y:.4f} (n=%{customdata})<extra>${agg.group_name}</extra>`,
    } as Plotly.Data);
    if (showCeOverlay && agg.quantities["coulombic_efficiency_pct"]) {
      out.push({
        x: agg.x,
        y: agg.quantities["coulombic_efficiency_pct"].mean,
        name: `${agg.group_name} CE`,
        yaxis: "y2",
        line: { color, width: style.ce_line_width, dash: style.ce_line_dash },
        type: "scatter",
        mode: "lines",
        opacity: style.ce_opacity,
      } as Plotly.Data);
    }
  }

  const soloOrIndividual = (s: ComputeResult["cell_series"][number]) =>
    compact ||
    s.group_id === null ||
    spec.presentation.show_individual_cells ||
    result.aggregates.length === 0;

  for (const s of result.cell_series) {
    if (s.excluded || !soloOrIndividual(s)) continue;
    const grouped = s.group_id !== null;
    const color = grouped ? pick(`g${s.group_id}`) : pick(`c${s.cell_id}`);
    out.push({
      x: s.x,
      y: s.quantities[column] ?? [],
      name: s.group_name ? `${s.label} (${s.group_name})` : s.label,
      line: {
        color,
        width: compact ? 1.3 : grouped ? Math.max(1, style.line_width - 1.2) : style.line_width,
        dash: compact ? "solid" : style.line_dash,
      },
      marker: { color, size: compact ? 3 : style.marker_size },
      opacity: compact ? 0.45 : grouped ? style.individual_opacity : 0.95,
      type: "scatter",
      mode,
      showlegend: !compact && !grouped,
    } as Plotly.Data);
    if (showCeOverlay && !grouped && s.quantities["coulombic_efficiency_pct"]) {
      out.push({
        x: s.x,
        y: s.quantities["coulombic_efficiency_pct"],
        name: `${s.label} CE`,
        yaxis: "y2",
        line: { color, width: style.ce_line_width, dash: style.ce_line_dash },
        type: "scatter",
        mode: "lines",
        opacity: style.ce_opacity,
      } as Plotly.Data);
    }
  }
  return out;
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
  } else if (cfg.x_axis === "capacity_mah") {
    raw = numeric(trace.capacity_mah);
    title = "Capacity (mAh)";
  } else {
    const factor = cfg.time_unit === "h" ? 3600 : cfg.time_unit === "min" ? 60 : 1;
    raw = numeric(trace.time_s).map((value) => value / factor);
    title = `Time (${cfg.time_unit})`;
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
      current = { key, phase, x: [], cycle: [], voltage: [], current: [] };
    }
    current.x.push(x[index]);
    current.cycle.push(trace.cycle[index] ?? null);
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
  const area = cfg.electrode_area_cm2 ?? null;
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

function tracesForTimeCapacity(result: TimeCapacityResult, spec: AnalysisSpec): Plotly.Data[] {
  const style = currentPlotStyle(spec, "time_capacity");
  const palette = PLOT_PALETTES[style.palette] ?? PLOT_PALETTES.app;
  const cfg = timeCapacityConfig(spec);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  const legendShown = new Set<string>();
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) colorFor.set(key, style.custom_colors[key] ?? palette[ci++ % palette.length]);
    return colorFor.get(key)!;
  };

  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
    const color = pick(seriesKey);
    const name = trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label;
    for (const segment of timeCapacitySegments(trace, spec)) {
      if (!hasFinitePoint(segment.voltage)) continue;
      const showlegend = !legendShown.has(seriesKey);
      legendShown.add(seriesKey);
      out.push({
        x: segment.x,
        y: segment.voltage,
        name,
        legendgroup: seriesKey,
        showlegend,
        line: { color, width: style.line_width, dash: style.line_dash },
        marker: { color, size: style.marker_size },
        mode: plotMode(style),
        type: "scatter",
        connectgaps: false,
        customdata: segment.cycle,
        hovertemplate: `%{y:.4f} V<br>%{x:.4f}<br>cycle %{customdata}<extra>${name}</extra>`,
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
            type: "scatter",
            connectgaps: false,
            showlegend: false,
            opacity: 0.85,
            customdata: segment.cycle,
            hovertemplate: `%{y:.4f}<br>%{x:.4f}<br>cycle %{customdata}<extra>${currentAxisLabel(left)}</extra>`,
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
              type: "scatter",
              connectgaps: false,
              showlegend: false,
              opacity: 0.75,
              customdata: segment.cycle,
              hovertemplate: `%{y:.4f}<br>%{x:.4f}<br>cycle %{customdata}<extra>${currentAxisLabel(cfg.current_right)}</extra>`,
            } as Plotly.Data);
          }
        }
      }
    }
  }
  return out;
}

function timeCapacityLayout(result: TimeCapacityResult | undefined, spec: AnalysisSpec): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "time_capacity");
  const cfg = timeCapacityConfig(spec);
  const xTitle = result?.cell_traces[0] ? timeCapacityX(result.cell_traces[0], spec).title : "Time (min)";
  const leftCurrentLabel = currentAxisLabel(cfg.current_left ?? "current_ma");
  const rightCurrentLabel = currentAxisLabel(cfg.current_right ?? "none");
  const hasRightCurrent = hasRightCurrentValues(result, spec);
  const rightMargin = hasRightCurrent ? 84 : style.legend_position === "right" ? 140 : 28;
  const ticks = tickLayout(style);
  const baseAxis = {
    showgrid: style.show_grid,
    gridcolor: "#e9ecef",
    zeroline: style.show_zero_line,
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    ...ticks,
  };
  const titleFont = { size: style.axis_title_size };
  return {
    height: cfg.stacked ? 620 : 560,
    margin: { l: 70, r: rightMargin, t: 20, b: 86 },
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size },
    // uirevision together with `matches` axes is a documented plotly.js
    // infinite-relayout trap — skip zoom persistence in stacked mode. In
    // flat mode, key the revision to the x-axis semantics so changing the
    // x quantity/unit/display resets the view instead of keeping stale ranges.
    ...(cfg.stacked
      ? {}
      : {
          uirevision: `${result?.computed_at ?? "no-data"}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`,
        }),
    showlegend: spec.presentation.legend,
    legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
    xaxis: {
      ...baseAxis,
      title: { text: cfg.stacked ? "" : style.x_title ?? xTitle, font: titleFont },
      domain: [0, 1],
      anchor: "y",
      showticklabels: !cfg.stacked,
      ticks: cfg.stacked ? "" : baseAxis.ticks,
      showgrid: cfg.stacked ? false : style.show_grid,
      zeroline: cfg.stacked ? false : style.show_zero_line,
      showline: cfg.stacked ? false : style.show_frame,
      mirror: cfg.stacked ? false : style.show_frame,
      ...(cfg.stacked ? { matches: "x2" as const } : {}),
      ...(cfg.stacked ? {} : axisLayout(style.x_axis)),
    },
    yaxis: {
      ...baseAxis,
      title: { text: style.y_title ?? "Voltage (V)", font: titleFont },
      domain: cfg.stacked ? [0.39, 1] : [0, 1],
      ...axisLayout(style.y_axis),
    },
    ...(cfg.stacked
      ? {
          xaxis2: {
            ...baseAxis,
            title: { text: style.x_title ?? xTitle, font: titleFont },
            domain: [0, 1],
            anchor: "y2",
            ...axisLayout(style.x_axis),
          },
          yaxis2: {
            ...baseAxis,
            title: { text: style.y2_title ?? leftCurrentLabel, font: titleFont },
            domain: [0, 0.39],
            anchor: "x2",
            ...axisLayout(style.y2_axis),
          },
          ...(hasRightCurrent
            ? {
                yaxis3: {
                  ...baseAxis,
                  title: { text: rightCurrentLabel, font: titleFont },
                  overlaying: "y2" as const,
                  side: "right" as const,
                  anchor: "x2",
                  showgrid: false,
                  ...axisLayout(style.y2_axis),
                },
              }
            : {}),
        }
      : {}),
  };
}

function SavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
}) {
  const previewSpec = useMemo(() => specForSavedPlot(baseSpec, plot), [baseSpec, plot]);
  const preview = useQuery({
    queryKey: ["saved-plot-preview", analysisId, plot.id, JSON.stringify(plot)],
    queryFn: () => post<ComputeResult>(`/api/analyses/${analysisId}/compute`, { spec: previewSpec }),
    staleTime: 5 * 60_000,
  });
  const traces = useMemo(
    () => (preview.data ? tracesForResult(preview.data, previewSpec, true) : []),
    [preview.data, previewSpec]
  );

  if (preview.isLoading) {
    return (
      <Center h={120}>
        <Loader size={18} />
      </Center>
    );
  }
  if (traces.length === 0) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          No preview
        </Text>
      </Center>
    );
  }
  const style = currentPlotStyle(previewSpec, "cycles");
  return (
    <Plot
      data={traces}
      layout={{
        height: 130,
        margin: { l: 34, r: 10, t: 8, b: 28 },
        paper_bgcolor: style.paper_bgcolor,
        plot_bgcolor: style.plot_bgcolor,
        xaxis: {
          title: { text: "" },
          showgrid: style.show_grid,
          gridcolor: "#edf2f7",
          zeroline: false,
          showline: style.show_frame,
          mirror: style.show_frame,
          linecolor: style.frame_color,
          linewidth: style.frame_width,
          ...axisLayout(style.x_axis),
        },
        yaxis: {
          title: { text: "" },
          showgrid: style.show_grid,
          gridcolor: "#edf2f7",
          zeroline: style.show_zero_line,
          showline: style.show_frame,
          mirror: style.show_frame,
          linecolor: style.frame_color,
          linewidth: style.frame_width,
          ...axisLayout(style.y_axis),
        },
        showlegend: false,
      }}
      config={{ displaylogo: false, responsive: true, staticPlot: true }}
      style={{ width: "100%" }}
      useResizeHandler
    />
  );
}

function SavedTimeCapacityPreview({
  analysisId,
  baseSpec,
  plot,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
}) {
  const previewSpec = useMemo(() => specForSavedPlot(baseSpec, plot), [baseSpec, plot]);
  const preview = useQuery({
    queryKey: ["saved-time-preview", analysisId, plot.id, JSON.stringify(plot)],
    queryFn: () => post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, { spec: previewSpec }),
    staleTime: 5 * 60_000,
  });
  const traces = useMemo(
    () => (preview.data ? tracesForTimeCapacity(preview.data, previewSpec) : []),
    [preview.data, previewSpec]
  );

  if (preview.isLoading) {
    return (
      <Center h={120}>
        <Loader size={18} />
      </Center>
    );
  }
  if (traces.length === 0) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          No preview
        </Text>
      </Center>
    );
  }
  const style = currentPlotStyle(previewSpec, "time_capacity");
  const cfg = timeCapacityConfig(previewSpec);
  const axis = {
    title: { text: "" },
    showgrid: style.show_grid,
    gridcolor: "#edf2f7",
    zeroline: false,
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    tickfont: { size: 9 },
  };
  return (
    <Plot
      data={traces}
      layout={{
        height: 130,
        margin: { l: 34, r: 10, t: 8, b: 24 },
        paper_bgcolor: style.paper_bgcolor,
        plot_bgcolor: style.plot_bgcolor,
        showlegend: false,
        xaxis: {
          ...axis,
          domain: [0, 1],
          anchor: "y",
          showticklabels: !cfg.stacked,
          ticks: cfg.stacked ? "" : undefined,
        },
        yaxis: { ...axis, domain: cfg.stacked ? [0.46, 1] : [0, 1] },
        ...(cfg.stacked
          ? {
              xaxis2: { ...axis, domain: [0, 1], anchor: "y2" },
              yaxis2: { ...axis, domain: [0, 0.32], anchor: "x2" },
            }
          : {}),
      }}
      config={{ displaylogo: false, responsive: true, staticPlot: true }}
      style={{ width: "100%" }}
      useResizeHandler
    />
  );
}

function MetricsTable({ result }: { result: ComputeResult | undefined }) {
  const metricRows: {
    key: string;
    label: string;
    sub: string | null;
    excluded: boolean;
    values: (string | null)[];
  }[] = [];

  for (const gm of result?.group_metrics ?? []) {
    metricRows.push({
      key: `g${gm.group_id}`,
      label: gm.group_name,
      sub: `replicate aggregate, n=${gm.metrics.n_members as number}`,
      excluded: false,
      values: METRIC_COLUMNS.map((mc) => {
        const v = gm.metrics[mc.key as string];
        if (v === undefined || typeof v === "number") return null;
        return `${fmt(v.mean, mc.digits)}${v.sd !== null ? ` +/- ${fmt(v.sd, mc.digits)}` : ""}`;
      }),
    });
  }

  for (const s of result?.cell_series ?? []) {
    metricRows.push({
      key: `c${s.cell_id}-${s.group_id ?? "solo"}`,
      label: s.group_name ? `${s.label} (${s.group_name})` : s.label,
      sub: s.excluded ? "hidden from plot" : null,
      excluded: s.excluded,
      values: METRIC_COLUMNS.map((mc) => {
        const v = s.metrics[mc.key];
        return v === null || v === undefined ? "-" : fmt(v as number, mc.digits);
      }),
    });
  }

  if (metricRows.length === 0) return <Alert color="gray">No samples selected.</Alert>;

  return (
    <Table.ScrollContainer minWidth={1120}>
      <Table highlightOnHover withTableBorder striped fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Cell / replicate</Table.Th>
            {METRIC_COLUMNS.map((mc) => (
              <Table.Th key={mc.key as string}>{mc.label}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {metricRows.map((row) => (
            <Table.Tr key={row.key} opacity={row.excluded ? 0.5 : 1}>
              <Table.Td>
                <Text size="xs" fw={row.sub?.startsWith("replicate") ? 700 : 500}>
                  {row.label}
                </Text>
                {row.sub && (
                  <Text size="10px" c="dimmed">
                    {row.sub}
                  </Text>
                )}
              </Table.Td>
              {row.values.map((v, i) => (
                <Table.Td key={i}>{v ?? "-"}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function SamplePanel({
  spec,
  groups,
  cells,
  onAdd,
  onRemoveEntry,
  onToggleCell,
}: {
  spec: AnalysisSpec;
  groups: ReplicateGroupSummary[];
  cells: CellSummary[];
  onAdd: () => void;
  onRemoveEntry: (index: number) => void;
  onToggleCell: (cellId: number) => void;
}) {
  const hidden = new Set(spec.selection.exclusions.map((e) => e.cell_id));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const cellById = new Map(cells.map((c) => [c.id, c]));

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">
          Plot samples
        </Text>
        <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={onAdd}>
          Add
        </Button>
      </Group>
      {spec.selection.entries.length === 0 ? (
        <Text size="xs" c="dimmed">
          No cells or replicates selected.
        </Text>
      ) : (
        <Stack gap="xs">
          {spec.selection.entries.map((entry, index) => {
            if (entry.kind === "replicate_group") {
              const group = groupById.get(entry.ref_id);
              return (
                <Box key={`${entry.kind}-${entry.ref_id}-${index}`}>
                  <Group justify="space-between" gap={6} wrap="nowrap">
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={700} truncate>
                        {group?.name ?? `replicate #${entry.ref_id}`}
                      </Text>
                      <Text size="10px" c="dimmed" tt="uppercase">
                        Replicate
                      </Text>
                    </Box>
                    <Tooltip label="Remove replicate from this plot">
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => onRemoveEntry(index)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  <Stack gap={2} mt={4} pl="md">
                    {(group?.cells ?? []).map((cell) => {
                      const isHidden = hidden.has(cell.id);
                      return (
                        <Group key={cell.id} justify="space-between" gap={6} wrap="nowrap">
                          <Text size="xs" c={isHidden ? "dimmed" : undefined} truncate>
                            {cell.name}
                          </Text>
                          <Tooltip label={isHidden ? "Show in plot" : "Hide from plot"}>
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color={isHidden ? "gray" : "teal"}
                              onClick={() => onToggleCell(cell.id)}
                            >
                              {isHidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      );
                    })}
                  </Stack>
                </Box>
              );
            }
            const cell = cellById.get(entry.ref_id);
            const isHidden = hidden.has(entry.ref_id);
            return (
              <Group key={`${entry.kind}-${entry.ref_id}-${index}`} justify="space-between" gap={6} wrap="nowrap">
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm" fw={700} truncate>
                    {cell?.name ?? `cell #${entry.ref_id}`}
                  </Text>
                  <Text size="10px" c="dimmed" tt="uppercase">
                    Cell
                  </Text>
                </Box>
                <Group gap={2} wrap="nowrap">
                  <Tooltip label={isHidden ? "Show in plot" : "Hide from plot"}>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color={isHidden ? "gray" : "teal"}
                      onClick={() => onToggleCell(entry.ref_id)}
                    >
                      {isHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove cell from this plot">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() => onRemoveEntry(index)}
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

function CycleSettings({
  spec,
  result,
  update,
}: {
  spec: AnalysisSpec;
  result: ComputeResult | undefined;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const polarizationSelected = isPolarizationQuantity(quantity);
  const canNormalizeByMass = isMassNormalizableQuantity(quantity);
  return (
    <Paper p="sm" withBorder>
      <Accordion
        key={polarizationSelected ? "polarization" : "standard"}
        multiple
        defaultValue={polarizationSelected ? ["plot", "polarization"] : ["plot"]}
      >
        <Accordion.Item value="plot">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Plot settings
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Select
                label="Quantity"
                data={(result?.quantities ?? []).map((q) => ({ value: q.key, label: q.label }))}
                value={quantity}
                onChange={(v) =>
                  v &&
                  update((s) => {
                    s.presentation.quantity = v;
                    if (!isMassNormalizableQuantity(v)) s.presentation.normalize_by_mass = false;
                  })
                }
              />
              {canNormalizeByMass && (
                <Switch
                  label="Normalize by g"
                  checked={Boolean(spec.presentation.normalize_by_mass)}
                  onChange={(e) =>
                    update((s) => void (s.presentation.normalize_by_mass = e.currentTarget.checked))
                  }
                />
              )}
              {CAPACITY_LIKE_KEYS.has(quantity) && (
                <Switch
                  label="CE on right axis"
                  checked={spec.presentation.ce_overlay}
                  onChange={(e) =>
                    update((s) => void (s.presentation.ce_overlay = e.currentTarget.checked))
                  }
                />
              )}
              <Switch
                label="Individual cells"
                checked={spec.presentation.show_individual_cells}
                onChange={(e) =>
                  update((s) => void (s.presentation.show_individual_cells = e.currentTarget.checked))
                }
              />
              <Select
                label="Replicates"
                data={[
                  { value: "replicate_mean", label: "Mean with band" },
                  { value: "none", label: "Cells only" },
                ]}
                value={spec.aggregation.mode}
                onChange={(v) =>
                  v && update((s) => void (s.aggregation.mode = v as "replicate_mean" | "none"))
                }
              />
              <Select
                label="Band"
                data={[
                  { value: "std", label: "Standard deviation" },
                  { value: "sem", label: "SEM" },
                  { value: "minmax", label: "Min-max" },
                  { value: "percentile", label: "10-90 percentile" },
                ]}
                value={spec.aggregation.dispersion}
                onChange={(v) =>
                  v &&
                  update(
                    (s) => void (s.aggregation.dispersion = v as AnalysisSpec["aggregation"]["dispersion"])
                  )
                }
              />
              <DebouncedNumberInput
                label="Min cells for band"
                min={1}
                value={spec.aggregation.min_n_for_band}
                onCommit={(v) => update((s) => void (s.aggregation.min_n_for_band = v ?? 2))}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {polarizationSelected && (
          <Accordion.Item value="polarization">
            <Accordion.Control>
              <Text fw={700} size="sm">
                Polarization
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                <Select
                  label="Voltage pair"
                  data={POLARIZATION_METHOD_OPTIONS}
                  value={spec.computation.polarization.method}
                  onChange={(v) =>
                    v &&
                    update(
                      (s) =>
                        void (s.computation.polarization.method =
                          v as AnalysisSpec["computation"]["polarization"]["method"])
                    )
                  }
                />
                <Select
                  label="Direction"
                  data={POLARIZATION_DIRECTION_OPTIONS}
                  value={spec.computation.polarization.direction}
                  onChange={(v) =>
                    v &&
                    update(
                      (s) =>
                        void (s.computation.polarization.direction =
                          v as AnalysisSpec["computation"]["polarization"]["direction"])
                    )
                  }
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}

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
                  value={spec.computation.cycle_range.start}
                  onCommit={(v) => update((s) => void (s.computation.cycle_range.start = v))}
                />
                <DebouncedNumberInput
                  label="To"
                  placeholder="end"
                  min={1}
                  value={spec.computation.cycle_range.end}
                  onCommit={(v) => update((s) => void (s.computation.cycle_range.end = v))}
                />
              </Group>
              <DebouncedNumberInput
                label="Skip every Nth"
                min={0}
                value={spec.computation.exclude_check_cycles_every_n}
                onCommit={(v) =>
                  update((s) => void (s.computation.exclude_check_cycles_every_n = v ?? 0))
                }
              />
              <Select
                label="Retention reference"
                data={[
                  { value: "max_first_n", label: "Max in first N cycles" },
                  { value: "cycle", label: "Specific cycle" },
                ]}
                value={spec.computation.retention_reference.mode}
                onChange={(v) =>
                  v &&
                  update(
                    (s) => void (s.computation.retention_reference.mode = v as "max_first_n" | "cycle")
                  )
                }
              />
              {spec.computation.retention_reference.mode === "max_first_n" ? (
                <DebouncedNumberInput
                  label="First N"
                  min={1}
                  value={spec.computation.retention_reference.n}
                  onCommit={(v) => update((s) => void (s.computation.retention_reference.n = v ?? 5))}
                />
              ) : (
                <DebouncedNumberInput
                  label="Reference cycle"
                  min={1}
                  value={spec.computation.retention_reference.cycle ?? 3}
                  onCommit={(v) => update((s) => void (s.computation.retention_reference.cycle = v ?? 3))}
                />
              )}
              <DebouncedNumberInput
                label="Formation cycles"
                min={0}
                value={spec.computation.formation_cycles}
                onCommit={(v) => update((s) => void (s.computation.formation_cycles = v ?? 0))}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

function TimeCapacitySettings({
  spec,
  update,
}: {
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const cfg = timeCapacityConfig(spec);
  const cyclesText = (cfg.cycles ?? []).join(", ");
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
                label="X axis"
                data={[
                  { value: "time", label: "Time" },
                  { value: "capacity_mah", label: "Capacity (mAh)" },
                  { value: "capacity_mah_g", label: "Specific capacity (mAh/g)" },
                ]}
                value={cfg.x_axis}
                onChange={(value) =>
                  value &&
                  updateTime(
                    (next) => void (next.x_axis = value as TimeCapacityConfig["x_axis"])
                  )
                }
              />
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
                    updateTime(
                      (next) => void (next.time_unit = value as TimeCapacityConfig["time_unit"])
                    )
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
                  updateTime(
                    (next) =>
                      void (next.display_mode = value as TimeCapacityConfig["display_mode"])
                  )
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
                  {needsArea && (
                    <DebouncedNumberInput
                      label="Electrode area (cm2)"
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

// Freeze every visible series' current color into custom_colors so that
// switching to the custom palette (explicitly or by editing one color)
// never repaints the untouched series.
function snapshotPaletteColors(
  style: PlotStyle,
  targets: { key: string; label: string; sub: string }[]
): void {
  const palette = PLOT_PALETTES[style.palette] ?? PLOT_PALETTES.app;
  targets.forEach((target, index) => {
    if (!style.custom_colors[target.key]) {
      style.custom_colors[target.key] = palette[index % palette.length];
    }
  });
}

function plotColorTargets(
  result: ComputeResult | TimeCapacityResult | undefined
): { key: string; label: string; sub: string }[] {
  const targets: { key: string; label: string; sub: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, sub: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ key, label, sub });
  };

  if (result && "cell_traces" in result) {
    for (const s of result.cell_traces) {
      if (s.group_id !== null) add(`g${s.group_id}`, s.group_name ?? `replicate #${s.group_id}`, "replicate");
      else add(`c${s.cell_id}`, s.label, "cell");
    }
    return targets;
  }

  for (const agg of result?.aggregates ?? []) add(`g${agg.group_id}`, agg.group_name, "replicate");
  for (const s of result?.cell_series ?? []) {
    if (s.group_id !== null) add(`g${s.group_id}`, s.group_name ?? `replicate #${s.group_id}`, "replicate");
    else add(`c${s.cell_id}`, s.label, "cell");
  }
  return targets;
}

function PlotStylePanel({
  opened,
  spec,
  result,
  update,
  onToggle,
  axisScope = "cycles",
}: {
  opened: boolean;
  spec: AnalysisSpec;
  result: ComputeResult | TimeCapacityResult | undefined;
  update: (fn: (s: AnalysisSpec) => void) => void;
  onToggle: () => void;
  axisScope?: AnalysisTabKey;
}) {
  const style = currentPlotStyle(spec, axisScope);
  const colorTargets = plotColorTargets(result);
  const computeResult = result && "cell_traces" in result ? undefined : result;
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const ceOverlayActive =
    axisScope === "cycles" && (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const timeCapacityStacked = axisScope === "time_capacity" && timeCapacityConfig(spec).stacked;
  const showRightAxisControls = ceOverlayActive || timeCapacityStacked;
  const setStyle = (fn: (style: PlotStyle) => void) => {
    update((s) => writeScopedStyle(s, axisScope, fn));
  };
  const setAxisTitle = (key: "x_title" | "y_title" | "y2_title", value: string) => {
    setStyle((next) => void (next[key] = value || null));
  };
  const setAxis = (axis: "x_axis" | "y_axis" | "y2_axis", fn: (axis: PlotStyle["x_axis"]) => void) => {
    setStyle((next) => {
      next[axis] = { ...next[axis] };
      fn(next[axis]);
    });
  };

  if (!opened) {
    return (
      <Paper
        withBorder
        p={4}
        style={{ width: 42, flexShrink: 0, display: "flex", alignItems: "center", flexDirection: "column" }}
      >
        <Tooltip label="Show plot style">
          <ActionIcon variant="subtle" onClick={onToggle} mt={4}>
            <IconChevronLeft size={16} />
          </ActionIcon>
        </Tooltip>
        <Text
          size="xs"
          c="dimmed"
          mt="sm"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Style
        </Text>
      </Paper>
    );
  }

  return (
    <Paper
      withBorder
      p="sm"
      style={{ width: 310, flexShrink: 0, maxHeight: 590, overflowY: "auto" }}
    >
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">
          Plot style
        </Text>
        <Tooltip label="Hide plot style">
          <ActionIcon variant="subtle" onClick={onToggle}>
            <IconChevronRight size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Accordion multiple defaultValue={["colors", "axes"]}>
        <Accordion.Item value="colors">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Colors
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Select
                label="Palette"
                data={PALETTE_OPTIONS}
                value={style.palette}
                onChange={(value) =>
                  value &&
                  setStyle((next) => {
                    if (value === "custom") {
                      // freeze the CURRENT colors so nothing jumps
                      snapshotPaletteColors(next, colorTargets);
                    } else {
                      next.custom_colors = {};
                    }
                    next.palette = value as PlotStyle["palette"];
                  })
                }
              />
              {colorTargets.length > 0 && (
                <Stack gap={6}>
                  {colorTargets.map((target, index) => {
                    const fallback = PLOT_PALETTES[style.palette][index % PLOT_PALETTES[style.palette].length];
                    return (
                      <DebouncedColorInput
                        key={target.key}
                        label={target.label}
                        description={target.sub}
                        value={style.custom_colors[target.key] ?? fallback}
                        format="hex"
                        onCommit={(value) =>
                          setStyle((next) => {
                            if (next.palette !== "custom") {
                              // editing one series must not repaint the others:
                              // snapshot the active palette before going custom
                              snapshotPaletteColors(next, colorTargets);
                              next.palette = "custom";
                            }
                            next.custom_colors[target.key] = value;
                          })
                        }
                        swatches={COLOR_SWATCHES}
                        swatchesPerRow={8}
                      />
                    );
                  })}
                </Stack>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="lines">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Lines
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Group grow>
                <DebouncedNumberInput
                  label="Width"
                  min={0.5}
                  max={8}
                  step={0.25}
                  value={style.line_width}
                  onCommit={(value) =>
                    setStyle((next) => void (next.line_width = value ?? 2.5))
                  }
                />
                <Select
                  label="Dash"
                  data={[
                    { value: "solid", label: "Solid" },
                    { value: "dot", label: "Dot" },
                    { value: "dash", label: "Dash" },
                    { value: "longdash", label: "Long dash" },
                  ]}
                  value={style.line_dash}
                  onChange={(value) =>
                    value && setStyle((next) => void (next.line_dash = value as PlotStyle["line_dash"]))
                  }
                />
              </Group>
              <Group grow>
                <Select
                  label="Markers"
                  data={[
                    { value: "none", label: "None" },
                    { value: "points", label: "Points" },
                    { value: "lines_points", label: "Lines + points" },
                  ]}
                  value={style.marker_mode}
                  onChange={(value) =>
                    value && setStyle((next) => void (next.marker_mode = value as PlotStyle["marker_mode"]))
                  }
                />
                <DebouncedNumberInput
                  label="Size"
                  min={2}
                  max={14}
                  value={style.marker_size}
                  onCommit={(value) =>
                    setStyle((next) => void (next.marker_size = value ?? 5))
                  }
                />
              </Group>
              <Group grow>
                <DebouncedNumberInput
                  label="Cells opacity"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={style.individual_opacity}
                  onCommit={(value) =>
                    setStyle((next) => void (next.individual_opacity = value ?? 0.35))
                  }
                />
                <DebouncedNumberInput
                  label="Band opacity"
                  min={0.02}
                  max={0.6}
                  step={0.02}
                  value={style.band_opacity}
                  onCommit={(value) =>
                    setStyle((next) => void (next.band_opacity = value ?? 0.18))
                  }
                />
              </Group>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="axes">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Axes
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <DebouncedTextInput
                label="X title"
                placeholder={axisScope === "time_capacity" ? "Time / capacity" : "Cycle"}
                value={style.x_title ?? ""}
                onCommit={(value) => setAxisTitle("x_title", value)}
              />
              <DebouncedTextInput
                label="Y title"
                placeholder={computeResult ? quantityLabel(computeResult, spec) : "Voltage (V)"}
                value={style.y_title ?? ""}
                onCommit={(value) => setAxisTitle("y_title", value)}
              />
              <Select
                label="X range"
                data={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
                value={style.x_axis.mode}
                onChange={(value) =>
                  value && setAxis("x_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                }
              />
              {style.x_axis.mode === "manual" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="X min"
                    placeholder="Auto"
                    value={style.x_axis.min}
                    onCommit={(value) => setAxis("x_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="X max"
                    placeholder="Auto"
                    value={style.x_axis.max}
                    onCommit={(value) => setAxis("x_axis", (axis) => void (axis.max = value))}
                  />
                </Group>
              )}
              <Select
                label="Y range"
                data={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
                value={style.y_axis.mode}
                onChange={(value) =>
                  value && setAxis("y_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                }
              />
              {style.y_axis.mode === "manual" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="Y min"
                    placeholder="Auto"
                    value={style.y_axis.min}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="Y max"
                    placeholder="Auto"
                    value={style.y_axis.max}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.max = value))}
                  />
                </Group>
              )}
              <Text size="10px" c="dimmed">
                Leave one bound empty to clamp only that side.
              </Text>
              <Group grow>
                <DebouncedNumberInput
                  label="X tick step"
                  placeholder="Auto"
                  min={0}
                  value={style.x_axis.dtick}
                  onCommit={(value) =>
                    setAxis("x_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                  }
                />
                <DebouncedNumberInput
                  label="Y tick step"
                  placeholder="Auto"
                  min={0}
                  value={style.y_axis.dtick}
                  onCommit={(value) =>
                    setAxis("y_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                  }
                />
              </Group>
              {showRightAxisControls && (
                <>
                  <Divider label={ceOverlayActive ? "Right axis (CE)" : "Second current axis"} labelPosition="left" />
                  <DebouncedTextInput
                    label="Right axis title"
                    placeholder={ceOverlayActive ? "CE (%)" : "Current / C-rate"}
                    value={style.y2_title ?? ""}
                    onCommit={(value) => setAxisTitle("y2_title", value)}
                  />
                  <Select
                    label="Right axis range"
                    data={[
                      { value: "auto", label: "Auto" },
                      { value: "manual", label: "Manual" },
                    ]}
                    value={style.y2_axis.mode}
                    onChange={(value) =>
                      value && setAxis("y2_axis", (axis) => void (axis.mode = value as "auto" | "manual"))
                    }
                  />
                  {style.y2_axis.mode === "manual" && (
                    <Group grow>
                      <DebouncedNumberInput
                        label="Right min"
                        placeholder="Auto"
                        value={style.y2_axis.min}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.min = value))}
                      />
                      <DebouncedNumberInput
                        label="Right max"
                        placeholder="Auto"
                        value={style.y2_axis.max}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.max = value))}
                      />
                    </Group>
                  )}
                  <DebouncedNumberInput
                    label="Right tick step"
                    placeholder="Auto"
                    min={0}
                    value={style.y2_axis.dtick}
                    onCommit={(value) =>
                      setAxis("y2_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                    }
                  />
                  {ceOverlayActive && (
                    <>
                      <Divider label="CE line" labelPosition="left" />
                      <Group grow>
                        <DebouncedNumberInput
                          label="CE width"
                          min={0.5}
                          max={8}
                          step={0.25}
                          value={style.ce_line_width}
                          onCommit={(value) => setStyle((next) => void (next.ce_line_width = value ?? 1.5))}
                        />
                        <Select
                          label="CE dash"
                          data={[
                            { value: "solid", label: "Solid" },
                            { value: "dot", label: "Dot" },
                            { value: "dash", label: "Dash" },
                            { value: "longdash", label: "Long dash" },
                          ]}
                          value={style.ce_line_dash}
                          onChange={(value) =>
                            value &&
                            setStyle((next) => void (next.ce_line_dash = value as PlotStyle["ce_line_dash"]))
                          }
                        />
                      </Group>
                      <DebouncedNumberInput
                        label="CE opacity"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={style.ce_opacity}
                        onCommit={(value) => setStyle((next) => void (next.ce_opacity = value ?? 0.7))}
                      />
                    </>
                  )}
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="fonts">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Fonts and ticks
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Group grow>
                <DebouncedNumberInput
                  label="Axis title size"
                  min={6}
                  max={40}
                  value={style.axis_title_size}
                  onCommit={(value) => setStyle((next) => void (next.axis_title_size = value ?? 14))}
                />
                <DebouncedNumberInput
                  label="Tick label size"
                  min={5}
                  max={32}
                  value={style.tick_font_size}
                  onCommit={(value) => setStyle((next) => void (next.tick_font_size = value ?? 12))}
                />
              </Group>
              <DebouncedNumberInput
                label="Legend size"
                min={5}
                max={32}
                value={style.legend_font_size}
                onCommit={(value) => setStyle((next) => void (next.legend_font_size = value ?? 12))}
              />
              <Select
                label="Tick marks"
                data={[
                  { value: "none", label: "None" },
                  { value: "outside", label: "Outside" },
                  { value: "inside", label: "Inside" },
                ]}
                value={style.tick_marks}
                onChange={(value) =>
                  value && setStyle((next) => void (next.tick_marks = value as PlotStyle["tick_marks"]))
                }
              />
              {style.tick_marks !== "none" && (
                <Group grow>
                  <DebouncedNumberInput
                    label="Tick length"
                    min={1}
                    max={20}
                    value={style.tick_length}
                    onCommit={(value) => setStyle((next) => void (next.tick_length = value ?? 5))}
                  />
                  <DebouncedNumberInput
                    label="Tick width"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={style.tick_width}
                    onCommit={(value) => setStyle((next) => void (next.tick_width = value ?? 1))}
                  />
                </Group>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="frame">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Grid and frame
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Switch
                label="Grid"
                checked={style.show_grid}
                onChange={(event) =>
                  setStyle((next) => void (next.show_grid = event.currentTarget.checked))
                }
              />
              <Switch
                label="Zero line (Y)"
                checked={style.show_zero_line}
                onChange={(event) =>
                  setStyle((next) => void (next.show_zero_line = event.currentTarget.checked))
                }
              />
              <Switch
                label="Border"
                checked={style.show_frame}
                onChange={(event) =>
                  setStyle((next) => void (next.show_frame = event.currentTarget.checked))
                }
              />
              <Group grow>
                <DebouncedColorInput
                  label="Border color"
                  value={style.frame_color}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.frame_color = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
                <DebouncedNumberInput
                  label="Border width"
                  min={1}
                  max={5}
                  value={style.frame_width}
                  onCommit={(value) => setStyle((next) => void (next.frame_width = value ?? 1))}
                />
              </Group>
              <Group grow>
                <DebouncedColorInput
                  label="Plot bg"
                  value={style.plot_bgcolor}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.plot_bgcolor = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
                <DebouncedColorInput
                  label="Paper bg"
                  value={style.paper_bgcolor}
                  format="hex"
                  onCommit={(value) => setStyle((next) => void (next.paper_bgcolor = value))}
                  swatches={COLOR_SWATCHES}
                  swatchesPerRow={8}
                />
              </Group>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="legend">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Legend
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Switch
                label="Legend"
                checked={spec.presentation.legend}
                onChange={(event) =>
                  update((s) => void (s.presentation.legend = event.currentTarget.checked))
                }
              />
              <Select
                label="Position"
                data={[
                  { value: "bottom", label: "Bottom" },
                  { value: "right", label: "Right" },
                  { value: "top", label: "Top" },
                  { value: "inside", label: "Inside" },
                ]}
                value={style.legend_position}
                onChange={(value) =>
                  value &&
                  setStyle((next) => void (next.legend_position = value as PlotStyle["legend_position"]))
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

function PlotHeader({
  plotName,
  subtitle,
  onExport,
  style,
  updateStyle,
  viewSize,
  canExport = false,
}: {
  plotName: string;
  subtitle: string;
  onExport?: (format: PlotExportFormat) => void;
  style?: PlotStyle;
  updateStyle?: (fn: (style: PlotStyle) => void) => void;
  viewSize?: { width: number; height: number } | null;
  canExport?: boolean;
}) {
  const exportStyle = style ?? DEFAULT_PLOT_STYLE;
  const selectedFormat = exportStyle.export_format ?? "png";
  const ratio =
    exportStyle.export_aspect_ratio === "custom"
      ? Math.max(0.1, exportStyle.export_width / exportStyle.export_height)
      : aspectRatioValue(
          exportStyle.export_aspect_ratio,
          (viewSize?.width ?? exportStyle.export_width) / (viewSize?.height ?? exportStyle.export_height)
        );
  const exportWidthValue = exportStyle.export_width || viewSize?.width || DEFAULT_PLOT_STYLE.export_width;
  const exportHeightValue =
    exportStyle.export_aspect_ratio === "custom"
      ? exportStyle.export_height
      : Math.max(240, Math.round(exportWidthValue / ratio));
  const setExportStyle = (fn: (style: PlotStyle) => void) => updateStyle?.(fn);
  const setAspect = (value: PlotAspectRatioKey) => {
    setExportStyle((next) => {
      next.export_aspect_ratio = value;
      if (value !== "view" && value !== "custom") {
        next.export_height = Math.round(next.export_width / aspectRatioValue(value, next.export_width / next.export_height));
      }
    });
  };
  const setExportWidth = (value: number) => {
    setExportStyle((next) => {
      next.export_width = value;
      if (next.export_aspect_ratio !== "custom" && next.export_aspect_ratio !== "view") {
        next.export_height = Math.round(value / aspectRatioValue(next.export_aspect_ratio, value / next.export_height));
      }
    });
  };

  return (
    <Group justify="space-between" mb="xs" align="start">
      <div>
        <Text fw={800} size="lg">
          {plotName}
        </Text>
        <Text size="sm" c="dimmed">
          {subtitle}
        </Text>
      </div>
      {onExport && (
        <Button.Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            disabled={!canExport}
            onClick={() => onExport(selectedFormat)}
          >
            {selectedFormat.toUpperCase()}
          </Button>
          <Popover withinPortal position="bottom-end" shadow="md" width={320}>
            <Popover.Target>
              <ActionIcon size={30} variant="default" disabled={!canExport} aria-label="Export settings">
                <IconChevronDown size={16} />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Select
                  label="Format"
                  data={EXPORT_FORMAT_OPTIONS}
                  value={selectedFormat}
                  comboboxProps={{ withinPortal: false }}
                  onChange={(value) =>
                    value && setExportStyle((next) => void (next.export_format = value as PlotExportFormat))
                  }
                />
                <Select
                  label="Aspect ratio"
                  data={ASPECT_RATIO_OPTIONS}
                  value={exportStyle.export_aspect_ratio}
                  comboboxProps={{ withinPortal: false }}
                  onChange={(value) => value && setAspect(value as PlotAspectRatioKey)}
                />
                <Group grow>
                  <NumberInput
                    label="Output width px"
                    min={320}
                    step={100}
                    value={exportWidthValue}
                    onChange={(value) => typeof value === "number" && setExportWidth(value)}
                  />
                  <NumberInput
                    label="Output height px"
                    min={240}
                    step={100}
                    disabled={exportStyle.export_aspect_ratio !== "custom"}
                    value={exportHeightValue}
                    onChange={(value) =>
                      typeof value === "number" &&
                      setExportStyle((next) => void (next.export_height = value))
                    }
                  />
                </Group>
                <NumberInput
                  label="PPI"
                  description={selectedFormat === "svg" ? "Ignored for SVG (vector)" : undefined}
                  min={36}
                  max={1200}
                  step={24}
                  value={exportStyle.export_ppi}
                  onChange={(value) =>
                    setExportStyle((next) => void (next.export_ppi = typeof value === "number" ? value : 96))
                  }
                />
                <Switch
                  label="Include title in figure"
                  checked={exportStyle.export_include_title}
                  onChange={(event) =>
                    setExportStyle((next) => void (next.export_include_title = event.currentTarget.checked))
                  }
                />
                <Button fullWidth leftSection={<IconDownload size={14} />} onClick={() => onExport(selectedFormat)}>
                  Download {selectedFormat.toUpperCase()}
                </Button>
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </Button.Group>
      )}
    </Group>
  );
}

function cyclePlotLayout(result: ComputeResult | undefined, spec: AnalysisSpec): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "cycles");
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = resolvedQuantity(result, spec);
  const showCeOverlay = (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const rightMargin = style.legend_position === "right" ? 140 : showCeOverlay ? 64 : 24;
  const topMargin = style.legend_position === "top" ? 56 : 20;
  const ticks = tickLayout(style);
  const axisBase = {
    showgrid: style.show_grid,
    gridcolor: "#edf2f7",
    zeroline: false,
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    ...ticks,
  };
  const titleFont = { size: style.axis_title_size };

  return {
    height: 500,
    margin: { l: 66, r: rightMargin, t: topMargin, b: 58 },
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size },
    // keep the user's zoom/pan across STYLE edits, but reset the view when
    // the data or the plotted quantity changes — otherwise switching e.g.
    // from CE (~99) to capacity (~120 mAh) kept the old ranges and showed
    // an empty plot
    uirevision: `${result?.computed_at ?? "no-data"}|${quantity}|${spec.presentation.normalize_by_mass ? "g" : "abs"}`,
    xaxis: {
      ...axisBase,
      title: { text: style.x_title ?? "Cycle", font: titleFont },
      ...axisLayout(style.x_axis),
    },
    yaxis: {
      ...axisBase,
      // zero line only makes sense on the value axis of a cycle plot
      zeroline: style.show_zero_line,
      zerolinecolor: "#adb5bd",
      title: { text: style.y_title ?? quantityInfo?.label ?? "", font: titleFont },
      ...axisLayout(style.y_axis),
    },
    ...(showCeOverlay
      ? {
          yaxis2: {
            title: { text: style.y2_title ?? "CE (%)", font: titleFont },
            overlaying: "y" as const,
            side: "right" as const,
            showgrid: false,
            zeroline: false,
            showline: style.show_frame,
            linecolor: style.frame_color,
            linewidth: style.frame_width,
            ...ticks,
            ...axisLayout(style.y2_axis),
          },
        }
      : {}),
    showlegend: spec.presentation.legend,
    legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
  };
}

// Keep the Plotly graph exactly as wide as its container, loop-free.
//
// The sync compares the RENDERED plot width against the container width and
// resizes only while they disagree (>1px) — a fixed point, so it cannot
// oscillate: after Plots.resize the two are equal and the guard blocks any
// further call. It runs when the container changes size (ResizeObserver)
// AND after every plot init/update, so both stuck states self-heal: a plot
// mounted mid-layout that stayed too small, and a plot left overflowing
// after the container shrank (where the container itself never re-fires).
// Deterministic zoom persistence. Plotly's own uirevision keeps trace UI
// state but drops interactive axis ranges whenever we hand it a rebuilt
// axis object (every style edit). So we remember GUI zooms ourselves:
// onRelayout records the ranges together with the current view signature,
// apply() re-injects them into freshly built layouts while the signature
// still matches, and a double-click autoscale (or a signature change, e.g.
// a different quantity) clears the memory so the view autoranges again.
type ZoomMemory = {
  onRelayout: (event: Readonly<Plotly.PlotRelayoutEvent>) => void;
  apply: (layout: Partial<Plotly.Layout>) => Partial<Plotly.Layout>;
};

function useZoomMemory(signature: string, enabled = true): ZoomMemory {
  const stored = useRef<{
    signature: string;
    x?: [number, number];
    y?: [number, number];
  } | null>(null);

  const onRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    if (!enabled) return;
    const ev = event as Record<string, unknown>;
    if (ev["xaxis.autorange"] === true || ev["yaxis.autorange"] === true) {
      stored.current = null; // double-click reset
      return;
    }
    const xr0 = ev["xaxis.range[0]"];
    const xr1 = ev["xaxis.range[1]"];
    const yr0 = ev["yaxis.range[0]"];
    const yr1 = ev["yaxis.range[1]"];
    const hasX = typeof xr0 === "number" && typeof xr1 === "number";
    const hasY = typeof yr0 === "number" && typeof yr1 === "number";
    if (!hasX && !hasY) return; // resize/autosize events etc.
    const prev = stored.current?.signature === signature ? stored.current : null;
    stored.current = {
      signature,
      x: hasX ? [xr0 as number, xr1 as number] : prev?.x,
      y: hasY ? [yr0 as number, yr1 as number] : prev?.y,
    };
  };

  const apply = (layout: Partial<Plotly.Layout>): Partial<Plotly.Layout> => {
    const mem = stored.current;
    if (!enabled || !mem || mem.signature !== signature) return layout;
    const out = { ...layout } as Record<string, unknown>;
    if (mem.x) out.xaxis = { ...(layout.xaxis ?? {}), range: [...mem.x], autorange: false };
    if (mem.y) out.yaxis = { ...(layout.yaxis ?? {}), range: [...mem.y], autorange: false };
    return out as Partial<Plotly.Layout>;
  };

  return { onRelayout, apply };
}

function usePlotSizeSync(plotDivRef: { current: HTMLElement | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  const sync = () => {
    if (frameRef.current !== null) return; // coalesce bursts into one frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const gd = plotDivRef.current;
      const box = containerRef.current;
      if (!gd || !box || !gd.isConnected) return;
      const target = Math.round(box.clientWidth);
      if (target < 10) return; // hidden/degenerate — never resize into 0
      const full = (gd as unknown as { _fullLayout?: { width?: number } })._fullLayout;
      const current = Math.round(full?.width ?? gd.clientWidth);
      if (Math.abs(current - target) <= 1) return; // converged
      try {
        (PlotlyLib as unknown as { Plots: { resize: (gd: HTMLElement) => void } }).Plots.resize(gd);
      } catch {
        // plot may be mid-unmount; ignore
      }
    });
  };

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => sync());
    observer.observe(box);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, sync };
}

function CyclePlotCard({
  plotName,
  subtitle,
  result,
  spec,
  update,
  updating,
  error,
}: {
  plotName: string;
  subtitle: string;
  result: ComputeResult | undefined;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
  updating: boolean;
  error: Error | null;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  // Rebuild traces/layout only when the fields they actually read change —
  // unrelated spec edits (other tabs' styles, autosave echoes) must not
  // trigger a full Plotly re-render.
  const viewSignature = useMemo(
    () =>
      JSON.stringify({
        quantity: spec.presentation.quantity,
        ce: spec.presentation.ce_overlay,
        individual: spec.presentation.show_individual_cells,
        legend: spec.presentation.legend,
        style: currentPlotStyle(spec, "cycles"),
      }),
    [spec]
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const traces = useMemo(() => (result ? tracesForResult(result, spec) : []), [result, viewSignature]);
  const zoomSignature = `${result?.computed_at ?? "no-data"}|${spec.presentation.quantity}|${
    spec.presentation.normalize_by_mass ? "g" : "abs"
  }`;
  const zoom = useZoomMemory(zoomSignature);
  const layout = useMemo(
    () => zoom.apply(cyclePlotLayout(result, spec)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, viewSignature]
  );
  const style = currentPlotStyle(spec, "cycles");
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
    update((s) => writeScopedStyle(s, "cycles", fn));
  };

  const exportPlot = async (format: PlotExportFormat) => {
    if (!plotDivRef.current || !result) return;
    try {
      const plan = resolveExportPlan(style, plotDivRef.current);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(plotName);
      // Render off the live figure with an export-only layout (exact size,
      // optional in-figure title) so the on-screen plot is never disturbed.
      const exportLayout: Partial<Plotly.Layout> = {
        ...layout,
        width: plan.layoutWidth,
        height: plan.layoutHeight,
        autosize: false,
      };
      if (style.export_include_title) {
        exportLayout.title = { text: plotName, font: { size: style.axis_title_size + 3 } };
        exportLayout.margin = { ...(layout.margin as object), t: Math.max(48, style.axis_title_size + 34) };
      }
      const figure = { data: traces, layout: exportLayout };
      const toImage = (
        PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
      ).toImage;

      if (format === "pdf") {
        const svgUrl = await toImage(figure, {
          format: "svg",
          width: plan.layoutWidth,
          height: plan.layoutHeight,
        });
        downloadBlob(
          await makeVectorPdf(svgUrl, plan.pixelWidth, plan.pixelHeight, ppi),
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
      downloadBlob(blob, `${filename}.${format}`);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Plot export failed.",
        color: "red",
      });
    }
  };

  return (
    <Group align="stretch" wrap="nowrap">
      <Paper
        p="sm"
        withBorder
        style={{ minHeight: 590, position: "relative", flex: 1, minWidth: 520, overflow: "hidden" }}
      >
        {/* spinner only when there is nothing to show — background
            refetches of cached data keep the subtle opacity dim instead */}
        <LoadingOverlay
          visible={updating && traces.length === 0}
          overlayProps={{ blur: 1.5, backgroundOpacity: 0.18 }}
          loaderProps={{ size: "sm", color: "teal" }}
        />
        <PlotHeader
          plotName={plotName}
          subtitle={subtitle}
          onExport={exportPlot}
          style={style}
          updateStyle={updatePlotStyle}
          viewSize={plotSize}
          canExport={traces.length > 0}
        />
        {error && <Alert color="red">{error.message || "Compute failed"}</Alert>}
        {traces.length === 0 ? (
          <Center h={500}>
            <Text size="sm" c="dimmed">
              Add cells or replicates to start plotting.
            </Text>
          </Center>
        ) : (
          <Box
            ref={containerRef}
            style={{ width: "100%", minWidth: 0, opacity: updating ? 0.42 : 1, transition: "opacity 160ms ease" }}
          >
            <Plot
              data={traces}
              layout={layout}
              config={{ displaylogo: false }}
              style={{ width: "100%" }}
              onRelayout={zoom.onRelayout}
              onInitialized={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
              }}
              onUpdate={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
              }}
            />
          </Box>
        )}
      </Paper>
      <PlotStylePanel
        opened={stylePanelOpen}
        spec={spec}
        result={result}
        update={update}
        onToggle={() => setStylePanelOpen((open) => !open)}
        axisScope="cycles"
      />
    </Group>
  );
}

function TimeCapacityPlotCard({
  analysisId,
  plotName,
  subtitle,
  spec,
  update,
}: {
  analysisId: number;
  plotName: string;
  subtitle: string;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const cfg = timeCapacityConfig(spec);
  // Refetch ONLY when fields that change the returned data change. Display
  // choices (stacked, x axis, units, current axes) are frontend renderings —
  // refetching on them doubled every toggle into two full plot rebuilds.
  const dataSignature = useMemo(
    () =>
      JSON.stringify({
        selection: spec.selection,
        cycles: cfg.cycles,
        start: cfg.cycle_start,
        end: cfg.cycle_end,
        points: cfg.max_points_per_cell,
      }),
    [spec.selection, cfg.cycles, cfg.cycle_start, cfg.cycle_end, cfg.max_points_per_cell]
  );
  const timeResult = useQuery({
    queryKey: ["time-capacity", analysisId, dataSignature],
    queryFn: () =>
      post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, { spec }),
    enabled: spec.selection.entries.length > 0,
    staleTime: 5 * 60_000,
  });
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
  const traces = useMemo(
    () => (timeResult.data ? tracesForTimeCapacity(timeResult.data, spec) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeResult.data, viewSignature]
  );
  const zoomSignature = `${timeResult.data?.computed_at ?? "no-data"}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`;
  const zoom = useZoomMemory(zoomSignature, !cfg.stacked);
  const layout = useMemo(
    () => zoom.apply(timeCapacityLayout(timeResult.data, spec)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeResult.data, viewSignature]
  );
  const style = currentPlotStyle(spec, "time_capacity");
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

  const exportPlot = async (format: PlotExportFormat) => {
    if (!plotDivRef.current || !timeResult.data) return;
    try {
      const plan = resolveExportPlan(style, plotDivRef.current);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(plotName);
      const exportLayout: Partial<Plotly.Layout> = {
        ...layout,
        width: plan.layoutWidth,
        height: plan.layoutHeight,
        autosize: false,
      };
      if (style.export_include_title) {
        exportLayout.title = { text: plotName, font: { size: style.axis_title_size + 3 } };
        exportLayout.margin = { ...(layout.margin as object), t: Math.max(48, style.axis_title_size + 34) };
      }
      const figure = { data: traces, layout: exportLayout };
      const toImage = (
        PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
      ).toImage;

      if (format === "pdf") {
        const svgUrl = await toImage(figure, {
          format: "svg",
          width: plan.layoutWidth,
          height: plan.layoutHeight,
        });
        downloadBlob(await makeVectorPdf(svgUrl, plan.pixelWidth, plan.pixelHeight, ppi), `${filename}.pdf`);
        return;
      }
      const dataUrl = await toImage(figure, {
        format,
        width: plan.layoutWidth,
        height: plan.layoutHeight,
        scale: plan.scale,
      });
      const blob = format === "png" ? pngWithPpi(dataUrl, ppi) : blobFromDataUrl(dataUrl, "image/svg+xml");
      downloadBlob(blob, `${filename}.${format}`);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Plot export failed.",
        color: "red",
      });
    }
  };

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
          loaderProps={{ size: "sm", color: "teal" }}
        />
        <PlotHeader
          plotName={plotName}
          subtitle={subtitle}
          onExport={exportPlot}
          style={style}
          updateStyle={updatePlotStyle}
          viewSize={plotSize}
          canExport={traces.length > 0}
        />
        {timeResult.isError && (
          <Alert color="red">{(timeResult.error as Error).message || "Time/capacity compute failed"}</Alert>
        )}
        {timeResult.isLoading ? (
          <Center h={500}>
            <Loader />
          </Center>
        ) : traces.length === 0 ? (
          <Center h={500}>
            <Text size="sm" c="dimmed">
              Add cells or replicates, then choose cycles to plot raw voltage and current.
            </Text>
          </Center>
        ) : (
          <Box
            ref={containerRef}
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
              config={{ displaylogo: false }}
              style={{ width: "100%" }}
              onRelayout={zoom.onRelayout}
              onInitialized={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
              }}
              onUpdate={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
              }}
            />
          </Box>
        )}
      </Paper>
      <PlotStylePanel
        opened={stylePanelOpen}
        spec={spec}
        result={timeResult.data}
        update={update}
        onToggle={() => setStylePanelOpen((open) => !open)}
        axisScope="time_capacity"
      />
    </Group>
  );
}

function FamilyPlaceholder({ tab }: { tab: AnalysisTabKey }) {
  const def = TAB_DEFS.find((item) => item.value === tab)!;
  const Icon = def.icon;
  return (
    <Paper p="lg" withBorder h={590}>
      <Center h="100%">
        <Stack align="center" gap="xs" maw={520}>
          <Icon size={34} color="#12b886" />
          <Text fw={700}>{def.label}</Text>
          <Text size="sm" c="dimmed" ta="center">
            This analysis family needs protocol-specific extraction from the raw cache. The saved
            plot workflow is ready here; the calculator can be added without changing the cycle
            analysis model.
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}

function SavedPlotsPanel({
  analysisId,
  activeTab,
  baseSpec,
  plots,
  activeSavedPlotId,
  activePlotDirty,
  onSaveNew,
  onUpdateActive,
  onOpen,
  onDelete,
}: {
  analysisId: number;
  activeTab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  plots: SavedAnalysisPlot[];
  activeSavedPlotId: string | null;
  activePlotDirty: boolean;
  onSaveNew: () => void;
  onUpdateActive: () => void;
  onOpen: (plot: SavedAnalysisPlot) => void;
  onDelete: (plotId: string) => void;
}) {
  const visiblePlots = plots.filter((plot) => plot.tab === activeTab);
  if (activeTab === "settings") return null;

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <div>
          <Text fw={700} size="sm">
            Saved plots
          </Text>
          <Text size="xs" c="dimmed">
            {tabLabel(activeTab)} ({visiblePlots.length})
          </Text>
        </div>
        <Group gap="xs">
          <Button size="xs" variant="default" disabled={!activeSavedPlotId || !activePlotDirty} onClick={onUpdateActive}>
            Update plot
          </Button>
          <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} onClick={onSaveNew}>
            Save new plot
          </Button>
        </Group>
      </Group>
      {visiblePlots.length === 0 ? (
        <Alert color="gray">No saved plots for this tab.</Alert>
      ) : (
        <Stack gap="xs">
          {visiblePlots.map((plot) => {
            const active = plot.id === activeSavedPlotId;
            return (
              <Box
                key={plot.id}
                p="xs"
                role="button"
                tabIndex={0}
                onMouseDownCapture={(event) => {
                  if ((event.target as HTMLElement).closest("button")) return;
                  onOpen(plot);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(plot);
                  }
                }}
                style={{
                  border: active
                    ? "1px solid var(--mantine-color-teal-3)"
                    : "1px solid var(--mantine-color-gray-2)",
                  background: active ? "var(--mantine-color-teal-0)" : "#fcfcfd",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <Group align="stretch" wrap="nowrap">
                  <Box w={260} style={{ flexShrink: 0 }}>
                    {plot.tab === "time_capacity" ? (
                      <SavedTimeCapacityPreview analysisId={analysisId} baseSpec={baseSpec} plot={plot} />
                    ) : plot.tab === "cycles" || plot.tab === "recap" ? (
                      <SavedPlotPreview analysisId={analysisId} baseSpec={baseSpec} plot={plot} />
                    ) : (
                      <Center h={130}>
                        <Text size="xs" c="dimmed">
                          {tabLabel(plot.tab)}
                        </Text>
                      </Center>
                    )}
                  </Box>
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6}>
                      <Badge size="xs" variant="light" color={active ? "teal" : "gray"}>
                        {tabLabel(plot.tab)}
                      </Badge>
                      <Text fw={700} truncate>
                        {plot.name}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {plot.subtitle}
                    </Text>
                    {plot.description && (
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {plot.description}
                      </Text>
                    )}
                    <Text size="10px" c="dimmed">
                      Saved {new Date(plot.modified_at).toLocaleString()}
                    </Text>
                  </Stack>
                  <Stack gap={6} justify="center" w={86}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(plot.id);
                      }}
                    >
                      Delete
                    </Button>
                  </Stack>
                </Group>
              </Box>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

function AnalysisSettingsPanel({
  title,
  setTitle,
  setDirty,
  analysis,
  folderOptions,
  setFiling,
}: {
  title: string;
  setTitle: (title: string) => void;
  setDirty: (dirty: boolean) => void;
  analysis: AnalysisFull;
  folderOptions: { value: string; label: string }[];
  setFiling: ReturnType<typeof useMutation<AnalysisFull, Error, { folder_id?: number; unfile?: boolean }>>;
}) {
  return (
    <Paper p="sm" withBorder>
      <Stack gap="md">
        <div>
          <Text fw={700}>Analysis settings</Text>
          <Text size="sm" c="dimmed">
            Filing is only for organization. It never changes which cells the analysis can reach.
          </Text>
        </div>
        <TextInput
          label="Analysis title"
          value={title}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setDirty(true);
          }}
        />
        <Select
          label="Folder"
          leftSection={<IconFolder size={14} />}
          data={folderOptions}
          searchable
          value={analysis.folder ? String(analysis.folder.id) : "none"}
          onChange={(value) => {
            if (!value) return;
            if (value === "none") setFiling.mutate({ unfile: true });
            else setFiling.mutate({ folder_id: Number(value) });
          }}
          disabled={setFiling.isPending}
        />
        <Text size="xs" c="dimmed">
          Current folder: {analysis.folder?.name ?? "Unfiled"}
        </Text>
      </Stack>
    </Paper>
  );
}

export function AnalysisPage() {
  const { analysisId } = useParams();
  const aid = Number(analysisId);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const analysis = useQuery({
    queryKey: ["analysis", aid],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${aid}`),
  });
  const groupsQuery = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
  });
  const cellsQuery = useQuery({
    queryKey: ["cells", "analysis-names"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
  });
  const treeQuery = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
  });

  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<AnalysisTabKey>("cycles");
  const [activeSavedPlotId, setActiveSavedPlotId] = useState<string | null>(null);
  const [activePlotBaselineSignature, setActivePlotBaselineSignature] = useState<string | null>(null);
  const [plotWorkspaceTouched, setPlotWorkspaceTouched] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ name: string; description: string } | null>(null);
  const [leavePrompt, setLeavePrompt] = useState<{
    proceed: () => void;
    mode: "new" | "update";
    name: string;
  } | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [rendered, setRendered] = useState<{ result: ComputeResult; spec: AnalysisSpec } | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const autosaveSignature = useMemo(
    () => (spec ? JSON.stringify({ title, spec }) : "no-spec"),
    [spec, title]
  );
  const autosaveSignatureRef = useRef(autosaveSignature);

  useEffect(() => {
    autosaveSignatureRef.current = autosaveSignature;
  }, [autosaveSignature]);

  useEffect(() => {
    if (analysis.data && spec === null) {
      const loadedSpec = normalizeSpec(analysis.data.spec);
      const matchingPlot = findMatchingSavedPlot(loadedSpec, activeTab);
      setSpec(loadedSpec);
      setTitle(analysis.data.title);
      setActiveSavedPlotId(matchingPlot?.id ?? null);
      setActivePlotBaselineSignature(matchingPlot ? snapshotSignature(loadedSpec) : null);
      setPlotWorkspaceTouched(false);
    }
  }, [activeTab, analysis.data, spec]);

  const update = (fn: (s: AnalysisSpec) => void) => {
    setSpec((s) => {
      if (!s) return s;
      // spec is normalized once on load (and saved plots when opened); a
      // plain clone keeps the per-edit cost low
      const next = clone(s);
      fn(next);
      return next;
    });
    setPlotWorkspaceTouched(true);
    setDirty(true);
  };

  const compute = useQuery({
    queryKey: ["compute", aid, computeSignature(spec)],
    queryFn: () => post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec }),
    enabled: spec !== null,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (compute.data && spec) setRendered({ result: compute.data, spec: clone(spec) });
  }, [compute.data, spec]);

  const setFiling = useMutation({
    mutationFn: (payload: { folder_id?: number; unfile?: boolean }) =>
      put<AnalysisFull>(`/api/analyses/${aid}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      notifications.show({ message: "Analysis filing updated", color: "teal" });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const recompute = useMutation({
    mutationFn: () => post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec, recompute: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["compute", aid] });
      notifications.show({ message: "Recomputed at current parser/calc versions", color: "teal" });
    },
  });

  const duplicate = useMutation({
    mutationFn: () => post<AnalysisFull>(`/api/analyses/${aid}/duplicate`),
    onSuccess: (a) => {
      notifications.show({ message: "Duplicated; now editing the copy", color: "teal" });
      setSpec(null);
      setRendered(null);
      setActiveSavedPlotId(null);
      setActivePlotBaselineSignature(null);
      setPlotWorkspaceTouched(false);
      navigate(`/analyses/${a.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => del(`/api/analyses/${aid}`),
    onSuccess: () => navigate("/analyses"),
  });

  useEffect(() => {
    if (!spec || !dirty) return;
    const signatureAtSchedule = autosaveSignature;
    const timer = window.setTimeout(() => {
      setAutosaveStatus("saving");
      put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec })
        .then(() => {
          qc.invalidateQueries({ queryKey: ["analysis", aid] });
          qc.invalidateQueries({ queryKey: ["analyses"] });
          if (autosaveSignatureRef.current === signatureAtSchedule) {
            setDirty(false);
            setAutosaveStatus("saved");
          }
        })
        .catch((e: Error) => {
          if (autosaveSignatureRef.current === signatureAtSchedule) {
            setAutosaveStatus("error");
            notifications.show({ message: e.message, color: "red" });
          }
        });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [aid, autosaveSignature, dirty, qc, spec, title]);

  const displayResult = rendered?.result ?? compute.data;
  const activePlot = spec
    ? (spec.saved_plots ?? []).find((plot) => plot.id === activeSavedPlotId) ?? null
    : null;
  const activePlotDirty = Boolean(
    spec && activePlot && activePlotBaselineSignature && snapshotSignature(spec) !== activePlotBaselineSignature
  );
  const plotTabs = TAB_DEFS.filter((tab) => tab.plotTab).map((tab) => tab.value);
  const isPlotTab = plotTabs.includes(activeTab);
  const matchingSavedPlot = spec && isPlotTab ? findMatchingSavedPlot(spec, activeTab) : null;
  const currentPlotSaved = Boolean(matchingSavedPlot);
  const hasUnsavedPlot = Boolean(
    spec &&
      isPlotTab &&
      spec.selection.entries.length > 0 &&
      !currentPlotSaved &&
      (plotWorkspaceTouched || activePlotDirty)
  );

  useEffect(() => {
    if (!hasUnsavedPlot || !spec) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedPlot, spec]);

  useEffect(() => {
    const onLeaveRequest = (event: Event) => {
      const request = event as CustomEvent<AnalysisLeaveRequestDetail>;
      if (!hasUnsavedPlot || !spec) return;
      event.preventDefault();
      setLeavePrompt({
        proceed: request.detail.proceed,
        mode: activePlotDirty ? "update" : "new",
        name: activePlot?.name ?? suggestedPlotName(activeTab, displayResult, spec),
      });
    };
    window.addEventListener(ANALYSIS_LEAVE_EVENT, onLeaveRequest);
    return () => window.removeEventListener(ANALYSIS_LEAVE_EVENT, onLeaveRequest);
  }, [activePlot?.name, activePlotDirty, activeTab, displayResult, hasUnsavedPlot, spec]);

  if (analysis.isError) {
    return (
      <Paper p="lg" withBorder>
        <Stack gap="sm">
          <Alert color="red">Analysis not found.</Alert>
          <Button w="fit-content" variant="light" onClick={() => navigate("/analyses")}>
            Back to analysis database
          </Button>
        </Stack>
      </Paper>
    );
  }

  if (analysis.isLoading || spec === null) {
    return (
      <Center h={300}>
        <Loader />
      </Center>
    );
  }

  const currentAnalysis = analysis.data!;
  const displaySubtitle = plotSubtitle(activeTab, displayResult, spec);
  const displayPlotName = activePlot?.name ?? "Unsaved plot";
  const folderOptions = flattenFolders(treeQuery.data);
  const plotUpdating = Boolean(compute.isFetching && rendered && activeTab === "cycles");

  const toggleCellVisibility = (cellId: number) => {
    update((s) => {
      const has = s.selection.exclusions.some((e) => e.cell_id === cellId);
      if (has) s.selection.exclusions = s.selection.exclusions.filter((e) => e.cell_id !== cellId);
      else {
        s.selection.exclusions.push({
          cell_id: cellId,
          reason: null,
          excluded_at: new Date().toISOString(),
        });
      }
    });
  };

  const openSavedPlot = (plot: SavedAnalysisPlot) => {
    const restoredForBaseline = specForSavedPlot(spec, plot);
    setActiveSavedPlotId(plot.id);
    setActivePlotBaselineSignature(snapshotSignature(restoredForBaseline));
    update((s) => {
      const restored = specForSavedPlot(s, plot);
      s.selection = restored.selection;
      s.computation = restored.computation;
      s.aggregation = restored.aggregation;
      s.presentation = restored.presentation;
    });
    setPlotWorkspaceTouched(false);
    setActiveTab(plot.tab);
  };

  const updateActivePlot = () => {
    if (!activePlot) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    setActivePlotBaselineSignature(snapshotSignature(spec));
    update((s) => {
      s.saved_plots = (s.saved_plots ?? []).map((plot) =>
        plot.id === activePlot.id
          ? savedPlotFromSpec(s, activeTab, plot.name, subtitle, plot.description, plot)
          : plot
      );
    });
    setPlotWorkspaceTouched(false);
  };

  const commitSavedPlot = () => {
    if (!saveDraft) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const plot = savedPlotFromSpec(spec, activeTab, saveDraft.name, subtitle, saveDraft.description);
    update((s) => {
      s.saved_plots = [...(s.saved_plots ?? []), plot];
    });
    setActiveSavedPlotId(plot.id);
    setActivePlotBaselineSignature(snapshotSignature(spec));
    setPlotWorkspaceTouched(false);
    setSaveDraft(null);
  };

  const savePlotAndLeave = () => {
    if (!leavePrompt) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const next = clone(spec);
    const plot = activePlot
      ? savedPlotFromSpec(next, activeTab, activePlot.name, subtitle, activePlot.description, activePlot)
      : savedPlotFromSpec(next, activeTab, leavePrompt.name, subtitle, null);
    next.saved_plots = activePlot
      ? (next.saved_plots ?? []).map((item) => (item.id === activePlot.id ? plot : item))
      : [...(next.saved_plots ?? []), plot];
    setLeaveSaving(true);
    put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: next })
      .then(() => {
        setSpec(next);
        setDirty(false);
        setAutosaveStatus("saved");
        setActiveSavedPlotId(plot.id);
        setActivePlotBaselineSignature(snapshotSignature(next));
        setPlotWorkspaceTouched(false);
        qc.invalidateQueries({ queryKey: ["analysis", aid] });
        qc.invalidateQueries({ queryKey: ["analyses"] });
        const proceed = leavePrompt.proceed;
        setLeaveSaving(false);
        setLeavePrompt(null);
        proceed();
      })
      .catch((e: Error) => {
        setLeaveSaving(false);
        notifications.show({ message: e.message, color: "red" });
      });
  };

  const sidebar = (
    <Stack w={330} gap="xs" style={{ flexShrink: 0 }}>
      <SamplePanel
        spec={spec}
        groups={groupsQuery.data ?? []}
        cells={cellsQuery.data ?? []}
        onAdd={() => setAddOpen(true)}
        onRemoveEntry={(index) => update((s) => void s.selection.entries.splice(index, 1))}
        onToggleCell={toggleCellVisibility}
      />
      {activeTab === "time_capacity" && <TimeCapacitySettings spec={spec} update={update} />}
      {activeTab === "cycles" && <CycleSettings spec={spec} result={displayResult} update={update} />}
    </Stack>
  );

  const savedPlotsPanel = (
    <SavedPlotsPanel
      analysisId={aid}
      activeTab={activeTab}
      baseSpec={spec}
      plots={spec.saved_plots ?? []}
      activeSavedPlotId={activeSavedPlotId}
      activePlotDirty={activePlotDirty}
      onSaveNew={() =>
        setSaveDraft({
          name: suggestedPlotName(activeTab, displayResult, spec),
          description: "",
        })
      }
      onUpdateActive={updateActivePlot}
      onOpen={openSavedPlot}
      onDelete={(plotId) => {
        update((s) => void (s.saved_plots = (s.saved_plots ?? []).filter((plot) => plot.id !== plotId)));
        if (activeSavedPlotId === plotId) {
          setActiveSavedPlotId(null);
          setActivePlotBaselineSignature(null);
        }
      }}
    />
  );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="start">
        <TextInput
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setDirty(true);
          }}
          variant="unstyled"
          style={{ flex: 1, maxWidth: 620 }}
          styles={{ input: { fontSize: 22, fontWeight: 700 } }}
        />
        <Group gap="xs">
          <Badge
            variant="light"
            color={autosaveStatus === "error" ? "red" : autosaveStatus === "saving" || dirty ? "yellow" : "teal"}
          >
            {autosaveStatus === "error" ? "Not saved" : autosaveStatus === "saving" || dirty ? "Saving" : "Saved"}
          </Badge>
          <Tooltip label="Duplicate and keep this record intact">
            <Button variant="default" leftSection={<IconCopy size={16} />} onClick={() => duplicate.mutate()}>
              Duplicate
            </Button>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={() =>
              modals.openConfirmModal({
                title: "Delete this analysis?",
                children: <Text size="sm">The recipe and provenance are removed. Data is untouched.</Text>,
                labels: { confirm: "Delete", cancel: "Cancel" },
                confirmProps: { color: "red" },
                onConfirm: () => remove.mutate(),
              })
            }
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>

      {displayResult && <BadgeBar badges={displayResult.badges} />}

      {/* keepMounted=false is load-bearing: with Mantine's default, EVERY
          tab's plots, settings panels and saved-plot previews stay mounted
          at once (hidden Plotly instances at 0x0, duplicated inputs, one
          compute per preview per tab) — the source of the freezes. */}
      <Tabs
        value={activeTab}
        onChange={(value) => value && setActiveTab(value as AnalysisTabKey)}
        keepMounted={false}
      >
        <Tabs.List>
          {TAB_DEFS.map((tab) => {
            const Icon = tab.icon;
            return (
              <Tabs.Tab key={tab.value} value={tab.value} leftSection={<Icon size={14} />}>
                {tab.label}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        <Tabs.Panel value="cycles" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              <CyclePlotCard
                plotName={displayPlotName}
                subtitle={displaySubtitle}
                result={displayResult}
                spec={spec}
                update={update}
                updating={plotUpdating}
                error={compute.isError ? (compute.error as Error) : null}
              />
              {savedPlotsPanel}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="recap" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              <Paper p="sm" withBorder style={{ minHeight: 590 }}>
                <PlotHeader plotName={displayPlotName} subtitle="Recap table" />
                <Divider mb="sm" />
                <MetricsTable result={displayResult} />
              </Paper>
              {savedPlotsPanel}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="time_capacity" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              <TimeCapacityPlotCard
                analysisId={aid}
                plotName={displayPlotName}
                subtitle={displaySubtitle}
                spec={spec}
                update={update}
              />
              {savedPlotsPanel}
            </Stack>
          </Group>
        </Tabs.Panel>

        {(["crate", "chargeability", "dcir"] as AnalysisTabKey[]).map(
          (tab) => (
            <Tabs.Panel key={tab} value={tab} pt="sm">
              <Group align="start" wrap="nowrap">
                {sidebar}
                <Stack style={{ flex: 1, minWidth: 0 }}>
                  <FamilyPlaceholder tab={tab} />
                  {savedPlotsPanel}
                </Stack>
              </Group>
            </Tabs.Panel>
          )
        )}

        <Tabs.Panel value="settings" pt="sm">
          <Stack gap="sm">
            <AnalysisSettingsPanel
              title={title}
              setTitle={setTitle}
              setDirty={setDirty}
              analysis={currentAnalysis}
              folderOptions={folderOptions}
              setFiling={setFiling}
            />
            {displayResult && (
              <Paper p="sm" withBorder>
                <Group justify="space-between">
                  <div>
                    <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                      Provenance
                    </Text>
                    <Text size="xs" c="dimmed">
                      {currentAnalysis.provenance
                        ? `Last saved: ${new Date(currentAnalysis.provenance.computed_at).toLocaleString()} - parser ${currentAnalysis.provenance.parser_version} - calc ${currentAnalysis.provenance.calc_version} - ${currentAnalysis.provenance.sources.length} cell(s)`
                        : "Never saved. Save to pin versions and file hashes."}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Rendering at parser {displayResult.parser_version} / calc {displayResult.calc_version}
                      {displayResult.parser_version !== displayResult.current_parser_version ||
                      displayResult.calc_version !== displayResult.current_calc_version
                        ? ` - current is ${displayResult.current_parser_version} / ${displayResult.current_calc_version}`
                        : " (current)"}
                    </Text>
                  </div>
                  <Tooltip label="Render with current parser/calc versions and pin new provenance">
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconRefresh size={14} />}
                      loading={recompute.isPending}
                      onClick={() => recompute.mutate()}
                    >
                      Recompute
                    </Button>
                  </Tooltip>
                </Group>
              </Paper>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {isPlotTab && (
        <AddEntriesModal
          opened={addOpen}
          onClose={() => setAddOpen(false)}
          existing={spec.selection.entries}
          currentFolderId={currentAnalysis.folder?.id ?? null}
          onAdd={(entries) => {
            update((s) => {
              for (const entry of entries) {
                if (!s.selection.entries.some((e) => e.kind === entry.kind && e.ref_id === entry.ref_id)) {
                  s.selection.entries.push(entry);
                }
              }
            });
          }}
        />
      )}

      <Modal opened={saveDraft !== null} onClose={() => setSaveDraft(null)} title="Save new plot">
        <Stack>
          <TextInput
            label="Title"
            value={saveDraft?.name ?? ""}
            onChange={(event) =>
              setSaveDraft((draft) => (draft ? { ...draft, name: event.currentTarget.value } : draft))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSavedPlot();
            }}
          />
          <Text size="sm" c="dimmed">
            {plotSubtitle(activeTab, displayResult, spec)}
          </Text>
          <Textarea
            label="Description"
            minRows={3}
            value={saveDraft?.description ?? ""}
            onChange={(event) =>
              setSaveDraft((draft) =>
                draft ? { ...draft, description: event.currentTarget.value } : draft
              )
            }
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSaveDraft(null)}>
              Cancel
            </Button>
            <Button onClick={commitSavedPlot}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={leavePrompt !== null}
        onClose={() => setLeavePrompt(null)}
        title="Unsaved plot"
        closeOnClickOutside={!leaveSaving}
        closeOnEscape={!leaveSaving}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Save this plot before leaving the analysis?
          </Text>
          {leavePrompt?.mode === "new" && (
            <TextInput
              label="Plot title"
              value={leavePrompt.name}
              onChange={(event) =>
                setLeavePrompt((prompt) =>
                  prompt ? { ...prompt, name: event.currentTarget.value } : prompt
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") savePlotAndLeave();
              }}
            />
          )}
          {leavePrompt?.mode === "update" && activePlot && (
            <Text size="sm" fw={700}>
              {activePlot.name}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" disabled={leaveSaving} onClick={() => setLeavePrompt(null)}>
              Go back
            </Button>
            <Button
              variant="subtle"
              color="red"
              disabled={leaveSaving}
              onClick={() => {
                const proceed = leavePrompt?.proceed;
                setLeavePrompt(null);
                proceed?.();
              }}
            >
              Discard
            </Button>
            <Button loading={leaveSaving} onClick={savePlotAndLeave}>
              Save and leave
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
