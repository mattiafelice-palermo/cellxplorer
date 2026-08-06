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
  Collapse,
  ColorInput,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Menu,
  Modal,
  NumberInput,
  Paper,
  Popover,
  Progress,
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
  IconStack2,
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
  IconFileExport,
  IconFolder,
  IconGauge,
  IconInfoCircle,
  IconLayersIntersect,
  IconPalette,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShare3,
  IconSettings,
  IconTable,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import PlotlyLib from "plotly.js-dist-min";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSpec,
  AnalysisTabKey,
  ANALYSIS_TAB_KEYS,
  ApiError,
  Badge as ApiBadge,
  BackgroundJob,
  CacheWarmupTask,
  CellMetrics,
  AnalysisSummary,
  CellSummary,
  ComputeResult,
  ColorPaletteSettings,
  DownloadSettings,
  del,
  FolderNode,
  get,
  PortableAnalysisEstimate,
  PortableSourcePreflight,
  PortableSourceUpdateResult,
  post,
  postBlob,
  put,
  PlotAspectRatioKey,
  PlotExportFormat,
  ProtocolSegment,
  ReplicateGroupSummary,
  AnalysisDraftPlot,
  SavedAnalysisPlot,
  SelectionEntry,
  PlotStyle,
  PlotStylePresetSettings,
  PlotAxisScope,
  AggregateSeries,
  CellSeries,
  SeriesStyleOverride,
  SeriesStyleRule,
  TimeCapacityResult,
  TimeCapacityTrace,
  Tree,
} from "../api";
import {
  clearAnalysisQueryCache,
  invalidateAnalysisQueries,
} from "../analysisQueryCache";
import {
  clearAnalysisWorkspaceEditorState,
  getAnalysisWorkspaceEditorState,
  isAnalysisWorkspaceViewActive,
  setAnalysisWorkspaceEditorState,
} from "../analysisWorkspace";
import {
  buildCommitSavedPlotSpec,
  buildDiscardEditedSavedPlotSpec,
  buildDiscardNewPlotSpec,
  buildStablePersistSpec,
  captureNormalWorkspace,
  draftAsSavedPlot,
  draftPlotFromWorkspace,
  isDraftPreviewPlotId,
  plotSessionBelongsToTab,
  resolveColdOpenWorkspace,
  savedPlotFromDraftSource,
  shouldRunLivePlotCompute,
  stripDraftPlots,
  type DraftSaveSource,
  type NormalWorkspaceSnapshot,
} from "../analysisDraftPolicy";
import {
  plotViewSignature,
  savedPlotPreviewSignature,
  savedPlotSelectionFromSpec,
  specForSavedPlotView,
} from "../analysisPlotPolicy";
import { DraftPlotCard } from "../components/DraftPlotCard";
import { resolveWarmup } from "../warmupCompletion";
import {
  DIAGNOSTIC_DEFAULTS,
  findDiagnosticCyclesAcross,
  formatCycleRanges,
  summarizeHidden,
} from "../diagnosticCycles";
import {
  CellHoverCard,
  RelatedAnalysesPopover,
  relatedAnalysesForCell,
} from "../components/CellSamplePopovers";
import Plot from "../components/Plot";
import {
  StepsPlotCard,
  StepsSettings,
  stepsLayoutForSpec,
  stepsTracesForResult,
  type StepsResult,
} from "../components/StepsPlotCard";
import {
  DcirPlotCard,
  DcirSettings,
  dcirLayoutForSpec,
  dcirTracesForResult,
  type DcirResult,
} from "../components/DcirPlotCard";
import {
  ChargeabilityPlotCard,
  ChargeabilitySettings,
  chargeabilityLayoutForSpec,
  chargeabilityTracesForResult,
  chargeabilityViewFor,
  type ChargeabilityResult,
} from "../components/ChargeabilityPlotCard";
import {
  RateCapabilityPlotCard,
  RateCapabilitySettings,
  rateCapabilityLayoutForSpec,
  rateCapabilityTracesForResult,
  rateCapabilityViewFor,
  type RateCapabilityResult,
} from "../components/RateCapabilityPlotCard";
import { FilenameTemplateEditor } from "../components/FilenameTemplateEditor";
import { ProtocolSegmentsPanel } from "../components/ProtocolSegmentsPanel";
import { saveDownload, shareDownload } from "../downloads";
import { renderExportFilename, sanitizeExportFilename } from "../exportFilenames";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "../navigationEvents";
import {
  getCycleQuantityExplainer,
  getTimeCapacityExplainer,
  type PlotExplainer,
} from "../plotExplainers";
import { applyPlotStylePreset } from "../plotStylePresets";
import {
  aggregateSeriesDescriptor,
  cellSeriesDescriptor,
  cyclesSeriesDescriptors,
  decimatePreviewTraces,
  resolveSeriesStyle,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  shadowOffsetValues,
  shadowRgba,
  shortSourceName,
  timeCapacitySeriesDescriptor,
  timeCapacitySeriesDescriptors,
  type ResolvedSeriesStyle,
  type SeriesDescriptor,
} from "../seriesStyling";
import { SeriesStyleModal } from "../components/SeriesStyleModal";
import { axisLayout, numericTraceExtent } from "../plotAxisLayout";
import {
  sourceBoundaryPointIndices,
  sourceExportColumns,
  type SourceExportColumn,
  type SourceExportValue,
} from "../sourceChainPlot";
import {
  multiSourceAnalysisPolicy,
  type MultiSourceAnalysisPolicy,
  type SourceCountCell,
} from "../multiSourceAnalysisPolicy";
import {
  PLOT_PALETTES,
  PALETTE_OPTIONS,
  DEFAULT_PLOT_STYLE,
  normalizePlotStyle,
  currentPlotStyle,
  writeScopedStyle,
  plotPalette,
  cePalette,
  plotMode,
  markerSymbol,
  cePlotMode,
  ceMarkerSymbol,
  hexToRgba,
} from "../plotStyle";
// Re-exported for consumers that previously imported these from AnalysisPage.tsx
// (ChargeabilityPlotCard, DcirPlotCard, StepsPlotCard, RateCapabilityPlotCard, etc.).
export { currentPlotStyle, plotPalette, cePalette, markerSymbol, ceMarkerSymbol } from "../plotStyle";

function formatPortableBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

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
  { value: "steps", label: "Steps", icon: IconStack2, plotTab: true },
  { value: "crate", label: "C-rate", icon: IconGauge, plotTab: true },
  { value: "chargeability", label: "Chargeability", icon: IconBolt, plotTab: true },
  { value: "dcir", label: "DCIR", icon: IconActivity, plotTab: true },
  { value: "recap", label: "Recap", icon: IconTable, plotTab: true },
  { value: "settings", label: "Settings", icon: IconSettings, plotTab: false },
];

function AnalysisTabHeader({
  value,
  onCommit,
}: {
  value: AnalysisTabKey;
  onCommit: (value: AnalysisTabKey) => void;
}) {
  const [visualValue, setVisualValue] = useState(value);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setVisualValue(value);
  }, [value]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const selectTab = (nextValue: string | null) => {
    if (!nextValue) return;
    const next = nextValue as AnalysisTabKey;
    setVisualValue(next);
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onCommit(next);
      }, 0);
    });
  };

  return (
    <Tabs value={visualValue} onChange={selectTab}>
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
    </Tabs>
  );
}

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

