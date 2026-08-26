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
  IconCheckbox,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDatabase,
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
  IconSquareCheck,
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
import { useSearchParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSpec,
  AnalysisTabKey,
  ANALYSIS_TAB_KEYS,
  Badge as ApiBadge,
  CellMetrics,
  AnalysisSummary,
  CellSummary,
  ComputeResult,
  del,
  FolderNode,
  get,
  post,
  put,
  PlotAspectRatioKey,
  PlotExportFormat,
  ProtocolFamilyGroup,
  ProtocolSegment,
  ReplicateGroupSummary,
  SavedAnalysisPlot,
  SelectionEntry,
  PlotStylePresetSettings,
  TimeCapacityResult,
  Tree,
} from "../../../api";
import {
  clearAnalysisQueryCache,
  invalidateAnalysisQueries,
  refreshPersistedAnalysisQueries,
} from "../workspace/analysisQueryCache";
import {
  clearAnalysisWorkspaceEditorState,
  getAnalysisWorkspaceEditorState,
  isAnalysisWorkspaceViewActive,
  setAnalysisWorkspaceEditorState,
} from "../workspace/analysisWorkspace";
import {
  buildCommitSavedPlotSpec,
  buildDiscardEditedSavedPlotSpec,
  buildDiscardNewPlotSpec,
  buildStablePersistSpec,
  captureNormalWorkspace,
  draftAsSavedPlot,
  draftPlotFromWorkspace,
  analysisTabRequiresPlotSession,
  plotSessionBelongsToTab,
  resolveColdOpenWorkspace,
  savedPlotFromDraftSource,
  shouldRunLivePlotCompute,
  stripDraftPlots,
  type DraftSaveSource,
  type NormalWorkspaceSnapshot,
} from "./policies/analysisDraftPolicy";
import {
  plotViewSignature,
  savedPlotSelectionFromSpec,
  specForSavedPlotView,
} from "./policies/analysisPlotPolicy";
import {
  DebouncedNumberInput,
  DebouncedTextInput,
} from "../../../components/DebouncedInputs";
import { PlotStylePanel } from "./plotting/PlotStylePanel";
import { SavedPlotsPanel } from "./artifacts/SavedPlotsPanel";
import { PortableReportFlow } from "./portable/PortableReportFlow";
import {
  CyclePlotCard,
  CycleSettings,
  cyclePlotLayout,
  cycleQuantityLabel,
  cycleTracesForResult,
  normalizeLegacyCycleQuantityKey,
  useCyclesResult,
} from "./families/cycles/CyclePlotCard";
import {
  DEFAULT_TIME_CAPACITY,
  TimeCapacityPlotCard,
  TimeCapacitySettings,
  timeCapacityConfig,
  timeCapacityLayout,
  timeCapacityTracesForResult,
} from "./families/time-capacity/TimeCapacityPlotCard";
import { selectedTimeCapacityCycleMax } from "./families/time-capacity/timeCapacityCycleNavigationPolicy";
import { voltageChannelSelectionLabel } from "./policies/voltageChannelPolicy";
import { parserSourceBreakdown } from "./policies/parserProvenancePolicy";
import {
  CellHoverCard,
  RelatedAnalysesPopover,
  relatedAnalysesForCell,
} from "../../../components/CellSamplePopovers";
import Plot from "../../../components/Plot";
import {
  StepsPlotCard,
  StepsSettings,
  stepsLayoutForSpec,
  stepsTracesForResult,
  type StepsResult,
} from "./families/steps/StepsPlotCard";
import {
  DcirPlotCard,
  DcirSettings,
  dcirLayoutForSpec,
  dcirTracesForResult,
  type DcirResult,
} from "./families/dcir/DcirPlotCard";
import {
  dcirSampleEntryKey,
  dcirSampleKeysInRange,
  filterAndSortDcirSampleItems,
  type DcirSampleSort,
} from "./families/dcir/dcirSampleListPolicy";
import { normalizeProtocolGroups } from "./protocol/protocolGroupPolicy";
import {
  ChargeabilityPlotCard,
  ChargeabilitySettings,
  chargeabilityLayoutForSpec,
  chargeabilityTracesForResult,
  chargeabilityViewFor,
  type ChargeabilityResult,
} from "./families/chargeability/ChargeabilityPlotCard";
import {
  RateCapabilityPlotCard,
  RateCapabilitySettings,
  rateCapabilityLayoutForSpec,
  rateCapabilityTracesForResult,
  rateCapabilityViewFor,
  type RateCapabilityResult,
} from "./families/rate-capability/RateCapabilityPlotCard";
import { FilenameTemplateEditor } from "../../../components/FilenameTemplateEditor";
import { ProtocolSegmentsPanel } from "./protocol/ProtocolSegmentsPanel";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "../../../navigationEvents";
import {
  getTimeCapacityExplainer,
  type PlotExplainer,
} from "./plotting/plotExplainers";
import { applyPlotStylePreset } from "./plotting/plotStylePresets";
import {
  decimatePreviewTraces,
  resolveSeriesStyle,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  shortSourceName,
  timeCapacitySeriesDescriptor,
} from "./plotting/seriesStyling";
import { axisLayout, numericTraceExtent } from "./plotting/plotAxisLayout";
import {
  sourceExportColumns,
} from "./plotting/sourceChainPlot";
import {
  hasMetadataOnlySources as selectionHasMetadataOnlySources,
  multiSourceAnalysisPolicy,
  selectedSourceCountCellsForSpec,
  type MultiSourceAnalysisPolicy,
} from "./policies/multiSourceAnalysisPolicy";
import {
  DEFAULT_PLOT_STYLE,
  normalizePlotStyle,
  currentPlotStyle,
  writeScopedStyle,
  plotPalette,
  cePalette,
  plotMode,
  plotStylePresetFamilyForTab,
} from "./plotting/plotStyle";
import { paletteColorAt, paletteOverflowMode } from "./plotting/paletteDraft";
import {
  axisGapDelta,
  draggedLegendPoint,
  hoverLabelLayout,
  legendLayout,
  legendMargins,
  plotAxisStyle,
  tickLayout,
} from "./plotting/plotLayout";
import {
  blobFromDataUrl,
  downloadBlob,
  downloadDataExport,
  exportFigure,
  makeVectorPdf,
  pngWithPpi,
  resolveExportPlan,
  slugFilename,
  textFromDataUrl,
  tracesToColumns,
} from "./plotting/plotExport";
import {
  afterPaint,
  interactivePlotTraces,
  newComputeToken,
  useDelayedFlag,
  usePlotSizeSync,
  useZoomMemory,
} from "./plotting/plotRuntime";
import {
  ComputeProgress,
  PlotHeader,
} from "./plotting/PlotHeader";
import {
  isAnalysisSegmentHidden,
  isCellHiddenInAnalysis,
  isSeriesHidden,
  visibilityAfterToggle,
} from "./policies/analysisVisibility";
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
    return `${voltageChannelSelectionLabel(cfg.voltage_channels)}${cfg.stacked ? " and current" : ""} vs ${axis}`;
  }
  if (tab === "cycles") return `${cycleQuantityLabel(result, spec)} vs cycle`;
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
  return tab === "cycles" ? `${cycleQuantityLabel(result, spec)} comparison` : `${tabLabel(tab)} view`;
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
  const legacyNormalized = normalizeLegacyCycleQuantityKey(presentation.quantity);
  if (legacyNormalized !== presentation.quantity) {
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
    protocol_group_id: segment.protocol_group_id ?? null,
    targets: (segment.targets ?? [])
      .map((target) => ({
        protocol_signature: target.protocol_signature,
        step_indices: [...new Set(target.step_indices ?? [])].sort((a, b) => a - b),
      }))
      .filter((target) => target.protocol_signature && target.step_indices.length > 0),
  }));
  spec.protocol_groups = normalizeProtocolGroups(
    (spec.protocol_groups ?? []).map((group): ProtocolFamilyGroup => ({
      id: group.id,
      name: group.name?.trim() || "Protocol group",
      family_signatures: [...new Set(group.family_signatures ?? [])].filter(Boolean),
      reference_signature: group.reference_signature,
      comparison_mode:
        group.comparison_mode === "strict" || group.comparison_mode === "custom"
          ? group.comparison_mode
          : "workflow",
      comparison_dimensions: {
        structure: Boolean(group.comparison_dimensions?.structure),
        termination: Boolean(group.comparison_dimensions?.termination),
        rates: Boolean(group.comparison_dimensions?.rates),
        timing: Boolean(group.comparison_dimensions?.timing),
        voltage: Boolean(group.comparison_dimensions?.voltage),
        recording: Boolean(group.comparison_dimensions?.recording),
      },
      ignore_empty_rest_pause: Boolean(group.ignore_empty_rest_pause),
    })),
  );
  spec.dcir_segments = (spec.dcir_segments ?? []).map((segment) => ({
    id: segment.id,
    name: segment.name,
    protocol_group_id: segment.protocol_group_id ?? null,
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
    time_capacity: timeCapacityConfig(spec),
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
  const legacyNormalized = normalizeLegacyCycleQuantityKey(spec.presentation.quantity);
  if (legacyNormalized !== spec.presentation.quantity) {
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

function CanonicalCyclingUnavailableState() {
  return (
    <Paper p="xl" withBorder>
      <Alert color="orange" icon={<IconInfoCircle size={18} />}>
        <Stack gap="xs">
          <Text fw={700}>Canonical cycling data unavailable</Text>
          <Text size="sm">
            One or more selected sources has readable metadata but no independently verified
            canonical cycling rows. This plot is disabled until a verified cycle identity is
            available.
          </Text>
        </Stack>
      </Alert>
    </Paper>
  );
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

function setCellVisibilityInDraft(
  draft: AnalysisSpec,
  groups: { id: number; cells: { id: number }[] }[],
  cellId: number,
  context: VisibilityContext,
  visible: boolean,
) {
  const isHidden = draft.selection.exclusions.some((exclusion) =>
    exclusionAppliesToContext(exclusion, cellId, context),
  );

  if (!visible) {
    if (!isHidden) {
      draft.selection.exclusions.push({
        cell_id: cellId,
        entry_kind: context.kind,
        entry_ref_id: context.ref_id,
        reason: null,
        excluded_at: new Date().toISOString(),
      });
    }
    return;
  }

  if (!isHidden) return;

  const hadLegacyExclusion = draft.selection.exclusions.some(
    (exclusion) =>
      exclusion.cell_id === cellId &&
      exclusion.entry_kind == null &&
      exclusion.entry_ref_id == null,
  );
  draft.selection.exclusions = draft.selection.exclusions.filter((exclusion) => {
    const legacy =
      exclusion.cell_id === cellId &&
      exclusion.entry_kind == null &&
      exclusion.entry_ref_id == null;
    return !legacy && !isExactContextExclusion(exclusion, cellId, context);
  });

  // Legacy plots hid a cell everywhere. Showing one occurrence converts the
  // other occurrences to explicit scoped exclusions.
  if (hadLegacyExclusion) {
    for (const other of selectionContextsForCell(draft.selection.entries, groups, cellId)) {
      if (other.kind === context.kind && other.ref_id === context.ref_id) continue;
      if (!draft.selection.exclusions.some((exclusion) => isExactContextExclusion(exclusion, cellId, other))) {
        draft.selection.exclusions.push({
          cell_id: cellId,
          entry_kind: other.kind,
          entry_ref_id: other.ref_id,
          reason: null,
          excluded_at: new Date().toISOString(),
        });
      }
    }
  }
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
  bulkActionsEnabled = false,
  onSetEntriesVisibility,
  onRemoveEntries,
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
  bulkActionsEnabled?: boolean;
  onSetEntriesVisibility?: (entries: SelectionEntry[], visible: boolean) => void;
  onRemoveEntries?: (entries: SelectionEntry[]) => void;
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
  const [searchTerm, setSearchTerm] = useState("");
  const [sortMode, setSortMode] = useState<DcirSampleSort>("name_asc");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  const dcirSampleItems = spec.selection.entries.map((entry) => {
    if (entry.kind === "replicate_group") {
      const group = groupById.get(entry.ref_id);
      return {
        key: dcirSampleEntryKey(entry),
        label: group?.name ?? `replicate #${entry.ref_id}`,
        visible: !hiddenGroups.has(entry.ref_id),
        entry,
      };
    }

    const context = { kind: "cell" as const, ref_id: entry.ref_id };
    return {
      key: dcirSampleEntryKey(entry),
      label: cellById.get(entry.ref_id)?.name ?? `cell #${entry.ref_id}`,
      visible: !spec.selection.exclusions.some((exclusion) =>
        exclusionAppliesToContext(exclusion, entry.ref_id, context),
      ),
      entry,
    };
  });
  const filteredDcirSampleItems = filterAndSortDcirSampleItems(
    dcirSampleItems,
    searchTerm,
    sortMode,
  );
  const shownDcirKeys = filteredDcirSampleItems.map((item) => item.key);
  const selectedShownCount = shownDcirKeys.filter((key) => selectedKeys.has(key)).length;
  const allShownSelected = shownDcirKeys.length > 0 && selectedShownCount === shownDcirKeys.length;
  const someShownSelected = selectedShownCount > 0 && !allShownSelected;
  const dcirSortOptions = [
    { value: "name_asc", label: "A/Z \u2191" },
    { value: "name_desc", label: "A/Z \u2193" },
    { value: "visible_first_asc", label: "\u{1F441} \u2191" },
    { value: "visible_first_desc", label: "\u{1F441} \u2193" },
  ];
  const selectedDcirEntries = spec.selection.entries.filter((entry) =>
    selectedKeys.has(dcirSampleEntryKey(entry)),
  );
  const entryIndexByKey = new Map(
    spec.selection.entries.map((entry, index) => [dcirSampleEntryKey(entry), index]),
  );
  const entriesForRender = bulkActionsEnabled
    ? filteredDcirSampleItems.map((item) => ({
        entry: item.entry,
        index: entryIndexByKey.get(item.key) ?? -1,
      }))
    : spec.selection.entries.map((entry, index) => ({ entry, index }));

  useEffect(() => {
    if (bulkActionsEnabled) return;
    setSelectionMode(false);
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setPendingDelete(false);
    setSearchTerm("");
    setSortMode("name_asc");
  }, [bulkActionsEnabled]);

  useEffect(() => {
    const liveKeys = new Set(spec.selection.entries.map(dcirSampleEntryKey));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    setSelectionAnchorKey((current) => (current && liveKeys.has(current) ? current : null));
  }, [spec.selection.entries]);

  useEffect(() => {
    if (selectedKeys.size === 0 && pendingDelete) setPendingDelete(false);
  }, [pendingDelete, selectedKeys.size]);

  const toggleSelectionMode = () => {
    setSelectionMode((current) => {
      const next = !current;
      if (!next) {
        setSelectedKeys(new Set());
        setSelectionAnchorKey(null);
        setPendingDelete(false);
      }
      return next;
    });
  };

  const toggleSelectedEntry = (
    entry: SelectionEntry,
    checked: boolean,
    shiftKey = false,
  ) => {
    const key = dcirSampleEntryKey(entry);
    const keysToUpdate = shiftKey
      ? dcirSampleKeysInRange(filteredDcirSampleItems, selectionAnchorKey, key)
      : [key];
    setSelectedKeys((current) => {
      const next = new Set(current);
      keysToUpdate.forEach((rangeKey) => {
        if (checked) next.add(rangeKey);
        else next.delete(rangeKey);
      });
      return next;
    });
    setSelectionAnchorKey(key);
    setPendingDelete(false);
  };

  const toggleSelectAllShown = () => {
    if (shownDcirKeys.length === 0) return;
    const shouldSelect = !allShownSelected;
    setSelectedKeys((current) => {
      const next = new Set(current);
      shownDcirKeys.forEach((key) => {
        if (shouldSelect) next.add(key);
        else next.delete(key);
      });
      return next;
    });
    setSelectionAnchorKey(shouldSelect ? shownDcirKeys[shownDcirKeys.length - 1] : null);
    setPendingDelete(false);
  };

  const applySelectedVisibility = (visible: boolean) => {
    if (selectedDcirEntries.length === 0 || !onSetEntriesVisibility) return;
    onSetEntriesVisibility(selectedDcirEntries, visible);
    setPendingDelete(false);
  };

  const confirmSelectedDelete = () => {
    if (selectedDcirEntries.length === 0 || !onRemoveEntries) return;
    onRemoveEntries(selectedDcirEntries);
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setPendingDelete(false);
    setSelectionMode(false);
  };

  const toggleCellVisibilityOnDoubleClick = (
    event: ReactMouseEvent<HTMLElement>,
    cellId: number,
    context: VisibilityContext,
  ) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button, input, [role='button']")
    ) {
      return;
    }
    onToggleCell(cellId, context);
  };

  return (
    <Paper p="sm" withBorder>
      <Group
        justify="space-between"
        gap="xs"
        mb={collapsed ? 0 : "xs"}
        wrap="nowrap"
        style={{ minWidth: 0 }}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: "1 1 auto" }}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={collapsed ? "Expand samples" : "Collapse samples"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
          </ActionIcon>
          <Text fw={700} size="sm" truncate style={{ minWidth: 0, flex: "0 1 auto" }}>
            Analysis samples
          </Text>
          {spec.selection.entries.length > 0 && (
            <Badge size="xs" variant="light" color="gray" style={{ flex: "0 0 auto" }}>
              {spec.selection.entries.length}
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flex: "0 0 auto" }}>
          {bulkActionsEnabled && spec.selection.entries.length > 0 && (
            <Tooltip label={selectionMode ? "Exit sample selection mode" : "Select samples"}>
              <ActionIcon
                size="sm"
                variant={selectionMode ? "light" : "subtle"}
                color={selectionMode ? "var(--mantine-primary-color-6)" : "gray"}
                aria-pressed={selectionMode}
                aria-label={selectionMode ? "Exit sample selection mode" : "Select samples"}
                onClick={toggleSelectionMode}
              >
                {selectionMode ? <IconSquareCheck size={16} /> : <IconCheckbox size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
          <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={onAdd}>
            Add
          </Button>
        </Group>
      </Group>
      <Collapse in={!collapsed}>
      {spec.selection.entries.length === 0 ? (
        <Text size="xs" c="dimmed">
          No cells or replicates selected.
        </Text>
      ) : (
        <Stack gap="xs">
          {bulkActionsEnabled && (
            <>
              <Group gap="xs" wrap="nowrap" align="end">
                <TextInput
                  size="xs"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.currentTarget.value)}
                  placeholder="Search samples"
                  leftSection={<IconSearch size={14} />}
                  aria-label="Search analysis samples"
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                />
                <Select
                  size="xs"
                  value={sortMode}
                  onChange={(value) => value && setSortMode(value as DcirSampleSort)}
                  data={dcirSortOptions}
                  aria-label="Order analysis samples by name or visibility"
                  allowDeselect={false}
                  style={{ flex: "0 0 112px", width: 112, minWidth: 0 }}
                />
              </Group>
              {selectionMode && (
                <Paper
                  withBorder
                  radius="sm"
                  p="xs"
                  bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                >
                  <Group gap={4} align="center" wrap="wrap">
                    <Checkbox
                      size="xs"
                      radius="xl"
                      label="All"
                      checked={allShownSelected}
                      indeterminate={someShownSelected}
                      disabled={shownDcirKeys.length === 0}
                      onChange={toggleSelectAllShown}
                      aria-label={
                        allShownSelected
                          ? "Deselect all shown samples"
                          : "Select all shown samples"
                      }
                      style={{ flex: "0 0 auto" }}
                    />
                    <Button
                      size="compact-xs"
                      variant="default"
                      leftSection={<IconEye size={13} />}
                      disabled={selectedKeys.size === 0}
                      onClick={() => applySelectedVisibility(true)}
                      style={{ flex: "1 1 72px" }}
                    >
                      Show
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="default"
                      leftSection={<IconEyeOff size={13} />}
                      disabled={selectedKeys.size === 0}
                      onClick={() => applySelectedVisibility(false)}
                      style={{ flex: "1 1 72px" }}
                    >
                      Hide
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="default"
                      color="red"
                      leftSection={<IconTrash size={13} />}
                      disabled={selectedKeys.size === 0}
                      onClick={() => setPendingDelete(true)}
                      style={{ flex: "1 1 72px" }}
                    >
                      Delete
                    </Button>
                  </Group>
                </Paper>
              )}
              {selectionMode && pendingDelete && selectedKeys.size > 0 && (
                <Alert color="red" variant="light" py="xs">
                  <Group gap="xs" justify="space-between" align="flex-start" wrap="wrap">
                    <Box style={{ minWidth: 0, flex: "1 1 150px" }}>
                      <Text size="xs" fw={600}>
                        Delete {selectedKeys.size} selected sample{selectedKeys.size === 1 ? "" : "s"}?
                      </Text>
                      <Text size="xs" c="dimmed" mt={2}>
                        Only this analysis membership is removed.
                      </Text>
                    </Box>
                    <Group gap={4} wrap="wrap" style={{ flex: "0 1 auto" }}>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() => setPendingDelete(false)}
                      >
                        Cancel
                      </Button>
                      <Button size="compact-xs" color="red" onClick={confirmSelectedDelete}>
                        Delete selected
                      </Button>
                    </Group>
                  </Group>
                </Alert>
              )}
            </>
          )}
          {bulkActionsEnabled && filteredDcirSampleItems.length === 0 ? (
            <Text size="xs" c="dimmed" ta="center" py={"xs"}>
              No matching samples.
            </Text>
          ) : entriesForRender.map(({ entry, index }) => {
            if (entry.kind === "replicate_group") {
              const group = groupById.get(entry.ref_id);
              const groupHidden = hiddenGroups.has(entry.ref_id);
              const selected = selectedKeys.has(dcirSampleEntryKey(entry));
              return (
                <Box key={`${entry.kind}-${entry.ref_id}`}>
                  <Group
                    justify="space-between"
                    gap={6}
                    wrap="nowrap"
                    bg={selected ? "var(--mantine-primary-color-light)" : undefined}
                    px={4}
                    py={2}
                    style={{ borderRadius: "var(--mantine-radius-sm)" }}
                  >
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                      {selectionMode && (
                        <Checkbox
                          size="xs"
                          radius="xl"
                          checked={selected}
                          style={{ flex: "0 0 auto" }}
                          onChange={(event) => {
                            const nativeEvent = event.nativeEvent as Event & { shiftKey?: boolean };
                            toggleSelectedEntry(
                              entry,
                              event.currentTarget.checked,
                              Boolean(nativeEvent.shiftKey),
                            );
                          }}
                          aria-label={`Select ${group?.name ?? `replicate #${entry.ref_id}`}`}
                        />
                      )}
                      <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
                        <Text
                          size="sm"
                          fw={700}
                          c={groupHidden ? "dimmed" : undefined}
                          truncate
                          title={group?.name ?? `replicate #${entry.ref_id}`}
                        >
                          {group?.name ?? `replicate #${entry.ref_id}`}
                        </Text>
                        <Text size="10px" c="dimmed" tt="uppercase">
                          Replicate
                        </Text>
                      </Box>
                    </Group>
                    <Group gap={2} wrap="nowrap" style={{ flex: "0 0 auto" }}>
                      {!selectionMode && (
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
                      )}
                      {!selectionMode && (
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
                      )}
                    </Group>
                  </Group>
                  <Stack gap={2} mt={4} pl="md">
                    {(group?.cells ?? []).map((cell) => {
                      const context = { kind: "replicate_group" as const, ref_id: entry.ref_id };
                      const isHidden = spec.selection.exclusions.some((exclusion) =>
                        exclusionAppliesToContext(exclusion, cell.id, context)
                      );
                      return (
                        <Group
                          key={cell.id}
                          justify="space-between"
                          gap={6}
                          wrap="nowrap"
                          onDoubleClick={
                            selectionMode && !groupHidden
                              ? (event) =>
                                  toggleCellVisibilityOnDoubleClick(event, cell.id, context)
                              : undefined
                          }
                          style={{ cursor: selectionMode && !groupHidden ? "pointer" : undefined }}
                        >
                          <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
                            <CellHoverCard cell={cellFactsById.get(cell.id) ?? cell} result={result}>
                              <Text
                                size="xs"
                                c={groupHidden || isHidden ? "dimmed" : undefined}
                                truncate
                                title={cell.name}
                              >
                                {cell.name}
                              </Text>
                            </CellHoverCard>
                          </Box>
                          <RelatedAnalysesPopover
                            related={relatedFor(cell.id)}
                            onImport={onImportEntries}
                            label={`Other analyses using ${cell.name}`}
                          />
                          {!selectionMode && (
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
                          )}
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
            const selected = selectedKeys.has(dcirSampleEntryKey(entry));
            return (
              <Group
                key={`${entry.kind}-${entry.ref_id}`}
                justify="space-between"
                gap={6}
                wrap="nowrap"
                bg={selected ? "var(--mantine-primary-color-light)" : undefined}
                px={4}
                py={2}
                onDoubleClick={
                  selectionMode
                    ? (event) =>
                        toggleCellVisibilityOnDoubleClick(event, entry.ref_id, context)
                    : undefined
                }
                style={{
                  borderRadius: "var(--mantine-radius-sm)",
                  cursor: selectionMode ? "pointer" : undefined,
                }}
              >
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                  {selectionMode && (
                    <Checkbox
                      size="xs"
                      radius="xl"
                      checked={selected}
                      style={{ flex: "0 0 auto" }}
                      onChange={(event) => {
                        const nativeEvent = event.nativeEvent as Event & { shiftKey?: boolean };
                        toggleSelectedEntry(
                          entry,
                          event.currentTarget.checked,
                          Boolean(nativeEvent.shiftKey),
                        );
                      }}
                      aria-label={`Select ${cell?.name ?? `cell #${entry.ref_id}`}`}
                    />
                  )}
                  <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <CellHoverCard
                      cell={cellFactsById.get(entry.ref_id) ?? cell ?? { id: entry.ref_id, name: `cell #${entry.ref_id}` }}
                      result={result}
                    >
                      <Box style={{ minWidth: 0 }}>
                        <Text
                          size="sm"
                          fw={700}
                          c={isHidden ? "dimmed" : undefined}
                          truncate
                          title={cell?.name ?? `cell #${entry.ref_id}`}
                        >
                          {cell?.name ?? `cell #${entry.ref_id}`}
                        </Text>
                        <Text size="10px" c="dimmed" tt="uppercase">
                          Cell
                        </Text>
                      </Box>
                    </CellHoverCard>
                  </Box>
                </Group>
                <Group gap={2} wrap="nowrap" style={{ flex: "0 0 auto" }}>
                  <RelatedAnalysesPopover
                    related={relatedFor(entry.ref_id)}
                    onImport={onImportEntries}
                    label={`Other analyses using ${cell?.name ?? entry.ref_id}`}
                  />
                  {!selectionMode && (
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
                  )}
                  {!selectionMode && (
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
                  )}
                </Group>
              </Group>
            );
          })}
          {bulkActionsEnabled && searchTerm.trim() && (
            <Text size="xs" c="dimmed">
              {`${filteredDcirSampleItems.length} of ${spec.selection.entries.length} samples match`}
            </Text>
          )}
        </Stack>
      )}
      </Collapse>
    </Paper>
  );
}

function PlotWorkspaceEmpty({
  hasSamples,
  onNewPlot,
}: {
  hasSamples: boolean;
  onNewPlot: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const handleClick = () => {
    if (hasSamples) {
      onNewPlot();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.key === "Enter" || event.key === " ") && hasSamples) {
      event.preventDefault();
      onNewPlot();
    }
  };

  return (
    <Paper
      p="sm"
      withBorder
      style={{
        minHeight: 420,
        cursor: hasSamples ? "pointer" : "default",
        transition: "background-color 160ms ease",
        backgroundColor:
          hasSamples && hovered ? "var(--mantine-color-gray-0)" : undefined,
      }}
      role={hasSamples ? "button" : undefined}
      tabIndex={hasSamples ? 0 : undefined}
      aria-label={hasSamples ? "Start a new plot for this tab" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => hasSamples && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Group justify="flex-end" mb="md">
        <Button
          size="xs"
          color="var(--mantine-primary-color-6)"
          variant={hasSamples ? "filled" : "light"}
          leftSection={<IconPlus size={14} />}
          disabled={!hasSamples}
          onClick={(e) => {
            e.stopPropagation();
            onNewPlot();
          }}
        >
          New
        </Button>
      </Group>
      <Center h={320}>
        <Stack gap={6} align="center" maw={420}>
          <Text fw={700}>No plot yet</Text>
          <Text size="sm" c="dimmed" ta="center">
            {hasSamples
              ? "Click anywhere here, or the New button, to start a draft."
              : "Add cells or replicates to this analysis, then click New."}
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}

  // Draft cards keep thumbnails in React Query only — posting `__draft__:*`
  // always 404s (not in saved_plots) and previously retry-stormed the API.



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

export interface AnalysisEditorProps {
  analysisId: number;
  workspaceVisible?: boolean;
  onOpenAnalysis: (analysisId: number) => void;
  onOpenAnalysisDatabase: () => void;
}

function AnalysisEditorView({
  analysisId,
  workspaceVisible = true,
  onOpenAnalysis,
  onOpenAnalysisDatabase,
}: AnalysisEditorProps) {
  const aid = analysisId;
  const workspaceState = useRef(getAnalysisWorkspaceEditorState(aid)).current;
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
  const [activeTab, setActiveTab] = useState<AnalysisTabKey>(
    workspaceState?.activeTab ?? "time_capacity",
  );
  const [timeCapacityVisited, setTimeCapacityVisited] = useState(
    workspaceState?.timeCapacityVisited ?? workspaceState?.activeTab === "time_capacity",
  );
  const [activeSavedPlotId, setActiveSavedPlotId] = useState<string | null>(
    workspaceState?.activeSavedPlotId ?? null,
  );
  const [activePlotBaselineSignature, setActivePlotBaselineSignature] = useState<string | null>(
    workspaceState?.activePlotBaselineSignature ?? null,
  );
  const [timeCapacityNavigationSession, setTimeCapacityNavigationSession] = useState(0);
  const [timeCapacityVirginNavigation, setTimeCapacityVirginNavigation] = useState(false);
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
  const [timeCapacityVoltageChannels, setTimeCapacityVoltageChannels] =
    useState<TimeCapacityResult["voltage_channels"]>(undefined);
  const [chargeabilityReady, setChargeabilityReady] = useState(false);
  const [rateCapabilityReady, setRateCapabilityReady] = useState(false);
  const autosaveSignature = useMemo(
    () => (spec ? JSON.stringify({ title, spec }) : "no-spec"),
    [spec, title]
  );
  const autosaveSignatureRef = useRef(autosaveSignature);
  const protocolSelectionCells = useMemo(
    () =>
      analysis.data && spec
        ? selectedSourceCountCellsForSpec(analysis.data, spec, cellsQuery.data, groupsQuery.data)
        : [],
    [analysis.data, cellsQuery.data, groupsQuery.data, spec],
  );
  // Resolve this from the live draft selection, not only the last persisted
  // AnalysisFull response. Adding/removing a Cell or replicate group must
  // synchronously gate every scientific request before autosave/refetch.
  const hasMetadataOnlySources = selectionHasMetadataOnlySources(protocolSelectionCells);
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
  const maxAvailableTimeCapacityCycle = useMemo(
    () =>
      selectedTimeCapacityCycleMax(
        spec?.selection.entries,
        cellsQuery.data,
        groupsQuery.data,
      ),
    [cellsQuery.data, groupsQuery.data, spec?.selection.entries],
  );

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

  const { result: compute, job: computeJob } = useCyclesResult({
    analysisId: aid,
    spec,
    // These tabs each own a dedicated scientific query. Running the cycle
    // engine beside those queries would duplicate computation without feeding
    // the visible plot.
    enabled:
      spec !== null &&
      initialComputeReady &&
      !hasMetadataOnlySources &&
      !(
        [
          "time_capacity",
          "steps",
          "dcir",
          "chargeability",
          "crate",
        ] as AnalysisTabKey[]
      ).includes(activeTab),
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
      onOpenAnalysis(a.id);
    },
  });

  const remove = useMutation({
    mutationFn: () => del(`/api/analyses/${aid}`),
    onSuccess: async () => {
      clearAnalysisWorkspaceEditorState(aid);
      onOpenAnalysisDatabase();
      await clearAnalysisQueryCache(qc, aid);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
      ]);
    },
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
        .then((saved) => {
          void refreshPersistedAnalysisQueries(qc, aid, saved);
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
      if (tab === "time_capacity") {
        setTimeCapacityNavigationSession((value) => value + 1);
        setTimeCapacityVirginNavigation(false);
      }
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
        void invalidateAnalysisQueries(qc, aid);
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
          <Button w="fit-content" variant="light" onClick={onOpenAnalysisDatabase}>
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
    activePlot && activePlot.tab === activeTab
      ? activePlot.name
      : activeTab === "recap"
        ? "Recap"
        : "Unsaved plot";
  const folderOptions = flattenFolders(treeQuery.data);
  const plotUpdating = Boolean(compute.isFetching && rendered && activeTab === "cycles");

  const toggleCellVisibility = (cellId: number, context: VisibilityContext) => {
    update((s) => {
      const isHidden = s.selection.exclusions.some((exclusion) =>
        exclusionAppliesToContext(exclusion, cellId, context),
      );
      setCellVisibilityInDraft(
        s,
        sampleGroups,
        cellId,
        context,
        visibilityAfterToggle(isHidden),
      );
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

  const setAnalysisEntriesVisibility = (entries: SelectionEntry[], visible: boolean) => {
    update((s) => {
      let hiddenGroups = s.selection.hidden_replicate_group_ids ?? [];
      for (const entry of entries) {
        if (entry.kind === "replicate_group") {
          hiddenGroups = visible
            ? hiddenGroups.filter((id) => id !== entry.ref_id)
            : hiddenGroups.includes(entry.ref_id)
              ? hiddenGroups
              : [...hiddenGroups, entry.ref_id];
          continue;
        }

        setCellVisibilityInDraft(
          s,
          sampleGroups,
          entry.ref_id,
          { kind: "cell", ref_id: entry.ref_id },
          visible,
        );
      }
      s.selection.hidden_replicate_group_ids = hiddenGroups;
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

  const removeAnalysisEntries = (entries: SelectionEntry[]) => {
    const keys = new Set(entries.map(dcirSampleEntryKey));
    update((s) => {
      const removed = s.selection.entries.filter((entry) => keys.has(dcirSampleEntryKey(entry)));
      if (removed.length === 0) return;
      s.selection.entries = s.selection.entries.filter(
        (entry) => !keys.has(dcirSampleEntryKey(entry)),
      );
      s.selection.exclusions = s.selection.exclusions.filter(
        (exclusion) =>
          !removed.some(
            (entry) =>
              exclusion.entry_kind === entry.kind && exclusion.entry_ref_id === entry.ref_id,
          ),
      );
      const removedGroupIds = new Set(
        removed
          .filter((entry) => entry.kind === "replicate_group")
          .map((entry) => entry.ref_id),
      );
      s.selection.hidden_replicate_group_ids = (
        s.selection.hidden_replicate_group_ids ?? []
      ).filter((id) => !removedGroupIds.has(id));
    });
  };

  const removeAnalysisEntry = (index: number) => {
    const entry = spec.selection.entries[index];
    if (entry) removeAnalysisEntries([entry]);
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

  const saveProtocolGroups = (groups: ProtocolFamilyGroup[]) => {
    update((s) => {
      s.protocol_groups = normalizeProtocolGroups(groups);
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
    if (plot.tab === "time_capacity") {
      setTimeCapacityNavigationSession((value) => value + 1);
      setTimeCapacityVirginNavigation(false);
    }
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
    if (plot.tab === "time_capacity") setTimeCapacityVirginNavigation(false);
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
    const family = plotStylePresetFamilyForTab(activeTab);
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
    if (activeTab === "time_capacity") {
      setTimeCapacityNavigationSession((value) => value + 1);
      setTimeCapacityVirginNavigation(true);
    }
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
          void invalidateAnalysisQueries(qc, aid);
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
        void invalidateAnalysisQueries(qc, aid);
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
        void invalidateAnalysisQueries(qc, aid);
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
    hasSamples: hasSamples && !hasMetadataOnlySources,
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
        bulkActionsEnabled={activeTab === "dcir"}
        onSetEntriesVisibility={setAnalysisEntriesVisibility}
        onRemoveEntries={removeAnalysisEntries}
      />
      {(["cycles", "steps", "recap", "time_capacity"] as AnalysisTabKey[]).includes(activeTab) &&
        !hasMetadataOnlySources &&
        (activeTab !== "steps" || activeProtocolPolicy.supported) && (
        <ProtocolSegmentsPanel
          cellIds={protocolCellIds}
          segments={spec.protocol_segments ?? []}
          protocolGroups={spec.protocol_groups ?? []}
          onSaveProtocolGroups={saveProtocolGroups}
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
      {activeTab === "time_capacity" && (
        <TimeCapacitySettings
          spec={spec}
          update={update}
          resetAxis={(s, axis) => resetManualAxis(s, "time_capacity", axis)}
          voltageChannels={timeCapacityVoltageChannels}
        />
      )}
      {activeTab === "cycles" && (
        <CycleSettings
          spec={spec}
          result={displayResult}
          update={update}
          resetAxis={(s, axis) => resetManualAxis(s, "cycles", axis)}
        />
      )}
      {activeTab === "steps" && !hasMetadataOnlySources && activeProtocolPolicy.supported && (
        <StepsSettings
          analysisId={aid}
          spec={spec}
          cells={currentAnalysis.selection_cells}
          update={update}
        />
      )}
      {activeTab === "dcir" && !hasMetadataOnlySources && activeProtocolPolicy.supported && (
        <DcirSettings
          analysisId={aid}
          spec={spec}
          cells={currentAnalysis.selection_cells}
          update={update}
        />
      )}
      {activeTab === "chargeability" && !hasMetadataOnlySources && activeProtocolPolicy.supported && (
        <ChargeabilitySettings
          analysisId={aid}
          spec={spec}
          update={update}
        />
      )}
      {activeTab === "crate" && !hasMetadataOnlySources && activeProtocolPolicy.supported && (
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
    newPlotEnabled: hasSamples && activeProtocolPolicy.supported && !hasMetadataOnlySources,
    onUpdatePlot: draftPlotSession
      ? () =>
          setSaveDraft({
            name: suggestedPlotName(activeTab, displayResult, spec),
            description: "",
            source: "live",
          })
      : updateActivePlot,
    updatePlotEnabled: !hasMetadataOnlySources && activeProtocolPolicy.supported && (draftPlotSession
      ? true
      : Boolean(activeSavedPlotId && activePlotDirty && activePlot?.tab === activeTab)),
    updatePlotLabel: draftPlotSession ? "Save as" : "Update",
  };

  const plotSurfaceFor = (tab: AnalysisTabKey, card: ReactNode) => {
    if (hasMetadataOnlySources && tab !== "settings") {
      return <CanonicalCyclingUnavailableState />;
    }
    const policy = protocolPolicyForTab(tab);
    if (policy.family && !policy.supported) {
      return <ProtocolMappingRequiredState policy={policy} />;
    }
    if (!analysisTabRequiresPlotSession(tab)) return card;
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
      <SavedPlotsPanel
        analysisId={aid}
        activeTab={tab}
        baseSpec={spec}
        plots={spec.saved_plots ?? []}
        activeSavedPlotId={activeSavedPlotId}
        activePlotDirty={activePlotDirty}
        hasSamples={hasSamples}
        canSaveNew={!hasMetadataOnlySources && activeTabPlotSession && tab === activeTab}
        draft={null}
        liveUnsaved={liveUnsavedDraft && tab === activeTab}
        onOpenDraft={() => {
          setActiveSavedPlotId(null);
          setActivePlotBaselineSignature(null);
          setPlotWorkspaceTouched(true);
          setPlotSessionActive(true);
          setActiveTab(tab);
        }}
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
        allowPreviewGeneration={!hasMetadataOnlySources && (
          tab === "time_capacity"
            ? timeCapacityReady
            : tab === "chargeability"
              ? chargeabilityReady
              : tab === "crate"
                ? rateCapabilityReady
                : tab === "cycles" || tab === "recap"
                  ? cycleLivePlotReady
                  : true
        )}
      />
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
          <PortableReportFlow
            analysisId={aid}
            title={title}
            spec={spec}
            analysis={analysis.data}
            availableCells={cellsQuery.data}
            availableGroups={groupsQuery.data}
            sourceCompatibilityPending={activeProtocolPolicy.pending}
            normalizeSpec={normalizeSpec}
            persistSpec={buildPersistPayload}
          />
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
      {hasMetadataOnlySources && (
        <Alert color="orange" title="Analysis unavailable for metadata-only sources">
          One or more selected BioLogic sources has readable metadata but no independently verified canonical cycling rows. Cache-backed plots and recompute remain disabled until a verified cycle identity is available.
        </Alert>
      )}

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
                  computeJob={computeJob}
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
                    maxAvailableCycle={maxAvailableTimeCapacityCycle}
                    isVirginNavigation={
                      timeCapacityVirginNavigation && activeSavedPlotId === null
                    }
                    navigationResetKey={`${aid}:${timeCapacityNavigationSession}:${activeSavedPlotId ?? "draft"}`}
                    active={activeTab === "time_capacity"}
                    onReadyChange={setTimeCapacityReady}
                    onVoltageChannelsChange={setTimeCapacityVoltageChannels}
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
            {displayResult && (() => {
              const savedParserVersion = currentAnalysis.provenance?.parser_version;
              const mixedSources =
                savedParserVersion === "mixed"
                  ? parserSourceBreakdown(currentAnalysis.provenance?.sources)
                  : [];
              return (
              <Paper p="sm" withBorder>
                <Group justify="space-between">
                  <div>
                    <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                      Provenance
                    </Text>
                    <Text size="xs" c="dimmed">
                      {currentAnalysis.provenance ? (
                        <>
                          {`Last saved: ${new Date(currentAnalysis.provenance.computed_at).toLocaleString()} - parser `}
                          {mixedSources.length > 0 ? (
                            <Tooltip
                              multiline
                              w={260}
                              label={
                                <Stack gap={2}>
                                  {mixedSources.map((entry) => (
                                    <Text key={`${entry.position}-${entry.parserVersion}`} size="xs">
                                      {`#${entry.position} ${entry.filename ?? "source"}: ${entry.parserVersion}`}
                                    </Text>
                                  ))}
                                </Stack>
                              }
                            >
                              <Text component="span" td="underline" style={{ cursor: "help" }}>
                                mixed
                              </Text>
                            </Tooltip>
                          ) : (
                            savedParserVersion
                          )}
                          {` - calc ${currentAnalysis.provenance.calc_version} - ${currentAnalysis.provenance.sources.length} cell(s)`}
                        </>
                      ) : (
                        "Never saved. Save to pin versions and file hashes."
                      )}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Rendering at parser {displayResult.parser_version} / calc {displayResult.calc_version}
                      {displayResult.parser_version !== displayResult.current_parser_version ||
                      displayResult.calc_version !== displayResult.current_calc_version
                        ? ` - current is ${displayResult.current_parser_version} / ${displayResult.current_calc_version}`
                        : " (current)"}
                    </Text>
                  </div>
                  <Tooltip label={hasMetadataOnlySources ? "Recompute is unavailable for metadata-only sources" : "Render with current parser/calc versions and pin new provenance"}>
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconRefresh size={14} />}
                      loading={recompute.isPending}
                      disabled={hasMetadataOnlySources}
                      onClick={() => recompute.mutate()}
                    >
                      Recompute
                    </Button>
                  </Tooltip>
                </Group>
              </Paper>
              );
            })()}
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

export const AnalysisEditor = memo(AnalysisEditorView);
