// Analysis editor. An analysis owns the sample set; saved plots store reusable
// views of that set: settings plus hidden/shown sample state.
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
  IconInfoCircle,
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
import {
  plotViewSignature,
  savedPlotPreviewSignature,
  savedPlotSelectionFromSpec,
  specForSavedPlotView,
} from "../analysisPlotPolicy";
import Plot from "../components/Plot";
import { saveDownload } from "../downloads";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "../navigationEvents";
import {
  getCycleQuantityExplainer,
  getTimeCapacityExplainer,
  type PlotExplainer,
} from "../plotExplainers";

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

const LEGEND_INSIDE_POSITION_OPTIONS: {
  value: PlotStyle["legend_inside_position"];
  label: string;
}[] = [
  { value: "top_left", label: "Top left" },
  { value: "top_center", label: "Top center" },
  { value: "top_right", label: "Top right" },
  { value: "center_left", label: "Center left" },
  { value: "center", label: "Center" },
  { value: "center_right", label: "Center right" },
  { value: "bottom_left", label: "Bottom left" },
  { value: "bottom_center", label: "Bottom center" },
  { value: "bottom_right", label: "Bottom right" },
  { value: "custom", label: "Custom (dragged)" },
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
  "cv_charge_capacity",
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
  cv_charge_capacity: {
    column: "cv_charge_capacity_mah_g",
    label: "CV charge capacity (mAh/g)",
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
  view: "voltage_current",
  derivative_phase: "both",
  derivative_specific: false,
  derivative_absolute_discharge: true,
  smoothing_window: 7,
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
  ce_custom_colors: {},
  ce_line_width: 1.5,
  ce_line_dash: "dot",
  ce_marker_mode: "none",
  ce_marker_size: 5,
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
  data_decimal_separator: "point",
  data_delimiter: "comma",
  export_settings_version: 3,
  export_format: "png",
  export_aspect_ratio: "view",
  export_ppi: 300,
  export_width: 2000,
  export_height: 1250,
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
  { key: "cv_reached_cycles", label: "Cycles reaching CV", digits: 0 },
  { key: "cv_reached_pct", label: "Cycles reaching CV (%)", digits: 1 },
  { key: "cv_charge_event_count", label: "CV step count", digits: 0 },
  { key: "mean_cv_charge_time_h", label: "Mean CV h", digits: 3 },
  { key: "median_cv_charge_time_h", label: "Median CV h", digits: 3 },
  { key: "mean_cv_charge_capacity_mah", label: "Mean CV Q (mAh)", digits: 3 },
  { key: "median_cv_charge_capacity_mah", label: "Median CV Q (mAh)", digits: 3 },
  { key: "mean_cv_charge_fraction_pct", label: "Mean CV Q (%)", digits: 2 },
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
  cv_charge_time: "CV charge time (h)",
  cv_charge_capacity: "CV charge capacity (mAh)",
  cv_charge_fraction: "CV charge fraction (%)",
  cv_charge_events: "CV charge events",
  cv_reached: "CV reached",
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
    if (cfg.view === "dqdv") {
      return `${cfg.derivative_specific ? "Specific " : ""}incremental capacity dQ/dV vs voltage`;
    }
    if (cfg.view === "dvdq") {
      return `Differential voltage dV/dQ vs ${cfg.derivative_specific ? "specific " : ""}capacity`;
    }
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
    ce_custom_colors: { ...(style?.ce_custom_colors ?? {}) },
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

// A manual axis range is tied to the scale it was set for. When the plotted
// quantity (cycles y) or the x semantics (time/capacity x) change, drop it
// back to auto — otherwise the new data can sit entirely outside the pinned
// window and the plot looks empty.
function resetManualAxis(spec: AnalysisSpec, scope: AnalysisTabKey, axis: "x_axis" | "y_axis"): void {
  const style = currentPlotStyle(spec, scope);
  if (style[axis].mode !== "manual") return;
  writeScopedStyle(spec, scope, (next) => {
    next[axis] = { ...next[axis], mode: "auto", min: null, max: null };
  });
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

function cePlotMode(style: PlotStyle): "lines" | "markers" | "lines+markers" {
  if (style.ce_marker_mode === "points") return "markers";
  if (style.ce_marker_mode === "lines_points") return "lines+markers";
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

const INSIDE_LEGEND_CHROME = {
  bgcolor: "rgba(255, 255, 255, 0.82)",
  bordercolor: "#dee2e6",
  borderwidth: 1,
} as const;

function legendLayout(style: PlotStyle): Partial<Plotly.Layout["legend"]> {
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
// A hidden legend reserves nothing — the plot reclaims the full area.
function legendMargins(style: PlotStyle, visible: boolean): { l: number; r: number; t: number; b: number } {
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

function draggedLegendPoint(event: Readonly<Plotly.PlotRelayoutEvent>): { x: number; y: number } | null {
  const values = event as unknown as Record<string, unknown>;
  const x = typeof values["legend.x"] === "number" ? values["legend.x"] : null;
  const y = typeof values["legend.y"] === "number" ? values["legend.y"] : null;
  if (x === null || y === null) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
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

// ------------------------------------------------------ data export (CSV/XLSX)

type DataColumn = { header: string; values: (number | null)[] };

// Export exactly what is plotted: one x/y column pair per visible trace
// (works for any tab — traces need not share an x grid). Dispersion bands
// (fill traces) are skipped.
function tracesToColumns(traces: Plotly.Data[], layout: Partial<Plotly.Layout>): DataColumn[] {
  const axisTitle = (axis: unknown): string =>
    String((axis as { title?: { text?: string } })?.title?.text ?? "");
  const columns: DataColumn[] = [];
  for (const raw of traces) {
    const t = raw as Record<string, unknown>;
    if (t.fill === "toself") continue;
    const xs = (t.x as (number | null)[]) ?? [];
    const ys = (t.y as (number | null)[]) ?? [];
    if (!ys.length) continue;
    const name = String(t.name ?? "series");
    const layoutRec = layout as Record<string, unknown>;
    const yKey = t.yaxis === "y3" ? "yaxis3" : t.yaxis === "y2" ? "yaxis2" : "yaxis";
    const xKey = t.xaxis === "x2" ? "xaxis2" : "xaxis";
    const xLabel = axisTitle(layoutRec[xKey]) || "x";
    const yLabel = axisTitle(layoutRec[yKey]) || "y";
    columns.push({ header: `${name} | ${xLabel}`, values: xs });
    columns.push({ header: `${name} | ${yLabel}`, values: ys });
  }
  return columns;
}

function buildDelimitedText(
  columns: DataColumn[],
  decimal: PlotStyle["data_decimal_separator"],
  delimiter: PlotStyle["data_delimiter"]
): string {
  const sep = delimiter === "tab" ? "\t" : delimiter === "semicolon" ? ";" : ",";
  const formatNumber = (v: number | null | undefined) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    const s = String(v);
    return decimal === "comma" ? s.replace(".", ",") : s;
  };
  const quote = (s: string) =>
    s.includes(sep) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
  const lines = [columns.map((c) => quote(c.header)).join(sep)];
  for (let i = 0; i < rowCount; i += 1) {
    lines.push(columns.map((c) => formatNumber(c.values[i])).join(sep));
  }
  // BOM so Excel detects UTF-8
  return "﻿" + lines.join("\r\n");
}

async function downloadDataExport(columns: DataColumn[], style: PlotStyle, baseName: string): Promise<void> {
  if (columns.length === 0) return;
  if (style.data_export_format === "xlsx") {
    const XLSX = await import("xlsx");
    const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
    const aoa: (string | number | null)[][] = [columns.map((c) => c.header)];
    for (let i = 0; i < rowCount; i += 1) {
      aoa.push(
        columns.map((c) => {
          const v = c.values[i];
          return v === null || v === undefined || Number.isNaN(v) ? null : v;
        })
      );
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Data");
    const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
    await downloadBlob(
      new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${baseName}.xlsx`
    );
    return;
  }
  const text = buildDelimitedText(columns, style.data_decimal_separator, style.data_delimiter);
  await downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `${baseName}.csv`);
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const result = await saveDownload(blob, filename);
  if (result.usedDefaultFolder && result.path) {
    notifications.show({ message: `Saved to ${result.path}`, color: "teal" });
  }
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
// jsPDF + svg2pdf. PDF is vector, so it uses a physical page size rather
// than borrowing the raster-only PPI setting.
async function makeVectorPdf(
  svgDataUrl: string,
  ratio: number,
  aspect: PlotAspectRatioKey
): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const svg = svgElementFromDataUrl(svgDataUrl);
  const a4Long = 841.89;
  const a4Short = 595.28;
  const defaultLongEdge = 720;
  const [pageWidth, pageHeight] =
    aspect === "a4_landscape"
      ? [a4Long, a4Short]
      : aspect === "a4_portrait"
        ? [a4Short, a4Long]
        : ratio >= 1
          ? [defaultLongEdge, defaultLongEdge / ratio]
          : [defaultLongEdge * ratio, defaultLongEdge];
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
  const normalizedPlot = {
    ...plot,
    selection: {
      entries: [],
      exclusions: clone(plot.selection?.exclusions ?? []),
      hidden_replicate_group_ids: clone(plot.selection?.hidden_replicate_group_ids ?? []),
    },
    presentation,
  };
  return {
    ...normalizedPlot,
    subtitle: plot.subtitle || plotSubtitle(plot.tab, undefined, specForSavedPlotView(base, normalizedPlot)),
  };
}

function normalizeSpec(input: AnalysisSpec): AnalysisSpec {
  const spec = clone(input);
  spec.selection = {
    entries: spec.selection?.entries ?? [],
    exclusions: spec.selection?.exclusions ?? [],
    hidden_replicate_group_ids: spec.selection?.hidden_replicate_group_ids ?? [],
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
  return specForSavedPlotView(normalizeSpec(base), plot);
}

function snapshotSignature(spec: AnalysisSpec): string {
  return plotViewSignature(spec);
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
    selection: savedPlotSelectionFromSpec(spec),
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
  const pickCe = (key: string) => style.ce_custom_colors[key] ?? pick(key);

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
      const ceColor = pickCe(`g${agg.group_id}`);
      out.push({
        x: agg.x,
        y: agg.quantities["coulombic_efficiency_pct"].mean,
        name: `${agg.group_name} CE`,
        yaxis: "y2",
        line: { color: ceColor, width: style.ce_line_width, dash: style.ce_line_dash },
        marker: { color: ceColor, size: style.ce_marker_size },
        type: "scatter",
        mode: cePlotMode(style),
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
      const ceColor = pickCe(`c${s.cell_id}`);
      out.push({
        x: s.x,
        y: s.quantities["coulombic_efficiency_pct"],
        name: `${s.label} CE`,
        yaxis: "y2",
        line: { color: ceColor, width: style.ce_line_width, dash: style.ce_line_dash },
        marker: { color: ceColor, size: style.ce_marker_size },
        type: "scatter",
        mode: cePlotMode(style),
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
          const showlegend = !legendShown.has(seriesKey);
          legendShown.add(seriesKey);
          out.push({
            x,
            y,
            name: baseName,
            legendgroup: seriesKey,
            showlegend,
            line: { color, width: style.line_width, dash: phase === "discharge" ? "dash" : style.line_dash },
            marker: { color, size: style.marker_size },
            mode: plotMode(style),
            type: "scatter",
            connectgaps: false,
            customdata: Array(x.length).fill(`${phase}, cycle ${cycle ?? "?"}`),
            hovertemplate: "%{y:.5g}<br>%{x:.5g}<br>%{customdata}<extra>%{fullData.name}</extra>",
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
  const lm = legendMargins(style, spec.presentation.legend);
  const rightMargin = Math.max(hasRightCurrent ? 84 : 28, lm.r ? lm.r + 24 : 0);
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
  if (cfg.view !== "voltage_current") {
    const specific = cfg.derivative_specific;
    const xTitle = cfg.view === "dqdv" ? "Voltage (V)" : specific ? "Specific capacity (mAh/g)" : "Capacity (mAh)";
    const yTitle =
      cfg.view === "dqdv"
        ? specific ? "dQ/dV (mAh/g/V)" : "dQ/dV (mAh/V)"
        : specific ? "dV/dQ (V/(mAh/g))" : "dV/dQ (V/mAh)";
    return {
      height: 560,
      margin: {
        l: 78 + lm.l,
        r: Math.max(28, lm.r ? lm.r + 24 : 0),
        t: 20 + lm.t,
        b: 58 + lm.b,
      },
      paper_bgcolor: style.paper_bgcolor,
      plot_bgcolor: style.plot_bgcolor,
      font: { size: style.tick_font_size },
      showlegend: spec.presentation.legend,
      legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
      xaxis: { ...baseAxis, title: { text: style.x_title ?? xTitle, font: titleFont }, ...axisLayout(style.x_axis) },
      yaxis: { ...baseAxis, title: { text: style.y_title ?? yTitle, font: titleFont }, ...axisLayout(style.y_axis) },
    };
  }
  return {
    height: cfg.stacked ? 620 : 560,
    margin: { l: 70 + lm.l, r: rightMargin, t: 20 + lm.t, b: 58 + lm.b },
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
      ...(cfg.stacked ? {} : axisLayout(style.x_axis)),
    },
    yaxis: {
      ...baseAxis,
      title: { text: style.y_title ?? "Voltage (V)", font: titleFont },
      domain: cfg.stacked ? [0.39, 1] : [0, 1],
      ...(cfg.stacked ? { showline: false, mirror: false } : {}),
      ...axisLayout(style.y_axis),
    },
    ...(cfg.stacked
      ? {
          xaxis2: {
            ...baseAxis,
            title: { text: style.x_title ?? xTitle, font: titleFont },
            domain: [0, 1],
            anchor: "y2",
            showline: false,
            mirror: false,
            ...axisLayout(style.x_axis),
          },
          yaxis2: {
            ...baseAxis,
            title: { text: style.y2_title ?? leftCurrentLabel, font: titleFont },
            domain: [0, 0.39],
            anchor: "x2",
            showline: false,
            mirror: false,
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
                  showline: false,
                  mirror: false,
                  ...axisLayout(style.y2_axis),
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
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const preview = useQuery({
    queryKey: ["saved-plot-preview", analysisId, plot.id, previewSignature],
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
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const preview = useQuery({
    queryKey: ["saved-time-preview", analysisId, plot.id, previewSignature],
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

type VisibilityContext = Pick<SelectionEntry, "kind" | "ref_id">;

function exclusionAppliesToContext(
  exclusion: AnalysisSpec["selection"]["exclusions"][number],
  cellId: number,
  context: VisibilityContext
) {
  return (
    exclusion.cell_id === cellId &&
    (exclusion.entry_kind == null || exclusion.entry_kind === context.kind) &&
    (exclusion.entry_ref_id == null || exclusion.entry_ref_id === context.ref_id)
  );
}

function isExactContextExclusion(
  exclusion: AnalysisSpec["selection"]["exclusions"][number],
  cellId: number,
  context: VisibilityContext
) {
  return (
    exclusion.cell_id === cellId &&
    exclusion.entry_kind === context.kind &&
    exclusion.entry_ref_id === context.ref_id
  );
}

function selectionContextsForCell(
  entries: SelectionEntry[],
  groups: ReplicateGroupSummary[],
  cellId: number
): VisibilityContext[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const contexts: VisibilityContext[] = [];
  for (const entry of entries) {
    if (entry.kind === "cell" && entry.ref_id === cellId) contexts.push(entry);
    if (
      entry.kind === "replicate_group" &&
      groupById.get(entry.ref_id)?.cells.some((cell) => cell.id === cellId)
    ) {
      contexts.push(entry);
    }
  }
  return contexts.filter(
    (context, index) =>
      contexts.findIndex((candidate) => candidate.kind === context.kind && candidate.ref_id === context.ref_id) === index
  );
}

function SamplePanel({
  spec,
  groups,
  cells,
  onAdd,
  onRemoveEntry,
  onToggleCell,
  onToggleReplicate,
}: {
  spec: AnalysisSpec;
  groups: ReplicateGroupSummary[];
  cells: CellSummary[];
  onAdd: () => void;
  onRemoveEntry: (index: number) => void;
  onToggleCell: (cellId: number, context: VisibilityContext) => void;
  onToggleReplicate: (groupId: number) => void;
}) {
  const hiddenGroups = new Set(spec.selection.hidden_replicate_group_ids ?? []);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const cellById = new Map(cells.map((c) => [c.id, c]));

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">
          Analysis samples
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
              const groupHidden = hiddenGroups.has(entry.ref_id);
              return (
                <Box key={`${entry.kind}-${entry.ref_id}-${index}`}>
                  <Group justify="space-between" gap={6} wrap="nowrap">
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={700} c={groupHidden ? "dimmed" : undefined} truncate>
                        {group?.name ?? `replicate #${entry.ref_id}`}
                      </Text>
                      <Text size="10px" c="dimmed" tt="uppercase">
                        Replicate
                      </Text>
                    </Box>
                    <Group gap={2} wrap="nowrap">
                      <Tooltip label={groupHidden ? "Show replicate in plot" : "Hide replicate from plot"}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color={groupHidden ? "gray" : "teal"}
                          onClick={() => onToggleReplicate(entry.ref_id)}
                          aria-label={groupHidden ? "Show replicate in plot" : "Hide replicate from plot"}
                        >
                          {groupHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Remove replicate from this analysis">
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
                  <Stack gap={2} mt={4} pl="md">
                    {(group?.cells ?? []).map((cell) => {
                      const context = { kind: "replicate_group" as const, ref_id: entry.ref_id };
                      const isHidden = spec.selection.exclusions.some((exclusion) =>
                        exclusionAppliesToContext(exclusion, cell.id, context)
                      );
                      return (
                        <Group key={cell.id} justify="space-between" gap={6} wrap="nowrap">
                          <Text size="xs" c={groupHidden || isHidden ? "dimmed" : undefined} truncate>
                            {cell.name}
                          </Text>
                          <Tooltip label={groupHidden ? "Show the replicate before changing member visibility" : isHidden ? "Show in plot" : "Hide from plot"}>
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color={isHidden ? "gray" : "teal"}
                              disabled={groupHidden}
                              onClick={() => onToggleCell(cell.id, context)}
                              aria-label={`${isHidden ? "Show" : "Hide"} ${cell.name} in replicate ${group?.name ?? entry.ref_id}`}
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
            const context = { kind: "cell" as const, ref_id: entry.ref_id };
            const isHidden = spec.selection.exclusions.some((exclusion) =>
              exclusionAppliesToContext(exclusion, entry.ref_id, context)
            );
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
                      onClick={() => onToggleCell(entry.ref_id, context)}
                      aria-label={`${isHidden ? "Show" : "Hide"} standalone cell ${cell?.name ?? entry.ref_id}`}
                    >
                      {isHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove cell from this analysis">
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
                    // a manual y-range was set for the OLD quantity's scale;
                    // keeping it would render the new quantity off-screen
                    resetManualAxis(s, "cycles", "y_axis");
                  })
                }
              />
              {canNormalizeByMass && (
                <Switch
                  label="Normalize by g"
                  checked={Boolean(spec.presentation.normalize_by_mass)}
                  onChange={(e) =>
                    update((s) => {
                      s.presentation.normalize_by_mass = e.currentTarget.checked;
                      // mAh ↔ mAh/g changes the y scale entirely
                      resetManualAxis(s, "cycles", "y_axis");
                    })
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
                    resetManualAxis(s, "time_capacity", "x_axis");
                    resetManualAxis(s, "time_capacity", "y_axis");
                  })
                }
              />
              {cfg.view === "voltage_current" ? (
                <>
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
                  update((s) => {
                    const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
                    next.x_axis = value as TimeCapacityConfig["x_axis"];
                    s.computation.time_capacity = next;
                    // manual x-range belongs to the previous x quantity's scale
                    resetManualAxis(s, "time_capacity", "x_axis");
                  })
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
                    update((s) => {
                      const next = { ...DEFAULT_TIME_CAPACITY, ...(s.computation.time_capacity ?? {}) };
                      next.time_unit = value as TimeCapacityConfig["time_unit"];
                      s.computation.time_capacity = next;
                      resetManualAxis(s, "time_capacity", "x_axis");
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
                    resetManualAxis(s, "time_capacity", "x_axis");
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
          <ActionIcon variant="subtle" onClick={onToggle} mt={4} aria-label="Show plot style">
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
          <ActionIcon variant="subtle" onClick={onToggle} aria-label="Hide plot style">
            <IconChevronRight size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Accordion multiple defaultValue={["colors", "axes", "ce-overlay"]}>
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

        {ceOverlayActive && (
          <Accordion.Item value="ce-overlay">
            <Accordion.Control>
              <Text fw={700} size="sm">
                CE overlay
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  These settings apply only to coulombic-efficiency traces on the right axis.
                </Text>
                {colorTargets.length > 0 && (
                  <Stack gap={6}>
                    {colorTargets.map((target, index) => {
                      const palette = PLOT_PALETTES[style.palette] ?? PLOT_PALETTES.app;
                      const mainColor =
                        style.custom_colors[target.key] ?? palette[index % palette.length];
                      return (
                        <DebouncedColorInput
                          key={`ce-${target.key}`}
                          label={`${target.label} CE`}
                          description={target.sub}
                          value={style.ce_custom_colors[target.key] ?? mainColor}
                          format="hex"
                          onCommit={(value) =>
                            setStyle((next) => {
                              next.ce_custom_colors[target.key] = value;
                            })
                          }
                          swatches={COLOR_SWATCHES}
                          swatchesPerRow={8}
                        />
                      );
                    })}
                  </Stack>
                )}
                <Group grow>
                  <DebouncedNumberInput
                    label="Width"
                    min={0.5}
                    max={8}
                    step={0.25}
                    value={style.ce_line_width}
                    onCommit={(value) => setStyle((next) => void (next.ce_line_width = value ?? 1.5))}
                  />
                  <Select
                    label="Dash"
                    data={[
                      { value: "solid", label: "Solid" },
                      { value: "dot", label: "Dot" },
                      { value: "dash", label: "Dash" },
                      { value: "longdash", label: "Long dash" },
                    ]}
                    value={style.ce_line_dash}
                    onChange={(value) =>
                      value && setStyle((next) => void (next.ce_line_dash = value as PlotStyle["ce_line_dash"]))
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
                    value={style.ce_marker_mode}
                    onChange={(value) =>
                      value &&
                      setStyle((next) => void (next.ce_marker_mode = value as PlotStyle["ce_marker_mode"]))
                    }
                  />
                  <DebouncedNumberInput
                    label="Marker size"
                    min={2}
                    max={14}
                    value={style.ce_marker_size}
                    onCommit={(value) => setStyle((next) => void (next.ce_marker_size = value ?? 5))}
                  />
                </Group>
                <DebouncedNumberInput
                  label="Opacity"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={style.ce_opacity}
                  onCommit={(value) => setStyle((next) => void (next.ce_opacity = value ?? 0.7))}
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}

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
                label="Show legend"
                checked={spec.presentation.legend}
                onChange={(event) =>
                  update((s) => void (s.presentation.legend = event.currentTarget.checked))
                }
              />
              {spec.presentation.legend && (
                <>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    radius={4}
                    data={[
                      { value: "outside", label: "Outside" },
                      { value: "inside", label: "Inside" },
                    ]}
                    value={style.legend_mode === "outside" ? "outside" : "inside"}
                    styles={{
                      root: { padding: 3 },
                      indicator: { boxShadow: "none", border: "1px solid var(--mantine-color-gray-3)" },
                      label: { paddingBlock: 6 },
                    }}
                    onChange={(value) =>
                      setStyle((next) => {
                        next.legend_mode = value as "outside" | "inside";
                        if (value === "inside" && next.legend_inside_position === "custom") {
                          next.legend_custom_x = Math.min(1, Math.max(0, next.legend_custom_x));
                          next.legend_custom_y = Math.min(1, Math.max(0, next.legend_custom_y));
                        }
                      })
                    }
                  />
                  {style.legend_mode === "outside" ? (
                    <Select
                      label="Side"
                      data={[
                        { value: "bottom", label: "Bottom" },
                        { value: "top", label: "Top" },
                        { value: "left", label: "Left" },
                        { value: "right", label: "Right" },
                      ]}
                      value={style.legend_side}
                      onChange={(value) =>
                        value &&
                        setStyle((next) => void (next.legend_side = value as PlotStyle["legend_side"]))
                      }
                    />
                  ) : (
                    <>
                      <Select
                        label="Position"
                        data={LEGEND_INSIDE_POSITION_OPTIONS}
                        value={style.legend_inside_position}
                        onChange={(value) =>
                          value &&
                          setStyle((next) => {
                            next.legend_mode = "inside";
                            next.legend_inside_position = value as PlotStyle["legend_inside_position"];
                          })
                        }
                      />
                      <SegmentedControl
                        size="xs"
                        fullWidth
                        radius={4}
                        data={[
                          { value: "h", label: "Horizontal" },
                          { value: "v", label: "Vertical" },
                        ]}
                        value={style.legend_orientation}
                        onChange={(value) =>
                          setStyle((next) => void (next.legend_orientation = value as "h" | "v"))
                        }
                      />
                      <Text size="10px" c="dimmed">
                        Drag the legend directly on the plot for a custom position. The dragged position is saved with the plot.
                      </Text>
                    </>
                  )}
                  {((style.legend_mode === "outside" && ["top", "bottom"].includes(style.legend_side)) ||
                    (style.legend_mode !== "outside" && style.legend_orientation === "h")) && (
                    <DebouncedNumberInput
                      label="Legend entry width (px)"
                      description="Use 0 for automatic sizing. Wider entries flow onto additional rows sooner."
                      min={0}
                      max={600}
                      step={20}
                      value={style.legend_entry_width}
                      onCommit={(value) =>
                        setStyle((next) => void (next.legend_entry_width = Math.max(0, value ?? 0)))
                      }
                    />
                  )}
                </>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

function PlotExplainerButton({ explainer }: { explainer?: PlotExplainer }) {
  if (!explainer) return null;
  return (
    <Popover withinPortal position="bottom-end" shadow="md" width={360}>
      <Popover.Target>
        <Tooltip label="How this plot is calculated">
          <ActionIcon size={30} variant="subtle" color="teal" aria-label="Plot explainer">
            <IconInfoCircle size={18} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <div>
            <Text fw={800}>{explainer.title}</Text>
            <Text size="sm" c="dimmed">
              {explainer.formula}
            </Text>
            {explainer.secondaryFormula && (
              <Text size="sm" c="dimmed" mt={4}>
                {explainer.secondaryFormula}
              </Text>
            )}
          </div>
          {explainer.requires.length > 0 && (
            <div>
              <Text size="xs" fw={800} tt="uppercase" c="dimmed" mb={4}>
                Requires
              </Text>
              <Group gap={6}>
                {explainer.requires.map((item) => (
                  <Badge key={item} size="sm" variant="light" color="teal">
                    {item}
                  </Badge>
                ))}
              </Group>
            </div>
          )}
          {explainer.notes.length > 0 && (
            <Stack gap={4}>
              <Text size="xs" fw={800} tt="uppercase" c="dimmed">
                Notes
              </Text>
              {explainer.notes.map((note) => (
                <Text key={note} size="sm">
                  {note}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function PlotHeader({
  plotName,
  subtitle,
  explainer,
  onExport,
  onDataExport,
  getExportPreview,
  style,
  updateStyle,
  viewSize,
  canExport = false,
}: {
  plotName: string;
  subtitle: string;
  explainer?: PlotExplainer;
  onExport?: (format: PlotExportFormat) => void;
  onDataExport?: () => void;
  getExportPreview?: () => Promise<string | null>;
  style?: PlotStyle;
  updateStyle?: (fn: (style: PlotStyle) => void) => void;
  viewSize?: { width: number; height: number } | null;
  canExport?: boolean;
}) {
  const exportStyle = style ?? DEFAULT_PLOT_STYLE;
  const selectedFormat = exportStyle.export_format ?? "png";
  const [exportPopoverOpen, setExportPopoverOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
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
  const ppi = Math.max(36, exportStyle.export_ppi || DEFAULT_PLOT_STYLE.export_ppi);
  const printWidthCm = (exportWidthValue / ppi) * 2.54;
  const printHeightCm = (exportHeightValue / ppi) * 2.54;
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

  // live thumbnail of the actual export output (same figure, scaled down),
  // regenerated while the popover is open and settings change
  useEffect(() => {
    if (!exportPopoverOpen || !getExportPreview) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getExportPreview()
        .then((url) => {
          if (!cancelled) setPreviewUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPreviewUrl(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    exportPopoverOpen,
    exportStyle.export_aspect_ratio,
    exportStyle.export_width,
    exportStyle.export_height,
    exportStyle.export_include_title,
  ]);

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
      <Group gap="xs" align="start">
        <PlotExplainerButton explainer={explainer} />
        {onDataExport && style && (
          <Button.Group>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconTable size={14} />}
              disabled={!canExport}
              onClick={onDataExport}
            >
              {exportStyle.data_export_format === "xlsx" ? "XLSX" : "CSV"}
            </Button>
            <Popover withinPortal position="bottom-end" shadow="md" width={280}>
              <Popover.Target>
                <Button size="xs" variant="default" px={6} disabled={!canExport} aria-label="Data export settings">
                  <IconChevronDown size={14} />
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Select
                    label="Format"
                    data={[
                      { value: "csv", label: "CSV (text)" },
                      { value: "xlsx", label: "Excel (.xlsx)" },
                    ]}
                    value={exportStyle.data_export_format}
                    comboboxProps={{ withinPortal: false }}
                    onChange={(value) =>
                      value &&
                      setExportStyle(
                        (next) => void (next.data_export_format = value as PlotStyle["data_export_format"])
                      )
                    }
                  />
                  {exportStyle.data_export_format === "csv" && (
                    <>
                      <Select
                        label="Decimal separator"
                        data={[
                          { value: "point", label: "Point (3.14)" },
                          { value: "comma", label: "Comma (3,14)" },
                        ]}
                        value={exportStyle.data_decimal_separator}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) =>
                          value &&
                          setExportStyle((next) => {
                            next.data_decimal_separator = value as PlotStyle["data_decimal_separator"];
                            // comma decimals cannot share the comma delimiter
                            if (value === "comma" && next.data_delimiter === "comma") {
                              next.data_delimiter = "semicolon";
                            }
                          })
                        }
                      />
                      <Select
                        label="Column separator"
                        data={[
                          { value: "comma", label: "Comma  ," , disabled: exportStyle.data_decimal_separator === "comma" },
                          { value: "semicolon", label: "Semicolon  ;" },
                          { value: "tab", label: "Tab" },
                        ]}
                        value={exportStyle.data_delimiter}
                        comboboxProps={{ withinPortal: false }}
                        onChange={(value) =>
                          value &&
                          setExportStyle(
                            (next) => void (next.data_delimiter = value as PlotStyle["data_delimiter"])
                          )
                        }
                      />
                    </>
                  )}
                  <Text size="10px" c="dimmed">
                    Exports the plotted series as x/y column pairs per trace (dispersion bands
                    excluded). Excel files keep full numeric precision.
                  </Text>
                  <Button fullWidth leftSection={<IconTable size={14} />} onClick={onDataExport}>
                    Download {exportStyle.data_export_format === "xlsx" ? "XLSX" : "CSV"}
                  </Button>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          </Button.Group>
        )}
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
            <Popover
              withinPortal
              position="bottom-end"
              shadow="md"
              width="min(760px, calc(100vw - 24px))"
              opened={exportPopoverOpen}
              onChange={setExportPopoverOpen}
            >
              <Popover.Target>
                <Button
                  size="xs"
                  variant="default"
                  px={6}
                  disabled={!canExport}
                  aria-label="Export settings"
                  onClick={() => setExportPopoverOpen((open) => !open)}
                >
                  <IconChevronDown size={14} />
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: getExportPreview
                      ? "repeat(auto-fit, minmax(min(300px, 100%), 1fr))"
                      : "1fr",
                    gap: 16,
                    alignItems: "start",
                  }}
                >
                  {getExportPreview && (
                    <Stack gap={6}>
                      <Text size="xs" fw={600} c="dimmed">
                        {selectedFormat === "png"
                          ? `Preview | ${Math.round(exportWidthValue)} x ${Math.round(exportHeightValue)} px`
                          : "Preview | Vector output"}
                      </Text>
                      <div
                        style={{
                          border: "1px solid var(--mantine-color-gray-3)",
                          borderRadius: 4,
                          padding: 2,
                          background:
                            "repeating-conic-gradient(#f1f3f5 0% 25%, #ffffff 0% 50%) 50% / 12px 12px",
                          minHeight: 220,
                          height: 300,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                        }}
                      >
                        {previewUrl ? (
                          <img
                            src={previewUrl}
                            alt="Export preview"
                            style={{
                              maxWidth: "100%",
                              maxHeight: "100%",
                              width: "auto",
                              height: "auto",
                              display: "block",
                            }}
                          />
                        ) : (
                          <Loader size={16} />
                        )}
                      </div>
                      <Text size="10px" c="dimmed">
                        This uses the selected aspect ratio and figure styling. The downloaded file keeps the full resolution.
                      </Text>
                    </Stack>
                  )}
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
                      {selectedFormat === "png" ? (
                        <>
                          <Group grow align="start">
                            <DebouncedNumberInput
                              label="Width (px)"
                              min={320}
                              step={100}
                              value={exportWidthValue}
                              onCommit={(value) => value !== null && setExportWidth(value)}
                            />
                            <DebouncedNumberInput
                              label="Height (px)"
                              min={240}
                              step={100}
                              disabled={exportStyle.export_aspect_ratio !== "custom"}
                              value={exportHeightValue}
                              onCommit={(value) =>
                                value !== null && setExportStyle((next) => void (next.export_height = value))
                              }
                            />
                          </Group>
                          <DebouncedNumberInput
                            label="Print density (PPI)"
                            description="Sets physical print size; it does not change the pixel dimensions above."
                            min={36}
                            max={1200}
                            step={24}
                            value={exportStyle.export_ppi}
                            onCommit={(value) =>
                              setExportStyle(
                                (next) => void (next.export_ppi = value ?? DEFAULT_PLOT_STYLE.export_ppi)
                              )
                            }
                          />
                          <Text size="10px" c="dimmed">
                            Print size at {Math.round(ppi)} PPI: {printWidthCm.toFixed(1)} x {printHeightCm.toFixed(1)} cm
                          </Text>
                        </>
                      ) : (
                        <Text size="xs" c="dimmed">
                          {selectedFormat.toUpperCase()} is vector-based, so it has no pixel resolution or PPI setting.
                          It can be resized without losing sharpness.
                        </Text>
                      )}
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
                </div>
              </Popover.Dropdown>
            </Popover>
          </Button.Group>
        )}
      </Group>
    </Group>
  );
}

function cyclePlotLayout(result: ComputeResult | undefined, spec: AnalysisSpec): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "cycles");
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = resolvedQuantity(result, spec);
  const showCeOverlay = (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const lm = legendMargins(style, spec.presentation.legend);
  const rightMargin = Math.max(showCeOverlay ? 64 : 24, lm.r ? lm.r + 24 : 0);
  const topMargin = 20 + lm.t;
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
    margin: { l: 66 + lm.l, r: rightMargin, t: topMargin, b: 58 + lm.b },
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
  /** Attach to the plot wrapper's onPointerDownCapture so only relayouts
   *  triggered by real pointer interaction are ever recorded. */
  armOnPointerDown: () => void;
};

function useZoomMemory(signature: string, enabled = true): ZoomMemory {
  const stored = useRef<{
    signature: string;
    x?: [number, number];
    y?: [number, number];
  } | null>(null);
  // Plotly also emits relayout events with range keys on PROGRAMMATIC paths
  // (an autosize echo after Plots.resize once recorded the plain autorange
  // as if it were a zoom; every later rebuild then pinned it and other
  // quantities rendered "empty"). Only pointer-armed events are recorded.
  const armed = useRef(false);
  // Omitting previously injected ranges from the next layout is NOT enough
  // to bring autorange back (plotly keeps the last explicit range), so
  // withdrawal must set autorange:true exactly once.
  const injected = useRef(false);

  const armOnPointerDown = () => {
    armed.current = true;
  };

  const onRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    if (!enabled) return;
    const ev = event as Record<string, unknown>;
    if (ev["xaxis.autorange"] === true || ev["yaxis.autorange"] === true) {
      stored.current = null; // double-click / modebar autoscale
      armed.current = false;
      return;
    }
    if (!armed.current) return; // programmatic echo — never record
    const xr0 = ev["xaxis.range[0]"];
    const xr1 = ev["xaxis.range[1]"];
    const yr0 = ev["yaxis.range[0]"];
    const yr1 = ev["yaxis.range[1]"];
    const hasX = typeof xr0 === "number" && typeof xr1 === "number";
    const hasY = typeof yr0 === "number" && typeof yr1 === "number";
    if (!hasX && !hasY) return;
    armed.current = false;
    const prev = stored.current?.signature === signature ? stored.current : null;
    stored.current = {
      signature,
      x: hasX ? [xr0 as number, xr1 as number] : prev?.x,
      y: hasY ? [yr0 as number, yr1 as number] : prev?.y,
    };
  };

  const apply = (layout: Partial<Plotly.Layout>): Partial<Plotly.Layout> => {
    if (!enabled) return layout;
    const mem = stored.current;
    if (mem && mem.signature === signature) {
      const out = { ...layout } as Record<string, unknown>;
      if (mem.x) out.xaxis = { ...(layout.xaxis ?? {}), range: [...mem.x], autorange: false };
      if (mem.y) out.yaxis = { ...(layout.yaxis ?? {}), range: [...mem.y], autorange: false };
      injected.current = true;
      return out as Partial<Plotly.Layout>;
    }
    if (injected.current) {
      // the previous build carried injected ranges — restore autorange once
      injected.current = false;
      stored.current = null;
      const out = { ...layout } as Record<string, unknown>;
      out.xaxis = { ...(layout.xaxis ?? {}), autorange: true };
      out.yaxis = { ...(layout.yaxis ?? {}), autorange: true };
      return out as Partial<Plotly.Layout>;
    }
    return layout;
  };

  return { onRelayout, apply, armOnPointerDown };
}

function usePlotSizeSync(plotDivRef: { current: HTMLElement | null }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);

  const sync = () => {
    if (frameRef.current !== null) return; // coalesce bursts into one frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const gd = plotDivRef.current;
      const box = boxRef.current;
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

  // Callback ref, NOT a mount-time effect: the plot container only renders
  // once data arrives, so an effect that ran at mount observed nothing and
  // window resizes were never seen. This attaches the ResizeObserver the
  // moment the container element actually appears (and re-attaches after
  // remounts), so window/panel/tab-driven size changes all reach the plot.
  const containerRef = (node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    boxRef.current = node;
    if (node) {
      const observer = new ResizeObserver(() => sync());
      observer.observe(node);
      observerRef.current = observer;
      sync();
    }
  };

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    []
  );

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
        // normalize swaps the plotted column (mAh ↔ mAh/g) at render time,
        // so it MUST invalidate the trace/layout memos
        normalize: spec.presentation.normalize_by_mass ?? false,
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
  const explainer = getCycleQuantityExplainer(
    spec.presentation.quantity ?? "discharge_capacity",
    Boolean(spec.presentation.normalize_by_mass)
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
    update((s) => writeScopedStyle(s, "cycles", fn));
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

  const buildExportFigure = (plan: { layoutWidth: number; layoutHeight: number }) => {
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
    return { data: traces, layout: exportLayout };
  };

  // faithful mini-render of the export output for the settings popover
  const getExportPreview = async (): Promise<string | null> => {
    if (!plotDivRef.current || traces.length === 0) return null;
    const plan = resolveExportPlan(style, plotDivRef.current);
    const toImage = (
      PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
    ).toImage;
    return toImage(buildExportFigure(plan), {
      format: "png",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      scale: Math.min(1, 420 / plan.layoutWidth),
    });
  };

  const handleDataExport = () => {
    downloadDataExport(tracesToColumns(traces, layout), style, `${slugFilename(plotName)}-data`).catch(
      (e: Error) => notifications.show({ message: e.message || "Data export failed.", color: "red" })
    );
  };

  const exportPlot = async (format: PlotExportFormat) => {
    if (!plotDivRef.current || !result) return;
    try {
      const plan = resolveExportPlan(style, plotDivRef.current);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(plotName);
      // Render off the live figure with an export-only layout (exact size,
      // optional in-figure title) so the on-screen plot is never disturbed.
      const figure = buildExportFigure(plan);
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
          explainer={explainer}
          onExport={exportPlot}
          onDataExport={handleDataExport}
          getExportPreview={getExportPreview}
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
            onPointerDownCapture={zoom.armOnPointerDown}
            style={{ width: "100%", minWidth: 0, opacity: updating ? 0.42 : 1, transition: "opacity 160ms ease" }}
          >
            <Plot
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
        derivative: cfg.view === "voltage_current" ? null : {
          view: cfg.view,
          phase: cfg.derivative_phase,
          specific: cfg.derivative_specific,
          absoluteDischarge: cfg.derivative_absolute_discharge,
          smoothing: cfg.smoothing_window,
        },
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
  const zoomSignature = `${timeResult.data?.computed_at ?? "no-data"}|${cfg.view}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`;
  const zoom = useZoomMemory(zoomSignature, cfg.view !== "voltage_current" || !cfg.stacked);
  const layout = useMemo(
    () => zoom.apply(timeCapacityLayout(timeResult.data, spec)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeResult.data, viewSignature]
  );
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

  const buildExportFigure = (plan: { layoutWidth: number; layoutHeight: number }) => {
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
    return { data: traces, layout: exportLayout };
  };

  // faithful mini-render of the export output for the settings popover
  const getExportPreview = async (): Promise<string | null> => {
    if (!plotDivRef.current || traces.length === 0) return null;
    const plan = resolveExportPlan(style, plotDivRef.current);
    const toImage = (
      PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
    ).toImage;
    return toImage(buildExportFigure(plan), {
      format: "png",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      scale: Math.min(1, 420 / plan.layoutWidth),
    });
  };

  const handleDataExport = () => {
    downloadDataExport(tracesToColumns(traces, layout), style, `${slugFilename(plotName)}-data`).catch(
      (e: Error) => notifications.show({ message: e.message || "Data export failed.", color: "red" })
    );
  };

  const exportPlot = async (format: PlotExportFormat) => {
    if (!plotDivRef.current || !timeResult.data) return;
    try {
      const plan = resolveExportPlan(style, plotDivRef.current);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(plotName);
      const figure = buildExportFigure(plan);
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
          explainer={explainer}
          onExport={exportPlot}
          onDataExport={handleDataExport}
          getExportPreview={getExportPreview}
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

  const toggleCellVisibility = (cellId: number, context: VisibilityContext) => {
    const groups = groupsQuery.data ?? [];
    update((s) => {
      const isHidden = s.selection.exclusions.some((exclusion) =>
        exclusionAppliesToContext(exclusion, cellId, context)
      );
      if (!isHidden) {
        s.selection.exclusions.push({
          cell_id: cellId,
          entry_kind: context.kind,
          entry_ref_id: context.ref_id,
          reason: null,
          excluded_at: new Date().toISOString(),
        });
        return;
      }

      const hadLegacyExclusion = s.selection.exclusions.some(
        (exclusion) =>
          exclusion.cell_id === cellId &&
          exclusion.entry_kind == null &&
          exclusion.entry_ref_id == null
      );
      s.selection.exclusions = s.selection.exclusions.filter((exclusion) => {
        const legacy =
          exclusion.cell_id === cellId &&
          exclusion.entry_kind == null &&
          exclusion.entry_ref_id == null;
        return !legacy && !isExactContextExclusion(exclusion, cellId, context);
      });

      // Legacy plots hid a cell everywhere. Showing one occurrence converts
      // the other occurrences to explicit scoped exclusions.
      if (hadLegacyExclusion) {
        for (const other of selectionContextsForCell(s.selection.entries, groups, cellId)) {
          if (other.kind === context.kind && other.ref_id === context.ref_id) continue;
          if (!s.selection.exclusions.some((exclusion) => isExactContextExclusion(exclusion, cellId, other))) {
            s.selection.exclusions.push({
              cell_id: cellId,
              entry_kind: other.kind,
              entry_ref_id: other.ref_id,
              reason: null,
              excluded_at: new Date().toISOString(),
            });
          }
        }
      }
    });
  };

  const toggleReplicateVisibility = (groupId: number) => {
    update((s) => {
      const hidden = s.selection.hidden_replicate_group_ids ?? [];
      s.selection.hidden_replicate_group_ids = hidden.includes(groupId)
        ? hidden.filter((id) => id !== groupId)
        : [...hidden, groupId];
    });
  };

  const removeAnalysisEntry = (index: number) => {
    update((s) => {
      const [removed] = s.selection.entries.splice(index, 1);
      if (!removed) return;
      s.selection.exclusions = s.selection.exclusions.filter(
        (exclusion) =>
          exclusion.entry_kind !== removed.kind || exclusion.entry_ref_id !== removed.ref_id
      );
      if (removed.kind === "replicate_group") {
        s.selection.hidden_replicate_group_ids = (
          s.selection.hidden_replicate_group_ids ?? []
        ).filter((id) => id !== removed.ref_id);
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
        onRemoveEntry={removeAnalysisEntry}
        onToggleCell={toggleCellVisibility}
        onToggleReplicate={toggleReplicateVisibility}
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