type PortableFigure = {
  data: unknown[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
};

type PortableSummaryRow = { label: string; cycles: number | null; status: string };

type PlotArtifact = {
  signature: string;
  svg: string;
  thumbnail?: string | null;
  preview_thumbnail?: string | null;
  figure: PortableFigure;
  summary: PortableSummaryRow[];
};

type PlotThumbnail = {
  signature: string;
  thumbnail: string;
  preview_thumbnail?: string | null;
};

async function lookupPlotThumbnail(
  analysisId: number,
  plotId: string,
  signature: string
): Promise<PlotThumbnail | null> {
  // Draft previews are session-only — never hit the saved-plot artifact API.
  if (isDraftPreviewPlotId(plotId)) return null;
  try {
    return await post<PlotThumbnail>(
      `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/thumbnail/lookup`,
      { signature }
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function lookupPlotArtifact(
  analysisId: number,
  plotId: string,
  signature: string,
): Promise<PlotArtifact | null> {
  if (isDraftPreviewPlotId(plotId)) return null;
  try {
    return await post<PlotArtifact>(
      `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/lookup`,
      { signature },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function jobProgress(job: BackgroundJob | undefined): number {
  if (!job) return 0;
  if (job.total <= 0) return job.status === "completed" ? 100 : 0;
  return Math.max(0, Math.min(100, (job.completed / job.total) * 100));
}

/**
 * Report a pending state only once it has lasted long enough to be worth
 * mentioning, then for long enough to be read.
 *
 * Most loads are served from cache in well under 250ms. Showing a progress bar
 * for that long makes a fast app feel sluggish twice over: the appear/disappear
 * registers as a flicker, and a spinner *means* "this is slow". The floor
 * matters as much as the delay — without it a 300ms load would show a 50ms
 * flash, moving the problem rather than fixing it.
 */
export function useDelayedFlag(active: boolean, delay = 250, minimum = 400): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let timer: number | undefined;
    if (active && !visible) {
      timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (!active && visible) {
      const remaining = Math.max(0, minimum - (Date.now() - shownAt.current));
      if (remaining === 0) setVisible(false);
      else timer = window.setTimeout(() => setVisible(false), remaining);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, visible, delay, minimum]);
  return visible;
}

function ComputeProgress({ job, label }: { job: BackgroundJob | undefined; label: string }) {
  return (
    <Stack gap="xs" w={360} maw="80%">
      <Text size="sm" fw={600} ta="center">
        {job?.description || label}
      </Text>
      <Progress value={jobProgress(job)} animated={job?.status === "running"} />
      <Text size="xs" c="dimmed" ta="center">
        {job?.total ? `${job.completed} of ${job.total} cells` : "Preparing cached data"}
      </Text>
    </Stack>
  );
}

function timeCapacityConfig(spec: AnalysisSpec): TimeCapacityConfig {
  return { ...DEFAULT_TIME_CAPACITY, ...(spec.computation.time_capacity ?? {}) };
}

const DEFAULT_STEPS_COMPUTATION: NonNullable<AnalysisSpec["computation"]["steps"]> = {
  series: [],
  mode: "union",
};

const DEFAULT_STEPS_VIEW: NonNullable<AnalysisSpec["presentation"]["steps_view"]> = {
  quantity: "time",
  direction: "charge",
  include_rest: false,
  x_axis: "occurrence",
};

const DEFAULT_DCIR_COMPUTATION: NonNullable<AnalysisSpec["computation"]["dcir"]> = {
  series: [],
};

const DEFAULT_DCIR_VIEW: NonNullable<AnalysisSpec["presentation"]["dcir_view"]> = {
  quantity: "absolute",
  x_axis: "occurrence",
  candidate_filter: {
    min_rest_s: 600,
    max_pulse_s: 120,
    min_ratio: 10,
  },
};

const DEFAULT_CHARGEABILITY_COMPUTATION: NonNullable<
  AnalysisSpec["computation"]["chargeability"]
> = {
  initial_soc_max_pct: 20,
  final_soc_min_pct: 80,
  min_current_ceiling_c: 7,
  soc_tolerance_pct: 2,
};

const DEFAULT_CHARGEABILITY_VIEW: NonNullable<
  AnalysisSpec["presentation"]["chargeability_view"]
> = {
  x_axis: "soc_pct",
  y_axis: "c_rate",
  time_unit: "min",
};

const DEFAULT_RATE_CAPABILITY_FAMILY = {
  enabled: true,
  charge_structure: "auto" as const,
  fixed_rate_c: null,
  selected_rates_c: [] as number[],
  monotonic: "prefer" as const,
  scaffold: "prefer" as const,
};

const DEFAULT_RATE_CAPABILITY_COMPUTATION: NonNullable<
  AnalysisSpec["computation"]["rate_capability"]
> = {
  min_points: 3,
  cutoff_tolerance_v: 0.03,
  rate_tolerance_fraction: 0.03,
  families: {
    charge: { ...DEFAULT_RATE_CAPABILITY_FAMILY },
    discharge: { ...DEFAULT_RATE_CAPABILITY_FAMILY },
  },
};

const DEFAULT_RATE_CAPABILITY_VIEW: NonNullable<
  AnalysisSpec["presentation"]["rate_capability_view"]
> = {
  x_axis: "c_rate",
  y_axis: "capacity_mah",
  show_charge: true,
  show_discharge: true,
  x_spacing: "equal",
  visualization: "line",
};

const DEFAULT_COMPUTATION: AnalysisSpec["computation"] = {
  cycle_range: { start: 1, end: null },
  exclude_check_cycles_every_n: 0,
  retention_reference: { mode: "max_first_n", n: 5, cycle: null },
  formation_cycles: 3,
  polarization: {
    method: "mean",
    direction: "charge_minus_discharge",
  },
  protocol_filter: {
    excluded_segment_ids: [],
    only_segment_ids: [],
  },
  time_capacity: DEFAULT_TIME_CAPACITY,
  steps: DEFAULT_STEPS_COMPUTATION,
  dcir: DEFAULT_DCIR_COMPUTATION,
  chargeability: DEFAULT_CHARGEABILITY_COMPUTATION,
  rate_capability: DEFAULT_RATE_CAPABILITY_COMPUTATION,
};

const DEFAULT_AGGREGATION: AnalysisSpec["aggregation"] = {
  mode: "replicate_mean",
  dispersion: "std",
  min_n_for_band: 2,
};

const DEFAULT_PRESENTATION: AnalysisSpec["presentation"] = {
  quantity: "discharge_capacity",
  normalize_by_mass: false,
  ce_overlay: true,
  show_individual_cells: true,
  legend: true,
  hidden_protocol_segment_ids: [],
  steps_view: DEFAULT_STEPS_VIEW,
  dcir_view: DEFAULT_DCIR_VIEW,
  chargeability_view: DEFAULT_CHARGEABILITY_VIEW,
  rate_capability_view: DEFAULT_RATE_CAPABILITY_VIEW,
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
        : cfg.x_axis === "capacity_mah_cm2"
        ? "areal capacity (mAh/cm²)"
        : cfg.x_axis === "capacity_mah"
        ? "capacity (mAh)"
        : `time (${cfg.time_unit})`;
    return `Voltage${cfg.stacked ? " and current" : ""} vs ${axis}`;
  }
  if (tab === "cycles") return `${quantityLabel(result, spec)} vs cycle`;
  if (tab === "dcir") {
    const view = { ...DEFAULT_DCIR_VIEW, ...(spec.presentation.dcir_view ?? {}) };
    const quantity =
      view.quantity === "relative" ? "DCIR change from first (%)" : "DCIR (mΩ)";
    const axis =
      view.x_axis === "cycle"
        ? "cycle"
        : view.x_axis === "time"
          ? "elapsed time"
          : "occurrence";
    return `${quantity} vs ${axis}`;
  }
  if (tab === "crate") {
    const view = rateCapabilityViewFor(spec);
    const xAxis =
      view.y_axis === "asymmetry_ratio" || view.x_axis === "c_rate"
        ? "C-rate"
        : view.x_axis === "current_ma"
          ? "current"
          : view.x_axis === "current_ma_g"
            ? "specific current"
            : "areal current density";
    const yAxis =
      view.y_axis === "capacity_mah"
        ? "CC capacity"
        : view.y_axis === "capacity_mah_g"
          ? "specific CC capacity"
          : view.y_axis === "capacity_mah_cm2"
            ? "areal CC capacity"
            : view.y_axis === "retention_pct"
              ? "retention from lowest common rate"
              : "rate-capability asymmetry";
    return `${yAxis} vs ${xAxis}`;
  }
  if (tab === "chargeability") {
    const view = chargeabilityViewFor(spec);
    const xAxis =
      view.x_axis === "soc_pct"
        ? "capacity-based SoC"
        : view.x_axis === "capacity_mah"
          ? "capacity"
          : view.x_axis === "capacity_mah_g"
            ? "specific capacity"
            : view.x_axis === "capacity_mah_cm2"
              ? "areal capacity"
              : `elapsed time (${view.time_unit})`;
    const yAxis =
      view.y_axis === "c_rate"
        ? "C-rate"
        : view.y_axis === "current_ma"
          ? "current"
          : view.y_axis === "current_ma_g"
            ? "specific current"
            : "areal current density";
    return `${yAxis} vs ${xAxis}`;
  }
  if (tab === "recap") return "Recap table";
  if (tab === "settings") return "Analysis settings";
  return `${tabLabel(tab)} view`;
}

function isPolarizationQuantity(quantity: string): boolean {
  return quantity === "polarization" || quantity === "polarization_pct";
}

function suggestedPlotName(tab: AnalysisTabKey, result: ComputeResult | undefined, spec: AnalysisSpec): string {
  if (tab === "time_capacity") return "Time / capacity comparison";
  if (tab === "dcir") {
    return spec.presentation.dcir_view?.quantity === "relative"
      ? "DCIR change comparison"
      : "DCIR comparison";
  }
  if (tab === "chargeability") {
    const y = spec.presentation.chargeability_view?.y_axis ?? DEFAULT_CHARGEABILITY_VIEW.y_axis;
    if (y === "current_ma") return "Chargeability current comparison";
    if (y === "current_ma_g") return "Chargeability specific current comparison";
    if (y === "current_ma_cm2") return "Chargeability areal current comparison";
    return "Chargeability comparison";
  }
  if (tab === "crate") {
    const quantity = rateCapabilityViewFor(spec).y_axis;
    return quantity === "asymmetry_ratio"
      ? "Rate-capability asymmetry"
      : quantity === "retention_pct"
        ? "Rate-capability retention"
        : "Rate capability comparison";
  }
  if (tab === "steps") {
    const quantity = spec.presentation.steps_view?.quantity ?? DEFAULT_STEPS_VIEW.quantity;
    if (quantity === "cv_charge_time") return "Steps CV charge time comparison";
    if (quantity === "voltage") return "Steps voltage comparison";
    if (quantity === "capacity") return "Steps capacity comparison";
    if (quantity === "block_duration") return "Steps block duration comparison";
    return "Steps time comparison";
  }
  return tab === "cycles" ? `${quantityLabel(result, spec)} comparison` : `${tabLabel(tab)} view`;
}

/** Quantity (and related options) that drive the default plot name. */
function plotNamingQuantityKey(
  tab: AnalysisTabKey,
  presentation: AnalysisSpec["presentation"],
): string {
  if (tab === "cycles" || tab === "recap") {
    return JSON.stringify({
      quantity: presentation.quantity ?? "discharge_capacity",
      normalize_by_mass: Boolean(presentation.normalize_by_mass),
    });
  }
  if (tab === "dcir") {
    return JSON.stringify({
      quantity: presentation.dcir_view?.quantity ?? DEFAULT_DCIR_VIEW.quantity,
    });
  }
  if (tab === "crate") {
    return JSON.stringify({
      y_axis: presentation.rate_capability_view?.y_axis ?? DEFAULT_RATE_CAPABILITY_VIEW.y_axis,
    });
  }
  if (tab === "steps") {
    const view = { ...DEFAULT_STEPS_VIEW, ...(presentation.steps_view ?? {}) };
    return JSON.stringify({
      quantity: view.quantity,
      direction: view.direction,
      include_rest: view.include_rest,
    });
  }
  if (tab === "chargeability") {
    const view = { ...DEFAULT_CHARGEABILITY_VIEW, ...(presentation.chargeability_view ?? {}) };
    return JSON.stringify({
      x_axis: view.x_axis,
      y_axis: view.y_axis,
      time_unit: view.time_unit,
    });
  }
  // Time/capacity plot name is not quantity-driven today.
  return tab;
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

/**
 * The grid / frame / zero-line axis props shared by every simple plot tab
 * (DCIR, steps, rate capability, chargeability). Those cards each build a
 * minimal layout by hand and were missing the frame (Border) and zero-line
 * colour wiring, so those style toggles did nothing. Spread this onto each
 * axis and the Border/Grid/Zero-line switches all take effect. Pass
 * `zeroLine: false` for the x axis, where a zero line rarely makes sense.
 */
/**
 * Whether an analysis sample (cell) has been hidden from the sidebar. The
 * series-based tabs (DCIR, steps, rate capability, chargeability) reference a
 * cell directly, so any exclusion touching that cell hides its lines — this is
 * what makes the "Analysis samples" eye toggle affect those tabs too.
 */
export function isCellHiddenInAnalysis(spec: AnalysisSpec, cellId: number): boolean {
  return (spec.selection.exclusions ?? []).some((exclusion) => exclusion.cell_id === cellId);
}

/** Display-only: has this DCIR/steps segment been hidden across all cells? */
export function isAnalysisSegmentHidden(spec: AnalysisSpec, segmentId: string): boolean {
  return (spec.presentation.hidden_analysis_segment_ids ?? []).includes(segmentId);
}

/** Display-only: has this individual (cell, segment) series line been hidden? */
export function isSeriesHidden(spec: AnalysisSpec, seriesId: string): boolean {
  return (spec.presentation.hidden_series_ids ?? []).includes(seriesId);
}

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

const MARKER_SYMBOL_OPTIONS = [
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "diamond", label: "Diamond" },
  { value: "triangle-up", label: "Triangle" },
  { value: "cross", label: "Cross" },
  { value: "x", label: "X" },
];

// Shared tick-mark + tick-label styling for all axes.
function tickLayout(style: PlotStyle, axis: PlotStyle["x_axis"]) {
  return {
    ticks: style.tick_marks === "none" ? ("" as const) : style.tick_marks,
    ticklen: style.tick_length,
    tickwidth: style.tick_width,
    tickcolor: style.frame_color,
    tickfont: { size: style.tick_font_size },
    ticklabelstandoff: axis.tick_label_standoff,
  };
}

function axisGapDelta(axis: PlotStyle["x_axis"]): number {
  return axis.title_standoff + axis.tick_label_standoff - 18;
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

function textFromDataUrl(dataUrl: string): string {
  const [metadata, payload = ""] = dataUrl.split(",", 2);
  return metadata.includes(";base64")
    ? new TextDecoder().decode(bytesFromDataUrl(dataUrl))
    : decodeURIComponent(payload);
}

// ------------------------------------------------------ data export (CSV/XLSX)

type DataColumn = SourceExportColumn;

function exportDecimalPlaces(header: string): number {
  const value = header.toLowerCase();
  if (value.includes("cycle")) return 0;
  if (value.includes("time")) return 3;
  if (value.includes("voltage") || value.includes("current")) return 5;
  if (value.includes("derivative") || value.includes("dq/dv") || value.includes("dv/dq")) return 7;
  return 6;
}

// Export exactly what is plotted: one x/y column pair per visible trace
// (works for any tab — traces need not share an x grid). Dispersion bands
// (fill traces) are skipped.
export function tracesToColumns(traces: Plotly.Data[], layout: Partial<Plotly.Layout>): DataColumn[] {
  const axisTitle = (axis: unknown): string =>
    String((axis as { title?: { text?: string } })?.title?.text ?? "");
  const columns: DataColumn[] = [];
  for (const raw of traces) {
    const t = raw as Record<string, unknown>;
    if (t.fill === "toself") continue;
    const exportXs = (
      t.meta as { cellxplorer_export_x?: (number | null)[] } | undefined
    )?.cellxplorer_export_x;
    const xs = exportXs ?? ((t.x as (number | null)[]) ?? []);
    const ys = (t.y as (number | null)[]) ?? [];
    if (!ys.length) continue;
    const exportColumns = t.cellxplorer_export_columns as DataColumn[] | undefined;
    if (Array.isArray(exportColumns)) columns.push(...exportColumns);
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
  precision: PlotStyle["data_precision"],
  decimal: PlotStyle["data_decimal_separator"],
  delimiter: PlotStyle["data_delimiter"]
): string {
  const sep = delimiter === "tab" ? "\t" : delimiter === "semicolon" ? ";" : ",";
  const formatNumber = (v: SourceExportValue | undefined, header: string) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    if (typeof v === "string") return v;
    const rounded =
      precision === "full"
        ? v
        : Number(v.toFixed(exportDecimalPlaces(header)));
    const s = String(rounded);
    return decimal === "comma" ? s.replace(".", ",") : s;
  };
  const quote = (s: string) =>
    s.includes(sep) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
  const lines = [columns.map((c) => quote(c.header)).join(sep)];
  for (let i = 0; i < rowCount; i += 1) {
    lines.push(columns.map((c) => formatNumber(c.values[i], c.header)).join(sep));
  }
  // BOM so Excel detects UTF-8
  return "﻿" + lines.join("\r\n");
}

export async function downloadDataExport(columns: DataColumn[], style: PlotStyle, baseName: string): Promise<void> {
  if (columns.length === 0) return;
  if (style.data_export_format === "xlsx") {
    const XLSX = await import("xlsx");
    const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
    const aoa: (string | number | null)[][] = [columns.map((c) => c.header)];
    for (let i = 0; i < rowCount; i += 1) {
      aoa.push(
        columns.map((c) => {
          const v = c.values[i];
          if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
          if (typeof v === "string") return v;
          if (style.data_precision === "full") return v;
          return Number(v.toFixed(exportDecimalPlaces(c.header)));
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
  const text = buildDelimitedText(
    columns,
    style.data_precision,
    style.data_decimal_separator,
    style.data_delimiter
  );
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

type ExportPlan = {
  layoutWidth: number;
  layoutHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  innerRatio: number;
  margin: { l: number; r: number; t: number; b: number };
};

function layoutMargins(
  layout: Partial<Plotly.Layout>,
  style: PlotStyle
): ExportPlan["margin"] {
  const raw = (layout.margin ?? {}) as Partial<ExportPlan["margin"]>;
  const margin = {
    l: Number(raw.l ?? 60),
    r: Number(raw.r ?? 30),
    t: Number(raw.t ?? 20),
    b: Number(raw.b ?? 55),
  };
  if (style.export_include_title) {
    margin.t = Math.max(margin.t, style.axis_title_size + 34);
  }
  return margin;
}

export function resolveExportPlan(
  style: PlotStyle,
  viewSize: { width: number; height: number } | null,
  layout: Partial<Plotly.Layout>
): ExportPlan {
  const viewWidth = Math.max(320, Math.round(viewSize?.width || style.export_width));
  const viewHeight = Math.max(240, Math.round(viewSize?.height || Number(layout.height) || 500));
  const margin = layoutMargins(layout, style);
  const aspect = style.export_aspect_ratio ?? "view";
  const viewInnerWidth = Math.max(120, viewWidth - margin.l - margin.r);
  const viewInnerHeight = Math.max(120, viewHeight - margin.t - margin.b);
  const viewRatio = viewInnerWidth / viewInnerHeight;
  const layoutWidth = viewWidth;
  const pixelWidth = Math.max(320, Math.round(style.export_width || viewWidth));
  const scale = pixelWidth / layoutWidth;
  let layoutHeight: number;
  let pixelHeight: number;
  let innerRatio: number;
  if (aspect === "custom") {
    pixelHeight = Math.max(240, Math.round(style.export_height || viewHeight * scale));
    layoutHeight = Math.max(margin.t + margin.b + 120, pixelHeight / scale);
    pixelHeight = Math.round(layoutHeight * scale);
    innerRatio = viewInnerWidth / Math.max(120, layoutHeight - margin.t - margin.b);
  } else {
    innerRatio = aspectRatioValue(aspect, viewRatio);
    layoutHeight = viewInnerWidth / innerRatio + margin.t + margin.b;
    pixelHeight = Math.max(240, Math.round(layoutHeight * scale));
  }
  return {
    layoutWidth: Math.round(layoutWidth),
    layoutHeight: Math.round(layoutHeight),
    pixelWidth,
    pixelHeight,
    scale,
    innerRatio,
    margin,
  };
}

export function exportFigure(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  plan: ExportPlan
) {
  const exportLayout: Partial<Plotly.Layout> = {
    ...layout,
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    autosize: false,
    margin: plan.margin,
  };
  if (style.export_include_title) {
    exportLayout.title = { text: plotName, font: { size: style.axis_title_size + 3 } };
  }
  return { data: traces, layout: exportLayout };
}

export async function styledPlotExportPreview(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  viewSize: { width: number; height: number } | null,
): Promise<string | null> {
  if (traces.length === 0) return null;
  const plan = resolveExportPlan(style, viewSize, layout);
  const toImage = (
    PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
  ).toImage;
  return toImage(exportFigure(traces, layout, style, plotName, plan), {
    format: "png",
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    scale: Math.min(1, 420 / plan.layoutWidth),
  });
}

export async function downloadStyledPlotExport(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  format: PlotExportFormat,
  baseName: string,
  viewSize: { width: number; height: number } | null,
): Promise<void> {
  if (traces.length === 0) return;
  const plan = resolveExportPlan(style, viewSize, layout);
  const toImage = (
    PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
  ).toImage;
  const figure = exportFigure(traces, layout, style, plotName, plan);
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
        style.export_aspect_ratio,
      ),
      `${slugFilename(baseName)}.pdf`,
    );
    return;
  }
  const dataUrl = await toImage(figure, {
    format,
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    scale: plan.scale,
  });
  const blob =
    format === "png"
      ? pngWithPpi(dataUrl, Math.max(36, style.export_ppi ?? 96))
      : blobFromDataUrl(dataUrl, "image/svg+xml");
  await downloadBlob(blob, `${slugFilename(baseName)}.${format}`);
}


function normalizeSavedPlot(plot: SavedAnalysisPlot, base: AnalysisSpec): SavedAnalysisPlot {
  const validSegmentIds = new Set((base.protocol_segments ?? []).map((segment) => segment.id));
  const protocolFilter = {
    excluded_segment_ids: [...new Set(plot.computation?.protocol_filter?.excluded_segment_ids ?? [])]
      .filter((id) => validSegmentIds.has(id)),
    only_segment_ids: [...new Set(plot.computation?.protocol_filter?.only_segment_ids ?? [])]
      .filter((id) => validSegmentIds.has(id)),
  };
  const presentation = {
    ...DEFAULT_PRESENTATION,
    ...(plot.presentation ?? {}),
    hidden_protocol_segment_ids: [
      ...new Set(plot.presentation?.hidden_protocol_segment_ids ?? []),
    ].filter((id) => validSegmentIds.has(id)),
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
    computation: {
      ...DEFAULT_COMPUTATION,
      ...(plot.computation ?? {}),
      protocol_filter: protocolFilter,
      steps: {
        ...DEFAULT_STEPS_COMPUTATION,
        ...(plot.computation?.steps ?? {}),
      },
      dcir: {
        ...DEFAULT_DCIR_COMPUTATION,
        ...(plot.computation?.dcir ?? {}),
      },
      chargeability: {
        ...DEFAULT_CHARGEABILITY_COMPUTATION,
        ...(plot.computation?.chargeability ?? {}),
      },
      rate_capability: {
        ...DEFAULT_RATE_CAPABILITY_COMPUTATION,
        ...(plot.computation?.rate_capability ?? {}),
        families: {
          charge: {
            ...DEFAULT_RATE_CAPABILITY_FAMILY,
            ...(plot.computation?.rate_capability?.families?.charge ?? {}),
          },
          discharge: {
            ...DEFAULT_RATE_CAPABILITY_FAMILY,
            ...(plot.computation?.rate_capability?.families?.discharge ?? {}),
          },
        },
      },
    },
    presentation: {
      ...presentation,
      steps_view: {
        ...DEFAULT_STEPS_VIEW,
        ...(plot.presentation?.steps_view ?? {}),
      },
      dcir_view: {
        ...DEFAULT_DCIR_VIEW,
        ...(plot.presentation?.dcir_view ?? {}),
        candidate_filter: {
          ...DEFAULT_DCIR_VIEW.candidate_filter,
          ...(plot.presentation?.dcir_view?.candidate_filter ?? {}),
        },
      },
      chargeability_view: {
        ...DEFAULT_CHARGEABILITY_VIEW,
        ...(plot.presentation?.chargeability_view ?? {}),
      },
      rate_capability_view: {
        ...DEFAULT_RATE_CAPABILITY_VIEW,
        ...(plot.presentation?.rate_capability_view ?? {}),
      },
    },
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
  spec.protocol_segments = (spec.protocol_segments ?? []).map((segment) => ({
    id: segment.id,
    name: segment.name,
    targets: (segment.targets ?? [])
      .map((target) => ({
        protocol_signature: target.protocol_signature,
        step_indices: [...new Set(target.step_indices ?? [])].sort((a, b) => a - b),
      }))
      .filter((target) => target.protocol_signature && target.step_indices.length > 0),
  }));
  spec.dcir_segments = (spec.dcir_segments ?? []).map((segment) => ({
    id: segment.id,
    name: segment.name,
    targets: (segment.targets ?? [])
      .filter(
        (target) =>
          target.protocol_signature &&
          Number.isFinite(target.rest_step_index) &&
          Number.isFinite(target.pulse_step_index) &&
          (target.direction === "charge" || target.direction === "discharge")
      )
      .map((target) => ({ ...target })),
  }));
  const validSegmentIds = new Set(spec.protocol_segments.map((segment) => segment.id));
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
    protocol_filter: {
      excluded_segment_ids: [
        ...new Set(spec.computation?.protocol_filter?.excluded_segment_ids ?? []),
      ].filter((id) => validSegmentIds.has(id)),
      only_segment_ids: [
        ...new Set(spec.computation?.protocol_filter?.only_segment_ids ?? []),
      ].filter((id) => validSegmentIds.has(id)),
    },
    time_capacity: {
      ...DEFAULT_TIME_CAPACITY,
      ...(spec.computation?.time_capacity ?? {}),
    },
    steps: {
      ...DEFAULT_STEPS_COMPUTATION,
      ...(spec.computation?.steps ?? {}),
    },
    dcir: {
      ...DEFAULT_DCIR_COMPUTATION,
      ...(spec.computation?.dcir ?? {}),
    },
    chargeability: {
      ...DEFAULT_CHARGEABILITY_COMPUTATION,
      ...(spec.computation?.chargeability ?? {}),
    },
    rate_capability: {
      ...DEFAULT_RATE_CAPABILITY_COMPUTATION,
      ...(spec.computation?.rate_capability ?? {}),
      families: {
        charge: {
          ...DEFAULT_RATE_CAPABILITY_FAMILY,
          ...(spec.computation?.rate_capability?.families?.charge ?? {}),
        },
        discharge: {
          ...DEFAULT_RATE_CAPABILITY_FAMILY,
          ...(spec.computation?.rate_capability?.families?.discharge ?? {}),
        },
      },
    },
  };
  spec.aggregation = { ...DEFAULT_AGGREGATION, ...(spec.aggregation ?? {}) };
  spec.presentation = {
    ...DEFAULT_PRESENTATION,
    ...(spec.presentation ?? {}),
    hidden_protocol_segment_ids: [
      ...new Set(spec.presentation?.hidden_protocol_segment_ids ?? []),
    ].filter((id) => validSegmentIds.has(id)),
    plot_style: normalizePlotStyle(spec.presentation?.plot_style),
    steps_view: {
      ...DEFAULT_STEPS_VIEW,
      ...(spec.presentation?.steps_view ?? {}),
    },
    dcir_view: {
      ...DEFAULT_DCIR_VIEW,
      ...(spec.presentation?.dcir_view ?? {}),
      candidate_filter: {
        ...DEFAULT_DCIR_VIEW.candidate_filter,
        ...(spec.presentation?.dcir_view?.candidate_filter ?? {}),
      },
    },
    chargeability_view: {
      ...DEFAULT_CHARGEABILITY_VIEW,
      ...(spec.presentation?.chargeability_view ?? {}),
    },
    rate_capability_view: {
      ...DEFAULT_RATE_CAPABILITY_VIEW,
      ...(spec.presentation?.rate_capability_view ?? {}),
    },
  };
  const legacyNormalized = LEGACY_NORMALIZED_QUANTITY_MAP[spec.presentation.quantity];
  if (legacyNormalized) {
    spec.presentation.quantity = legacyNormalized;
    spec.presentation.normalize_by_mass = true;
  }
  spec.saved_plots = (spec.saved_plots ?? []).map((plot) => normalizeSavedPlot(plot, spec));
  // Drafts are session-only; never hydrate persisted draft_plots into the editor.
  spec.draft_plots = null;
  spec.draft_plot = null;
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

function selectedSourceCountCells(
  analysis: AnalysisFull,
  spec: AnalysisSpec,
  availableCells: Pick<CellSummary, "id" | "name" | "n_files">[] | undefined = [],
  availableGroups: ReplicateGroupSummary[] | undefined = [],
): SourceCountCell[] {
  const direct = new Map<number, SourceCountCell>(
    analysis.selection_cells.map((cell) => [cell.id, cell]),
  );
  for (const cell of availableCells ?? []) {
    if (!direct.has(cell.id)) {
      direct.set(cell.id, { id: cell.id, name: cell.name, source_count: cell.n_files });
    }
  }
  const groups = new Map<number, { cells: SourceCountCell[] }>();
  for (const group of analysis.selection_groups) {
    for (const cell of group.cells) {
      if (!direct.has(cell.id)) direct.set(cell.id, cell);
    }
    groups.set(group.id, { cells: group.cells });
  }
  for (const group of availableGroups ?? []) {
    groups.set(group.id, {
      cells: group.cells.map((cell) => {
        const resolved = direct.get(cell.id);
        return resolved ?? { id: cell.id, name: cell.name, source_count: null };
      }),
    });
  }
  const selected = new Map<number, SourceCountCell>();
  for (const entry of spec.selection.entries ?? []) {
    if (entry.kind === "cell") {
      const cell = direct.get(entry.ref_id) ?? {
        id: entry.ref_id,
        name: `Cell #${entry.ref_id}`,
        source_count: null,
      };
      selected.set(cell.id, cell);
      continue;
    }
    if (entry.kind === "replicate_group") {
      const group = groups.get(entry.ref_id);
      if (!group) {
        selected.set(-entry.ref_id, {
          id: -entry.ref_id,
          name: `Replicate group #${entry.ref_id}`,
          source_count: null,
        });
        continue;
      }
      for (const cell of group.cells) {
        const resolved = direct.get(cell.id) ?? cell;
        selected.set(resolved.id, resolved);
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.id - right.id);
}

function ProtocolMappingRequiredState({
  policy,
  compact = false,
}: {
  policy: MultiSourceAnalysisPolicy;
  compact?: boolean;
}) {
  const names = policy.unsupportedCells.map((cell) => cell.name);
  const affected = names.length <= 4
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")}, +${names.length - 3} more`;
  return (
    <Paper p={compact ? "sm" : "xl"} withBorder>
      <Alert
        color={policy.pending ? "blue" : "yellow"}
        variant="light"
        icon={<IconInfoCircle size={18} />}
      >
        <Stack gap="xs">
          <Text fw={700}>
            {policy.pending ? "Checking source compatibility" : "Protocol mapping required"}
          </Text>
          <Text size="sm">
            {policy.pending
              ? policy.message
              : "This plot uses source-local protocol steps. Restarted files can renumber steps, and CellXplorer refuses to guess how the continuation chain maps across files."}
          </Text>
          {policy.pending ? (
            <Text size="sm" c="dimmed">
              Source counts are not available yet for: {policy.unresolvedCells.map((cell) => cell.name).join(", ")}.
            </Text>
          ) : (
            <Text size="sm">
              <Text span fw={600}>Affected Cells:</Text> {affected}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {policy.pending
              ? "Wait for source compatibility to resolve. No scientific request will be sent while this check is pending."
              : "Use Cycles or Time / capacity for this selection. Save and scientific export are unavailable until semantic source-step mapping is reviewed."}
          </Text>
        </Stack>
      </Alert>
    </Paper>
  );
}

function BlockedWarmupNotice({ onComplete }: { onComplete: (error?: string, detail?: string) => void }) {
  useEffect(() => {
    onComplete(undefined, "Skipped: protocol mapping is required for multi-source Cells");
  }, [onComplete]);
  return null;
}

function computeSignature(spec: AnalysisSpec | null): string {
  if (!spec) return "no-spec";
  return JSON.stringify({
    selection: spec.selection,
    protocol_segments: spec.protocol_segments ?? [],
    dcir_segments: spec.dcir_segments ?? [],
    computation: spec.computation,
    aggregation: spec.aggregation,
    hidden_protocol_segment_ids: spec.presentation.hidden_protocol_segment_ids ?? [],
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
            <IconFolder size={14} color="var(--mantine-primary-color-6)" />
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
              bg={selected.has(key) ? "var(--mantine-primary-color-0)" : undefined}
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
              bg={selected.has(key) ? "var(--mantine-primary-color-0)" : undefined}
              style={{ cursor: added ? "default" : "pointer" }}
              onClick={(event) => toggleEntry(entry, event)}
            >
              <Table.Td w={42}>
                <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
              </Table.Td>
              <Table.Td>
                <Group gap={6} pl={(depth + 1) * 16}>
                  <IconLayersIntersect size={14} color="var(--mantine-primary-color-6)" />
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
                      bg={selected.has(key) ? "var(--mantine-primary-color-0)" : undefined}
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
                      bg={selected.has(key) ? "var(--mantine-primary-color-0)" : undefined}
                      style={{ cursor: added ? "default" : "pointer" }}
                      onClick={(event) => toggleEntry(entry, event)}
                    >
                      <Table.Td w={42}>
                        <Checkbox checked={added || selected.has(key)} disabled={added} readOnly />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} pl={16}>
                          <IconLayersIntersect size={14} color="var(--mantine-primary-color-6)" />
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

/** Hover label styling shared by every analysis plot. */
function hoverLabelLayout(style: PlotStyle) {
  return {
    bgcolor: style.paper_bgcolor || "#ffffff",
    bordercolor: style.frame_color || "#adb5bd",
    font: { size: Math.max(10, style.tick_font_size - 1), family: "inherit" },
    align: "left" as const,
    namelength: 28,
  };
}

/**
 * The drop shadow: a wider, offset, semi-transparent copy drawn underneath.
 *
 * Plotly has no line shadow, so this is the only way to get one. Push it before
 * the real trace so it renders below, and keep it out of the legend and hover.
 */
function shadowTraceFor(
  x: (number | null)[],
  y: (number | null)[],
  resolved: ResolvedSeriesStyle,
  axes: { xaxis?: string; yaxis?: string } = {},
): Plotly.Data {
  return {
    x: shadowOffsetValues(x, resolved.shadowOffsetX),
    y: shadowOffsetValues(y, -resolved.shadowOffsetY),
    type: "scatter",
    mode: "lines",
    hoverinfo: "skip",
    showlegend: false,
    connectgaps: false,
    line: {
      color: shadowRgba(resolved.shadowColor, resolved.shadowOpacity),
      width: resolved.lineWidth + resolved.shadowSpread,
      dash: resolved.lineDash,
      shape: resolved.lineShape,
    },
    ...axes,
  } as Plotly.Data;
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

let webGlSupport: boolean | null = null;

function supportsWebGl(): boolean {
  if (webGlSupport !== null) return webGlSupport;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    webGlSupport = Boolean(
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true })
    );
  } catch {
    webGlSupport = false;
  }
  return webGlSupport;
}

function interactivePlotTraces(traces: Plotly.Data[]): Plotly.Data[] {
  if (!supportsWebGl()) return traces;
  return traces.map((trace) => {
    const value = trace as Record<string, unknown>;
    // Plotly's SVG renderer remains the reliable fallback for filled bands.
    // Every ordinary line/marker series uses WebGL in the interactive view.
    if ((value.type ?? "scatter") !== "scatter" || value.fill) return trace;
    return { ...trace, type: "scattergl" } as Plotly.Data;
  });
}

/**
 * Drop diagnostic cycles from a computed result before it is plotted.
 *
 * Filtering the result rather than each trace is what makes the guarantee hold:
 * capacity, coulombic efficiency, the replicate band and the below-minimum-n
 * markers all read from these arrays, so they cannot fall out of step with one
 * another. The input is never mutated — exports and the cache keep every cycle.
 */
function withoutDiagnosticCycles(
  result: ComputeResult,
  hidden: Set<number>,
  reindex = false
): ComputeResult {
  if (hidden.size === 0) return result;
  const keptIndices = (x: number[]) =>
    x.reduce<number[]>((acc, cycle, index) => {
      if (!hidden.has(cycle)) acc.push(index);
      return acc;
    }, []);
  const take = <T,>(values: T[] | null | undefined, indices: number[]): T[] =>
    Array.isArray(values) ? indices.map((i) => values[i]) : [];

  // A single map from surviving cycle number to its 1-based position, built from
  // the union across every series so cells stay aligned after the gaps close.
  const remap = (() => {
    if (!reindex) return null;
    const surviving = new Set<number>();
    for (const series of result.cell_series)
      for (const cycle of series.x) if (!hidden.has(cycle)) surviving.add(cycle);
    for (const agg of result.aggregates)
      for (const cycle of agg.x) if (!hidden.has(cycle)) surviving.add(cycle);
    const sorted = [...surviving].sort((a, b) => a - b);
    return new Map(sorted.map((cycle, index) => [cycle, index + 1]));
  })();
  const remapX = (x: number[]) => (remap ? x.map((cycle) => remap.get(cycle) ?? cycle) : x);

  return {
    ...result,
    aggregates: result.aggregates.map((agg) => {
      const indices = keptIndices(agg.x);
      return {
        ...agg,
        x: remapX(take(agg.x, indices)),
        quantities: Object.fromEntries(
          Object.entries(agg.quantities).map(([key, q]) => [
            key,
            {
              ...q,
              mean: take(q.mean, indices),
              band_low: take(q.band_low, indices),
              band_high: take(q.band_high, indices),
              n: take(q.n, indices),
            },
          ])
        ),
      };
    }),
    cell_series: result.cell_series.map((series) => {
      const indices = keptIndices(series.x);
      return {
        ...series,
        x: remapX(take(series.x, indices)),
        quantities: Object.fromEntries(
          Object.entries(series.quantities).map(([key, values]) => [key, take(values, indices)])
        ),
        source_cycle: take(series.source_cycle, indices),
        source_position: take(series.source_position, indices),
        source_filename: take(series.source_filename, indices),
        source_hash: take(series.source_hash, indices),
      };
    }),
  };
}

/** The diagnostic cycles this spec asks to hide, or an empty set when off. */
function diagnosticCyclesFor(result: ComputeResult, spec: AnalysisSpec): Set<number> {
  if (!spec.presentation.hide_diagnostic_cycles) return new Set();
  return findDiagnosticCyclesAcross(
    result.cell_series.filter((s) => !s.excluded),
    { tolerance: spec.presentation.diagnostic_tolerance ?? DIAGNOSTIC_DEFAULTS.tolerance }
  );
}

function tracesForResult(
  original: ComputeResult,
  spec: AnalysisSpec,
  compact = false
): Plotly.Data[] {
  // Filter here rather than at each call site so the live plot, the saved
  // thumbnail and the exported figure cannot disagree about what is shown.
  const result = withoutDiagnosticCycles(
    original,
    diagnosticCyclesFor(original, spec),
    spec.presentation.reindex_diagnostic_cycles ?? false
  );
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const { column } = resolvedQuantity(result, spec);
  const showCeOverlay = !compact && (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const style = currentPlotStyle(spec, "cycles");
  const palette = plotPalette(style);
  const secondaryPalette = cePalette(style);
  const mode = compact ? "lines" : plotMode(style);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) colorFor.set(key, style.custom_colors[key] ?? palette[ci++ % palette.length]);
    return colorFor.get(key)!;
  };
  let ceIndex = 0;
  const pickCe = (key: string) => {
    if (style.ce_custom_colors[key]) return style.ce_custom_colors[key];
    if (style.ce_palette_mode === "single") return style.ce_single_color ?? "#495057";
    if (style.ce_palette_mode === "secondary") {
      return secondaryPalette[ceIndex++ % secondaryPalette.length];
    }
    return pick(key);
  };

  for (const agg of result.aggregates) {
    const color = pick(`g${agg.group_id}`);
    const q = agg.quantities[column];
    if (!q) continue;
    const aggDescriptor = aggregateSeriesDescriptor(agg, compact);
    const aggResolved = resolveSeriesStyle(
      {
        color,
        lineWidth: compact ? 2 : style.line_width,
        lineDash: compact ? "solid" : style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: compact ? 3 : style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      },
      aggDescriptor,
      style.series_rules,
      style.series_overrides,
    );
    if (aggResolved.hidden) continue;
    if (!compact) {
      out.push(
        ...bandSegmentTraces(
          agg.x,
          q.band_low,
          q.band_high,
          aggResolved.color,
          style.band_opacity,
          `${agg.group_name} band`
        )
      );
    }
    if (aggResolved.shadow && !compact) {
      out.push(shadowTraceFor(agg.x, q.mean, aggResolved));
    }
    out.push({
      x: agg.x,
      y: q.mean,
      name: aggResolved.name,
      line: {
        color: aggResolved.color,
        width: aggResolved.lineWidth,
        dash: aggResolved.lineDash,
        shape: aggResolved.lineShape,
      },
      marker: {
        color: aggResolved.color,
        size: aggResolved.markerSize,
        symbol: seriesPlotlySymbol(aggResolved),
      },
      opacity: aggResolved.opacity,
      showlegend: aggResolved.showInLegend,
      type: "scatter",
      mode: compact ? mode : seriesPlotlyMode(aggResolved),
      customdata: q.n,
      hovertemplate: compact
        ? undefined
        : `cycle %{x}: %{y:.4f} (n=%{customdata})<extra>${agg.group_name}</extra>`,
    } as Plotly.Data);
    if (!compact) {
      const lowCountX: number[] = [];
      const lowCountY: number[] = [];
      const lowCountN: number[] = [];
      q.n.forEach((count, index) => {
        const value = q.mean[index];
        if (
          count > 0 &&
          count < spec.aggregation.min_n_for_band &&
          value !== null &&
          Number.isFinite(value)
        ) {
          lowCountX.push(agg.x[index]);
          lowCountY.push(value);
          lowCountN.push(count);
        }
      });
      if (lowCountX.length > 0) {
        out.push({
          x: lowCountX,
          y: lowCountY,
          name: `${agg.group_name} below minimum n`,
          type: "scatter",
          mode: "markers",
          marker: {
            color: style.low_n_color,
            size: style.low_n_marker_size,
            symbol: style.low_n_marker_symbol,
            line: { color: style.paper_bgcolor, width: 0.8 },
          },
          customdata: lowCountN,
          showlegend: false,
          hovertemplate:
            `cycle %{x}: %{y:.4f} (n=%{customdata}, band requires ${spec.aggregation.min_n_for_band})` +
            `<extra>${agg.group_name}</extra>`,
        } as Plotly.Data);
      }
    }
    if (showCeOverlay && agg.quantities["coulombic_efficiency_pct"]) {
      const ceColor = pickCe(`g${agg.group_id}`);
      out.push({
        x: agg.x,
        y: agg.quantities["coulombic_efficiency_pct"].mean,
        name: `${agg.group_name} CE`,
        yaxis: "y2",
        line: { color: ceColor, width: style.ce_line_width, dash: style.ce_line_dash },
        marker: { color: ceColor, size: style.ce_marker_size, symbol: ceMarkerSymbol(style) },
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
    // Per-series resolution. The base carries exactly what this trace used to
    // hardcode, so a plot with no overrides and no rules is byte-identical.
    const descriptor = cellSeriesDescriptor(s);
    const resolved = resolveSeriesStyle(
      {
        color,
        lineWidth: compact ? 1.3 : grouped ? Math.max(1, style.line_width - 1.2) : style.line_width,
        lineDash: compact ? "solid" : style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: compact ? 3 : style.marker_size,
        markerOpen: style.marker_open,
        opacity: compact ? 0.45 : grouped ? style.individual_opacity : 0.95,
      },
      descriptor,
      style.series_rules,
      style.series_overrides,
    );
    if (resolved.hidden) continue;
    const sourceCycle = s.source_cycle ?? s.x.map(() => null);
    const sourcePosition = s.source_position ?? s.x.map(() => null);
    const sourceFilename = s.source_filename ?? s.x.map(() => null);
    const sourceHash = s.source_hash ?? s.x.map(() => null);
    const sourceColumns = sourceExportColumns(
      s.label,
      s.x,
      sourceCycle,
      sourcePosition,
      sourceFilename,
      sourceHash,
    );
    const customdata = s.x.map((cycle, index) => [
      cycle,
      sourceCycle[index] ?? "",
      sourcePosition[index] ?? "",
      shortSourceName(String(sourceFilename[index] ?? "")),
    ]);
    if (resolved.shadow && !compact) {
      out.push(shadowTraceFor(s.x, s.quantities[column] ?? [], resolved));
    }
    out.push({
      x: s.x,
      y: s.quantities[column] ?? [],
      name: resolved.name,
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
      opacity: resolved.opacity,
      type: "scatter",
      mode: compact ? mode : seriesPlotlyMode(resolved),
      showlegend: !compact && !grouped && resolved.showInLegend,
      customdata,
      cellxplorer_export_columns: sourceColumns,
      hovertemplate:
        `cycle %{customdata[0]}: %{y:.4f}<br>local cycle %{customdata[1]}<br>` +
        `%{customdata[3]} (source %{customdata[2]})<extra>${s.label}</extra>`,
    } as Plotly.Data);
    const values = s.quantities[column] ?? [];
    const boundaryIndices = sourceBoundaryPointIndices(sourcePosition, s.x, values);
    if (boundaryIndices.length) {
      out.push({
        x: boundaryIndices.map((index) => s.x[index]),
        y: boundaryIndices.map((index) => values[index]),
        name: "Source boundary",
        type: "scatter",
        mode: "markers",
        marker: {
          color,
          size: Math.max(style.marker_size + 2, 7),
          symbol: "diamond-open",
          line: { color: style.paper_bgcolor, width: 1.2 },
        },
        showlegend: false,
        customdata: boundaryIndices.map((index) => [
          s.x[index],
          sourceCycle[index] ?? "",
          sourcePosition[index] ?? "",
          shortSourceName(String(sourceFilename[index] ?? "")),
        ]),
        hovertemplate:
          "source boundary<br>global cycle %{customdata[0]}<br>local cycle %{customdata[1]}<br>" +
          "%{customdata[3]} (source %{customdata[2]})<extra></extra>",
      } as Plotly.Data);
    }
    if (showCeOverlay && !grouped && s.quantities["coulombic_efficiency_pct"]) {
      const ceColor = pickCe(`c${s.cell_id}`);
      out.push({
        x: s.x,
        y: s.quantities["coulombic_efficiency_pct"],
        name: `${s.label} CE`,
        yaxis: "y2",
        line: { color: ceColor, width: style.ce_line_width, dash: style.ce_line_dash },
        marker: { color: ceColor, size: style.ce_marker_size, symbol: ceMarkerSymbol(style) },
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

function tracesForTimeCapacity(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  interactiveWebGl = false
): Plotly.Data[] {
  const style = currentPlotStyle(spec, "time_capacity");
  const palette = plotPalette(style);
  const cfg = timeCapacityConfig(spec);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  const legendShown = new Set<string>();
  const traceType = interactiveWebGl ? "scattergl" : "scatter";
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) colorFor.set(key, style.custom_colors[key] ?? palette[ci++ % palette.length]);
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
          if (resolved.shadow) out.push(shadowTraceFor(x, y, resolved));
          out.push({
            x,
            y,
            name: resolved.name,
            legendgroup: seriesKey,
            showlegend: showlegend && resolved.showInLegend,
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
      if (resolved.shadow) out.push(shadowTraceFor(segment.x, segment.voltage, resolved));
      out.push({
        x: segment.x,
        y: segment.voltage,
        name,
        legendgroup: seriesKey,
        showlegend,
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
        hovertemplate:
          "%{y:.4f} V<br>%{x:.4f}<br>global cycle %{customdata[0]}<br>" +
          "local cycle %{customdata[1]}<br>%{customdata[3]} (source %{customdata[2]})" +
          `<extra>${name}</extra>`,
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

function timeCapacityLayout(
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
        text: style.y_title ?? "Voltage (V)",
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

function SavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
  warmup = false,
  warmupTask,
  onWarmupComplete,
  allowGeneration = true,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
  warmup?: boolean;
  warmupTask?: CacheWarmupTask;
  onWarmupComplete?: (error?: string, detail?: string) => void;
  allowGeneration?: boolean;
}) {
  const previewSpec = useMemo(() => specForSavedPlot(baseSpec, plot), [baseSpec, plot]);
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const qc = useQueryClient();
  const draftPreview = isDraftPreviewPlotId(plot.id);
  const [generationFailed, setGenerationFailed] = useState(false);
  const warmupReported = useRef(false);
  const renderedFresh = useRef(false);
  const rebuiltThumbnail = useRef(false);
  const thumbnail = useQuery({
    queryKey: ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryFn: async () => {
      if (draftPreview) {
        // Keep any client-rendered draft thumbnail; never ask the server.
        return (
          qc.getQueryData<PlotThumbnail>([
            "plot-thumbnail",
            analysisId,
            plot.id,
            previewSignature,
          ]) ?? null
        );
      }
      return lookupPlotThumbnail(analysisId, plot.id, previewSignature);
    },
    staleTime: draftPreview ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const thumbnailPairReady = Boolean(
    thumbnail.data?.thumbnail && thumbnail.data?.preview_thumbnail
  );
  const artifact = useQuery({
    queryKey: ["plot-artifact", analysisId, plot.id, previewSignature],
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotArtifact>([
            "plot-artifact",
            analysisId,
            plot.id,
            previewSignature,
          ]) ?? null
        );
      }
      return lookupPlotArtifact(analysisId, plot.id, previewSignature);
    },
    enabled:
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)),
    staleTime: draftPreview ? Infinity : 5 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const preview = useQuery<
    | ComputeResult
    | DcirResult
    | StepsResult
    | ChargeabilityResult
    | RateCapabilityResult
  >({
    queryKey: ["saved-plot-preview", analysisId, plot.id, previewSignature, warmup ? "warmup" : "visible"],
    queryFn: () =>
      plot.tab === "steps"
        ? post<StepsResult>(`/api/analyses/${analysisId}/steps`, {
            spec: previewSpec,
            background: warmup,
          })
        : plot.tab === "dcir"
        ? post<DcirResult>(`/api/analyses/${analysisId}/dcir`, {
            spec: previewSpec,
            background: warmup,
          })
        : plot.tab === "chargeability"
        ? post<ChargeabilityResult>(
            `/api/analyses/${analysisId}/chargeability`,
            {
              spec: previewSpec,
              background: warmup,
            }
          )
        : plot.tab === "crate"
        ? post<RateCapabilityResult>(
            `/api/analyses/${analysisId}/rate-capability`,
            {
              spec: previewSpec,
              background: warmup,
            }
          )
        : post<ComputeResult>(`/api/analyses/${analysisId}/compute`, {
            spec: previewSpec,
            background: warmup,
          }),
    // Warmup must not recompute plots that are already cached: the compute
    // only runs when neither a thumbnail nor a full artifact exists, exactly
    // like the visible path.
    enabled:
      (warmup || allowGeneration) &&
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)) &&
      artifact.isSuccess &&
      artifact.data === null,
    staleTime: 5 * 60_000,
  });
  const traces = useMemo(
    () =>
      preview.data
        ? plot.tab === "steps"
          ? stepsTracesForResult(preview.data as StepsResult, previewSpec)
          : plot.tab === "dcir"
          ? dcirTracesForResult(preview.data as DcirResult, previewSpec)
          : plot.tab === "chargeability"
          ? chargeabilityTracesForResult(
              preview.data as ChargeabilityResult,
              previewSpec
            )
          : plot.tab === "crate"
          ? rateCapabilityTracesForResult(
              preview.data as RateCapabilityResult,
              previewSpec
            )
          : tracesForResult(preview.data as ComputeResult, previewSpec)
        : [],
    [plot.tab, preview.data, previewSpec]
  );

  useEffect(() => {
    if (
      (warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) ||
      artifact.data ||
      !preview.data ||
      traces.length === 0
    ) return;
    let cancelled = false;
    setGenerationFailed(false);
    const layout =
      plot.tab === "steps"
        ? stepsLayoutForSpec(previewSpec)
        : plot.tab === "dcir"
        ? dcirLayoutForSpec(previewSpec)
        : plot.tab === "chargeability"
        ? chargeabilityLayoutForSpec(
            previewSpec,
            preview.data as ChargeabilityResult
          )
        : plot.tab === "crate"
        ? rateCapabilityLayoutForSpec(
            previewSpec,
            preview.data as RateCapabilityResult
          )
        : cyclePlotLayout(preview.data as ComputeResult, previewSpec, traces);
    const figure = portableFigure(traces, layout);
    if (!figure) return;
    const summary =
      plot.tab === "steps"
        ? (preview.data as StepsResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.n_blocks,
            status: series.n_blocks > 0 ? "Visible" : "No matching blocks",
          }))
        : plot.tab === "dcir"
        ? (preview.data as DcirResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.n_measurements,
            status: series.n_measurements > 0 ? "Visible" : "No measurements",
          }))
        : plot.tab === "chargeability"
        ? (preview.data as ChargeabilityResult).cells.map((cell) => ({
            label: cell.cell_name,
            cycles: cell.match_count,
            status:
              cell.match_count > 0
                ? "Matched"
                : cell.status === "no_candidates"
                  ? "No candidates"
                  : "No matching event",
          }))
        : plot.tab === "crate"
        ? (preview.data as RateCapabilityResult).cells.map((cell) => {
            const points =
              cell.families.charge.point_count +
              cell.families.discharge.point_count;
            return {
              label: cell.cell_name,
              cycles: points,
              status: points > 0 ? "Matched" : "No sweep detected",
            };
          })
        : (preview.data as ComputeResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.metrics?.n_cycles ?? series.x.length,
            status: series.excluded ? "Hidden" : "Visible",
          }));
    let generatedLocally = false;
    queuedPortableArtifactImages(figure)
      .then(({ svg, thumbnail, preview_thumbnail }) => {
        const generated: PlotArtifact = {
          signature: previewSignature,
          svg,
          thumbnail,
          preview_thumbnail,
          figure,
          summary,
        };
        generatedLocally = true;
        renderedFresh.current = true;
        if (!cancelled && !warmup) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail,
              preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            generated
          );
        }
        return storePlotArtifactWithRetry(analysisId, plot.id, generated, warmupTask);
      })
      .then((stored) => {
        if (!cancelled) {
          if (stored.thumbnail) {
            qc.setQueryData(
              ["plot-thumbnail", analysisId, plot.id, previewSignature],
              {
                signature: previewSignature,
                thumbnail: stored.thumbnail,
                preview_thumbnail: stored.preview_thumbnail,
              }
            );
          }
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            stored
          );
        }
      })
      .catch((error) => {
        if (!cancelled && (!generatedLocally || warmup)) setGenerationFailed(true);
        console.warn("Could not persist the saved plot preview", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, plot.tab, preview.data, previewSignature, previewSpec, qc, thumbnail.data, thumbnailPairReady, traces, warmup, warmupTask]);

  useEffect(() => {
    const current = artifact.data;
    if ((warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) || !current) return;
    let cancelled = false;
    // The thumbnail embedded in an older full artifact belongs to that
    // artifact's renderer generation. A miss in the dedicated versioned
    // thumbnail cache means it must be rebuilt from the canonical SVG even
    // when the legacy artifact happens to contain an image.
    queuedPortableThumbnails(current.svg, current.figure)
      .then(({ thumbnail, preview_thumbnail }) => {
        const enriched = { ...current, thumbnail, preview_thumbnail };
        rebuiltThumbnail.current = true;
        if (!cancelled && !warmup) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail,
              preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            enriched
          );
        }
        return storePlotArtifactWithRetry(analysisId, plot.id, enriched, warmupTask);
      })
      .then((stored) => {
        if (!cancelled && stored.thumbnail) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail: stored.thumbnail,
              preview_thumbnail: stored.preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            stored
          );
        }
      })
      .catch((error) => {
        if (!cancelled && warmup) setGenerationFailed(true);
        console.warn("Could not cache the plot thumbnail", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, previewSignature, qc, thumbnail.data, thumbnailPairReady, warmup, warmupTask]);

  const previewImage = thumbnail.data?.thumbnail ?? artifact.data?.thumbnail ??
    (artifact.data ? svgDataUrl(artifact.data.svg) : null);
  const generationDeferred =
    !warmup &&
    !allowGeneration &&
    thumbnail.isSuccess &&
    thumbnail.data === null &&
    artifact.isSuccess &&
    artifact.data === null;
  const previewPending =
    thumbnail.isLoading ||
    artifact.isLoading ||
    preview.isLoading ||
    generationDeferred ||
    (traces.length > 0 && !generationFailed);
  const showPreviewLoader = useDelayedFlag(previewPending);
  useEffect(() => {
    if (!warmup || warmupReported.current || !onWarmupComplete) return;
    // Shared resolver: a failed thumbnail/artifact lookup leaves the compute
    // query disabled, so without an explicit terminal state for it the task
    // never reports and stalls the whole warmup queue. See warmupCompletion.ts.
    const resolution = resolveWarmup({
      generationFailed,
      thumbnailPairReady,
      thumbnailErrored: thumbnail.isError,
      thumbnailError: thumbnail.error,
      artifactErrored: artifact.isError,
      artifactError: artifact.error,
      previewErrored: preview.isError,
      previewError: preview.error,
      previewSucceeded: preview.isSuccess,
      traceCount: traces.length,
      renderedFresh: renderedFresh.current,
      rebuiltThumbnail: rebuiltThumbnail.current,
    });
    if (resolution.status !== "done") return;
    warmupReported.current = true;
    onWarmupComplete(resolution.error, resolution.detail);
  }, [
    artifact.error,
    artifact.isError,
    generationFailed,
    onWarmupComplete,
    preview.error,
    preview.isError,
    preview.isSuccess,
    thumbnail.error,
    thumbnail.isError,
    thumbnailPairReady,
    traces.length,
    warmup,
  ]);
  if (previewImage) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={previewImage}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }

  if (previewPending) {
    // A grid of saved plots would otherwise flash twenty loaders at once on a
    // warm cache. Hold the row height; only admit to loading if it drags.
    return <Center h={120}>{showPreviewLoader ? <Loader size={18} /> : null}</Center>;
  }
  if (traces.length === 0 || generationFailed) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          Preview unavailable
        </Text>
      </Center>
    );
  }
  return null;
}

function SavedTimeCapacityPreview({
  analysisId,
  baseSpec,
  plot,
  warmup = false,
  warmupTask,
  onWarmupComplete,
  allowGeneration = true,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
  warmup?: boolean;
  warmupTask?: CacheWarmupTask;
  onWarmupComplete?: (error?: string, detail?: string) => void;
  allowGeneration?: boolean;
}) {
  const previewSpec = useMemo(() => specForSavedPlot(baseSpec, plot), [baseSpec, plot]);
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const qc = useQueryClient();
  const draftPreview = isDraftPreviewPlotId(plot.id);
  const [generationFailed, setGenerationFailed] = useState(false);
  const warmupReported = useRef(false);
  const renderedFresh = useRef(false);
  const rebuiltThumbnail = useRef(false);
  const thumbnail = useQuery({
    queryKey: ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotThumbnail>([
            "plot-thumbnail",
            analysisId,
            plot.id,
            previewSignature,
          ]) ?? null
        );
      }
      return lookupPlotThumbnail(analysisId, plot.id, previewSignature);
    },
    staleTime: draftPreview ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const thumbnailPairReady = Boolean(
    thumbnail.data?.thumbnail && thumbnail.data?.preview_thumbnail
  );
  const artifact = useQuery({
    queryKey: ["plot-artifact", analysisId, plot.id, previewSignature],
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotArtifact>([
            "plot-artifact",
            analysisId,
            plot.id,
            previewSignature,
          ]) ?? null
        );
      }
      return lookupPlotArtifact(analysisId, plot.id, previewSignature);
    },
    enabled:
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)),
    staleTime: draftPreview ? Infinity : 5 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const preview = useQuery({
    queryKey: ["saved-time-preview", analysisId, plot.id, previewSignature, warmup ? "warmup" : "visible"],
    queryFn: () =>
      post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
        spec: previewSpec,
        viewport_width: 1200,
        precision: "standard",
        compact: true,
        background: warmup,
      }),
    // Warmup must not recompute plots that are already cached: the compute
    // only runs when neither a thumbnail nor a full artifact exists, exactly
    // like the visible path.
    enabled:
      (warmup || allowGeneration) &&
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)) &&
      artifact.isSuccess &&
      artifact.data === null,
    staleTime: 5 * 60_000,
  });
  const traces = useMemo(
    () => (preview.data ? tracesForTimeCapacity(preview.data, previewSpec) : []),
    [preview.data, previewSpec]
  );

  useEffect(() => {
    if (
      (warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) ||
      artifact.data ||
      !preview.data ||
      traces.length === 0
    ) return;
    let cancelled = false;
    setGenerationFailed(false);
    const layout = timeCapacityLayout(preview.data, previewSpec, traces);
    const figure = portableFigure(traces, layout);
    if (!figure) return;
    const summary = preview.data.cell_traces.map((trace) => ({
      label: trace.label,
      cycles: new Set(trace.cycle.filter((cycle) => cycle !== null)).size,
      status: trace.excluded ? "Hidden" : "Visible",
    }));
    let generatedLocally = false;
    queuedPortableArtifactImages(figure)
      .then(({ svg, thumbnail, preview_thumbnail }) => {
        const generated: PlotArtifact = {
          signature: previewSignature,
          svg,
          thumbnail,
          preview_thumbnail,
          figure,
          summary,
        };
        generatedLocally = true;
        renderedFresh.current = true;
        if (!cancelled && !warmup) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail,
              preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            generated
          );
        }
        return storePlotArtifactWithRetry(analysisId, plot.id, generated, warmupTask);
      })
      .then((stored) => {
        if (!cancelled) {
          if (stored.thumbnail) {
            qc.setQueryData(
              ["plot-thumbnail", analysisId, plot.id, previewSignature],
              {
                signature: previewSignature,
                thumbnail: stored.thumbnail,
                preview_thumbnail: stored.preview_thumbnail,
              }
            );
          }
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            stored
          );
        }
      })
      .catch((error) => {
        if (!cancelled && (!generatedLocally || warmup)) setGenerationFailed(true);
        console.warn("Could not persist the saved time/capacity preview", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, preview.data, previewSignature, previewSpec, qc, thumbnail.data, thumbnailPairReady, traces, warmup, warmupTask]);

  useEffect(() => {
    const current = artifact.data;
    if ((warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) || !current) return;
    let cancelled = false;
    // See SavedPlotPreview: an artifact thumbnail is not proof that the
    // current dedicated thumbnail generation has been persisted.
    queuedPortableThumbnails(current.svg, current.figure)
      .then(({ thumbnail, preview_thumbnail }) => {
        const enriched = { ...current, thumbnail, preview_thumbnail };
        rebuiltThumbnail.current = true;
        if (!cancelled && !warmup) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail,
              preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            enriched
          );
        }
        return storePlotArtifactWithRetry(analysisId, plot.id, enriched, warmupTask);
      })
      .then((stored) => {
        if (!cancelled && stored.thumbnail) {
          qc.setQueryData(
            ["plot-thumbnail", analysisId, plot.id, previewSignature],
            {
              signature: previewSignature,
              thumbnail: stored.thumbnail,
              preview_thumbnail: stored.preview_thumbnail,
            }
          );
          qc.setQueryData(
            ["plot-artifact", analysisId, plot.id, previewSignature],
            stored
          );
        }
      })
      .catch((error) => {
        if (!cancelled && warmup) setGenerationFailed(true);
        console.warn("Could not cache the time/capacity thumbnail", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, previewSignature, qc, thumbnail.data, thumbnailPairReady, warmup, warmupTask]);

  const previewImage = thumbnail.data?.thumbnail ?? artifact.data?.thumbnail ??
    (artifact.data ? svgDataUrl(artifact.data.svg) : null);
  const generationDeferred =
    !warmup &&
    !allowGeneration &&
    thumbnail.isSuccess &&
    thumbnail.data === null &&
    artifact.isSuccess &&
    artifact.data === null;
  const previewPending =
    thumbnail.isLoading ||
    artifact.isLoading ||
    preview.isLoading ||
    generationDeferred ||
    (traces.length > 0 && !generationFailed);
  const showPreviewLoader = useDelayedFlag(previewPending);
  useEffect(() => {
    if (!warmup || warmupReported.current || !onWarmupComplete) return;
    // Shared resolver: a failed thumbnail/artifact lookup leaves the compute
    // query disabled, so without an explicit terminal state for it the task
    // never reports and stalls the whole warmup queue. See warmupCompletion.ts.
    const resolution = resolveWarmup({
      generationFailed,
      thumbnailPairReady,
      thumbnailErrored: thumbnail.isError,
      thumbnailError: thumbnail.error,
      artifactErrored: artifact.isError,
      artifactError: artifact.error,
      previewErrored: preview.isError,
      previewError: preview.error,
      previewSucceeded: preview.isSuccess,
      traceCount: traces.length,
      renderedFresh: renderedFresh.current,
      rebuiltThumbnail: rebuiltThumbnail.current,
    });
    if (resolution.status !== "done") return;
    warmupReported.current = true;
    onWarmupComplete(resolution.error, resolution.detail);
  }, [
    artifact.error,
    artifact.isError,
    generationFailed,
    onWarmupComplete,
    preview.error,
    preview.isError,
    preview.isSuccess,
    thumbnail.error,
    thumbnail.isError,
    thumbnailPairReady,
    traces.length,
    warmup,
  ]);
  if (previewImage) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={previewImage}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }

  if (previewPending) {
    // A grid of saved plots would otherwise flash twenty loaders at once on a
    // warm cache. Hold the row height; only admit to loading if it drags.
    return <Center h={120}>{showPreviewLoader ? <Loader size={18} /> : null}</Center>;
  }
  if (traces.length === 0 || generationFailed) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          Preview unavailable
        </Text>
      </Center>
    );
  }
  return null;
}

export function AnalysisCacheWarmupRenderer({
  analysis,
  plot,
  task,
  onComplete,
}: {
  analysis: AnalysisFull;
  plot: SavedAnalysisPlot;
  task: CacheWarmupTask;
  onComplete: (error?: string, detail?: string) => void;
}) {
  const policy = multiSourceAnalysisPolicy(
    plot.tab,
    selectedSourceCountCells(analysis, analysis.spec),
  );
  if (policy.family && !policy.supported) {
    return <BlockedWarmupNotice onComplete={onComplete} />;
  }
  return plot.tab === "time_capacity" ? (
    <SavedTimeCapacityPreview
      analysisId={analysis.id}
      baseSpec={analysis.spec}
      plot={plot}
      warmup
      warmupTask={task}
      onWarmupComplete={onComplete}
    />
  ) : (
    <SavedPlotPreview
      analysisId={analysis.id}
      baseSpec={analysis.spec}
      plot={plot}
      warmup
      warmupTask={task}
      onWarmupComplete={onComplete}
    />
  );
}

function CachedSavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
}) {
  const previewSignature = useMemo(
    () => savedPlotPreviewSignature(baseSpec, plot),
    [baseSpec, plot]
  );
  const thumbnail = useQuery({
    queryKey: ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryFn: () => lookupPlotThumbnail(analysisId, plot.id, previewSignature),
    staleTime: 60 * 60_000,
    retry: false,
  });

  if (thumbnail.data) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={thumbnail.data.thumbnail}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }
  return (
    <Center h={120}>
      {thumbnail.isLoading ? (
        <Loader size={18} />
      ) : (
        <Text size="xs" c="dimmed">
          Preview will be prepared on export
        </Text>
      )}
    </Center>
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
  groups: { id: number; cells: { id: number }[] }[],
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
  analysisId,
  result,
  onAdd,
  onRemoveEntry,
  onToggleCell,
  onToggleReplicate,
  onImportEntries,
}: {
  spec: AnalysisSpec;
  groups: {
    id: number;
    name: string;
    cell_ids: number[];
    cells: Pick<CellSummary, "id" | "name">[];
  }[];
  cells: Pick<CellSummary, "id" | "name">[];
  analysisId: number;
  result: ComputeResult | undefined;
  onAdd: () => void;
  onRemoveEntry: (index: number) => void;
  onToggleCell: (cellId: number, context: VisibilityContext) => void;
  onToggleReplicate: (groupId: number) => void;
  onImportEntries: (entries: { kind: "cell" | "replicate_group"; ref_id: number }[]) => void;
}) {
  const hiddenGroups = new Set(spec.selection.hidden_replicate_group_ids ?? []);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const cellById = new Map(cells.map((c) => [c.id, c]));
  // Read the startup-persisted caches directly: the popovers must open without
  // waiting on a request. `enabled: false` keeps this from issuing one.
  const allAnalyses = useQuery({
    queryKey: ["analyses", ""],
    queryFn: () => get<AnalysisSummary[]>("/api/analyses"),
    staleTime: 5 * 60_000,
  });
  const allCells = useQuery({
    queryKey: ["cells", ""],
    queryFn: () => get<CellSummary[]>("/api/cells"),
    staleTime: 5 * 60_000,
  });
  const allGroups = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
    staleTime: 5 * 60_000,
  });
  const cellFactsById = useMemo(
    () => new Map((allCells.data ?? []).map((c) => [c.id, c])),
    [allCells.data]
  );
  const lookupCells = useMemo(
    () =>
      new Map<number, { id: number; name: string }>(
        (allCells.data ?? []).map((c) => [c.id, { id: c.id, name: c.name }])
      ),
    [allCells.data]
  );
  const lookupGroups = useMemo(
    () =>
      new Map(
        (allGroups.data ?? []).map((g) => [
          g.id,
          { id: g.id, name: g.name, cell_ids: g.cell_ids ?? [] },
        ])
      ),
    [allGroups.data]
  );
  const presentRefs = useMemo(
    () =>
      (spec.selection.entries ?? []).map((e) => ({ kind: String(e.kind), ref_id: e.ref_id })),
    [spec.selection.entries]
  );
  const relatedFor = (cellId: number) =>
    relatedAnalysesForCell(
      cellId,
      analysisId,
      allAnalyses.data ?? [],
      lookupCells,
      lookupGroups,
      presentRefs
    );

  const [collapsed, setCollapsed] = useState(false);

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb={collapsed ? 0 : "xs"} wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={collapsed ? "Expand samples" : "Collapse samples"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
          </ActionIcon>
          <Text fw={700} size="sm">
            Analysis samples
          </Text>
          {spec.selection.entries.length > 0 && (
            <Badge size="xs" variant="light" color="gray">
              {spec.selection.entries.length}
            </Badge>
          )}
        </Group>
        <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={onAdd}>
          Add
        </Button>
      </Group>
      <Collapse in={!collapsed}>
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
                          color={groupHidden ? "gray" : "var(--mantine-primary-color-6)"}
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
                          <CellHoverCard cell={cellFactsById.get(cell.id) ?? cell} result={result}>
                            <Text size="xs" c={groupHidden || isHidden ? "dimmed" : undefined} truncate>
                              {cell.name}
                            </Text>
                          </CellHoverCard>
                          <RelatedAnalysesPopover
                            related={relatedFor(cell.id)}
                            onImport={onImportEntries}
                            label={`Other analyses using ${cell.name}`}
                          />
                          <Tooltip label={groupHidden ? "Show the replicate before changing member visibility" : isHidden ? "Show in plot" : "Hide from plot"}>
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color={isHidden ? "gray" : "var(--mantine-primary-color-6)"}
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
                <CellHoverCard
                  cell={cellFactsById.get(entry.ref_id) ?? cell ?? { id: entry.ref_id, name: `cell #${entry.ref_id}` }}
                  result={result}
                >
                  <Box style={{ minWidth: 0 }}>
                    <Text size="sm" fw={700} truncate>
                      {cell?.name ?? `cell #${entry.ref_id}`}
                    </Text>
                    <Text size="10px" c="dimmed" tt="uppercase">
                      Cell
                    </Text>
                  </Box>
                </CellHoverCard>
                <Group gap={2} wrap="nowrap">
                  <RelatedAnalysesPopover
                    related={relatedFor(entry.ref_id)}
                    onImport={onImportEntries}
                    label={`Other analyses using ${cell?.name ?? entry.ref_id}`}
                  />
                  <Tooltip label={isHidden ? "Show in plot" : "Hide from plot"}>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color={isHidden ? "gray" : "var(--mantine-primary-color-6)"}
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
      </Collapse>
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
              <Tooltip
                label={
                  "Hides protocol diagnostics — DCIR pulses and rate checks — found from cycle " +
                  "durations rather than capacity, so a genuinely degrading cell is never hidden. " +
                  "Display only: exports keep every cycle."
                }
                multiline
                maw={320}
                withArrow
                openDelay={300}
              >
                <Switch
                  label="Hide diagnostic cycles"
                  checked={spec.presentation.hide_diagnostic_cycles ?? false}
                  onChange={(e) =>
                    update((s) => {
                      s.presentation.hide_diagnostic_cycles = e.currentTarget.checked;
                      // The visible range collapses to the healthy band; a
                      // manual range chosen for the unfiltered plot would crop it.
                      resetManualAxis(s, "cycles", "y_axis");
                    })
                  }
                />
              </Tooltip>
              {(spec.presentation.hide_diagnostic_cycles ?? false) && (
                <Tooltip
                  label={
                    "Close the gaps the hidden cycles leave: drop them from the x-axis and " +
                    "renumber the remaining cycles 1..N. Display only — exports keep the real " +
                    "cycle numbers."
                  }
                  multiline
                  maw={320}
                  withArrow
                  openDelay={300}
                >
                  <Switch
                    ml="md"
                    label="Reindex remaining cycles"
                    checked={spec.presentation.reindex_diagnostic_cycles ?? false}
                    onChange={(e) =>
                      update((s) => {
                        s.presentation.reindex_diagnostic_cycles = e.currentTarget.checked;
                        resetManualAxis(s, "cycles", "x_axis");
                      })
                    }
                  />
                </Tooltip>
              )}
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
                    resetManualAxis(s, "time_capacity", "x_axis");
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

// Freeze every visible series' current color into custom_colors so that
// switching to the custom palette (explicitly or by editing one color)
// never repaints the untouched series.
function snapshotPaletteColors(
  style: PlotStyle,
  targets: { key: string; label: string; sub: string }[]
): void {
  const palette = plotPalette(style);
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

export function PlotStylePanel({
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
  const queryClient = useQueryClient();
  const presetQuery = useQuery({
    queryKey: ["plot-style-presets"],
    queryFn: () => get<PlotStylePresetSettings>("/api/settings/plot-style-presets"),
    staleTime: 5 * 60_000,
  });
  const paletteQuery = useQuery({
    queryKey: ["color-palettes"],
    queryFn: () => get<ColorPaletteSettings>("/api/settings/color-palettes"),
    staleTime: 5 * 60_000,
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [applyPresetRanges, setApplyPresetRanges] = useState(false);
  const [applyPresetTicks, setApplyPresetTicks] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetFamily, setPresetFamily] = useState<"all" | "cycles" | "time_capacity">(
    axisScope === "time_capacity" ? "time_capacity" : "cycles",
  );
  const [presetDefault, setPresetDefault] = useState(false);
  const [seriesStyleOpen, setSeriesStyleOpen] = useState(false);
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

  // Per-series styling. Descriptors come from whichever result this tab shows —
  // the time/capacity result has `cell_traces`, the cycles result has
  // `cell_series` — so the editor lists exactly what is on screen.
  const timeCapacityResult = result && "cell_traces" in result ? result : undefined;
  const seriesDescriptors = useMemo(() => {
    if (timeCapacityResult) return timeCapacitySeriesDescriptors(timeCapacityResult.cell_traces);
    if (computeResult) {
      return cyclesSeriesDescriptors(
        computeResult.aggregates,
        computeResult.cell_series,
        spec.presentation.show_individual_cells,
      );
    }
    return [];
  }, [timeCapacityResult, computeResult, spec]);
  /**
   * The preview is the real plot: the same trace and layout builders, called
   * with the draft overrides applied. Rebuilding a simplified version here
   * would let the preview drift from the result.
   */
  const buildSeriesPreview = useCallback(
    (draftOverrides: Record<string, SeriesStyleOverride>, draftRules: SeriesStyleRule[]) => {
      if (!result) return { data: [] as Plotly.Data[], layout: {} as Partial<Plotly.Layout> };
      // A shallow spec with only the scoped style swapped. structuredClone here
      // copied the whole selection, protocol segments and saved-plot state on
      // every keystroke, for the sake of two fields.
      const draftSpec: AnalysisSpec = {
        ...spec,
        presentation: {
          ...spec.presentation,
          plot_styles: {
            ...(spec.presentation.plot_styles ?? {}),
            [axisScope]: {
              ...currentPlotStyle(spec, axisScope),
              series_overrides: draftOverrides,
              series_rules: draftRules,
            },
          },
        },
      };
      if (timeCapacityResult) {
        const data = decimatePreviewTraces(tracesForTimeCapacity(timeCapacityResult, draftSpec));
        return { data, layout: timeCapacityLayout(timeCapacityResult, draftSpec, data) };
      }
      const data = decimatePreviewTraces(
        tracesForResult(result as ComputeResult, draftSpec),
      );
      return { data, layout: cyclePlotLayout(result as ComputeResult, draftSpec, data) };
    },
    [result, spec, axisScope, timeCapacityResult],
  );
  // Resolved once per style change rather than per render: plotPalette returns
  // a fresh array each call, so an inline callback changed identity constantly
  // and re-resolved every series on every render.
  const seriesBaseDefaults = useMemo(
    () => ({
      palette: plotPalette(style),
      customColors: style.custom_colors,
      lineWidth: style.line_width,
      lineDash: style.line_dash,
      markerMode: style.marker_mode,
      markerSymbol: style.marker_symbol,
      markerSize: style.marker_size,
      markerOpen: style.marker_open,
    }),
    [style],
  );
  const seriesKeyOrder = useMemo(
    () => new Map(seriesDescriptors.map((item, index) => [item.key, index])),
    [seriesDescriptors],
  );
  const seriesBaseFor = useCallback(
    (descriptor: SeriesDescriptor) => {
      const index = seriesKeyOrder.get(descriptor.key) ?? 0;
      const { palette } = seriesBaseDefaults;
      return {
        color: seriesBaseDefaults.customColors[descriptor.key] ?? palette[index % palette.length],
        lineWidth: seriesBaseDefaults.lineWidth,
        lineDash: seriesBaseDefaults.lineDash,
        markerMode: seriesBaseDefaults.markerMode,
        markerSymbol: seriesBaseDefaults.markerSymbol,
        markerSize: seriesBaseDefaults.markerSize,
        markerOpen: seriesBaseDefaults.markerOpen,
        opacity: 1,
      };
    },
    [seriesKeyOrder, seriesBaseDefaults],
  );
  const customisedSeriesCount = Object.keys(style.series_overrides ?? {}).length;
  const seriesRuleCount = (style.series_rules ?? []).length;
  const seriesStyleSummary =
    customisedSeriesCount || seriesRuleCount
      ? [
          customisedSeriesCount ? `${customisedSeriesCount} customised` : null,
          seriesRuleCount ? `${seriesRuleCount} rule${seriesRuleCount === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const setAxisTitle = (key: "x_title" | "y_title" | "y2_title", value: string) => {
    setStyle((next) => void (next[key] = value || null));
  };
  const setAxis = (axis: "x_axis" | "y_axis" | "y2_axis", fn: (axis: PlotStyle["x_axis"]) => void) => {
    setStyle((next) => {
      next[axis] = { ...next[axis] };
      fn(next[axis]);
    });
  };
  const axisRangeError = (axis: PlotStyle["x_axis"]) =>
    axis.mode === "manual" &&
    axis.min !== null &&
    axis.max !== null &&
    axis.min >= axis.max
      ? "Minimum must be smaller than maximum."
      : undefined;
  const availablePresets = (presetQuery.data?.presets ?? []).filter(
    (preset) => preset.plot_family === "all" || preset.plot_family === axisScope,
  );
  const customPaletteOptions = (paletteQuery.data?.palettes ?? []).map((palette) => ({
    value: `user:${palette.id}`,
    label: palette.name,
  }));
  const paletteOptions = [
    ...PALETTE_OPTIONS.filter((option) => option.value !== "custom"),
    ...(customPaletteOptions.length
      ? [{ group: "Custom palettes", items: customPaletteOptions }]
      : []),
    { value: "custom", label: "Manual colors" },
  ];
  const savePreset = useMutation({
    mutationFn: () => {
      const id = crypto.randomUUID();
      const existing = presetQuery.data?.presets ?? [];
      return put<PlotStylePresetSettings>("/api/settings/plot-style-presets", {
        presets: [
          ...existing,
          {
            id,
            name: presetName.trim(),
            plot_family: presetFamily,
            style,
            is_default: presetDefault,
          },
        ],
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["plot-style-presets"], saved);
      setSavePresetOpen(false);
      setPresetName("");
      setPresetDefault(false);
      notifications.show({ message: "Plot-style preset saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save the preset.", color: "red" }),
  });
  const applySelectedPreset = () => {
    const preset = availablePresets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    setStyle((next) => {
      Object.assign(
        next,
        applyPlotStylePreset(
          next,
          normalizePlotStyle(preset.style),
          applyPresetRanges,
          applyPresetTicks,
        ),
      );
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
      <Stack gap={6} mb="sm">
        <Select
          label="Style preset"
          placeholder={presetQuery.isLoading ? "Loading presets..." : "Choose preset"}
          data={availablePresets.map((preset) => ({
            value: preset.id,
            label: `${preset.name}${preset.is_default ? " (default)" : ""}`,
          }))}
          value={selectedPresetId}
          onChange={setSelectedPresetId}
          clearable
        />
        <Group gap="md">
          <Checkbox
            size="xs"
            label="Apply ranges"
            checked={applyPresetRanges}
            onChange={(event) => setApplyPresetRanges(event.currentTarget.checked)}
          />
          <Checkbox
            size="xs"
            label="Apply ticks"
            checked={applyPresetTicks}
            onChange={(event) => setApplyPresetTicks(event.currentTarget.checked)}
          />
        </Group>
        <Group grow>
          <Button
            size="xs"
            variant="default"
            disabled={!selectedPresetId}
            onClick={applySelectedPreset}
          >
            Apply
          </Button>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={13} />}
            onClick={() => {
              setPresetFamily(axisScope === "time_capacity" ? "time_capacity" : "cycles");
              setSavePresetOpen(true);
            }}
          >
            Save current
          </Button>
        </Group>
      </Stack>
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
                data={paletteOptions}
                value={style.palette_id ? `user:${style.palette_id}` : style.palette}
                onChange={(value) =>
                  value &&
                  setStyle((next) => {
                    if (value.startsWith("user:")) {
                      const palette = paletteQuery.data?.palettes.find(
                        (item) => item.id === value.slice(5),
                      );
                      if (!palette) return;
                      next.palette = "custom";
                      next.palette_id = palette.id;
                      next.palette_colors = [...palette.colors];
                      next.custom_colors = {};
                      return;
                    }
                    if (value === "custom") {
                      // freeze the CURRENT colors so nothing jumps
                      snapshotPaletteColors(next, colorTargets);
                      next.palette_id = null;
                      next.palette_colors = [];
                      next.palette = "custom";
                      return;
                    }
                    next.palette_id = null;
                    next.palette_colors = [];
                    next.custom_colors = {};
                    next.palette = value as PlotStyle["palette"];
                  })
                }
              />
              {colorTargets.length > 0 && (
                <Stack gap={6}>
                  {colorTargets.map((target, index) => {
                    const activePalette = plotPalette(style);
                    const fallback = activePalette[index % activePalette.length];
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
              {/* The controls below apply to every series at once; this opens
                  the editor for styling series individually or by rule. */}
              <Button
                variant="light"
                leftSection={<IconPalette size={15} />}
                onClick={() => setSeriesStyleOpen(true)}
              >
                Series appearance…
              </Button>
              {seriesStyleSummary && (
                <Text size="xs" c="dimmed">
                  {seriesStyleSummary}
                </Text>
              )}
              <Divider label="Applies to all series" labelPosition="left" />
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
              {style.marker_mode !== "none" && (
                <Group grow align="flex-end">
                  <Select
                    label="Marker shape"
                    data={MARKER_SYMBOL_OPTIONS}
                    value={style.marker_symbol}
                    onChange={(value) =>
                      value &&
                      setStyle((next) => void (next.marker_symbol = value as PlotStyle["marker_symbol"]))
                    }
                  />
                  <Switch
                    label="Open (outline only)"
                    checked={style.marker_open}
                    onChange={(event) =>
                      setStyle((next) => void (next.marker_open = event.currentTarget.checked))
                    }
                    mb={8}
                  />
                </Group>
              )}
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
              {axisScope === "cycles" && (
                <>
                  <Divider label="Below minimum replicate count" labelPosition="left" />
                  <Text size="xs" c="dimmed">
                    These markers identify aggregate points where fewer cells contribute than the
                    minimum selected for the replicate band.
                  </Text>
                  <DebouncedColorInput
                    label="Point color"
                    value={style.low_n_color}
                    format="hex"
                    onCommit={(value) => setStyle((next) => void (next.low_n_color = value))}
                    swatches={COLOR_SWATCHES}
                    swatchesPerRow={8}
                  />
                  <Group grow>
                    <Select
                      label="Marker"
                      data={[
                        { value: "circle", label: "Circle" },
                        { value: "square", label: "Square" },
                        { value: "diamond", label: "Diamond" },
                        { value: "cross", label: "Cross" },
                        { value: "x", label: "X" },
                        { value: "triangle-up", label: "Triangle" },
                      ]}
                      value={style.low_n_marker_symbol}
                      onChange={(value) =>
                        value &&
                        setStyle(
                          (next) =>
                            void (next.low_n_marker_symbol =
                              value as PlotStyle["low_n_marker_symbol"])
                        )
                      }
                    />
                    <DebouncedNumberInput
                      label="Marker size"
                      min={2}
                      max={20}
                      value={style.low_n_marker_size}
                      onCommit={(value) =>
                        setStyle((next) => void (next.low_n_marker_size = value ?? 8))
                      }
                    />
                  </Group>
                </>
              )}
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
                <Select
                  label="CE colors"
                  data={[
                    { value: "match", label: "Match primary series" },
                    { value: "secondary", label: "Independent palette" },
                    { value: "single", label: "Single color" },
                  ]}
                  value={style.ce_palette_mode ?? "match"}
                  onChange={(value) =>
                    value &&
                    setStyle((next) => {
                      next.ce_palette_mode = value as NonNullable<PlotStyle["ce_palette_mode"]>;
                      next.ce_custom_colors = {};
                    })
                  }
                />
                {(style.ce_palette_mode ?? "match") === "secondary" && (
                  <Select
                    label="CE palette"
                    data={paletteOptions.filter(
                      (option) => !("value" in option) || option.value !== "custom",
                    )}
                    value={
                      style.ce_palette_id
                        ? `user:${style.ce_palette_id}`
                        : "app"
                    }
                    onChange={(value) =>
                      value &&
                      setStyle((next) => {
                        if (value.startsWith("user:")) {
                          const palette = paletteQuery.data?.palettes.find(
                            (item) => item.id === value.slice(5),
                          );
                          if (!palette) return;
                          next.ce_palette_id = palette.id;
                          next.ce_palette_colors = [...palette.colors];
                        } else {
                          next.ce_palette_id = null;
                          next.ce_palette_colors = [
                            ...(PLOT_PALETTES[value as PlotStyle["palette"]] ??
                              PLOT_PALETTES.app),
                          ];
                        }
                        next.ce_custom_colors = {};
                      })
                    }
                  />
                )}
                {(style.ce_palette_mode ?? "match") === "single" && (
                  <DebouncedColorInput
                    label="CE color"
                    value={style.ce_single_color ?? "#495057"}
                    format="hex"
                    onCommit={(value) =>
                      setStyle((next) => {
                        next.ce_single_color = value;
                        next.ce_custom_colors = {};
                      })
                    }
                    swatches={COLOR_SWATCHES}
                    swatchesPerRow={8}
                  />
                )}
                {colorTargets.length > 0 && (
                  <Stack gap={6}>
                    {colorTargets.map((target, index) => {
                      const palette =
                        style.ce_palette_mode === "secondary"
                          ? cePalette(style)
                          : plotPalette(style);
                      const mainColor =
                        style.ce_palette_mode === "single"
                          ? style.ce_single_color ?? "#495057"
                          : style.custom_colors[target.key] ?? palette[index % palette.length];
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
                {style.ce_marker_mode !== "none" && (
                  <Group grow align="flex-end">
                    <Select
                      label="Marker shape"
                      data={MARKER_SYMBOL_OPTIONS}
                      value={style.ce_marker_symbol ?? "circle"}
                      onChange={(value) =>
                        value &&
                        setStyle((next) => void (next.ce_marker_symbol = value as PlotStyle["ce_marker_symbol"]))
                      }
                    />
                    <Switch
                      label="Open (outline only)"
                      checked={style.ce_marker_open ?? false}
                      onChange={(event) =>
                        setStyle((next) => void (next.ce_marker_open = event.currentTarget.checked))
                      }
                      mb={8}
                    />
                  </Group>
                )}
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
                    step={0.1}
                    decimalScale={8}
                    error={axisRangeError(style.x_axis)}
                    value={style.x_axis.min}
                    onCommit={(value) => setAxis("x_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="X max"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
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
                    step={0.1}
                    decimalScale={8}
                    error={axisRangeError(style.y_axis)}
                    value={style.y_axis.min}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.min = value))}
                  />
                  <DebouncedNumberInput
                    label="Y max"
                    placeholder="Auto"
                    step={0.1}
                    decimalScale={8}
                    value={style.y_axis.max}
                    onCommit={(value) => setAxis("y_axis", (axis) => void (axis.max = value))}
                  />
                </Group>
              )}
              <Text size="10px" c="dimmed">
                Leave one bound empty to clamp only that side.
              </Text>
              <Group grow align="start">
                <Select
                  label="X ticks"
                  data={[
                    { value: "auto", label: "Automatic" },
                    { value: "step", label: "Step size" },
                    { value: "count", label: "Tick count" },
                  ]}
                  value={style.x_axis.tick_mode}
                  onChange={(value) =>
                    value &&
                    setAxis(
                      "x_axis",
                      (axis) => void (axis.tick_mode = value as PlotStyle["x_axis"]["tick_mode"])
                    )
                  }
                />
                {style.x_axis.tick_mode === "step" ? (
                  <DebouncedNumberInput
                    label="X step"
                    min={0}
                    step={0.1}
                    decimalScale={8}
                    value={style.x_axis.dtick}
                    onCommit={(value) =>
                      setAxis("x_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                    }
                  />
                ) : style.x_axis.tick_mode === "count" ? (
                  <DebouncedNumberInput
                    label="X tick count"
                    min={2}
                    max={30}
                    step={1}
                    allowDecimal={false}
                    value={style.x_axis.tick_count}
                    onCommit={(value) =>
                      setAxis(
                        "x_axis",
                        (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                      )
                    }
                  />
                ) : <div />}
              </Group>
              <Group grow align="start">
                <Select
                  label="Y ticks"
                  data={[
                    { value: "auto", label: "Automatic" },
                    { value: "step", label: "Step size" },
                    { value: "count", label: "Tick count" },
                  ]}
                  value={style.y_axis.tick_mode}
                  onChange={(value) =>
                    value &&
                    setAxis(
                      "y_axis",
                      (axis) => void (axis.tick_mode = value as PlotStyle["y_axis"]["tick_mode"])
                    )
                  }
                />
                {style.y_axis.tick_mode === "step" ? (
                  <DebouncedNumberInput
                    label="Y step"
                    min={0}
                    step={0.1}
                    decimalScale={8}
                    value={style.y_axis.dtick}
                    onCommit={(value) =>
                      setAxis("y_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                    }
                  />
                ) : style.y_axis.tick_mode === "count" ? (
                  <DebouncedNumberInput
                    label="Y tick count"
                    min={2}
                    max={30}
                    step={1}
                    allowDecimal={false}
                    value={style.y_axis.tick_count}
                    onCommit={(value) =>
                      setAxis(
                        "y_axis",
                        (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                      )
                    }
                  />
                ) : <div />}
              </Group>
              <Group grow>
                <DebouncedNumberInput
                  label="X title gap"
                  description="Axis title to tick labels"
                  min={0}
                  max={80}
                  value={style.x_axis.title_standoff}
                  onCommit={(value) =>
                    setAxis("x_axis", (axis) => void (axis.title_standoff = value ?? 14))
                  }
                />
                <DebouncedNumberInput
                  label="X label gap"
                  description="Tick labels to axis"
                  min={0}
                  max={40}
                  value={style.x_axis.tick_label_standoff}
                  onCommit={(value) =>
                    setAxis("x_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
                  }
                />
              </Group>
              <Group grow>
                <DebouncedNumberInput
                  label="Y title gap"
                  description="Axis title to tick labels"
                  min={0}
                  max={80}
                  value={style.y_axis.title_standoff}
                  onCommit={(value) =>
                    setAxis("y_axis", (axis) => void (axis.title_standoff = value ?? 14))
                  }
                />
                <DebouncedNumberInput
                  label="Y label gap"
                  description="Tick labels to axis"
                  min={0}
                  max={40}
                  value={style.y_axis.tick_label_standoff}
                  onCommit={(value) =>
                    setAxis("y_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
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
                        step={0.1}
                        decimalScale={8}
                        error={axisRangeError(style.y2_axis)}
                        value={style.y2_axis.min}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.min = value))}
                      />
                      <DebouncedNumberInput
                        label="Right max"
                        placeholder="Auto"
                        step={0.1}
                        decimalScale={8}
                        value={style.y2_axis.max}
                        onCommit={(value) => setAxis("y2_axis", (axis) => void (axis.max = value))}
                      />
                    </Group>
                  )}
                  <Select
                    label="Right ticks"
                    data={[
                      { value: "auto", label: "Automatic" },
                      { value: "step", label: "Step size" },
                      { value: "count", label: "Tick count" },
                    ]}
                    value={style.y2_axis.tick_mode}
                    onChange={(value) =>
                      value &&
                      setAxis(
                        "y2_axis",
                        (axis) => void (axis.tick_mode = value as PlotStyle["y2_axis"]["tick_mode"])
                      )
                    }
                  />
                  {style.y2_axis.tick_mode === "step" && (
                    <DebouncedNumberInput
                      label="Right tick step"
                      min={0}
                      step={0.1}
                      decimalScale={8}
                      value={style.y2_axis.dtick}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.dtick = value && value > 0 ? value : null))
                      }
                    />
                  )}
                  {style.y2_axis.tick_mode === "count" && (
                    <DebouncedNumberInput
                      label="Right tick count"
                      min={2}
                      max={30}
                      step={1}
                      allowDecimal={false}
                      value={style.y2_axis.tick_count}
                      onCommit={(value) =>
                        setAxis(
                          "y2_axis",
                          (axis) => void (axis.tick_count = value && value >= 2 ? Math.round(value) : null)
                        )
                      }
                    />
                  )}
                  <Group grow>
                    <DebouncedNumberInput
                      label="Right title gap"
                      description="Axis title to tick labels"
                      min={0}
                      max={80}
                      value={style.y2_axis.title_standoff}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.title_standoff = value ?? 14))
                      }
                    />
                    <DebouncedNumberInput
                      label="Right label gap"
                      description="Tick labels to axis"
                      min={0}
                      max={40}
                      value={style.y2_axis.tick_label_standoff}
                      onCommit={(value) =>
                        setAxis("y2_axis", (axis) => void (axis.tick_label_standoff = value ?? 4))
                      }
                    />
                  </Group>
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
      <SeriesStyleModal
        opened={seriesStyleOpen}
        onClose={() => setSeriesStyleOpen(false)}
        descriptors={seriesDescriptors}
        overrides={style.series_overrides ?? {}}
        rules={style.series_rules ?? []}
        baseFor={seriesBaseFor}
        buildPreview={buildSeriesPreview}
        onChange={({ overrides, rules }) =>
          setStyle((next) => {
            next.series_overrides = overrides;
            next.series_rules = rules;
          })
        }
      />
      <Modal
        opened={savePresetOpen}
        onClose={() => setSavePresetOpen(false)}
        title="Save plot-style preset"
        centered
      >
        <Stack gap="sm">
          <TextInput
            label="Preset name"
            value={presetName}
            onChange={(event) => setPresetName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && presetName.trim()) savePreset.mutate();
            }}
            autoFocus
          />
          <Select
            label="Available for"
            value={presetFamily}
            data={[
              { value: "all", label: "All plot types" },
              { value: "cycles", label: "Cycles plots" },
              { value: "time_capacity", label: "Time / capacity plots" },
            ]}
            onChange={(value) =>
              value &&
              setPresetFamily(value as "all" | "cycles" | "time_capacity")
            }
          />
          <Switch
            label="Use as default for new plots"
            checked={presetDefault}
            onChange={(event) => setPresetDefault(event.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            The preset stores all current styling, ranges, and tick settings. When applying it,
            ranges and ticks can be left unchanged independently.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSavePresetOpen(false)}>
              Cancel
            </Button>
            <Button
              leftSection={<IconDeviceFloppy size={14} />}
              disabled={!presetName.trim()}
              loading={savePreset.isPending}
              onClick={() => savePreset.mutate()}
            >
              Save preset
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

function PlotExplainerButton({ explainer }: { explainer?: PlotExplainer }) {
  if (!explainer) return null;
  return (
    <Popover withinPortal position="bottom-end" shadow="md" width={360}>
      <Popover.Target>
        <Tooltip label="How this plot is calculated">
          <ActionIcon size={30} variant="subtle" color="var(--mantine-primary-color-6)" aria-label="Plot explainer">
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
                  <Badge key={item} size="sm" variant="light" color="var(--mantine-primary-color-6)">
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

export function PlotHeader({
  analysisTitle,
  tabName,
  plotName,
  subtitle,
  quantityName,
  xAxisName,
  sampleSummary,
  explainer,
  onExport,
  onDataExport,
  getExportPreview,
  style,
  updateStyle,
  viewSize,
  layout,
  canExport = false,
  edited = false,
  onNewPlot,
  newPlotEnabled = false,
  onUpdatePlot,
  updatePlotEnabled = false,
  updatePlotLabel = "Update",
}: {
  analysisTitle?: string;
  tabName?: string;
  plotName: string;
  subtitle: string;
  quantityName?: string;
  xAxisName?: string;
  sampleSummary?: string;
  explainer?: PlotExplainer;
  onExport?: (format: PlotExportFormat, baseName: string) => void;
  onDataExport?: (baseName: string) => void;
  getExportPreview?: () => Promise<string | null>;
  style?: PlotStyle;
  updateStyle?: (fn: (style: PlotStyle) => void) => void;
  viewSize?: { width: number; height: number } | null;
  layout?: Partial<Plotly.Layout>;
  canExport?: boolean;
  /** Amber chip when the open saved plot has unsaved edits. */
  edited?: boolean;
  onNewPlot?: () => void;
  /** Green and clickable when the analysis has samples. */
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  /** Amber/active when the open saved plot has unsaved edits, or when saving a draft. */
  updatePlotEnabled?: boolean;
  /** `Save as` for new drafts; `Update` for edited saved plots. */
  updatePlotLabel?: string;
}) {
  const exportStyle = style ?? DEFAULT_PLOT_STYLE;
  const selectedFormat = exportStyle.export_format ?? "png";
  const [exportPopoverOpen, setExportPopoverOpen] = useState(false);
  const [dataExportPopoverOpen, setDataExportPopoverOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [filenameTemplate, setFilenameTemplate] = useState(
    "{analysis} - {plot_title}",
  );
  const filenameTemplateInitialized = useRef(false);
  const downloadSettings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<DownloadSettings>("/api/settings"),
    staleTime: 5 * 60_000,
  });
  const exportPreviewSignature = JSON.stringify(exportStyle);
  const plan = resolveExportPlan(exportStyle, viewSize ?? null, layout ?? {});
  const exportWidthValue = plan.pixelWidth;
  const exportHeightValue = plan.pixelHeight;
  const ppi = Math.max(36, exportStyle.export_ppi || DEFAULT_PLOT_STYLE.export_ppi);
  const printWidthCm = (exportWidthValue / ppi) * 2.54;
  const printHeightCm = (exportHeightValue / ppi) * 2.54;
  const setExportStyle = (fn: (style: PlotStyle) => void) => updateStyle?.(fn);
  const setAspect = (value: PlotAspectRatioKey) => {
    setExportStyle((next) => {
      next.export_aspect_ratio = value;
    });
  };
  const setExportWidth = (value: number) => {
    setExportStyle((next) => {
      next.export_width = value;
    });
  };
  const filenameContext = {
    analysis: analysisTitle?.trim() || "Analysis",
    plotTitle:
      plotName === "Unsaved plot" || plotName === "New plot"
        ? subtitle || "Plot"
        : plotName,
    quantity: quantityName?.trim() || subtitle || "Plot",
    xAxis: xAxisName?.trim() || "X axis",
    tab: tabName?.trim() || "Analysis",
    sampleSummary: sampleSummary?.trim() || "samples",
  };
  useEffect(() => {
    if (filenameTemplateInitialized.current || !downloadSettings.data) return;
    filenameTemplateInitialized.current = true;
    setFilenameTemplate(
      downloadSettings.data.export_filename_template || "{analysis} - {plot_title}",
    );
  }, [downloadSettings.data]);
  const renderedFilename = sanitizeExportFilename(
    renderExportFilename(filenameTemplate, filenameContext),
    "plot",
  );
  const exportPlot = () => {
    onExport?.(selectedFormat, renderedFilename);
    setExportPopoverOpen(false);
  };
  const exportData = () => {
    onDataExport?.(renderedFilename);
    setDataExportPopoverOpen(false);
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
    exportPreviewSignature,
    viewSize?.width,
    viewSize?.height,
  ]);

  return (
    <>
    <Group justify="space-between" mb="xs" align="start">
      <div>
        <Group gap={8} align="center" wrap="nowrap">
          <Text fw={800} size="lg">
            {plotName}
          </Text>
          {edited ? (
            <Badge size="xs" variant="light" color="yellow">
              Edited
            </Badge>
          ) : null}
        </Group>
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
              onClick={exportData}
            >
              {exportStyle.data_export_format === "xlsx" ? "XLSX" : "CSV"}
            </Button>
            <Popover
              withinPortal
              position="bottom-end"
              shadow="md"
              width="min(540px, calc(100vw - 24px))"
              opened={dataExportPopoverOpen}
              onChange={setDataExportPopoverOpen}
            >
              <Popover.Target>
                <Button
                  size="xs"
                  variant="default"
                  px={6}
                  disabled={!canExport}
                  aria-label="Data export settings"
                  onClick={() => setDataExportPopoverOpen((open) => !open)}
                >
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
                  <Select
                    label="Numeric precision"
                    data={[
                      { value: "standard", label: "Standard (recommended)" },
                      { value: "full", label: "Full source precision" },
                    ]}
                    value={exportStyle.data_precision}
                    comboboxProps={{ withinPortal: false }}
                    onChange={(value) =>
                      value &&
                      setExportStyle(
                        (next) => void (next.data_precision = value as PlotStyle["data_precision"])
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
                    excluded). Standard precision removes meaningless floating-point tails; full
                    precision preserves every stored digit.
                  </Text>
                  <Divider />
                  <FilenameTemplateEditor
                    value={filenameTemplate}
                    onChange={setFilenameTemplate}
                  />
                  <Paper withBorder p="xs" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                    <Text size="xs" c="dimmed">Result</Text>
                    <Text size="sm" fw={600} lineClamp={2}>
                      {renderedFilename}.{exportStyle.data_export_format}
                    </Text>
                  </Paper>
                  <Button
                    fullWidth
                    leftSection={<IconTable size={14} />}
                    onClick={exportData}
                  >
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
              onClick={exportPlot}
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
                        The aspect ratio applies to the data rectangle; labels, margins, and outside legends are added around it.
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
                    </Stack>
                    <Stack
                      gap="xs"
                      style={{ gridColumn: "1 / -1" }}
                    >
                      <Divider />
                      <FilenameTemplateEditor
                        value={filenameTemplate}
                        onChange={setFilenameTemplate}
                      />
                      <Paper withBorder p="xs" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                        <Text size="xs" c="dimmed">Result</Text>
                        <Text size="sm" fw={600} lineClamp={2}>
                          {renderedFilename}.{selectedFormat}
                        </Text>
                      </Paper>
                      <Button
                        fullWidth
                        leftSection={<IconDownload size={14} />}
                        onClick={exportPlot}
                      >
                        Download {selectedFormat.toUpperCase()}
                      </Button>
                    </Stack>
                </div>
              </Popover.Dropdown>
            </Popover>
          </Button.Group>
        )}
        {onUpdatePlot ? (
          <Button
            size="xs"
            color="yellow"
            variant={updatePlotEnabled ? "filled" : "light"}
            disabled={!updatePlotEnabled}
            onClick={onUpdatePlot}
          >
            {updatePlotLabel}
          </Button>
        ) : null}
        {onNewPlot ? (
          <Button
            size="xs"
            color="var(--mantine-primary-color-6)"
            variant={newPlotEnabled ? "filled" : "light"}
            leftSection={<IconPlus size={14} />}
            disabled={!newPlotEnabled}
            onClick={onNewPlot}
          >
            New
          </Button>
        ) : null}
      </Group>
    </Group>
    </>
  );
}

function PlotWorkspaceEmpty({
  hasSamples,
  onNewPlot,
}: {
  hasSamples: boolean;
  onNewPlot: () => void;
}) {
  return (
    <Paper p="sm" withBorder style={{ minHeight: 420 }}>
      <Group justify="flex-end" mb="md">
        <Button
          size="xs"
          color="var(--mantine-primary-color-6)"
          variant={hasSamples ? "filled" : "light"}
          leftSection={<IconPlus size={14} />}
          disabled={!hasSamples}
          onClick={onNewPlot}
        >
          New
        </Button>
      </Group>
      <Center h={320}>
        <Stack gap={6} align="center" maw={420}>
          <Text fw={700}>No plot yet</Text>
          <Text size="sm" c="dimmed" ta="center">
            {hasSamples
              ? "Click New to start a draft for this tab."
              : "Add cells or replicates to this analysis, then click New."}
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}

function cyclePlotLayout(
  result: ComputeResult | undefined,
  spec: AnalysisSpec,
  traces: Plotly.Data[] = []
): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "cycles");
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = resolvedQuantity(result, spec);
  const showCeOverlay = (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const lm = legendMargins(style, spec.presentation.legend);
  const leftGap = axisGapDelta(style.y_axis);
  const bottomGap = axisGapDelta(style.x_axis);
  const rightGap = showCeOverlay ? axisGapDelta(style.y2_axis) : 0;
  const rightMargin = Math.max(
    (showCeOverlay ? 64 : 24) + rightGap,
    lm.r ? lm.r + 24 : 0
  );
  const topMargin = 20 + lm.t;
  const axisBase = (axis: PlotStyle["x_axis"]) => ({
    showgrid: style.show_grid,
    gridcolor: "#edf2f7",
    zeroline: false,
    showline: style.show_frame,
    mirror: style.show_frame,
    linecolor: style.frame_color,
    linewidth: style.frame_width,
    ...tickLayout(style, axis),
  });
  const titleFont = { size: style.axis_title_size };
  const xRange = numericTraceExtent(traces, "x", ["x"]);
  const yRange = numericTraceExtent(traces, "y", ["y"]);
  const y2Range = numericTraceExtent(traces, "y", ["y2"]);

  return {
    height: 500,
    margin: {
      l: 66 + lm.l + leftGap,
      r: rightMargin,
      t: topMargin,
      b: 58 + lm.b + bottomGap,
    },
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
    font: { size: style.tick_font_size },
    hoverlabel: hoverLabelLayout(style),
    // keep the user's zoom/pan across STYLE edits, but reset the view when
    // the data or the plotted quantity changes — otherwise switching e.g.
    // from CE (~99) to capacity (~120 mAh) kept the old ranges and showed
    // an empty plot
    uirevision: `${result?.computed_at ?? "no-data"}|${quantity}|${spec.presentation.normalize_by_mass ? "g" : "abs"}|${
      spec.presentation.reindex_diagnostic_cycles ? "reidx" : "noreidx"
    }`,
    xaxis: {
      ...axisBase(style.x_axis),
      title: {
        text: style.x_title ?? "Cycle",
        font: titleFont,
        standoff: style.x_axis.title_standoff,
      },
      ...axisLayout(style.x_axis, xRange),
    },
    yaxis: {
      ...axisBase(style.y_axis),
      // zero line only makes sense on the value axis of a cycle plot
      zeroline: style.show_zero_line,
      zerolinecolor: "#adb5bd",
      title: {
        text: style.y_title ?? quantityInfo?.label ?? "",
        font: titleFont,
        standoff: style.y_axis.title_standoff,
      },
      ...axisLayout(style.y_axis, yRange),
    },
    ...(showCeOverlay
      ? {
          yaxis2: {
            title: {
              text: style.y2_title ?? "CE (%)",
              font: titleFont,
              standoff: style.y2_axis.title_standoff,
            },
            overlaying: "y" as const,
            side: "right" as const,
            showgrid: false,
            zeroline: false,
            showline: style.show_frame,
            linecolor: style.frame_color,
            linewidth: style.frame_width,
            ...tickLayout(style, style.y2_axis),
            ...axisLayout(style.y2_axis, y2Range),
          },
        }
      : {}),
    showlegend: spec.presentation.legend,
    legend: { ...legendLayout(style), font: { size: style.legend_font_size } },
  };
}

type PortablePlotSnapshot = {
  id: string;
  name: string;
  subtitle: string;
  description: string | null;
  tab: AnalysisTabKey;
  figure: PortableFigure | null;
  svg: string | null;
  summary: PortableSummaryRow[];
};

function portableFigure(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>
): PortablePlotSnapshot["figure"] {
  const responsiveLayout = { ...layout, autosize: true } as Record<string, unknown>;
  delete responsiveLayout.width;
  return JSON.parse(
    JSON.stringify({
      data: traces,
      layout: responsiveLayout,
      config: { displaylogo: false, responsive: true },
    })
  ) as NonNullable<PortablePlotSnapshot["figure"]>;
}

async function portableSvg(
  figure: NonNullable<PortablePlotSnapshot["figure"]>,
  options: { width?: number; height?: number; hideLegend?: boolean } = {}
): Promise<string> {
  const width = options.width ?? 1200;
  const height = options.height ?? 720;
  const sourceLayout = figure.layout as Record<string, unknown>;
  const sourceMargin = (sourceLayout.margin ?? {}) as Record<string, number>;
  const renderFigure = options.hideLegend
    ? {
        ...figure,
        layout: {
          ...sourceLayout,
          autosize: false,
          width,
          height,
          showlegend: false,
          margin: {
            ...sourceMargin,
            l: Math.max(70, Math.min(sourceMargin.l ?? 80, 110)),
            r: Math.max(55, Math.min(sourceMargin.r ?? 70, 110)),
            t: Math.max(28, Math.min(sourceMargin.t ?? 40, 70)),
            b: Math.max(62, Math.min(sourceMargin.b ?? 75, 100)),
          },
        },
      }
    : figure;
  const toImage = (
    PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
  ).toImage;
  const dataUrl = await toImage(renderFigure, {
    format: "svg",
    width,
    height,
  });
  return textFromDataUrl(dataUrl);
}

async function rasterThumbnail(
  svg: string,
  width: number,
  height: number,
  sourceFontFloor: number,
): Promise<string> {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  documentNode.querySelectorAll("g.legend").forEach((node) => node.remove());
  documentNode.querySelectorAll("text").forEach((node) => {
    const current = Number.parseFloat(node.style.fontSize || node.getAttribute("font-size") || "12");
    node.style.fontSize = `${Math.max(sourceFontFloor, current * 1.5)}px`;
  });
  documentNode.querySelectorAll(".scatterlayer path.js-line").forEach((node) => {
    const path = node as SVGPathElement;
    const rawWidth = path.style.strokeWidth || path.getAttribute("stroke-width");
    const current = rawWidth ? Number.parseFloat(rawWidth) : Number.NaN;
    const rawOpacity = path.style.strokeOpacity || path.getAttribute("stroke-opacity");
    const opacity = rawOpacity ? Number.parseFloat(rawOpacity) : 1;
    if (
      !Number.isFinite(current) ||
      current <= 0 ||
      (Number.isFinite(opacity) && opacity <= 0) ||
      path.style.stroke === "none" ||
      path.getAttribute("stroke") === "none"
    ) {
      return;
    }
    path.style.strokeWidth = `${Math.max(2.5, current * 1.4)}px`;
  });
  documentNode
    .querySelectorAll("path.xlines-above, path.ylines-above, path.xlines-below, path.ylines-below")
    .forEach((node) => {
      (node as SVGPathElement).style.strokeWidth = "3.5px";
    });
  const thumbnailSvg = new XMLSerializer().serializeToString(documentNode.documentElement);
  const url = URL.createObjectURL(
    new Blob([thumbnailSvg], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Could not render the cached SVG preview."));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the thumbnail canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const sourceWidth = image.naturalWidth || 1200;
    const sourceHeight = image.naturalHeight || 720;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(
      image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
    const webp = canvas.toDataURL("image/webp", 0.84);
    return webp.startsWith("data:image/webp;base64,")
      ? webp
      : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function savedRowThumbnail(svg: string): Promise<string> {
  // The saved-plot list is deliberately compact and wide. It is derived from
  // the canonical portable SVG, so this path is cheap when only the small
  // row image needs rebuilding.
  return rasterThumbnail(svg, 480, 288, 28);
}

async function hoverPreviewThumbnail(
  figure: NonNullable<PortablePlotSnapshot["figure"]>
): Promise<string> {
  // A wide plot scaled into a 4:3 bitmap remains a wide plot with whitespace.
  // Re-layout Plotly at 4:3 first so the hover panel receives a true preview.
  const svg = await portableSvg(figure, { width: 640, height: 480, hideLegend: true });
  return rasterThumbnail(svg, 480, 360, 18);
}

/** Identify a compute so the server can attach a job to it if it does work. */
function newComputeToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Plotly image export is synchronous-heavy even though it returns a promise.
// Serializing thumbnail work prevents several saved plots from blocking the UI
// at the same time when a tab is opened for the first time.
let portableSvgQueue: Promise<void> = Promise.resolve();

/**
 * Wait until the browser has drawn what it already has.
 *
 * Plotly image export blocks the main thread in long synchronous chunks, so
 * starting it straight from an effect prevents React from committing — every
 * *cached* thumbnail on the page keeps showing a spinner while one uncached
 * plot is generated. Yielding to idle first lets the warm plots paint, so the
 * spinner marks the plot actually being built rather than all of them.
 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const start = () => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 500 });
      } else {
        window.setTimeout(resolve, 32);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(start));
  });
}

function queuedPortableArtifactImages(
  figure: NonNullable<PortablePlotSnapshot["figure"]>
): Promise<{ svg: string; thumbnail: string; preview_thumbnail: string }> {
  const task = portableSvgQueue.then(async () => {
    await afterPaint();
    const svg = await portableSvg(figure);
    const thumbnail = await savedRowThumbnail(svg);
    const preview_thumbnail = await hoverPreviewThumbnail(figure);
    return { svg, thumbnail, preview_thumbnail };
  });
  portableSvgQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function queuedPortableThumbnails(
  svg: string,
  figure: NonNullable<PortablePlotSnapshot["figure"]>,
): Promise<{ thumbnail: string; preview_thumbnail: string }> {
  const task = portableSvgQueue.then(async () => {
    await afterPaint();
    return {
      thumbnail: await savedRowThumbnail(svg),
      preview_thumbnail: await hoverPreviewThumbnail(figure),
    };
  });
  portableSvgQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function storePlotArtifactWithRetry(
  analysisId: number,
  plotId: string,
  artifact: PlotArtifact,
  warmupTask?: CacheWarmupTask,
): Promise<PlotArtifact> {
  // Draft cards keep thumbnails in React Query only — posting `__draft__:*`
  // always 404s (not in saved_plots) and previously retry-stormed the API.
  if (isDraftPreviewPlotId(plotId)) return artifact;
  const delays = [0, 800, 1600, 2600];
  let lastError: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      return await post<PlotArtifact>(
        `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}`,
        warmupTask
          ? {
              ...artifact,
              warmup_task_id: warmupTask.id,
              expected_data_signature: warmupTask.expected_data_signature,
              expected_analysis_modified_at: warmupTask.analysis_modified_at,
            }
          : artifact
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  throw lastError;
}

async function buildPortablePlotSnapshots(
  analysisId: number,
  baseSpec: AnalysisSpec,
  analysisTitle: string,
  selectedPlotIds: string[],
  onProgress?: (completed: number, total: number, stage: string) => void,
  readMemoryArtifact?: (plotId: string, signature: string) => PlotArtifact | null
): Promise<PortablePlotSnapshot[]> {
  const saved = baseSpec.saved_plots ?? [];
  const views =
    saved.length > 0
      ? saved.filter((plot) => selectedPlotIds.includes(plot.id))
      : [
          {
            id: "current",
            tab: "cycles" as AnalysisTabKey,
            name: analysisTitle,
            subtitle: "Current analysis view",
            description: null,
          },
        ].filter((plot) => selectedPlotIds.includes(plot.id));

  const snapshots: PortablePlotSnapshot[] = [];
  for (let index = 0; index < views.length; index += 1) {
      const view = views[index];
      onProgress?.(index, views.length, `Preparing ${view.name}`);
      const viewSpec =
        "selection" in view
          ? specForSavedPlot(baseSpec, view as SavedAnalysisPlot)
          : clone(baseSpec);
      const artifactSignature =
        "selection" in view
          ? savedPlotPreviewSignature(baseSpec, view as SavedAnalysisPlot)
          : null;
      let cachedArtifact: PlotArtifact | null = null;
      if (artifactSignature) {
        cachedArtifact = readMemoryArtifact?.(view.id, artifactSignature) ?? null;
      }
      if (artifactSignature && !cachedArtifact) {
        try {
          cachedArtifact = await post<PlotArtifact>(
            `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}/lookup`,
            { signature: artifactSignature }
          );
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
      }
      if (cachedArtifact) {
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure: cachedArtifact.figure,
          svg: cachedArtifact.svg,
          summary: cachedArtifact.summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "time_capacity") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "time_capacity",
          spec: viewSpec,
        });
        const result = await post<TimeCapacityResult>(
          `/api/analyses/${analysisId}/time-capacity`,
          {
            spec: viewSpec,
            job_id: job.id,
            viewport_width: 1200,
            precision: "standard",
            compact: true,
          }
        );
        const traces = tracesForTimeCapacity(result, viewSpec);
        const layout = timeCapacityLayout(result, viewSpec, traces);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_traces.map((trace) => ({
          label: trace.label,
          cycles: new Set(trace.cycle.filter((cycle) => cycle !== null)).size,
          status: trace.excluded ? "Hidden" : "Visible",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn("Could not cache the generated portable plot", error);
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "cycles") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "cycles",
          spec: viewSpec,
        });
        const result = await post<ComputeResult>(
          `/api/analyses/${analysisId}/compute`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = tracesForResult(result, viewSpec);
        const layout = cyclePlotLayout(result, viewSpec, traces);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.metrics?.n_cycles ?? series.x.length,
          status: series.excluded ? "Hidden" : "Visible",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn("Could not cache the generated portable plot", error);
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "steps") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "steps",
          spec: viewSpec,
        });
        const result = await post<StepsResult>(
          `/api/analyses/${analysisId}/steps`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = stepsTracesForResult(result, viewSpec);
        const layout = stepsLayoutForSpec(viewSpec);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.n_blocks,
          status: series.n_blocks > 0 ? "Visible" : "No matching blocks",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn("Could not cache the generated portable Steps plot", error);
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "dcir") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "dcir",
          spec: viewSpec,
        });
        const result = await post<DcirResult>(
          `/api/analyses/${analysisId}/dcir`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = dcirTracesForResult(result, viewSpec);
        const layout = dcirLayoutForSpec(viewSpec);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.n_measurements,
          status: series.n_measurements > 0 ? "Visible" : "No measurements",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn("Could not cache the generated portable DCIR plot", error);
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "chargeability") {
        const job = await post<BackgroundJob>(
          `/api/analyses/${analysisId}/compute-jobs`,
          {
            kind: "chargeability",
            spec: viewSpec,
          }
        );
        const result = await post<ChargeabilityResult>(
          `/api/analyses/${analysisId}/chargeability`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = chargeabilityTracesForResult(result, viewSpec);
        const layout = chargeabilityLayoutForSpec(viewSpec, result);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cells.map((cell) => ({
          label: cell.cell_name,
          cycles: cell.match_count,
          status:
            cell.match_count > 0
              ? "Matched"
              : cell.status === "no_candidates"
                ? "No candidates"
                : "No matching event",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn(
              "Could not cache the generated portable Chargeability plot",
              error
            );
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "crate") {
        const job = await post<BackgroundJob>(
          `/api/analyses/${analysisId}/compute-jobs`,
          {
            kind: "rate_capability",
            spec: viewSpec,
          }
        );
        const result = await post<RateCapabilityResult>(
          `/api/analyses/${analysisId}/rate-capability`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = rateCapabilityTracesForResult(result, viewSpec);
        const layout = rateCapabilityLayoutForSpec(viewSpec, result);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cells.map((cell) => {
          const points =
            cell.families.charge.point_count +
            cell.families.discharge.point_count;
          return {
            label: cell.cell_name,
            cycles: points,
            status: points > 0 ? "Matched" : "No sweep detected",
          };
        });
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            console.warn(
              "Could not cache the generated portable rate-capability plot",
              error
            );
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      snapshots.push({
        id: view.id,
        name: view.name,
        subtitle: view.subtitle,
        description: view.description,
        tab: view.tab,
        figure: null,
        svg: null,
        summary: [],
      });
      onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
  }
  return snapshots;
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
    const xRange = Array.isArray(ev["xaxis.range"]) ? ev["xaxis.range"] as unknown[] : [];
    const yRange = Array.isArray(ev["yaxis.range"]) ? ev["yaxis.range"] as unknown[] : [];
    const xr0 = ev["xaxis.range[0]"] ?? xRange[0];
    const xr1 = ev["xaxis.range[1]"] ?? xRange[1];
    const yr0 = ev["yaxis.range[0]"] ?? yRange[0];
    const yr1 = ev["yaxis.range[1]"] ?? yRange[1];
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

export function usePlotSizeSync(plotDivRef: { current: HTMLElement | null }) {
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
  analysisTitle,
  plotName,
  subtitle,
  result,
  spec,
  update,
  updating,
  error,
  computeJob,
  edited = false,
  onNewPlot,
  newPlotEnabled = false,
  onUpdatePlot,
  updatePlotEnabled = false,
  updatePlotLabel = "Update",
}: {
  analysisTitle: string;
  plotName: string;
  subtitle: string;
  result: ComputeResult | undefined;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
  updating: boolean;
  error: Error | null;
  edited?: boolean;
  onNewPlot?: () => void;
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  updatePlotEnabled?: boolean;
  updatePlotLabel?: string;
  computeJob: BackgroundJob | undefined;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const showComputeProgress = useDelayedFlag(updating);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  // Rebuild traces/layout only when the fields they actually read change —
  // unrelated spec edits (other tabs' styles, autosave echoes) must not
  // trigger a full Plotly re-render.
  //
  // Any presentation field that changes what is plotted (not merely how it is
  // styled) must appear here, in zoomSignature, and in cyclePlotLayout
  // uirevision. A flag that changes the data but not these keys silently does
  // nothing.
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
        // Hiding diagnostics drops points from every trace, so it belongs here
        // for the same reason as normalize: it changes what is plotted.
        hideDiagnostics: spec.presentation.hide_diagnostic_cycles ?? false,
        reindexDiagnostics: spec.presentation.reindex_diagnostic_cycles ?? false,
        diagnosticTolerance: spec.presentation.diagnostic_tolerance ?? null,
        style: currentPlotStyle(spec, "cycles"),
      }),
    [spec]
  );
  // Build one canonical SVG-capable trace set, then change only the renderer
  // type for the interactive graph. Data, style, order and layout stay shared.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const exportTraces = useMemo(() => (result ? tracesForResult(result, spec) : []), [result, viewSignature]);
  const traces = useMemo(() => interactivePlotTraces(exportTraces), [exportTraces]);
  // Reported next to the plot so a filtered view always states what it removed
  // and what remains — the count is the disclosure, not a diagnostic aid.
  const diagnostics = useMemo(() => {
    if (!result || !spec.presentation.hide_diagnostic_cycles) return null;
    const hidden = diagnosticCyclesFor(result, spec);
    const everyCycle = result.cell_series
      .filter((s) => !s.excluded)
      .flatMap((s) => s.x);
    return summarizeHidden(everyCycle, hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, spec.presentation.hide_diagnostic_cycles, spec.presentation.diagnostic_tolerance]);
  // Any protocol-segment mode filters at the cycle level, never sub-cycle, so
  // the plot must say so — a segment here changes which cycles appear, not the
  // per-cycle quantity.
  const segmentsActive =
    (spec.computation.protocol_filter?.only_segment_ids?.length ?? 0) > 0 ||
    (spec.computation.protocol_filter?.excluded_segment_ids?.length ?? 0) > 0 ||
    (spec.presentation.hidden_protocol_segment_ids?.length ?? 0) > 0;
  const zoomSignature = `${result?.computed_at ?? "no-data"}|${spec.presentation.quantity}|${
    spec.presentation.normalize_by_mass ? "g" : "abs"
  }|${spec.presentation.reindex_diagnostic_cycles ? "reidx" : "noreidx"}`;
  const zoom = useZoomMemory(zoomSignature);
  const layout = useMemo(
    () => zoom.apply(cyclePlotLayout(result, spec, exportTraces)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, viewSignature, exportTraces]
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

  const currentViewSize = () => {
    if (!plotDivRef.current) return plotSize;
    const rect = plotDivRef.current.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };

  // faithful mini-render of the export output for the settings popover
  const getExportPreview = async (): Promise<string | null> => {
    if (!plotDivRef.current || exportTraces.length === 0) return null;
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

  const handleDataExport = (baseName: string) => {
    downloadDataExport(tracesToColumns(exportTraces, layout), style, baseName).catch(
      (e: Error) => notifications.show({ message: e.message || "Data export failed.", color: "red" })
    );
  };

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    if (!plotDivRef.current || !result) return;
    try {
      const plan = resolveExportPlan(style, currentViewSize(), layout);
      const ppi = Math.max(36, style.export_ppi ?? 96);
      const filename = slugFilename(baseName);
      // Render off the live figure with an export-only layout (exact size,
      // optional in-figure title) so the on-screen plot is never disturbed.
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
          loaderProps={{ size: "sm" }}
        />
        <PlotHeader
          analysisTitle={analysisTitle}
          tabName="Cycles"
          plotName={plotName}
          subtitle={subtitle}
          quantityName={resolvedQuantity(result, spec)?.label ?? subtitle}
          xAxisName={style.x_title ?? "Cycle"}
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
          canExport={exportTraces.length > 0}
          edited={edited}
          onNewPlot={onNewPlot}
          newPlotEnabled={newPlotEnabled}
          onUpdatePlot={onUpdatePlot}
          updatePlotEnabled={updatePlotEnabled}
          updatePlotLabel={updatePlotLabel}
        />
        {error && <Alert color="red">{error.message || "Compute failed"}</Alert>}
        {segmentsActive && (
          <Alert
            color="yellow"
            variant="light"
            icon={<IconInfoCircle size={16} />}
            styles={{ message: { fontSize: 12 } }}
          >
            Protocol segments here select whole cycles: a cycle is plotted if it contains the
            segment. Each point is still computed over the entire cycle — the segment does not
            isolate a single step's quantity.
          </Alert>
        )}
        {diagnostics && diagnostics.hiddenCount > 0 && (
          <Group gap="xs" wrap="nowrap" align="center">
            <Badge color="var(--mantine-primary-color-6)" variant="light" style={{ flexShrink: 0 }}>
              {diagnostics.hiddenCount} hidden · {diagnostics.shownCount} shown
            </Badge>
            <Tooltip
              label={`Hidden cycles: ${formatCycleRanges(diagnostics.hidden)}`}
              multiline
              maw={420}
              withArrow
              openDelay={200}
            >
              <Text size="xs" c="dimmed" truncate="end">
                diagnostic cycles {formatCycleRanges(diagnostics.hidden, 4)}
              </Text>
            </Tooltip>
            <NumberInput
              size="xs"
              w={132}
              min={5}
              max={90}
              step={5}
              suffix="%"
              label={undefined}
              aria-label="Diagnostic sensitivity"
              value={Math.round(
                (spec.presentation.diagnostic_tolerance ?? DIAGNOSTIC_DEFAULTS.tolerance) * 100
              )}
              onChange={(value) => {
                const pct = typeof value === "number" ? value : Number(value);
                if (!Number.isFinite(pct)) return;
                update((s) => {
                  s.presentation.diagnostic_tolerance = Math.min(0.9, Math.max(0.05, pct / 100));
                });
              }}
            />
          </Group>
        )}
        {traces.length === 0 ? (
          // The height is held whether or not progress is showing, so a load
          // that beats the delay lands the plot without any reflow.
          <Center h={500}>
            {updating ? (
              showComputeProgress ? (
                <ComputeProgress job={computeJob} label="Preparing cycle plot" />
              ) : null
            ) : (
              <Text size="sm" c="dimmed">
                Add cells or replicates to start plotting.
              </Text>
            )}
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

function TimeCapacityPlotCardView({
  analysisId,
  analysisTitle,
  plotName,
  subtitle,
  spec,
  update,
  onReadyChange,
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
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const cfg = timeCapacityConfig(spec);
  // Keep cache identity stable across restarts, window sizes and style-panel
  // changes. Point density is controlled solely by max_points_per_cell.
  const viewportWidth = 1200;
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
      cfg.view,
      cfg.derivative_phase,
      cfg.derivative_specific,
      cfg.derivative_absolute_discharge,
      cfg.smoothing_window,
      viewportWidth,
    ]
  );
  const timeResult = useQuery({
    queryKey: ["time-capacity", analysisId, dataSignature],
    queryFn: async () => {
      // The server opens an activity entry only if the cache misses, so send a
      // token instead of pre-creating a job: a cached load costs one request
      // and leaves no spurious "Preparing..." entry behind.
      const token = newComputeToken();
      setComputeToken(token);
      try {
        return await post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
          spec,
          job_token: token,
          viewport_width: viewportWidth,
          precision: "standard",
          compact: true,
        });
      } finally {
        window.setTimeout(
          () => setComputeToken((current) => (current === token ? null : current)),
          300
        );
      }
    },
    enabled: spec.selection.entries.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
    placeholderData: (previous) => previous,
  });
  const computeJob = useQuery({
    queryKey: ["background-job-token", computeToken],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${computeToken}`),
    enabled: computeToken !== null,
    // null means the compute was served from cache and never opened a job.
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 300 : false,
  });
  const showComputeProgress = useDelayedFlag(timeResult.isLoading);
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
    () => (timeResult.data ? tracesForTimeCapacity(timeResult.data, spec) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeResult.data, viewSignature]
  );
  const traces = useMemo(() => interactivePlotTraces(exportTraces), [exportTraces]);
  const zoomSignature = `${analysisId}|${cfg.view}|${cfg.x_axis}|${cfg.time_unit}|${cfg.display_mode}`;
  const zoom = useZoomMemory(zoomSignature, cfg.view !== "voltage_current" || !cfg.stacked);
  const layout = useMemo(
    () => zoom.apply(timeCapacityLayout(timeResult.data, spec, exportTraces)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeResult.data, viewSignature, exportTraces]
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

  const currentViewSize = () => {
    if (!plotDivRef.current) return plotSize;
    const rect = plotDivRef.current.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };

  // faithful mini-render of the export output for the settings popover
  const getExportPreview = async (): Promise<string | null> => {
    if (!plotDivRef.current || exportTraces.length === 0) return null;
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

  const handleDataExport = (baseName: string) => {
    downloadDataExport(tracesToColumns(exportTraces, layout), style, baseName).catch(
      (e: Error) => notifications.show({ message: e.message || "Data export failed.", color: "red" })
    );
  };

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    if (!plotDivRef.current || !timeResult.data) return;
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
              ? "Voltage and current"
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
          canExport={exportTraces.length > 0}
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
        {timeResult.isLoading ? (
          // Hold the space silently until the load is slow enough to mention.
          <Center h={500}>
            {showComputeProgress ? (
              <ComputeProgress job={computeJob.data ?? undefined} label="Preparing time/capacity plot" />
            ) : null}
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

const TimeCapacityPlotCard = memo(TimeCapacityPlotCardView);

/** Per-tab draft card with the same thumbnail pipeline as saved plots. */
function TabDraftPlotCard({
  analysisId,
  tab,
  baseSpec,
  draft,
  liveUnsaved,
  allowPreviewGeneration,
  onOpen,
}: {
  analysisId: number;
  tab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  draft: AnalysisDraftPlot | null;
  liveUnsaved: boolean;
  allowPreviewGeneration: boolean;
  onOpen: () => void;
}) {
  const previewSource = useMemo(() => {
    if (liveUnsaved) {
      return draftPlotFromWorkspace(baseSpec, tab, draft?.name ?? null, draft?.updated_at ?? "1970-01-01T00:00:00.000Z");
    }
    return draft;
  }, [baseSpec, draft, liveUnsaved, tab]);

  const [stableDraft, setStableDraft] = useState(previewSource);
  useEffect(() => {
    if (!liveUnsaved) {
      setStableDraft(previewSource);
      return;
    }
    const timer = window.setTimeout(() => setStableDraft(previewSource), 700);
    return () => window.clearTimeout(timer);
  }, [liveUnsaved, previewSource]);

  const previewPlot = useMemo(
    () => (stableDraft ? draftAsSavedPlot(stableDraft) : null),
    [stableDraft],
  );

  const preview =
    previewPlot == null ? null : tab === "time_capacity" ? (
      <SavedTimeCapacityPreview
        analysisId={analysisId}
        baseSpec={baseSpec}
        plot={previewPlot}
        allowGeneration={allowPreviewGeneration}
      />
    ) : tab === "cycles" ||
      tab === "recap" ||
      tab === "dcir" ||
      tab === "steps" ||
      tab === "crate" ||
      tab === "chargeability" ? (
      <SavedPlotPreview
        analysisId={analysisId}
        baseSpec={baseSpec}
        plot={previewPlot}
        allowGeneration={allowPreviewGeneration}
      />
    ) : (
      <Center h={130}>
        <Text size="xs" c="dimmed">
          Draft preview
        </Text>
      </Center>
    );

  return (
    <DraftPlotCard
      draft={draft}
      liveUnsaved={liveUnsaved}
      activeTab={tab}
      preview={preview}
      onOpen={onOpen}
    />
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
  onOpen,
  onDelete,
  allowPreviewGeneration,
  hasSamples,
  canSaveNew,
}: {
  analysisId: number;
  activeTab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  plots: SavedAnalysisPlot[];
  activeSavedPlotId: string | null;
  activePlotDirty: boolean;
  onSaveNew: () => void;
  onOpen: (plot: SavedAnalysisPlot) => void;
  onDelete: (plotId: string) => void;
  allowPreviewGeneration: boolean;
  hasSamples: boolean;
  canSaveNew: boolean;
}) {
  const visiblePlots = plots.filter((plot) => plot.tab === activeTab);
  const visiblePlotKey = visiblePlots.map((plot) => plot.id).join("|");
  const [generationPlotIds, setGenerationPlotIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let idleCallback: number | null = null;
    const ids = visiblePlotKey ? visiblePlotKey.split("|") : [];
    const prioritized = activeSavedPlotId && ids.includes(activeSavedPlotId)
      ? activeSavedPlotId
      : null;
    setGenerationPlotIds(allowPreviewGeneration && prioritized ? new Set([prioritized]) : new Set());
    if (!allowPreviewGeneration) return;

    const queue = ids.filter((id) => id !== prioritized);
    const schedule = () => {
      if (cancelled || queue.length === 0) return;
      const admitOne = () => {
        if (cancelled) return;
        const nextId = queue.shift();
        if (nextId) setGenerationPlotIds((current) => new Set(current).add(nextId));
        if (queue.length > 0) timer = window.setTimeout(schedule, 250);
      };
      if ("requestIdleCallback" in window) {
        idleCallback = window.requestIdleCallback(admitOne, { timeout: 1500 });
      } else {
        timer = globalThis.setTimeout(admitOne, 250);
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (idleCallback !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback);
      }
    };
  }, [activeSavedPlotId, allowPreviewGeneration, visiblePlotKey]);

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
          <Button
            size="xs"
            leftSection={<IconDeviceFloppy size={14} />}
            disabled={!hasSamples || !canSaveNew}
            onClick={onSaveNew}
          >
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
                    ? "1px solid var(--mantine-primary-color-3)"
                    : "1px solid var(--mantine-color-gray-2)",
                  background: active ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <Group align="stretch" wrap="nowrap">
                  <Box
                    className="cx-plot-thumbnail-frame"
                    w={260}
                    style={{ flexShrink: 0 }}
                  >
                    {plot.tab === "time_capacity" ? (
                      <SavedTimeCapacityPreview
                        analysisId={analysisId}
                        baseSpec={baseSpec}
                        plot={plot}
                        allowGeneration={generationPlotIds.has(plot.id)}
                      />
                    ) : plot.tab === "cycles" ||
                      plot.tab === "recap" ||
                      plot.tab === "dcir" ||
                      plot.tab === "steps" ||
                      plot.tab === "crate" ||
                      plot.tab === "chargeability" ? (
                      <SavedPlotPreview
                        analysisId={analysisId}
                        baseSpec={baseSpec}
                        plot={plot}
                        allowGeneration={generationPlotIds.has(plot.id)}
                      />
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
                      <Badge size="xs" variant="light" color={active ? "var(--mantine-primary-color-6)" : "gray"}>
                        {tabLabel(plot.tab)}
                      </Badge>
                      <Text fw={700} truncate>
                        {plot.name}
                      </Text>
                      {active && activePlotDirty ? (
                        <Badge size="xs" variant="light" color="yellow">
                          Edited
                        </Badge>
                      ) : null}
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
                        modals.openConfirmModal({
                          title: "Delete this saved plot?",
                          children: (
                            <Text size="sm">
                              &quot;{plot.name}&quot; will be removed from this analysis. This cannot be undone.
                            </Text>
                          ),
                          labels: { confirm: "Delete", cancel: "Cancel" },
                          confirmProps: { color: "red" },
                          onConfirm: () => onDelete(plot.id),
                        });
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

function AnalysisPageView({
  analysisIdOverride,
  workspaceVisible = true,
}: {
  analysisIdOverride?: number;
  workspaceVisible?: boolean;
} = {}) {
  const { analysisId } = useParams();
  const aid = analysisIdOverride ?? Number(analysisId);
  const workspaceState = useRef(getAnalysisWorkspaceEditorState(aid)).current;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  const analysis = useQuery({
    queryKey: ["analysis", aid],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${aid}`),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
  const groupsQuery = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
  });
  const cellsQuery = useQuery({
    queryKey: ["cells", "analysis-picker"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
  });
  const treeQuery = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
  });
  const plotPresetQuery = useQuery({
    queryKey: ["plot-style-presets"],
    queryFn: () => get<PlotStylePresetSettings>("/api/settings/plot-style-presets"),
    staleTime: 5 * 60_000,
  });

  const [spec, setSpec] = useState<AnalysisSpec | null>(workspaceState?.spec ?? null);
  const [title, setTitle] = useState(workspaceState?.title ?? "");
  const [dirty, setDirty] = useState(workspaceState?.dirty ?? false);
  const [activeTab, setActiveTab] = useState<AnalysisTabKey>(workspaceState?.activeTab ?? "cycles");
  const [timeCapacityVisited, setTimeCapacityVisited] = useState(
    workspaceState?.timeCapacityVisited ?? workspaceState?.activeTab === "time_capacity",
  );
  const [activeSavedPlotId, setActiveSavedPlotId] = useState<string | null>(
    workspaceState?.activeSavedPlotId ?? null,
  );
  const [activePlotBaselineSignature, setActivePlotBaselineSignature] = useState<string | null>(
    workspaceState?.activePlotBaselineSignature ?? null,
  );
  const [plotWorkspaceTouched, setPlotWorkspaceTouched] = useState(
    workspaceState?.plotWorkspaceTouched ?? false,
  );
  /** False until the user opens a saved plot or clicks New plot. */
  const [plotSessionActive, setPlotSessionActive] = useState(
    Boolean(workspaceState?.activeSavedPlotId || workspaceState?.plotWorkspaceTouched),
  );
  const normalWorkspaceRef = useRef<NormalWorkspaceSnapshot | null>(
    workspaceState?.normalWorkspace ?? null,
  );
  /** Last opened saved plot per family tab — preferred when switching back. */
  const lastPlotIdByTabRef = useRef<Partial<Record<AnalysisTabKey, string>>>(
    workspaceState?.activeSavedPlotId && workspaceState?.activeTab
      ? { [workspaceState.activeTab]: workspaceState.activeSavedPlotId }
      : {},
  );
  const [addOpen, setAddOpen] = useState(false);
  const [portableExportOpen, setPortableExportOpen] = useState(false);
  const [portableExportAction, setPortableExportAction] = useState<"download" | "share">("download");
  const [preparedPortableShare, setPreparedPortableShare] = useState<{
    blob: Blob;
    filename: string;
    title: string;
  } | null>(null);
  const [preparedShareBusy, setPreparedShareBusy] = useState(false);
  const [includePortableOriginals, setIncludePortableOriginals] = useState(false);
  const [portablePlotIds, setPortablePlotIds] = useState<string[]>([]);
  const [portableSourceDecision, setPortableSourceDecision] =
    useState<PortableSourcePreflight | null>(null);
  const [pendingPortableExport, setPendingPortableExport] = useState<{
    action: "download" | "share";
  } | null>(null);
  const [portableProgress, setPortableProgress] = useState<{
    completed: number;
    total: number;
    stage: string;
    phase: "plots" | "packing" | "done";
  } | null>(null);
  const [computeToken, setComputeToken] = useState<string | null>(null);
  const [saveDraft, setSaveDraft] = useState<{
    name: string;
    description: string;
    source: DraftSaveSource;
    afterSave?: "none" | "new_plot" | "switch_tab";
    targetTab?: AnalysisTabKey;
  } | null>(null);
  const [leavePrompt, setLeavePrompt] = useState<{
    proceed: () => void;
    mode: "new" | "update" | "copy";
    name: string;
    description: string;
    stage: "confirm" | "details";
  } | null>(null);
  const [quantityRenamePrompt, setQuantityRenamePrompt] = useState<{
    name: string;
    suggestedName: string;
    afterUpdate?: () => void;
  } | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [rendered, setRendered] = useState<{ result: ComputeResult; spec: AnalysisSpec } | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [initialComputeReady, setInitialComputeReady] = useState(false);
  const [timeCapacityReady, setTimeCapacityReady] = useState(false);
  const [chargeabilityReady, setChargeabilityReady] = useState(false);
  const [rateCapabilityReady, setRateCapabilityReady] = useState(false);
  const portableEstimate = useQuery({
    queryKey: ["portable-analysis-estimate", aid],
    queryFn: () =>
      get<PortableAnalysisEstimate>(`/api/analyses/${aid}/portable-estimate`),
    enabled: portableExportOpen,
    staleTime: 30_000,
  });
  const portableSourcePreflight = useMutation({
    mutationFn: () =>
      post<PortableSourcePreflight>(
        `/api/analyses/${aid}/portable-source-preflight`,
        {}
      ),
  });
  const autosaveSignature = useMemo(
    () => (spec ? JSON.stringify({ title, spec }) : "no-spec"),
    [spec, title]
  );
  const autosaveSignatureRef = useRef(autosaveSignature);
  const protocolSelectionCells = useMemo(
    () =>
      analysis.data && spec
        ? selectedSourceCountCells(analysis.data, spec, cellsQuery.data, groupsQuery.data)
        : [],
    [analysis.data, cellsQuery.data, groupsQuery.data, spec],
  );
  const protocolPolicyForTab = (tab: AnalysisTabKey) =>
    multiSourceAnalysisPolicy(tab, protocolSelectionCells);
  const activeProtocolPolicy = protocolPolicyForTab(activeTab);
  const protocolCellIds = useMemo(() => {
    if (!spec) return [];
    const availableGroups = groupsQuery.data ?? analysis.data?.selection_groups ?? [];
    const groupById = new Map(availableGroups.map((group) => [group.id, group]));
    const ids = new Set<number>();
    for (const entry of spec.selection.entries) {
      if (entry.kind === "cell") ids.add(entry.ref_id);
      else groupById.get(entry.ref_id)?.cell_ids.forEach((cellId) => ids.add(cellId));
    }
    return [...ids].sort((a, b) => a - b);
  }, [analysis.data?.selection_groups, groupsQuery.data, spec]);

  useEffect(() => {
    autosaveSignatureRef.current = autosaveSignature;
  }, [autosaveSignature]);

  useEffect(() => {
    if (activeTab === "time_capacity") setTimeCapacityVisited(true);
  }, [activeTab]);

  // Deep link from the command palette: ?tab=<key> selects the tab and
  // ?plot=<id> restores that saved plot. Applied once the spec has loaded,
  // then stripped from the URL. Declared with the other hooks so it always
  // runs — the component returns early while the analysis is still loading.
  const deepLinkApplied = useRef<string | null>(null);
  useEffect(() => {
    const tabParam = searchParams.get("tab");
    const plotParam = searchParams.get("plot");
    if (!tabParam && !plotParam) {
      deepLinkApplied.current = null;
      return;
    }
    if (!isAnalysisWorkspaceViewActive(aid) || !spec) return;
    const deepLinkKey = `${tabParam ?? ""}:${plotParam ?? ""}`;
    if (deepLinkApplied.current === deepLinkKey) return;
    deepLinkApplied.current = deepLinkKey;
    const plot = plotParam
      ? (spec.saved_plots ?? []).find((candidate) => candidate.id === plotParam)
      : undefined;
    if (plot) {
      openSavedPlot(plot);
    } else if (tabParam && (ANALYSIS_TAB_KEYS as readonly string[]).includes(tabParam)) {
      setActiveTab(tabParam as AnalysisTabKey);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    next.delete("plot");
    setSearchParams(next, { replace: true });
    // openSavedPlot is declared below and stable for this one-shot deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aid, spec, searchParams, setSearchParams]);

  useEffect(() => {
    if (analysis.data && spec === null) {
      const loadedSpec = normalizeSpec(analysis.data.spec);
      const opened = resolveColdOpenWorkspace({
        spec: loadedSpec,
        tab: activeTab,
        viewSignature: snapshotSignature,
      });
      const nextSpec = opened.spec;
      setSpec(nextSpec);
      setTitle(analysis.data.title);
      setActiveSavedPlotId(opened.activeSavedPlotId);
      setActivePlotBaselineSignature(
        opened.activeSavedPlotId ? snapshotSignature(nextSpec) : null,
      );
      setPlotWorkspaceTouched(false);
      setPlotSessionActive(opened.plotSessionActive);
      setDirty(opened.changed);
      if (opened.activeSavedPlotId) {
        lastPlotIdByTabRef.current[activeTab] = opened.activeSavedPlotId;
      }
      if (!normalWorkspaceRef.current) {
        normalWorkspaceRef.current = captureNormalWorkspace(nextSpec, activeTab);
      }
    }
  }, [activeTab, analysis.data, spec]);

  // Explode/ungroup deletes the group and strips it server-side; keep-mounted
  // editors still hold the old selection until we drop those dead entries.
  useEffect(() => {
    if (!spec || !groupsQuery.isSuccess) return;
    const liveGroupIds = new Set(groupsQuery.data.map((group) => group.id));
    const deadGroupIds = new Set(
      (spec.selection.entries ?? [])
        .filter(
          (entry) =>
            entry.kind === "replicate_group" && !liveGroupIds.has(entry.ref_id),
        )
        .map((entry) => entry.ref_id),
    );
    if (deadGroupIds.size === 0) return;

    const serverSpec = analysis.data ? normalizeSpec(analysis.data.spec) : null;
    const serverAlreadyClean =
      serverSpec != null &&
      !(serverSpec.selection.entries ?? []).some(
        (entry) =>
          entry.kind === "replicate_group" && deadGroupIds.has(entry.ref_id),
      );

    setSpec((current) => {
      if (!current) return current;
      if (serverAlreadyClean && serverSpec) {
        const next = clone(current);
        next.selection = clone(serverSpec.selection);
        next.saved_plots = clone(serverSpec.saved_plots ?? []);
        return next;
      }
      const next = clone(current);
      next.selection.entries = (next.selection.entries ?? []).filter(
        (entry) =>
          !(entry.kind === "replicate_group" && deadGroupIds.has(entry.ref_id)),
      );
      next.selection.exclusions = (next.selection.exclusions ?? []).filter(
        (exclusion) =>
          !(
            exclusion.entry_kind === "replicate_group" &&
            exclusion.entry_ref_id != null &&
            deadGroupIds.has(exclusion.entry_ref_id)
          ),
      );
      next.selection.hidden_replicate_group_ids = (
        next.selection.hidden_replicate_group_ids ?? []
      ).filter((groupId) => !deadGroupIds.has(groupId));
      next.saved_plots = (next.saved_plots ?? []).map((plot) => ({
        ...plot,
        selection: {
          ...plot.selection,
          exclusions: (plot.selection?.exclusions ?? []).filter(
            (exclusion) =>
              !(
                exclusion.entry_kind === "replicate_group" &&
                exclusion.entry_ref_id != null &&
                deadGroupIds.has(exclusion.entry_ref_id)
              ),
          ),
          hidden_replicate_group_ids: (
            plot.selection?.hidden_replicate_group_ids ?? []
          ).filter((groupId) => !deadGroupIds.has(groupId)),
        },
      }));
      return next;
    });
    setDirty(!serverAlreadyClean);
    if (serverAlreadyClean) setAutosaveStatus("saved");
  }, [analysis.data, groupsQuery.data, groupsQuery.isSuccess, spec]);

  useEffect(() => {
    if (!spec || initialComputeReady) return;
    // Paint the editor shell, then prioritize its live plot. Saved rows may
    // read existing thumbnails immediately, but uncached preview generation
    // is admitted only after the live result is ready.
    const frame = window.requestAnimationFrame(() => setInitialComputeReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [initialComputeReady, spec]);

  const update = useCallback((fn: (s: AnalysisSpec) => void) => {
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
  }, []);

  const compute = useQuery({
    queryKey: ["compute", aid, computeSignature(spec)],
    queryFn: async () => {
      // See the time/capacity card: the job is opened server-side only on a
      // cache miss, so a warm analysis makes exactly one request.
      const token = newComputeToken();
      setComputeToken(token);
      try {
        return await post<ComputeResult>(`/api/analyses/${aid}/compute`, {
          spec,
          job_token: token,
        });
      } finally {
        window.setTimeout(
          () => setComputeToken((current) => (current === token ? null : current)),
          300
        );
      }
    },
    // These tabs each own a dedicated scientific query.
    // Running the cycle engine beside those queries duplicates cache reads,
    // result decoding, and sometimes full computation without feeding the
    // visible plot.
    enabled:
      spec !== null &&
      initialComputeReady &&
      !(
        [
          "time_capacity",
          "steps",
          "dcir",
          "chargeability",
          "crate",
        ] as AnalysisTabKey[]
      ).includes(activeTab),
    staleTime: 5 * 60_000,
  });
  const computeJob = useQuery({
    queryKey: ["background-job-token", computeToken],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${computeToken}`),
    enabled: computeToken !== null,
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 300 : false,
  });
  const cycleLivePlotReady =
    initialComputeReady &&
    !compute.isFetching &&
    (spec?.selection.entries.length === 0 || compute.isSuccess || compute.isError);
  // Declared with the other hooks: the page has early returns below, and this
  // gates the one that renders while the analysis itself is being fetched.
  const showPageLoader = useDelayedFlag(analysis.isLoading || spec === null);

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
    onSuccess: async (a) => {
      await clearAnalysisQueryCache(qc, a.id);
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
    onSuccess: async () => {
      clearAnalysisWorkspaceEditorState(aid);
      navigate("/analyses");
      await clearAnalysisQueryCache(qc, aid);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
      ]);
    },
  });

  const portableExport = useMutation({
    mutationFn: async ({
      action,
      includeOriginalFiles,
    }: {
      action: "download" | "share";
      includeOriginalFiles: boolean;
    }) => {
      if (!spec) throw new Error("The analysis is not ready.");
      if (portablePlotIds.length === 0) throw new Error("Select at least one saved plot.");
      setPortableProgress({
        completed: 0,
        total: portablePlotIds.length,
        stage: "Preparing plots",
        phase: "plots",
      });
      const views = await buildPortablePlotSnapshots(
        aid,
        spec,
        title,
        portablePlotIds,
        (completed, total, stage) =>
          setPortableProgress({ completed, total, stage, phase: "plots" }),
        (plotId, signature) =>
          qc.getQueryData<PlotArtifact>([
            "plot-artifact",
            aid,
            plotId,
            signature,
          ]) ?? null
      );
      setPortableProgress({
        completed: portablePlotIds.length,
        total: portablePlotIds.length,
        stage: includeOriginalFiles ? "Packing report and source files" : "Packing report",
        phase: "packing",
      });
      const blob = await postBlob(`/api/analyses/${aid}/portable-export`, {
        include_original_files: includeOriginalFiles,
        views,
      });
      setPortableProgress({
        completed: portablePlotIds.length,
        total: portablePlotIds.length,
        stage: "Report ready",
        phase: "done",
      });
      const filename = `${sanitizeExportFilename(title) || "CellXplorer analysis"}.html`;
      if (action === "share") {
        setPreparedPortableShare({
          blob,
          filename,
          title: title || "CellXplorer analysis",
        });
        return {
          cancelled: false,
          usedDefaultFolder: false,
          shared: false,
          prepared: true,
        };
      }
      return { ...(await saveDownload(blob, filename)), shared: false };
    },
    onSuccess: (result) => {
      setPortableProgress(null);
      if ("prepared" in result && result.prepared) {
        notifications.show({
          message: "Portable analysis ready. Open the Windows share sheet to continue.",
          color: "teal",
        });
        return;
      }
      if (!result.cancelled) {
        setPortableExportOpen(false);
        setPortableSourceDecision(null);
        setPendingPortableExport(null);
        notifications.show({
          message: result.shared
            ? "Portable analysis shared."
            : "shareFallback" in result && result.shareFallback
              ? "Windows sharing is unavailable, so the portable analysis was saved instead."
              : "Portable analysis exported.",
          color: "teal",
        });
      }
    },
    onError: (
      error: Error,
      variables: { action: "download" | "share"; includeOriginalFiles: boolean }
    ) => {
      setPortableProgress(null);
      if (
        variables.includeOriginalFiles &&
        error instanceof ApiError &&
        error.status === 409
      ) {
        setPendingPortableExport({ action: variables.action });
        void portableSourcePreflight
          .mutateAsync()
          .then(setPortableSourceDecision)
          .catch((preflightError: Error) =>
            notifications.show({ message: preflightError.message, color: "red" })
          );
      }
      notifications.show({ message: error.message, color: "red" });
    },
  });

  const updatePortableSources = useMutation({
    mutationFn: (preflight: PortableSourcePreflight) =>
      post<PortableSourceUpdateResult>(
        `/api/analyses/${aid}/portable-source-update`,
        {
          sources: preflight.sources
            .filter(
              (source) =>
                source.status === "changed" &&
                source.expected_size !== null &&
                source.expected_mtime_ns !== null
            )
            .map((source) => ({
              source_id: source.source_id,
              expected_size: source.expected_size,
              expected_mtime_ns: source.expected_mtime_ns,
            })),
        }
      ),
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const buildPersistPayload = useCallback(() => {
    if (!spec) return null;
    const activePlotForPersist = activeSavedPlotId
      ? (spec.saved_plots ?? []).find((plot) => plot.id === activeSavedPlotId) ?? null
      : null;
    const baselineDirty = Boolean(
      activePlotForPersist &&
        activePlotBaselineSignature &&
        snapshotSignature(spec) !== activePlotBaselineSignature,
    );
    const liveDraftSession = Boolean(
      plotSessionActive && activeSavedPlotId === null && plotWorkspaceTouched,
    );
    if (baselineDirty && activePlotForPersist) {
      return buildStablePersistSpec({
        current: spec,
        mode: "edited_saved",
        savedPlot: activePlotForPersist,
      });
    }
    if (liveDraftSession) {
      return buildStablePersistSpec({
        current: spec,
        mode: "draft_session",
        normal: normalWorkspaceRef.current ?? captureNormalWorkspace(spec, activeTab),
      });
    }
    return buildStablePersistSpec({ current: spec, mode: "stable" });
  }, [
    activePlotBaselineSignature,
    activeSavedPlotId,
    activeTab,
    plotSessionActive,
    plotWorkspaceTouched,
    spec,
  ]);

  useEffect(() => {
    if (!spec || !dirty) return;
    const signatureAtSchedule = autosaveSignature;
    const timer = window.setTimeout(() => {
      const persistSpec = buildPersistPayload();
      if (!persistSpec) return;
      setAutosaveStatus("saving");
      put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: persistSpec })
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
  }, [aid, autosaveSignature, buildPersistPayload, dirty, qc, spec, title]);

  const displayResult = rendered?.result ?? compute.data;
  const portableSavedPlots = spec?.saved_plots ?? [];
  const portablePlotOptions = portableSavedPlots.length
    ? portableSavedPlots
    : [
        {
          id: "current",
          name: title || "Current analysis",
          subtitle: "Current analysis view",
          tab: "cycles" as AnalysisTabKey,
        },
      ];
  const portablePlotPolicy = (plot: (typeof portablePlotOptions)[number]) => {
    if (!analysis.data || !spec) {
      return multiSourceAnalysisPolicy(plot.tab, []);
    }
    const plotSpec = "selection" in plot ? specForSavedPlot(spec, plot) : spec;
    return multiSourceAnalysisPolicy(
      plot.tab,
      selectedSourceCountCells(analysis.data, plotSpec, cellsQuery.data, groupsQuery.data),
    );
  };
  const portablePlotPolicies = portablePlotOptions.map((plot) => ({
    plot,
    policy: portablePlotPolicy(plot),
  }));
  const guardedPortablePlots = portablePlotPolicies.filter(
    ({ policy }) => policy.family && !policy.supported,
  );
  const exportablePortablePlotIds = portablePlotPolicies
    .filter(({ policy }) => !policy.family || policy.supported)
    .map(({ plot }) => plot.id);
  const openPortableExport = (action: "download" | "share" = "download") => {
    if (activeProtocolPolicy.pending) {
      notifications.show({
        message: "Checking source compatibility. Portable export will be available when the selection is resolved.",
        color: "blue",
      });
      return;
    }
    setPortableExportAction(action);
    setPreparedPortableShare(null);
    setPreparedShareBusy(false);
    setPortableSourceDecision(null);
    setPendingPortableExport(null);
    setPortablePlotIds(exportablePortablePlotIds);
    setPortableExportOpen(true);
  };
  useEffect(() => {
    setPreparedPortableShare(null);
  }, [aid, includePortableOriginals, portablePlotIds.join("|"), title]);

  const sharePreparedPortable = () => {
    const prepared = preparedPortableShare;
    if (!prepared || preparedShareBusy) return;

    // Calling shareDownload directly in this click handler is intentional:
    // Windows WebView requires navigator.share() to retain this user gesture.
    const shareRequest = shareDownload(
      prepared.blob,
      prepared.filename,
      prepared.title,
      "CellXplorer portable battery analysis",
    );
    setPreparedShareBusy(true);
    void shareRequest
      .then(async (result) => {
        if (result === "cancelled") return;
        if (result === "unsupported") {
          const saved = await saveDownload(prepared.blob, prepared.filename);
          if (saved.cancelled) return;
          notifications.show({
            message: "Windows sharing is unavailable, so the portable analysis was saved instead.",
            color: "teal",
          });
        } else {
          notifications.show({ message: "Portable analysis shared.", color: "teal" });
        }
        setPortableExportOpen(false);
        setPreparedPortableShare(null);
      })
      .catch((error: Error) =>
        notifications.show({ message: error.message, color: "red" })
      )
      .finally(() => setPreparedShareBusy(false));
  };
  const beginPortableExport = async (action: "download" | "share") => {
    if (!spec || portablePlotIds.length === 0) return;
    const blockedSelected = portablePlotPolicies.filter(
      ({ plot, policy }) => portablePlotIds.includes(plot.id) && policy.family && !policy.supported,
    );
    if (blockedSelected.length > 0) {
      setPortablePlotIds((current) =>
        current.filter((id) => !blockedSelected.some(({ plot }) => plot.id === id)),
      );
      notifications.show({
        message: "The selected portable plots are not source-compatible yet. Choose only the enabled plots.",
        color: "yellow",
      });
      return;
    }
    try {
      const persistSpec = buildPersistPayload();
      if (!persistSpec) return;
      await put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: persistSpec });
      if (!includePortableOriginals) {
        setPortableSourceDecision(null);
        setPendingPortableExport(null);
        portableExport.mutate({ action, includeOriginalFiles: false });
        return;
      }
      setPendingPortableExport({ action });
      const preflight = await portableSourcePreflight.mutateAsync();
      if (!preflight.ready) {
        setPortableSourceDecision(preflight);
        return;
      }
      setPortableSourceDecision(null);
      setPendingPortableExport(null);
      portableExport.mutate({ action, includeOriginalFiles: true });
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not prepare the export.",
        color: "red",
      });
    }
  };
  const continuePortableWithoutSources = () => {
    const pending = pendingPortableExport;
    if (!pending) return;
    setPortableSourceDecision(null);
    setPendingPortableExport(null);
    portableExport.mutate({
      action: pending.action,
      includeOriginalFiles: false,
    });
  };
  const updatePortableSourcesAndContinue = async () => {
    const decision = portableSourceDecision;
    const pending = pendingPortableExport;
    if (!decision || !pending) return;
    try {
      const result = await updatePortableSources.mutateAsync(decision);
      result.errors.forEach((error) =>
        notifications.show({
          message: `${error.filename}: ${error.error}`,
          color: "red",
        })
      );
      const affectedIds = new Set([
        ...decision.affected_analysis_ids,
        ...result.preflight.affected_analysis_ids,
        aid,
      ]);
      for (const analysisId of affectedIds) {
        for (const root of [
          "saved-plot-preview",
          "saved-time-preview",
          "plot-thumbnail",
          "plot-artifact",
        ]) {
          qc.removeQueries({ queryKey: [root, analysisId] });
        }
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cells"] }),
        qc.invalidateQueries({ queryKey: ["cell"] }),
        qc.invalidateQueries({ queryKey: ["cell-cycles"] }),
        qc.invalidateQueries({ queryKey: ["replicate-groups"] }),
        qc.invalidateQueries({ queryKey: ["replicate-preview"] }),
        qc.invalidateQueries({ queryKey: ["files"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["activity"] }),
        invalidateAnalysisQueries(qc, aid),
      ]);
      if (!result.preflight.ready) {
        setPortableSourceDecision(result.preflight);
        return;
      }
      setPortableSourceDecision(null);
      setPendingPortableExport(null);
      notifications.show({
        message: `Updated ${result.updated} source file${result.updated === 1 ? "" : "s"}; rebuilding the selected plots for export.`,
        color: "teal",
      });
      portableExport.mutate({
        action: pending.action,
        includeOriginalFiles: true,
      });
    } catch {
      // The mutation displays the error and keeps the decision available.
    }
  };
  const portableExportBusy =
    portableExport.isPending ||
    portableSourcePreflight.isPending ||
    updatePortableSources.isPending ||
    preparedShareBusy;
  const portableSourceBlockers =
    portableSourceDecision?.sources.filter((source) => source.status !== "current") ?? [];
  const canUpdatePortableSources = Boolean(
    portableSourceDecision &&
      portableSourceDecision.changed > 0 &&
      portableSourceDecision.unavailable === 0 &&
      portableSourceDecision.changing === 0 &&
      portableSourceDecision.error === 0
  );
  const portableEstimatedBytes = portableEstimate.data
    ? portableEstimate.data.runtime_embedded_bytes +
      portableEstimate.data.report_shell_bytes +
      portablePlotIds.length * portableEstimate.data.estimated_per_plot_bytes +
      (includePortableOriginals
        ? Math.ceil((portableEstimate.data.original_bytes * 4) / 3)
        : 0)
    : null;
  const activePlot = spec
    ? (spec.saved_plots ?? []).find((plot) => plot.id === activeSavedPlotId) ?? null
    : null;
  const activePlotDirty = Boolean(
    spec && activePlot && activePlotBaselineSignature && snapshotSignature(spec) !== activePlotBaselineSignature
  );
  const plotTabs = TAB_DEFS.filter((tab) => tab.plotTab).map((tab) => tab.value);
  const isPlotTab = plotTabs.includes(activeTab);
  // A New-plot session is a draft whenever no saved plot is open — even if the
  // default settings happen to signature-match an existing saved plot.
  const isLiveDraft = Boolean(
    spec &&
      isPlotTab &&
      plotSessionActive &&
      activeSavedPlotId === null &&
      plotWorkspaceTouched &&
      spec.selection.entries.length > 0,
  );
  const hasUnsavedPlot = Boolean(isLiveDraft || activePlotDirty);

  const openColdTabWorkspace = useCallback(
    (tab: AnalysisTabKey, sourceSpec: AnalysisSpec) => {
      const opened = resolveColdOpenWorkspace({
        spec: sourceSpec,
        tab,
        viewSignature: snapshotSignature,
        preferredPlotId: lastPlotIdByTabRef.current[tab] ?? null,
      });
      setActiveTab(tab);
      setActiveSavedPlotId(opened.activeSavedPlotId);
      setPlotSessionActive(opened.plotSessionActive);
      setPlotWorkspaceTouched(false);
      setSpec(opened.spec);
      if (opened.activeSavedPlotId) {
        lastPlotIdByTabRef.current[tab] = opened.activeSavedPlotId;
        setActivePlotBaselineSignature(snapshotSignature(opened.spec));
        normalWorkspaceRef.current = captureNormalWorkspace(opened.spec, tab);
      } else {
        setActivePlotBaselineSignature(null);
      }
      if (opened.changed) setDirty(true);
    },
    [],
  );

  const applyTabWorkspace = useCallback(
    (tab: AnalysisTabKey) => {
      if (!spec) {
        setActiveTab(tab);
        return;
      }
      const currentPlot =
        (spec.saved_plots ?? []).find((plot) => plot.id === activeSavedPlotId) ?? null;
      if (currentPlot?.tab === tab) {
        setActiveTab(tab);
        setPlotSessionActive(true);
        return;
      }
      // Stay on an in-progress draft for this tab.
      if (
        activeSavedPlotId === null &&
        plotWorkspaceTouched &&
        plotSessionActive &&
        activeTab === tab
      ) {
        setActiveTab(tab);
        return;
      }
      openColdTabWorkspace(tab, spec);
    },
    [
      activeSavedPlotId,
      activeTab,
      openColdTabWorkspace,
      plotSessionActive,
      plotWorkspaceTouched,
      spec,
    ],
  );

  // Family tabs must never show another tab's plot as a fake "Unsaved plot".
  useEffect(() => {
    if (!spec || activeTab === "settings" || isLiveDraft) return;
    const sessionOnTab = plotSessionBelongsToTab({
      tab: activeTab,
      activeTab,
      plotSessionActive,
      activeSavedPlotId,
      activePlotTab: activePlot?.tab ?? null,
      plotWorkspaceTouched,
    });
    if (sessionOnTab) return;
    const hasTabPlots = (spec.saved_plots ?? []).some((plot) => plot.tab === activeTab);
    const sessionElsewhere = Boolean(
      plotSessionActive && activePlot && activePlot.tab !== activeTab,
    );
    const emptyButHasPlots = !plotSessionActive && activeSavedPlotId == null && hasTabPlots;
    if (sessionElsewhere || emptyButHasPlots) {
      applyTabWorkspace(activeTab);
    }
  }, [
    activePlot,
    activeSavedPlotId,
    activeTab,
    applyTabWorkspace,
    isLiveDraft,
    plotSessionActive,
    plotWorkspaceTouched,
    spec,
  ]);

  useEffect(() => {
    setAnalysisWorkspaceEditorState({
      analysisId: aid,
      spec,
      title,
      dirty,
      hasUnsavedPlot,
      activeTab,
      timeCapacityVisited,
      activeSavedPlotId,
      activePlotBaselineSignature,
      plotWorkspaceTouched,
      normalWorkspace: normalWorkspaceRef.current,
    });
  }, [
    activePlotBaselineSignature,
    activeSavedPlotId,
    activeTab,
    aid,
    dirty,
    hasUnsavedPlot,
    plotWorkspaceTouched,
    spec,
    timeCapacityVisited,
    title,
  ]);

  useEffect(() => {
    if (!hasUnsavedPlot || !spec) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedPlot, spec]);

  const persistWorkspaceAndProceed = (
    proceed: () => void,
    options?: { wait?: boolean },
  ) => {
    if (!spec) {
      proceed();
      return;
    }
    const wait = options?.wait ?? true;
    const persistSpec = buildPersistPayload() ?? stripDraftPlots(spec);
    const payload = { title, spec: persistSpec };
    setDirty(false);
    setAutosaveStatus("saving");
    if (wait) setLeaveSaving(true);
    else proceed();
    put<AnalysisFull>(`/api/analyses/${aid}`, payload)
      .then((saved) => {
        setAutosaveStatus("saved");
        qc.setQueryData(["analysis", aid], saved);
        qc.invalidateQueries({ queryKey: ["analyses"] });
        if (wait) {
          setLeaveSaving(false);
          proceed();
        }
      })
      .catch((error: Error) => {
        if (wait) setLeaveSaving(false);
        setDirty(true);
        setAutosaveStatus("error");
        notifications.show({ message: error.message, color: "red" });
      });
  };

  useEffect(() => {
    const onLeaveRequest = (event: Event) => {
      if (!isAnalysisWorkspaceViewActive(aid)) return;
      const request = event as CustomEvent<AnalysisLeaveRequestDetail>;
      if (!spec || leaveSaving) return;
      const reason = request.detail.reason ?? "navigate";

      // Keep-mounted navigate: keep the in-memory draft/edits; only flush stable
      // analysis state (membership, etc.) in the background.
      if (reason === "navigate") {
        if (dirty) {
          event.preventDefault();
          persistWorkspaceAndProceed(request.detail.proceed, { wait: false });
        }
        return;
      }

      // Tab close: drafts and dirty saved plots must be saved or discarded.
      if (activePlotDirty && activePlot) {
        event.preventDefault();
        setLeavePrompt({
          proceed: request.detail.proceed,
          mode: "update",
          name: activePlot.name,
          description: activePlot.description ?? "",
          stage: "confirm",
        });
        return;
      }
      if (hasUnsavedPlot && !activePlotDirty) {
        event.preventDefault();
        setLeavePrompt({
          proceed: request.detail.proceed,
          mode: "new",
          name: suggestedPlotName(activeTab, displayResult, spec),
          description: "",
          stage: "confirm",
        });
        return;
      }
      if (dirty) {
        event.preventDefault();
        persistWorkspaceAndProceed(request.detail.proceed);
      }
    };
    window.addEventListener(ANALYSIS_LEAVE_EVENT, onLeaveRequest);
    return () => window.removeEventListener(ANALYSIS_LEAVE_EVENT, onLeaveRequest);
  }, [
    activePlot,
    activePlotDirty,
    activeTab,
    aid,
    dirty,
    displayResult,
    hasUnsavedPlot,
    leaveSaving,
    qc,
    spec,
    timeCapacityVisited,
    title,
  ]);

  const liveUnsavedDraft = isLiveDraft;

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
    // Opening an analysis is usually instant; hold the height silently rather
    // than flashing a spinner on the way in.
    return <Center h={300}>{showPageLoader ? <Loader /> : null}</Center>;
  }

  const currentAnalysis = analysis.data!;
  const sampleGroups = groupsQuery.data ?? currentAnalysis.selection_groups;
  const displaySubtitle = plotSubtitle(activeTab, displayResult, spec);
  const displayPlotName =
    activePlot && activePlot.tab === activeTab ? activePlot.name : "Unsaved plot";
  const folderOptions = flattenFolders(treeQuery.data);
  const plotUpdating = Boolean(compute.isFetching && rendered && activeTab === "cycles");

  const toggleCellVisibility = (cellId: number, context: VisibilityContext) => {
    const groups = sampleGroups;
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

  /** Pull samples in from another analysis, skipping anything already here. */
  const importAnalysisEntries = (
    entries: { kind: "cell" | "replicate_group"; ref_id: number }[]
  ) => {
    let added = 0;
    update((s) => {
      for (const entry of entries) {
        const present = s.selection.entries.some(
          (existing) => existing.kind === entry.kind && existing.ref_id === entry.ref_id
        );
        if (present) continue;
        s.selection.entries.push({ kind: entry.kind, ref_id: entry.ref_id });
        added += 1;
      }
    });
    notifications.show({
      message:
        added === 0
          ? "Those samples are already in this analysis."
          : `Added ${added} sample${added === 1 ? "" : "s"}.`,
      color: added === 0 ? "gray" : "teal",
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

  const saveProtocolSegment = (segment: ProtocolSegment) => {
    update((s) => {
      const segments = s.protocol_segments ?? [];
      const index = segments.findIndex((item) => item.id === segment.id);
      if (index >= 0) segments[index] = segment;
      else segments.push(segment);
      s.protocol_segments = segments;
    });
  };

  const toggleProtocolSegmentHidden = (segmentId: string) => {
    update((s) => {
      const hidden = s.presentation.hidden_protocol_segment_ids ?? [];
      s.presentation.hidden_protocol_segment_ids = hidden.includes(segmentId)
        ? hidden.filter((id) => id !== segmentId)
        : [...hidden, segmentId];
    });
  };

  // Display-only segment visibility for the series-based tabs (steps / DCIR):
  // hides every series that plots the segment, across cells, without recompute.
  const toggleAnalysisSegmentHidden = (segmentId: string) => {
    update((s) => {
      const hidden = s.presentation.hidden_analysis_segment_ids ?? [];
      s.presentation.hidden_analysis_segment_ids = hidden.includes(segmentId)
        ? hidden.filter((id) => id !== segmentId)
        : [...hidden, segmentId];
    });
  };

  const toggleProtocolSegmentExcluded = (segmentId: string) => {
    update((s) => {
      const filter = s.computation.protocol_filter ?? {
        excluded_segment_ids: [],
        only_segment_ids: [],
      };
      const excluded = filter.excluded_segment_ids.includes(segmentId);
      s.computation.protocol_filter = {
        excluded_segment_ids: excluded
          ? filter.excluded_segment_ids.filter((id) => id !== segmentId)
          : [...filter.excluded_segment_ids, segmentId],
        only_segment_ids: excluded
          ? filter.only_segment_ids
          : filter.only_segment_ids.filter((id) => id !== segmentId),
      };
    });
  };

  const useOnlyProtocolSegment = (segmentId: string | null) => {
    update((s) => {
      const filter = s.computation.protocol_filter ?? {
        excluded_segment_ids: [],
        only_segment_ids: [],
      };
      s.computation.protocol_filter = {
        excluded_segment_ids: segmentId
          ? filter.excluded_segment_ids.filter((id) => id !== segmentId)
          : filter.excluded_segment_ids,
        only_segment_ids: segmentId ? [segmentId] : [],
      };
      if (segmentId) {
        s.presentation.hidden_protocol_segment_ids = (
          s.presentation.hidden_protocol_segment_ids ?? []
        ).filter((id) => id !== segmentId);
      }
    });
  };

  const deleteProtocolSegment = (segmentId: string) => {
    update((s) => {
      const without = (values: string[] | undefined) => (values ?? []).filter((id) => id !== segmentId);
      s.protocol_segments = (s.protocol_segments ?? []).filter((segment) => segment.id !== segmentId);
      s.computation.protocol_filter = {
        excluded_segment_ids: without(s.computation.protocol_filter?.excluded_segment_ids),
        only_segment_ids: without(s.computation.protocol_filter?.only_segment_ids),
      };
      s.presentation.hidden_protocol_segment_ids = without(s.presentation.hidden_protocol_segment_ids);
      s.saved_plots = (s.saved_plots ?? []).map((plot) => ({
        ...plot,
        computation: {
          ...plot.computation,
          protocol_filter: {
            excluded_segment_ids: without(plot.computation.protocol_filter?.excluded_segment_ids),
            only_segment_ids: without(plot.computation.protocol_filter?.only_segment_ids),
          },
        },
        presentation: {
          ...plot.presentation,
          hidden_protocol_segment_ids: without(plot.presentation.hidden_protocol_segment_ids),
        },
      }));
    });
  };

  const applyUpdateActivePlot = (name: string) => {
    if (!activePlot || !spec) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const trimmed = name.trim() || activePlot.name;
    setActivePlotBaselineSignature(snapshotSignature(spec));
    normalWorkspaceRef.current = captureNormalWorkspace(spec, activeTab);
    update((s) => {
      s.saved_plots = (s.saved_plots ?? []).map((plot) =>
        plot.id === activePlot.id
          ? savedPlotFromSpec(s, activeTab, trimmed, subtitle, plot.description, plot)
          : plot
      );
    });
    setPlotWorkspaceTouched(false);
  };

  const updateActivePlot = (options?: { afterUpdate?: () => void }) => {
    if (!activePlot || !spec) return;
    const quantityChanged =
      plotNamingQuantityKey(activeTab, activePlot.presentation) !==
      plotNamingQuantityKey(activeTab, spec.presentation);
    if (quantityChanged) {
      setQuantityRenamePrompt({
        name: activePlot.name,
        suggestedName: suggestedPlotName(activeTab, displayResult, spec),
        afterUpdate: options?.afterUpdate,
      });
      return;
    }
    applyUpdateActivePlot(activePlot.name);
    options?.afterUpdate?.();
  };

  const confirmQuantityRenameUpdate = () => {
    if (!quantityRenamePrompt) return;
    const { name, afterUpdate } = quantityRenamePrompt;
    setQuantityRenamePrompt(null);
    applyUpdateActivePlot(name);
    afterUpdate?.();
  };

  const openSavedPlotDirect = (plot: SavedAnalysisPlot) => {
    const restoredForBaseline = specForSavedPlot(spec, plot);
    setActiveSavedPlotId(plot.id);
    setActivePlotBaselineSignature(snapshotSignature(restoredForBaseline));
    normalWorkspaceRef.current = captureNormalWorkspace(restoredForBaseline, plot.tab);
    lastPlotIdByTabRef.current[plot.tab] = plot.id;
    update((s) => {
      const restored = specForSavedPlot(s, plot);
      s.selection = restored.selection;
      s.computation = restored.computation;
      s.aggregation = restored.aggregation;
      s.presentation = restored.presentation;
    });
    setPlotWorkspaceTouched(false);
    setPlotSessionActive(true);
    setActiveTab(plot.tab);
  };

  const activateAnalysisTab = (next: AnalysisTabKey) => {
    if (next === activeTab) return;
    if (next === "settings") {
      setActiveTab(next);
      return;
    }
    const leavingDraft = Boolean(isLiveDraft && activeTab !== next);
    const leavingDirtySaved = Boolean(
      activePlotDirty && activePlot && activePlot.tab === activeTab && next !== activeTab,
    );
    if (!leavingDraft && !leavingDirtySaved) {
      applyTabWorkspace(next);
      return;
    }
    modals.open({
      title: leavingDraft ? "Discard the current draft?" : "Discard unsaved edits?",
      children: (
        <Stack gap="md">
          <Text size="sm">
            {leavingDraft
              ? "Switching tabs will discard this unsaved draft."
              : "Switching tabs will discard edits that were not written back."}
          </Text>
          <Group justify="flex-end" wrap="nowrap" gap="xs">
            <Button variant="default" onClick={() => modals.closeAll()}>
              Cancel
            </Button>
            {leavingDraft ? (
              <Button
                variant="light"
                onClick={() => {
                  modals.closeAll();
                  setSaveDraft({
                    name: suggestedPlotName(activeTab, displayResult, spec),
                    description: "",
                    source: "live",
                    afterSave: "switch_tab",
                    targetTab: next,
                  });
                }}
              >
                Save as new plot
              </Button>
            ) : (
              <Button
                variant="light"
                onClick={() => {
                  modals.closeAll();
                  updateActivePlot({ afterUpdate: () => applyTabWorkspace(next) });
                }}
              >
                Save changes
              </Button>
            )}
            <Button
              color="red"
              onClick={() => {
                modals.closeAll();
                applyTabWorkspace(next);
              }}
            >
              Discard and switch
            </Button>
          </Group>
        </Stack>
      ),
    });
  };

  const openSavedPlot = (plot: SavedAnalysisPlot) => {
    const switchingAwayFromDraft = Boolean(
      hasUnsavedPlot && activeSavedPlotId === null && plotSessionActive,
    );
    const switchingAwayFromDirtySaved = Boolean(
      activePlotDirty && activeSavedPlotId && activeSavedPlotId !== plot.id,
    );
    if (!switchingAwayFromDraft && !switchingAwayFromDirtySaved) {
      openSavedPlotDirect(plot);
      return;
    }
    modals.open({
      title: switchingAwayFromDraft ? "Discard the current draft?" : "Discard unsaved edits?",
      children: (
        <Stack gap="md">
          <Text size="sm">
            {switchingAwayFromDraft
              ? "Opening another plot will discard this unsaved draft."
              : "Opening another plot will discard edits that were not written back."}
          </Text>
          <Group justify="flex-end" wrap="nowrap" gap="xs">
            <Button variant="default" onClick={() => modals.closeAll()}>
              Cancel
            </Button>
            {switchingAwayFromDraft ? (
              <Button
                variant="light"
                onClick={() => {
                  modals.closeAll();
                  setSaveDraft({
                    name: suggestedPlotName(activeTab, displayResult, spec),
                    description: "",
                    source: "live",
                    afterSave: "none",
                  });
                }}
              >
                Save as new plot
              </Button>
            ) : (
              <Button
                variant="light"
                onClick={() => {
                  modals.closeAll();
                  updateActivePlot({ afterUpdate: () => openSavedPlotDirect(plot) });
                }}
              >
                Save changes
              </Button>
            )}
            <Button
              color="red"
              onClick={() => {
                modals.closeAll();
                openSavedPlotDirect(plot);
              }}
            >
              Discard and open
            </Button>
          </Group>
        </Stack>
      ),
    });
  };

  const commitSavedPlot = () => {
    if (!saveDraft || !spec) return;
    const afterSave = saveDraft.afterSave ?? "none";
    const targetTab = saveDraft.targetTab;
    const source = saveDraft.source;
    const draftName = saveDraft.name;
    const draftDescription = saveDraft.description;
    const now = new Date().toISOString();
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const plot =
      source === "draft"
        ? savedPlotFromDraftSource({
            draft: draftPlotFromWorkspace(spec, activeTab, draftName, now),
            name: draftName,
            subtitle: "",
            description: draftDescription,
            id: uid(),
            modifiedAt: now,
          })
        : savedPlotFromSpec(spec, activeTab, draftName, subtitle, draftDescription);
    setSaveDraft(null);
    const next = buildCommitSavedPlotSpec({
      current: spec,
      plot,
      source,
      afterSave: "none",
    });
    const restored = specForSavedPlot(next, plot);
    next.selection = restored.selection;
    next.computation = restored.computation;
    next.aggregation = restored.aggregation;
    next.presentation = restored.presentation;
    setDirty(true);
    if (afterSave === "switch_tab" && targetTab) {
      openColdTabWorkspace(targetTab, next);
      return;
    }
    setSpec(next);
    setActiveSavedPlotId(plot.id);
    setActiveTab(plot.tab);
    setActivePlotBaselineSignature(snapshotSignature(next));
    normalWorkspaceRef.current = captureNormalWorkspace(next, plot.tab);
    setPlotWorkspaceTouched(false);
    setPlotSessionActive(true);
    if (afterSave === "new_plot") {
      queueMicrotask(() => startNewPlotReset());
    }
  };

  const startNewPlotReset = () => {
    if (spec && !(hasUnsavedPlot && activeSavedPlotId === null)) {
      normalWorkspaceRef.current = captureNormalWorkspace(spec, activeTab);
    }
    const family =
      activeTab === "time_capacity"
        ? "time_capacity"
        : activeTab === "cycles"
          ? "cycles"
          : "all";
    const defaults = plotPresetQuery.data?.presets ?? [];
    const preset =
      defaults.find(
        (item) => item.is_default && item.plot_family === family,
      ) ??
      defaults.find(
        (item) => item.is_default && item.plot_family === "all",
      );
    const initialStyle = preset
      ? normalizePlotStyle(preset.style)
      : normalizePlotStyle(DEFAULT_PLOT_STYLE);
    update((s) => {
      const entries = clone(s.selection.entries);
      const savedPlots = clone(s.saved_plots ?? []);
      const existingStyles = { ...(s.presentation.plot_styles ?? {}) };
      s.selection = {
        entries,
        exclusions: [],
        hidden_replicate_group_ids: [],
      };
      s.computation = clone(DEFAULT_COMPUTATION);
      s.aggregation = clone(DEFAULT_AGGREGATION);
      s.presentation = {
        ...clone(DEFAULT_PRESENTATION),
        plot_style: initialStyle,
        plot_styles: {
          ...existingStyles,
          [activeTab]: initialStyle,
        },
      };
      s.saved_plots = savedPlots;
      s.draft_plots = null;
      s.draft_plot = null;
    });
    setActiveSavedPlotId(null);
    setActivePlotBaselineSignature(null);
    setPlotWorkspaceTouched(true);
    setPlotSessionActive(true);
  };

  const startNewPlot = () => {
    if (!spec || spec.selection.entries.length === 0) return;
    const hasDraft = Boolean(hasUnsavedPlot && activeSavedPlotId === null);
    if (hasDraft) {
      modals.open({
        title: "Discard the current draft?",
        children: (
          <Stack gap="md">
            <Text size="sm">
              Starting a new plot will discard the current unsaved draft.
            </Text>
            <Group justify="flex-end" wrap="nowrap" gap="xs">
              <Button variant="default" onClick={() => modals.closeAll()}>
                Cancel
              </Button>
              <Button
                variant="light"
                onClick={() => {
                  modals.closeAll();
                  setSaveDraft({
                    name: suggestedPlotName(activeTab, displayResult, spec),
                    description: "",
                    source: "live",
                    afterSave: "new_plot",
                  });
                }}
              >
                Save as new plot
              </Button>
              <Button
                color="red"
                onClick={() => {
                  modals.closeAll();
                  startNewPlotReset();
                }}
              >
                Discard and start new
              </Button>
            </Group>
          </Stack>
        ),
      });
      return;
    }
    startNewPlotReset();
  };

  const discardLeaveChanges = () => {
    if (!leavePrompt || !spec) {
      const proceed = leavePrompt?.proceed;
      setLeavePrompt(null);
      proceed?.();
      return;
    }
    const proceed = leavePrompt.proceed;
    const mode = leavePrompt.mode;
    if ((mode === "update" || mode === "copy") && activePlot) {
      const restoredView = specForSavedPlot(spec, activePlot);
      const next = buildDiscardEditedSavedPlotSpec(spec, restoredView);
      setLeaveSaving(true);
      put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: next })
        .then(() => {
          setSpec(next);
          setActivePlotBaselineSignature(snapshotSignature(next));
          normalWorkspaceRef.current = captureNormalWorkspace(next, activePlot.tab);
          setPlotWorkspaceTouched(false);
          setDirty(false);
          setAutosaveStatus("saved");
          qc.invalidateQueries({ queryKey: ["analysis", aid] });
          qc.invalidateQueries({ queryKey: ["analyses"] });
          setLeaveSaving(false);
          setLeavePrompt(null);
          proceed();
        })
        .catch((error: Error) => {
          setLeaveSaving(false);
          notifications.show({ message: error.message, color: "red" });
        });
      return;
    }
    const normal = normalWorkspaceRef.current ?? captureNormalWorkspace(spec, activeTab);
    let next = buildDiscardNewPlotSpec(spec, normal);
    const tabPlots = (next.saved_plots ?? []).filter((plot) => plot.tab === normal.tab);
    const reopen = tabPlots[0] ?? null;
    if (reopen) next = specForSavedPlot(next, reopen);
    setLeaveSaving(true);
    put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: next })
      .then(() => {
        setSpec(next);
        setActiveTab(normal.tab);
        setActiveSavedPlotId(reopen?.id ?? null);
        setActivePlotBaselineSignature(reopen ? snapshotSignature(next) : null);
        setPlotSessionActive(Boolean(reopen));
        normalWorkspaceRef.current = normal;
        setPlotWorkspaceTouched(false);
        setDirty(false);
        setAutosaveStatus("saved");
        qc.invalidateQueries({ queryKey: ["analysis", aid] });
        qc.invalidateQueries({ queryKey: ["analyses"] });
        setLeaveSaving(false);
        setLeavePrompt(null);
        proceed();
      })
      .catch((error: Error) => {
        setLeaveSaving(false);
        notifications.show({ message: error.message, color: "red" });
      });
  };

  const savePlotAndLeave = () => {
    if (!leavePrompt) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const next = stripDraftPlots(clone(spec));
    const mode = leavePrompt.mode;
    const plot =
      mode === "update" && activePlot
        ? savedPlotFromSpec(
            next,
            activeTab,
            activePlot.name,
            subtitle,
            activePlot.description,
            activePlot,
          )
        : savedPlotFromSpec(
            next,
            activeTab,
            leavePrompt.name,
            subtitle,
            leavePrompt.description || null,
          );
    if (mode === "update" && activePlot) {
      next.saved_plots = (next.saved_plots ?? []).map((item) =>
        item.id === activePlot.id ? plot : item,
      );
    } else {
      next.saved_plots = [...(next.saved_plots ?? []), plot];
    }
    setLeaveSaving(true);
    put<AnalysisFull>(`/api/analyses/${aid}`, { title, spec: next })
      .then(() => {
        setSpec(next);
        setDirty(false);
        setAutosaveStatus("saved");
        setActiveSavedPlotId(plot.id);
        setActivePlotBaselineSignature(snapshotSignature(next));
        setPlotWorkspaceTouched(false);
        setPlotSessionActive(true);
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

  const hasSamples = spec.selection.entries.length > 0;
  const activeTabPlotSession = plotSessionBelongsToTab({
    tab: activeTab,
    activeTab,
    plotSessionActive,
    activeSavedPlotId,
    activePlotTab: activePlot?.tab ?? null,
    plotWorkspaceTouched,
  });
  const rateCapabilityRecognitionEnabled = shouldRunLivePlotCompute({
    workspaceVisible,
    plotSessionActive: activeTab === "crate" && activeTabPlotSession,
    hasSamples,
  });

  const sidebar = (
    <Stack w={330} gap="xs" style={{ flexShrink: 0 }}>
      <SamplePanel
        spec={spec}
        groups={sampleGroups}
        cells={currentAnalysis.selection_cells}
        analysisId={aid}
        result={rendered?.result}
        onAdd={() => setAddOpen(true)}
        onRemoveEntry={removeAnalysisEntry}
        onToggleCell={toggleCellVisibility}
        onToggleReplicate={toggleReplicateVisibility}
        onImportEntries={importAnalysisEntries}
      />
      {(["cycles", "steps", "recap", "time_capacity"] as AnalysisTabKey[]).includes(activeTab) &&
        (activeTab !== "steps" || activeProtocolPolicy.supported) && (
        <ProtocolSegmentsPanel
          cellIds={protocolCellIds}
          segments={spec.protocol_segments ?? []}
          // On the steps tab, hiding a segment hides the series that plot it —
          // a display-only filter (hidden_analysis_segment_ids). On the cycle /
          // time-capacity tabs it masks those steps in the computed data
          // (hidden_protocol_segment_ids), which is a different, cached effect.
          hiddenSegmentIds={
            activeTab === "steps"
              ? spec.presentation.hidden_analysis_segment_ids ?? []
              : spec.presentation.hidden_protocol_segment_ids ?? []
          }
          excludedSegmentIds={spec.computation.protocol_filter?.excluded_segment_ids ?? []}
          onlySegmentIds={spec.computation.protocol_filter?.only_segment_ids ?? []}
          onSaveSegment={saveProtocolSegment}
          onDeleteSegment={deleteProtocolSegment}
          onToggleHidden={
            activeTab === "steps"
              ? toggleAnalysisSegmentHidden
              : toggleProtocolSegmentHidden
          }
          onToggleExcluded={toggleProtocolSegmentExcluded}
          onUseOnly={useOnlyProtocolSegment}
        />
      )}
      {activeTab === "time_capacity" && <TimeCapacitySettings spec={spec} update={update} />}
      {activeTab === "cycles" && <CycleSettings spec={spec} result={displayResult} update={update} />}
      {activeTab === "steps" && activeProtocolPolicy.supported && (
        <StepsSettings
          analysisId={aid}
          spec={spec}
          cells={currentAnalysis.selection_cells}
          update={update}
        />
      )}
      {activeTab === "dcir" && activeProtocolPolicy.supported && (
        <DcirSettings
          analysisId={aid}
          spec={spec}
          cells={currentAnalysis.selection_cells}
          update={update}
        />
      )}
      {activeTab === "chargeability" && activeProtocolPolicy.supported && (
        <ChargeabilitySettings
          analysisId={aid}
          spec={spec}
          update={update}
        />
      )}
      {activeTab === "crate" && activeProtocolPolicy.supported && (
        <RateCapabilitySettings
          analysisId={aid}
          spec={spec}
          update={update}
          recognitionEnabled={rateCapabilityRecognitionEnabled}
        />
      )}
    </Stack>
  );

  const draftPlotSession = Boolean(isLiveDraft && activeTabPlotSession);
  const newPlotHeaderProps = {
    onNewPlot: startNewPlot,
    newPlotEnabled: hasSamples && activeProtocolPolicy.supported,
    onUpdatePlot: draftPlotSession
      ? () =>
          setSaveDraft({
            name: suggestedPlotName(activeTab, displayResult, spec),
            description: "",
            source: "live",
          })
      : updateActivePlot,
    updatePlotEnabled: activeProtocolPolicy.supported && (draftPlotSession
      ? true
      : Boolean(activeSavedPlotId && activePlotDirty && activePlot?.tab === activeTab)),
    updatePlotLabel: draftPlotSession ? "Save as" : "Update",
  };

  const plotSurfaceFor = (tab: AnalysisTabKey, card: ReactNode) => {
    const policy = protocolPolicyForTab(tab);
    if (policy.family && !policy.supported) {
      return <ProtocolMappingRequiredState policy={policy} />;
    }
    const sessionOnTab = plotSessionBelongsToTab({
      tab,
      activeTab,
      plotSessionActive,
      activeSavedPlotId,
      activePlotTab: activePlot?.tab ?? null,
      plotWorkspaceTouched,
    });
    return (
      <>
        {sessionOnTab ? (
          card
        ) : (
          <PlotWorkspaceEmpty hasSamples={hasSamples} onNewPlot={startNewPlot} />
        )}
      </>
    );
  };

  const savedPlotsPanelFor = (tab: AnalysisTabKey) => {
    const policy = protocolPolicyForTab(tab);
    if (policy.family && !policy.supported) {
      return <ProtocolMappingRequiredState policy={policy} compact />;
    }
    return (
    <>
      <TabDraftPlotCard
        analysisId={aid}
        tab={tab}
        baseSpec={spec}
        draft={null}
        liveUnsaved={liveUnsavedDraft && tab === activeTab}
        allowPreviewGeneration={
          tab === "time_capacity"
            ? timeCapacityReady
            : tab === "chargeability"
              ? chargeabilityReady
              : tab === "crate"
                ? rateCapabilityReady
                : true
        }
        onOpen={() => {
          setActiveSavedPlotId(null);
          setActivePlotBaselineSignature(null);
          setPlotWorkspaceTouched(true);
          setPlotSessionActive(true);
          setActiveTab(tab);
        }}
      />
      <SavedPlotsPanel
      analysisId={aid}
      activeTab={tab}
      baseSpec={spec}
      plots={spec.saved_plots ?? []}
      activeSavedPlotId={activeSavedPlotId}
      activePlotDirty={activePlotDirty}
      hasSamples={hasSamples}
      canSaveNew={activeTabPlotSession && tab === activeTab}
      onSaveNew={() =>
        setSaveDraft({
          name: suggestedPlotName(tab, displayResult, spec),
          description: "",
          source: "live",
        })
      }
      onOpen={openSavedPlot}
      onDelete={(plotId) => {
        update((s) => void (s.saved_plots = (s.saved_plots ?? []).filter((plot) => plot.id !== plotId)));
        if (activeSavedPlotId === plotId) {
          const remaining = (spec.saved_plots ?? []).filter(
            (plot) => plot.id !== plotId && plot.tab === tab,
          );
          if (remaining[0]) {
            openSavedPlot(remaining[0]);
          } else {
            setActiveSavedPlotId(null);
            setActivePlotBaselineSignature(null);
            setPlotSessionActive(false);
          }
        }
      }}
      allowPreviewGeneration={
        tab === "time_capacity"
          ? timeCapacityReady
          : tab === "chargeability"
            ? chargeabilityReady
          : tab === "crate"
            ? rateCapabilityReady
          : tab === "cycles" || tab === "recap"
            ? cycleLivePlotReady
            : true
      }
      />
    </>
    );
  };

  return (
    <Stack gap="sm" data-analysis-editor={aid}>
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
          <Button.Group>
            <Tooltip label="Create a standalone, re-importable HTML analysis">
              <Button
                variant="default"
                leftSection={<IconFileExport size={16} />}
                disabled={activeProtocolPolicy.pending}
                onClick={() => openPortableExport("download")}
              >
                Portable report
              </Button>
            </Tooltip>
            <Menu withinPortal position="bottom-end">
              <Menu.Target>
                <ActionIcon
                  variant="default"
                  size={36}
                  aria-label="Portable report actions"
                  disabled={activeProtocolPolicy.pending}
                  style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                >
                  <IconChevronDown size={15} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  leftSection={<IconShare3 size={16} />}
                  onClick={() => openPortableExport("share")}
                >
                  Share to app
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Button.Group>
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
      <AnalysisTabHeader value={activeTab} onCommit={activateAnalysisTab} />
      <Tabs value={activeTab} keepMounted={false}>

        <Tabs.Panel value="cycles" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "cycles",
                <CyclePlotCard
                  analysisTitle={title}
                  plotName={displayPlotName}
                  subtitle={displaySubtitle}
                  result={displayResult}
                  spec={spec}
                  update={update}
                  updating={plotUpdating}
                  error={compute.isError ? (compute.error as Error) : null}
                  computeJob={computeJob.data ?? undefined}
                  edited={activePlotDirty && activePlot?.tab === "cycles"}
                  {...newPlotHeaderProps}
                />,
              )}
              {savedPlotsPanelFor("cycles")}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="steps" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "steps",
                <StepsPlotCard
                  analysisId={aid}
                  analysisTitle={title}
                  plotName={displayPlotName}
                  spec={spec}
                  cells={currentAnalysis.selection_cells}
                  update={update}
                  edited={activePlotDirty && activePlot?.tab === "steps"}
                  {...newPlotHeaderProps}
                />,
              )}
              {savedPlotsPanelFor("steps")}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="dcir" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "dcir",
                <DcirPlotCard
                  analysisId={aid}
                  analysisTitle={title}
                  plotName={displayPlotName}
                  spec={spec}
                  update={update}
                  edited={activePlotDirty && activePlot?.tab === "dcir"}
                  {...newPlotHeaderProps}
                />,
              )}
              {savedPlotsPanelFor("dcir")}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="chargeability" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "chargeability",
                <ChargeabilityPlotCard
                  analysisId={aid}
                  analysisTitle={title}
                  plotName={displayPlotName}
                  spec={spec}
                  update={update}
                  onReadyChange={setChargeabilityReady}
                  edited={activePlotDirty && activePlot?.tab === "chargeability"}
                  {...newPlotHeaderProps}
                />,
              )}
              {savedPlotsPanelFor("chargeability")}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="recap" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "recap",
                <Paper p="sm" withBorder style={{ minHeight: 590 }}>
                  <PlotHeader
                    plotName={displayPlotName}
                    subtitle="Recap table"
                    edited={activePlotDirty && activePlot?.tab === "recap"}
                    {...newPlotHeaderProps}
                  />
                  <Divider mb="sm" />
                  <MetricsTable result={displayResult} />
                </Paper>,
              )}
              {savedPlotsPanelFor("recap")}
            </Stack>
          </Group>
        </Tabs.Panel>

        {(timeCapacityVisited || activeTab === "time_capacity") && (
          /* Keep only this expensive plot alive after its first visit. The
             parent still unmounts every other inactive analysis family. */
          <Tabs.Panel value="time_capacity" pt="sm" keepMounted>
            <Group align="start" wrap="nowrap">
              {activeTab === "time_capacity" ? sidebar : null}
              <Stack style={{ flex: 1, minWidth: 0 }}>
                {plotSurfaceFor(
                  "time_capacity",
                  <TimeCapacityPlotCard
                    analysisId={aid}
                    analysisTitle={title}
                    plotName={displayPlotName}
                    subtitle={plotSubtitle("time_capacity", undefined, spec)}
                    spec={spec}
                    update={update}
                    onReadyChange={setTimeCapacityReady}
                    edited={activePlotDirty && activePlot?.tab === "time_capacity"}
                    {...newPlotHeaderProps}
                  />,
                )}
                {activeTab === "time_capacity" ? savedPlotsPanelFor("time_capacity") : null}
              </Stack>
            </Group>
          </Tabs.Panel>
        )}

        <Tabs.Panel value="crate" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              {plotSurfaceFor(
                "crate",
                <RateCapabilityPlotCard
                  analysisId={aid}
                  analysisTitle={title}
                  plotName={displayPlotName}
                  spec={spec}
                  update={update}
                  recognitionEnabled={rateCapabilityRecognitionEnabled}
                  onReadyChange={setRateCapabilityReady}
                  edited={activePlotDirty && activePlot?.tab === "crate"}
                  {...newPlotHeaderProps}
                />,
              )}
              {savedPlotsPanelFor("crate")}
            </Stack>
          </Group>
        </Tabs.Panel>

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

      <Modal
        opened={portableExportOpen}
        onClose={() => {
          if (!portableExportBusy) {
            setPortableExportOpen(false);
            setPreparedPortableShare(null);
            setPortableSourceDecision(null);
            setPendingPortableExport(null);
          }
        }}
        title={portableExportAction === "share" ? "Share portable analysis" : "Export portable analysis"}
        size="xl"
        closeOnClickOutside={!portableExportBusy}
        closeOnEscape={!portableExportBusy}
      >
        <Stack>
          <Text size="sm">
            Creates one HTML file that opens as an interactive report in a browser and can be
            imported into CellXplorer later.
          </Text>
          <Paper withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <div>
                <Text size="sm" fw={700}>
                  Plots to include
                </Text>
                <Text size="xs" c="dimmed">
                  {portablePlotIds.length} of {portablePlotOptions.length} selected
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setPortablePlotIds(exportablePortablePlotIds)}
                >
                  Select all supported
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => setPortablePlotIds([])}
                >
                  Clear
                </Button>
              </Group>
            </Group>
            <ScrollArea.Autosize mah={430}>
              <Stack gap="xs">
                {portablePlotOptions.map((plot) => {
                  const selected = portablePlotIds.includes(plot.id);
                  const policy = portablePlotPolicies.find(({ plot: candidate }) => candidate.id === plot.id)?.policy;
                  const blocked = Boolean(policy?.family && !policy.supported);
                  const toggle = () =>
                    !blocked && setPortablePlotIds((current) =>
                      selected
                        ? current.filter((id) => id !== plot.id)
                        : [...current, plot.id]
                    );
                  return (
                    <Paper
                      key={plot.id}
                      withBorder
                      p="xs"
                      bg={
                        selected
                          ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
                          : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                      }
                      style={{
                        borderColor: selected
                          ? "var(--mantine-primary-color-3)"
                          : "var(--mantine-color-gray-2)",
                        cursor: blocked ? "not-allowed" : "pointer",
                      }}
                      onClick={blocked ? undefined : toggle}
                    >
                      <Group wrap="nowrap" align="center">
                        <Checkbox
                          checked={selected}
                          disabled={blocked}
                          onChange={toggle}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Include ${plot.name}`}
                        />
                        <Box
                          w={210}
                          style={{ flexShrink: 0, pointerEvents: "none" }}
                        >
                          {"selection" in plot ? (
                            plot.tab === "time_capacity" ||
                            plot.tab === "cycles" ||
                            plot.tab === "recap" ||
                            plot.tab === "dcir" ||
                            plot.tab === "steps" ||
                            plot.tab === "chargeability" ||
                            plot.tab === "crate" ? (
                              <CachedSavedPlotPreview
                                analysisId={aid}
                                baseSpec={spec}
                                plot={plot as SavedAnalysisPlot}
                              />
                            ) : (
                              <Center h={130}>
                                <Text size="xs" c="dimmed">
                                  {tabLabel(plot.tab)}
                                </Text>
                              </Center>
                            )
                          ) : (
                            <Center h={130}>
                              <Text size="xs" c="dimmed">
                                Current view
                              </Text>
                            </Center>
                          )}
                        </Box>
                        <Stack gap={3} style={{ minWidth: 0, flex: 1 }}>
                          <Badge size="xs" variant="light" color={selected ? "var(--mantine-primary-color-6)" : "gray"}>
                            {tabLabel(plot.tab)}
                          </Badge>
                          <Text size="sm" fw={700} lineClamp={2}>
                            {plot.name}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            {plot.subtitle || tabLabel(plot.tab)}
                          </Text>
                          {blocked && (
                            <Text size="xs" c="orange" lineClamp={2}>
                              {policy?.pending
                                ? `Checking source compatibility: ${policy.unresolvedCells.map((cell) => cell.name).join(", ")}`
                                : `Protocol mapping required: ${policy?.unsupportedCells.map((cell) => cell.name).join(", ")}`}
                            </Text>
                          )}
                        </Stack>
                      </Group>
                    </Paper>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          </Paper>
          {guardedPortablePlots.length > 0 && (
            <Alert color="yellow" title="Some saved plots cannot be included">
              <Stack gap={4}>
                <Text size="sm">
                  These plots remain visible so the omission is explicit. They are disabled until
                  their source compatibility is resolved.
                </Text>
                {guardedPortablePlots.map(({ plot, policy }) => (
                  <Text key={plot.id} size="sm">
                    <Text span fw={700}>{plot.name}</Text>: {policy.pending
                      ? `checking ${policy.unresolvedCells.map((cell) => cell.name).join(", ")}`
                      : `protocol mapping required for ${policy.unsupportedCells.map((cell) => cell.name).join(", ")}`}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          {portableEstimate.isError ? (
            <Alert color="red">Could not estimate the export size.</Alert>
          ) : (
            <Paper withBorder p="sm" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
              <Group justify="space-between" align="start">
                <div>
                  <Text size="sm" fw={700}>
                    {portableEstimate.data?.cells ?? "..."} cells ·{" "}
                    {portableEstimate.data?.sources ?? "..."} source files
                  </Text>
                  <Text size="xs" c="dimmed">
                    Embedded Plotly runtime after compression:{" "}
                    {portableEstimate.data
                      ? formatPortableBytes(portableEstimate.data.runtime_embedded_bytes)
                      : "calculating..."}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Rough HTML estimate:{" "}
                    {portableEstimatedBytes !== null
                      ? formatPortableBytes(portableEstimatedBytes)
                      : "calculating..."}
                  </Text>
                </div>
                <Text size="xs" c="dimmed" maw={260}>
                  Metadata, settings and provenance are always included. Plot data varies with
                  point density, so this estimate is intentionally approximate.
                </Text>
              </Group>
            </Paper>
          )}
          <Switch
            checked={includePortableOriginals}
            onChange={(event) => setIncludePortableOriginals(event.currentTarget.checked)}
            disabled={portableExportBusy}
            label="Include original .nda/.ndax files"
            description={
              portableEstimate.data
                ? `${formatPortableBytes(portableEstimate.data.original_bytes)} before compression. Embedded sources are gzip-compressed and decoded only when extracted or imported.`
                : "Original Neware files can make the HTML substantially larger."
            }
          />
          {includePortableOriginals && portableEstimate.data?.missing_originals ? (
            <Alert color="orange">
              {portableEstimate.data.missing_originals} original source{" "}
              {portableEstimate.data.missing_originals === 1 ? "is" : "are"} unavailable and
              cannot be embedded. CellXplorer will check again before export and let you continue
              without source files.
            </Alert>
          ) : null}
          <Alert color="gray">
            Reports without original files remain fully viewable. On import, CellXplorer reconnects
            sources by checksum or recorded path; missing sources remain offline until relinked.
          </Alert>
          {portableExport.isPending && portableProgress ? (
            <Paper withBorder p="sm">
              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="sm" fw={600}>{portableProgress.stage}</Text>
                  <Text size="xs" c="dimmed">
                    {portableProgress.phase === "plots"
                      ? `${portableProgress.completed} of ${portableProgress.total} plots`
                      : portableProgress.phase === "packing"
                        ? "Finalizing file"
                        : "Complete"}
                  </Text>
                </Group>
                <Progress
                  animated
                  value={
                    portableProgress.phase === "plots"
                      ? portableProgress.total > 0
                        ? (portableProgress.completed / portableProgress.total) * 85
                        : 0
                      : portableProgress.phase === "packing"
                        ? 92
                        : 100
                  }
                />
              </Stack>
            </Paper>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={portableExportBusy}
              onClick={() => {
                setPortableExportOpen(false);
                setPreparedPortableShare(null);
                setPortableSourceDecision(null);
                setPendingPortableExport(null);
              }}
            >
              Cancel
            </Button>
            <Button
              leftSection={<IconFileExport size={16} />}
              loading={portableExportBusy}
              disabled={portablePlotIds.length === 0}
              onClick={() =>
                preparedPortableShare
                  ? sharePreparedPortable()
                  : void beginPortableExport(portableExportAction)
              }
            >
              {preparedPortableShare
                ? "Open share sheet"
                : portableExportAction === "share"
                  ? "Prepare HTML"
                  : "Export HTML"}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={portableSourceDecision !== null}
        onClose={() => {
          if (!updatePortableSources.isPending) {
            setPortableSourceDecision(null);
            setPendingPortableExport(null);
          }
        }}
        title="Source files changed"
        size="lg"
        closeOnClickOutside={!updatePortableSources.isPending}
        closeOnEscape={!updatePortableSources.isPending}
      >
        <Stack>
          <Alert color="orange" title="The requested source files cannot be embedded yet">
            CellXplorer compared the current file bytes with the versions used by the analysis.
            Export has paused before rebuilding any plots, so it cannot silently omit a changed
            file.
          </Alert>
          <ScrollArea.Autosize mah={320}>
            <Stack gap="xs">
              {portableSourceBlockers.map((source) => (
                <Paper key={source.source_id} withBorder p="sm">
                  <Group justify="space-between" align="start" wrap="nowrap">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={700} truncate>
                        {source.filename}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {source.cell_name}
                      </Text>
                    </div>
                    <Badge
                      color={
                        source.status === "changed"
                          ? "orange"
                          : source.status === "changing"
                            ? "yellow"
                            : "red"
                      }
                      variant="light"
                    >
                      {source.status === "changed"
                        ? "Changed"
                        : source.status === "changing"
                          ? "Still changing"
                          : source.status === "unavailable"
                            ? "Unavailable"
                            : "Read error"}
                    </Badge>
                  </Group>
                  <Text size="xs" mt={6}>
                    {source.message}
                  </Text>
                </Paper>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {canUpdatePortableSources ? (
            <Alert color="var(--mantine-primary-color-6)">
              Updating adopts the new stable file version, rebuilds its scientific cache, and
              invalidates {portableSourceDecision?.affected_analyses ?? 0} dependent{" "}
              {(portableSourceDecision?.affected_analyses ?? 0) === 1
                ? "analysis"
                : "analyses"}. The selected plots are then regenerated before the report is
              packaged.
            </Alert>
          ) : (
            <Alert color="gray">
              Automatic update is available once every source is present, readable, and no longer
              being written. You can cancel and retry later, or export a fully viewable report
              without the original source files.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={updatePortableSources.isPending}
              onClick={() => {
                setPortableSourceDecision(null);
                setPendingPortableExport(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="light"
              color="gray"
              disabled={updatePortableSources.isPending}
              onClick={continuePortableWithoutSources}
            >
              Export without .nda/.ndax
            </Button>
            <Button
              loading={updatePortableSources.isPending}
              disabled={!canUpdatePortableSources}
              onClick={() => void updatePortableSourcesAndContinue()}
            >
              Update sources, refresh plots & export
            </Button>
          </Group>
        </Stack>
      </Modal>

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
        opened={quantityRenamePrompt !== null}
        onClose={() => setQuantityRenamePrompt(null)}
        title="Quantity changed"
      >
        <Stack gap="md">
          <Text size="sm">
            You changed the quantity shown on this plot. Update the plot name to match the new
            quantity?
          </Text>
          <TextInput
            label="Plot name"
            value={quantityRenamePrompt?.name ?? ""}
            onChange={(event) =>
              setQuantityRenamePrompt((prompt) =>
                prompt ? { ...prompt, name: event.currentTarget.value } : prompt
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && quantityRenamePrompt?.name.trim()) {
                confirmQuantityRenameUpdate();
              }
            }}
          />
          {quantityRenamePrompt &&
          quantityRenamePrompt.suggestedName.trim() &&
          quantityRenamePrompt.suggestedName !== quantityRenamePrompt.name ? (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                Suggested name — click to use, then edit if you like
              </Text>
              <Button
                variant="light"
                justify="flex-start"
                onClick={() =>
                  setQuantityRenamePrompt((prompt) =>
                    prompt ? { ...prompt, name: prompt.suggestedName } : prompt
                  )
                }
              >
                {quantityRenamePrompt.suggestedName}
              </Button>
            </Stack>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setQuantityRenamePrompt(null)}>
              Cancel
            </Button>
            <Button
              disabled={!quantityRenamePrompt?.name.trim()}
              onClick={confirmQuantityRenameUpdate}
            >
              Update plot
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={leavePrompt !== null}
        onClose={() => setLeavePrompt(null)}
        size={640}
        title={
          leavePrompt?.stage === "details"
            ? leavePrompt.mode === "copy"
              ? "Save as a copy"
              : "Save new plot"
            : leavePrompt?.mode === "update"
              ? "Unsaved edits"
              : "Unsaved plot"
        }
        closeOnClickOutside={!leaveSaving}
        closeOnEscape={!leaveSaving}
      >
        <Stack>
          {leavePrompt?.stage === "confirm" ? (
            <>
              <Text size="sm" c="dimmed">
                {leavePrompt.mode === "update"
                  ? "This saved plot has edits that are not written back yet."
                  : "This draft is temporary. Save it now, or it will be discarded."}
              </Text>
              {leavePrompt.mode === "update" && activePlot ? (
                <Text size="sm" fw={700}>
                  {activePlot.name}
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <TextInput
                label="Title"
                value={leavePrompt?.name ?? ""}
                onChange={(event) =>
                  setLeavePrompt((prompt) =>
                    prompt ? { ...prompt, name: event.currentTarget.value } : prompt
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && leavePrompt?.name.trim()) savePlotAndLeave();
                }}
                data-autofocus
              />
              <Text size="sm" c="dimmed">
                {plotSubtitle(activeTab, displayResult, spec)}
              </Text>
              <Textarea
                label="Description"
                minRows={3}
                value={leavePrompt?.description ?? ""}
                onChange={(event) =>
                  setLeavePrompt((prompt) =>
                    prompt
                      ? { ...prompt, description: event.currentTarget.value }
                      : prompt
                  )
                }
              />
            </>
          )}
          <Group justify="space-between" wrap="nowrap" gap="sm" preventGrowOverflow={false}>
            <Button
              variant="subtle"
              color="red"
              disabled={leaveSaving}
              loading={leaveSaving}
              style={{ flexShrink: 0 }}
              onClick={discardLeaveChanges}
            >
              {leavePrompt?.mode === "update" ? "Discard changes" : "Discard"}
            </Button>
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              {leavePrompt?.stage === "confirm" && leavePrompt.mode === "new" ? (
                <Button
                  loading={leaveSaving}
                  onClick={() =>
                    setLeavePrompt((prompt) =>
                      prompt ? { ...prompt, stage: "details", mode: "new" } : prompt
                    )
                  }
                >
                  Save as new plot
                </Button>
              ) : null}
              {leavePrompt?.stage === "confirm" && leavePrompt.mode === "update" ? (
                <>
                  <Button
                    variant="light"
                    disabled={leaveSaving}
                    onClick={() =>
                      setLeavePrompt((prompt) =>
                        prompt
                          ? {
                              ...prompt,
                              mode: "copy",
                              stage: "details",
                              name: `${activePlot?.name ?? "Plot"} (copy)`,
                              description: activePlot?.description ?? "",
                            }
                          : prompt
                      )
                    }
                  >
                    Save as a copy…
                  </Button>
                  <Button loading={leaveSaving} onClick={savePlotAndLeave}>
                    Save changes
                  </Button>
                </>
              ) : null}
              {leavePrompt?.stage === "details" ? (
                <Button
                  loading={leaveSaving}
                  disabled={!leavePrompt.name.trim()}
                  onClick={savePlotAndLeave}
                >
                  Save and leave
                </Button>
              ) : null}
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

export const AnalysisPage = memo(AnalysisPageView);
