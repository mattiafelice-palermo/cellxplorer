import {
  ActionIcon,
  Accordion,
  Alert,
  Badge,
  Box,
  Center,
  Group,
  LoadingOverlay,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";
import PlotlyLib from "plotly.js-dist-min";

import {
  get,
  post,
  type AnalysisSpec,
  type BackgroundJob,
  type ComputeResult,
  type PlotExportFormat,
  type PlotStyle,
  type SeriesStyleOverride,
  type SeriesStyleRule,
} from "../../../../../api";
import { DebouncedNumberInput } from "../../../../../components/DebouncedInputs";
import Plot from "../../../../../components/Plot";
import {
  DIAGNOSTIC_DEFAULTS,
  findDiagnosticCyclesAcross,
  formatCycleRanges,
  summarizeHidden,
} from "./diagnosticCycles";
import { getCycleQuantityExplainer } from "../../plotting/plotExplainers";
import { PlotHeader, ComputeProgress } from "../../plotting/PlotHeader";
import { PlotStylePanel } from "../../plotting/PlotStylePanel";
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
  cePalette,
  hexToRgba,
  plotMode,
  plotPalette,
  writeScopedStyle,
} from "../../plotting/plotStyle";
import { paletteColorAt, paletteOverflowMode } from "../../plotting/paletteDraft";
import {
  hiddenSeriesIdsAfterShowAll,
  hiddenSeriesIdsAfterShowOnly,
  isAnalysisSampleHidden,
  plotSeriesVisibilityItems,
} from "../../policies/analysisVisibility";
import {
  aggregateSeriesDescriptor,
  cellSeriesDescriptor,
  composeSeriesKey,
  decimatePreviewTraces,
  resolveAllSeriesStyles,
  seriesLegendRanks,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  shortSourceName,
  type BaseSeriesStyle,
  type SeriesDescriptor,
} from "../../plotting/seriesStyling";
import {
  sourceBoundaryPointIndices,
  sourceExportColumns,
} from "../../plotting/sourceChainPlot";
import {
  cycleCeSeriesKey,
  cycleCeVisibilityKey,
  cycleSeriesVisibilityCandidatesForResult,
  cycleTraceEmissionPlan,
  cycleTraceVisibility,
  cycleVisibilityKey,
} from "./cycleVisibility";
import type { CycleSelectableTraceMeta } from "./cyclePointSelectionPolicy";
import { withoutCyclePointSelectionMetadata } from "./cyclePointSelectionPolicy";
import {
  CyclePointInspector,
  CyclePointSelectionOverlay,
} from "./CyclePointInspector";
import { useCyclePointSelection } from "./useCyclePointSelection";

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

export type ResolvedCycleQuantity = {
  key: string;
  column: string;
  label: string;
};

export function normalizeLegacyCycleQuantityKey(value: string): string {
  return LEGACY_NORMALIZED_QUANTITY_MAP[value] ?? value;
}

export function isMassNormalizableCycleQuantity(quantity: string): boolean {
  return quantity in NORMALIZED_QUANTITY_MAP;
}

export function resolveCycleQuantity(
  result: ComputeResult | undefined,
  spec: AnalysisSpec,
): ResolvedCycleQuantity {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const baseInfo = result?.quantities.find((q) => q.key === quantity);
  if (spec.presentation.normalize_by_mass && isMassNormalizableCycleQuantity(quantity)) {
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

export function cycleQuantityLabel(result: ComputeResult | undefined, spec: AnalysisSpec): string {
  return resolveCycleQuantity(result, spec).label;
}

export function computeSignature(spec: AnalysisSpec | null): string {
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

export type UseCyclesResultArgs = {
  analysisId: number;
  spec: AnalysisSpec | null;
  enabled: boolean;
};

export function useCyclesResult({
  analysisId,
  spec,
  enabled,
}: UseCyclesResultArgs): {
  result: UseQueryResult<ComputeResult, Error>;
  job: BackgroundJob | undefined;
} {
  const [computeToken, setComputeToken] = useState<string | null>(null);
  const result = useQuery<ComputeResult, Error>({
    queryKey: ["compute", analysisId, computeSignature(spec)],
    queryFn: async () => {
      if (!spec) throw new Error("Cycles compute requires an analysis spec");
      const token = newComputeToken();
      setComputeToken(token);
      try {
        return await post<ComputeResult>(`/api/analyses/${analysisId}/compute`, {
          spec,
          job_token: token,
        });
      } finally {
        window.setTimeout(
          () => setComputeToken((current) => (current === token ? null : current)),
          300,
        );
      }
    },
    enabled: enabled && spec !== null,
    staleTime: 5 * 60_000,
  });
  const jobQuery = useQuery<BackgroundJob | null, Error>({
    queryKey: ["background-job-token", computeToken],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${computeToken}`),
    enabled: computeToken !== null,
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 300 : false,
  });
  return { result, job: jobQuery.data ?? undefined };
}

function bandSegmentTraces(
  x: number[],
  low: (number | null)[],
  high: (number | null)[],
  color: string,
  opacity: number,
  name: string,
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

export function withoutDiagnosticCycles(
  result: ComputeResult,
  hidden: Set<number>,
  reindex = false,
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
    for (const series of result.cell_series) {
      for (const cycle of series.x) if (!hidden.has(cycle)) surviving.add(cycle);
    }
    for (const agg of result.aggregates) {
      for (const cycle of agg.x) if (!hidden.has(cycle)) surviving.add(cycle);
    }
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
          ]),
        ),
      };
    }),
    cell_series: result.cell_series.map((series) => {
      const indices = keptIndices(series.x);
      return {
        ...series,
        x: remapX(take(series.x, indices)),
        quantities: Object.fromEntries(
          Object.entries(series.quantities).map(([key, values]) => [key, take(values, indices)]),
        ),
        source_cycle: take(series.source_cycle, indices),
        source_position: take(series.source_position, indices),
        source_filename: take(series.source_filename, indices),
        source_hash: take(series.source_hash, indices),
      };
    }),
  };
}

export function cycleSeriesIsHidden(
  series: Pick<ComputeResult["cell_series"][number], "cell_id" | "group_id" | "excluded">,
  spec: AnalysisSpec,
): boolean {
  return isAnalysisSampleHidden(spec, series);
}

/** The diagnostic cycles this spec asks to hide, or an empty set when off. */
export function diagnosticCyclesFor(result: ComputeResult, spec: AnalysisSpec): Set<number> {
  if (!spec.presentation.hide_diagnostic_cycles) return new Set();
  return findDiagnosticCyclesAcross(
    result.cell_series.filter((s) => !cycleSeriesIsHidden(s, spec)),
    {
      tolerance: spec.presentation.diagnostic_tolerance ?? DIAGNOSTIC_DEFAULTS.tolerance,
      formationCycles: spec.computation.formation_cycles,
    },
  );
}

/** Primary CellXplorer visibility targets for the current Cycles plot. */
export function cycleSeriesVisibilityCandidates(
  original: ComputeResult,
  spec: AnalysisSpec,
): { key: string; label: string }[] {
  const result = withoutDiagnosticCycles(
    original,
    diagnosticCyclesFor(original, spec),
    spec.presentation.reindex_diagnostic_cycles ?? false,
  );
  const { column } = resolveCycleQuantity(result, spec);
  const showCeOverlay =
    (spec.presentation.ce_overlay ?? false) &&
    CAPACITY_LIKE_KEYS.has(spec.presentation.quantity ?? "discharge_capacity");
  const showIndividual =
    spec.presentation.show_individual_cells || result.aggregates.length === 0;
  return cycleSeriesVisibilityCandidatesForResult(result, spec, {
    column,
    showIndividual,
    includeCoulombicEfficiency: showCeOverlay,
  });
}

function aggregateContributorCellIds(
  result: ComputeResult,
  groupId: number,
  quantityColumn: string,
  scientificCycles: number[],
): number[][] {
  const eligibleCyclesByCell = result.cell_series
    .filter((series) => series.group_id === groupId && !series.excluded)
    .map((series) => {
      const values = series.quantities[quantityColumn] ?? [];
      const eligibleCycles = new Set<number>();
      series.x.forEach((cycle, index) => {
        const value = values[index];
        if (value !== null && value !== undefined && Number.isFinite(value)) {
          eligibleCycles.add(cycle);
        }
      });
      return { cellId: series.cell_id, eligibleCycles };
    });
  return scientificCycles.map((cycle) => [
    ...new Set(
      eligibleCyclesByCell
        .filter(({ eligibleCycles }) => eligibleCycles.has(cycle))
        .map(({ cellId }) => cellId),
    ),
  ]);
}

export function cycleTracesForResult(
  original: ComputeResult,
  spec: AnalysisSpec,
  compact = false,
  includePointSelectionMetadata = false,
): Plotly.Data[] {
  // Filter here rather than at each call site so the live plot, the saved
  // thumbnail and the exported figure cannot disagree about what is shown.
  const hiddenDiagnosticCycles = diagnosticCyclesFor(original, spec);
  const result = withoutDiagnosticCycles(
    original,
    hiddenDiagnosticCycles,
    spec.presentation.reindex_diagnostic_cycles ?? false,
  );
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = resolveCycleQuantity(result, spec);
  const { column } = quantityInfo;
  const showCeOverlay =
    !compact && (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const style = currentPlotStyle(spec, "cycles");
  const palette = plotPalette(style);
  const secondaryPalette = cePalette(style);
  const mode = compact ? "lines" : plotMode(style);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  const paletteOverflow = paletteOverflowMode(style.palette_overflow_mode);
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) {
      colorFor.set(key, style.custom_colors[key] ?? paletteColorAt(palette, ci++, paletteOverflow));
    }
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

  const soloOrIndividual = (s: ComputeResult["cell_series"][number]) =>
    compact ||
    s.group_id === null ||
    spec.presentation.show_individual_cells ||
    result.aggregates.length === 0;

  const ceDescriptorFor = (
    primary: SeriesDescriptor,
    sourceKey: string,
    label: string,
  ): SeriesDescriptor => ({
    key: composeSeriesKey({ sourceKey, axis: "y2", measure: "coulombic_efficiency" }),
    kind: primary.kind,
    label,
    cellName: primary.cellName,
    groupName: primary.groupName,
    plot: 0,
    axis: "y2",
    measure: "coulombic_efficiency",
    sourceKey,
    visibilityKey: cycleCeVisibilityKey(sourceKey),
    secondarySuffix: " CE",
  });

  // Every stylable series, primary and CE, in draw order — the same order the
  // trace-building loops below walk, so baseFor reproduces the legacy palette
  // cycling call order exactly.
  const descriptors: SeriesDescriptor[] = [];
  const colorKeyFor = new Map<string, string>();
  for (const agg of result.aggregates) {
    const aggDescriptor = aggregateSeriesDescriptor(agg, compact);
    aggDescriptor.visibilityKey = cycleVisibilityKey(aggDescriptor.key);
    colorKeyFor.set(aggDescriptor.key, `g${agg.group_id}`);
    descriptors.push(aggDescriptor);
    if (showCeOverlay && agg.quantities[column] && agg.quantities["coulombic_efficiency_pct"]) {
      descriptors.push(ceDescriptorFor(aggDescriptor, `g${agg.group_id}`, `${agg.group_name} CE`));
    }
  }
  for (const s of result.cell_series) {
    if (cycleSeriesIsHidden(s, spec) || !soloOrIndividual(s)) continue;
    const grouped = s.group_id !== null;
    const descriptor = cellSeriesDescriptor(s);
    descriptor.visibilityKey = cycleVisibilityKey(descriptor.key);
    colorKeyFor.set(descriptor.key, grouped ? `g${s.group_id}` : `c${s.cell_id}`);
    descriptors.push(descriptor);
    if (showCeOverlay && !grouped && s.quantities["coulombic_efficiency_pct"]) {
      descriptors.push(ceDescriptorFor(descriptor, `c${s.cell_id}`, `${s.label} CE`));
    }
  }

  const baseFor = (d: SeriesDescriptor): BaseSeriesStyle => {
    if (d.measure === "coulombic_efficiency") {
      return {
        color: pickCe(d.sourceKey ?? ""),
        lineWidth: style.ce_line_width,
        lineDash: style.ce_line_dash,
        markerMode: style.ce_marker_mode,
        markerSymbol: style.ce_marker_symbol,
        markerSize: style.ce_marker_size,
        markerOpen: style.ce_marker_open,
        opacity: style.ce_opacity,
      };
    }
    const color = pick(colorKeyFor.get(d.key) ?? d.key);
    if (d.kind === "group") {
      return {
        color,
        lineWidth: compact ? 2 : style.line_width,
        lineDash: compact ? "solid" : style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: compact ? 3 : style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      };
    }
    const grouped = d.groupName !== null;
    return {
      color,
      lineWidth: compact ? 1.3 : grouped ? Math.max(1, style.line_width - 1.2) : style.line_width,
      lineDash: compact ? "solid" : style.line_dash,
      markerMode: style.marker_mode,
      markerSymbol: style.marker_symbol,
      markerSize: compact ? 3 : style.marker_size,
      markerOpen: style.marker_open,
      opacity: compact ? 0.45 : grouped ? style.individual_opacity : 0.95,
    };
  };

  const resolvedStyles = resolveAllSeriesStyles({
    descriptors,
    baseFor,
    rules: style.series_rules,
    overrides: style.series_overrides,
    linkSecondaryColors: style.link_secondary_colors ?? false,
    secondaryNameMode: style.secondary_name_mode ?? "independent",
    secondaryNameSuffix: style.secondary_name_suffix ?? null,
  });
  const legendRanks = seriesLegendRanks(descriptors, style.series_order);

  for (const [aggregateIndex, agg] of result.aggregates.entries()) {
    const aggKey = `g${agg.group_id}`;
    const q = agg.quantities[column];
    if (!q) continue;
    const aggResolved = resolvedStyles.get(aggKey);
    const ceKey = cycleCeSeriesKey(aggKey);
    const ceResolved = resolvedStyles.get(ceKey);
    const aggregateEmission = cycleTraceEmissionPlan(spec, aggKey, {
      primary: Boolean(aggResolved && !aggResolved.hidden),
      ce: Boolean(
        showCeOverlay &&
          agg.quantities["coulombic_efficiency_pct"] &&
          ceResolved &&
          !ceResolved.hidden,
      ),
    });
    const scientificCycles = (original.aggregates[aggregateIndex]?.x ?? agg.x).filter(
      (cycle) => !hiddenDiagnosticCycles.has(cycle),
    );
    const primaryDetailCellIds = aggregateContributorCellIds(
      original,
      agg.group_id,
      column,
      scientificCycles,
    );
    const primarySelectionMeta: CycleSelectableTraceMeta = {
      cellxplorerCycleSelection: {
        version: 1,
        seriesKey: aggKey,
        sampleKind: "replicate",
        cellId: null,
        groupId: agg.group_id,
        sampleLabel: agg.group_name,
        scientificCycles,
        detailCellIds: primaryDetailCellIds,
        quantityKey: quantityInfo.key,
        quantityLabel: quantityInfo.label,
        axis: "y",
      },
    };
    if (aggregateEmission.primary && aggResolved) {
      if (!compact) {
        out.push(
          ...bandSegmentTraces(
            agg.x,
            q.band_low,
            q.band_high,
            aggResolved.color,
            style.band_opacity,
            `${agg.group_name} band`,
          ),
        );
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
        legendrank: legendRanks.get(aggKey),
        type: "scatter",
        mode: compact ? mode : seriesPlotlyMode(aggResolved),
        ...(includePointSelectionMetadata ? { meta: primarySelectionMeta } : {}),
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
    }
    if (aggregateEmission.ce && ceResolved) {
      const ceDetailCellIds = aggregateContributorCellIds(
        original,
        agg.group_id,
        "coulombic_efficiency_pct",
        scientificCycles,
      );
      const ceSelectionMeta: CycleSelectableTraceMeta = {
        cellxplorerCycleSelection: {
          version: 1,
          seriesKey: ceKey,
          sampleKind: "replicate",
          cellId: null,
          groupId: agg.group_id,
          sampleLabel: agg.group_name,
          scientificCycles,
          detailCellIds: ceDetailCellIds,
          quantityKey: "coulombic_efficiency_pct",
          quantityLabel: "Coulombic efficiency (%)",
          axis: "y2",
        },
      };
      out.push({
        x: agg.x,
        y: agg.quantities["coulombic_efficiency_pct"]!.mean,
        name: ceResolved.name,
        yaxis: "y2",
        line: { color: ceResolved.color, width: ceResolved.lineWidth, dash: ceResolved.lineDash },
        marker: {
          color: ceResolved.color,
          size: ceResolved.markerSize,
          symbol: seriesPlotlySymbol(ceResolved),
        },
        type: "scatter",
        mode: seriesPlotlyMode(ceResolved),
        opacity: ceResolved.opacity,
        showlegend: ceResolved.showInLegend,
        legendrank: legendRanks.get(ceKey),
        ...(includePointSelectionMetadata ? { meta: ceSelectionMeta } : {}),
      } as Plotly.Data);
    }
  }

  for (const [seriesIndex, s] of result.cell_series.entries()) {
    const cellKey = `c${s.cell_id}`;
    if (cycleSeriesIsHidden(s, spec) || !soloOrIndividual(s)) continue;
    const grouped = s.group_id !== null;
    const resolved = resolvedStyles.get(cellKey);
    const ceKey = cycleCeSeriesKey(cellKey);
    const ceResolved = resolvedStyles.get(ceKey);
    const cellEmission = cycleTraceEmissionPlan(spec, cellKey, {
      primary: Boolean(resolved && !resolved.hidden),
      ce: Boolean(
        showCeOverlay &&
          !grouped &&
          s.quantities["coulombic_efficiency_pct"] &&
          ceResolved &&
          !ceResolved.hidden,
      ),
    });
    const sourceCycle = s.source_cycle ?? s.x.map(() => null);
    const sourcePosition = s.source_position ?? s.x.map(() => null);
    const sourceFilename = s.source_filename ?? s.x.map(() => null);
    const sourceHash = s.source_hash ?? s.x.map(() => null);
    const scientificCycles = (original.cell_series[seriesIndex]?.x ?? s.x).filter(
      (cycle) => !hiddenDiagnosticCycles.has(cycle),
    );
    const sourceColumns = sourceExportColumns(
      s.label,
      s.x,
      sourceCycle,
      sourcePosition,
      sourceFilename,
      sourceHash,
    );
    const values = s.quantities[column] ?? [];
    if (cellEmission.primary && resolved) {
      const color = grouped ? pick(`g${s.group_id}`) : pick(cellKey);
      const customdata = scientificCycles.map((cycle, index) => [
        cycle,
        sourceCycle[index] ?? "",
        sourcePosition[index] ?? "",
        shortSourceName(String(sourceFilename[index] ?? "")),
      ]);
      const primarySelectionMeta: CycleSelectableTraceMeta = {
        cellxplorerCycleSelection: {
          version: 1,
          seriesKey: cellKey,
          sampleKind: "cell",
          cellId: s.cell_id,
          groupId: s.group_id,
          sampleLabel: s.label,
          scientificCycles,
          detailCellIds: scientificCycles.map(() => [s.cell_id]),
          localCycles: sourceCycle,
          sourcePositions: sourcePosition,
          sourceFilenames: sourceFilename,
          quantityKey: quantityInfo.key,
          quantityLabel: quantityInfo.label,
          axis: "y",
        },
      };
      out.push({
        x: s.x,
        y: values,
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
        legendrank: legendRanks.get(cellKey),
        ...(includePointSelectionMetadata ? { meta: primarySelectionMeta } : {}),
        customdata,
        cellxplorer_export_columns: sourceColumns,
        hovertemplate:
          `cycle %{customdata[0]}: %{y:.4f}<br>local cycle %{customdata[1]}<br>` +
          `%{customdata[3]} (source %{customdata[2]})<extra>${s.label}</extra>`,
      } as Plotly.Data);
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
    }
    if (cellEmission.ce && ceResolved) {
      const ceSelectionMeta: CycleSelectableTraceMeta = {
        cellxplorerCycleSelection: {
          version: 1,
          seriesKey: ceKey,
          sampleKind: "cell",
          cellId: s.cell_id,
          groupId: s.group_id,
          sampleLabel: s.label,
          scientificCycles,
          detailCellIds: scientificCycles.map(() => [s.cell_id]),
          localCycles: sourceCycle,
          sourcePositions: sourcePosition,
          sourceFilenames: sourceFilename,
          quantityKey: "coulombic_efficiency_pct",
          quantityLabel: "Coulombic efficiency (%)",
          axis: "y2",
        },
      };
      out.push({
        x: s.x,
        y: s.quantities["coulombic_efficiency_pct"],
        name: ceResolved.name,
        yaxis: "y2",
        line: { color: ceResolved.color, width: ceResolved.lineWidth, dash: ceResolved.lineDash },
        marker: {
          color: ceResolved.color,
          size: ceResolved.markerSize,
          symbol: seriesPlotlySymbol(ceResolved),
        },
        type: "scatter",
        mode: seriesPlotlyMode(ceResolved),
        opacity: ceResolved.opacity,
        showlegend: ceResolved.showInLegend,
        legendrank: legendRanks.get(ceKey),
        ...(includePointSelectionMetadata ? { meta: ceSelectionMeta } : {}),
      } as Plotly.Data);
    }
  }
  return out;
}

export function cyclePlotLayout(
  result: ComputeResult | undefined,
  spec: AnalysisSpec,
  traces: Plotly.Data[] = [],
): Partial<Plotly.Layout> {
  const style = currentPlotStyle(spec, "cycles");
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = resolveCycleQuantity(result, spec);
  const showCeOverlay =
    (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const lm = legendMargins(style, spec.presentation.legend);
  const leftGap = axisGapDelta(style.y_axis);
  const bottomGap = axisGapDelta(style.x_axis);
  const rightGap = showCeOverlay ? axisGapDelta(style.y2_axis) : 0;
  const rightMargin = Math.max(
    (showCeOverlay ? 64 : 24) + rightGap,
    lm.r ? lm.r + 24 : 0,
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
    // Keep the user's zoom/pan across style edits, but reset the view when
    // the data or the plotted quantity changes.
    uirevision: `${result?.computed_at ?? "no-data"}|${quantity}|${
      spec.presentation.normalize_by_mass ? "g" : "abs"
    }|${spec.presentation.reindex_diagnostic_cycles ? "reidx" : "noreidx"}`,
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
      zeroline: style.show_zero_line,
      zerolinecolor: "#adb5bd",
      title: {
        text: style.y_title ?? quantityInfo.label,
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

function isPolarizationQuantity(quantity: string): boolean {
  return quantity === "polarization" || quantity === "polarization_pct";
}

export function CycleSettings({
  spec,
  result,
  update,
  resetAxis,
}: {
  spec: AnalysisSpec;
  result: ComputeResult | undefined;
  update: (fn: (s: AnalysisSpec) => void) => void;
  resetAxis: (spec: AnalysisSpec, axis: "x_axis" | "y_axis") => void;
}) {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const polarizationSelected = isPolarizationQuantity(quantity);
  const canNormalizeByMass = isMassNormalizableCycleQuantity(quantity);
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
                    if (!isMassNormalizableCycleQuantity(v)) s.presentation.normalize_by_mass = false;
                    resetAxis(s, "y_axis");
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
                      resetAxis(s, "y_axis");
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
              <Group gap={4} wrap="nowrap">
                <Switch
                  label="Hide diagnostic cycles"
                  checked={spec.presentation.hide_diagnostic_cycles ?? false}
                  onChange={(e) =>
                    update((s) => {
                      s.presentation.hide_diagnostic_cycles = e.currentTarget.checked;
                      resetAxis(s, "y_axis");
                    })
                  }
                />
                <Tooltip
                  label={
                    `For each cell, the filter takes the lower of charge and discharge capacity. ` +
                    `After the first ${spec.computation.formation_cycles} formation cycles, it ` +
                    `compares that value with the median of the neighbouring post-formation ` +
                    `${DIAGNOSTIC_DEFAULTS.window}-cycle window. A cycle is hidden when its ` +
                    `lower capacity is more than ${Math.round(
                      (spec.presentation.diagnostic_tolerance ?? DIAGNOSTIC_DEFAULTS.tolerance) * 100,
                    )}% ` +
                    `below that local median. The percentage below controls this cutoff; the ` +
                    `filter is display-only and does not use DCIR recognition.`
                  }
                  multiline
                  maw={360}
                  withArrow
                  openDelay={300}
                >
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    aria-label="How diagnostic cycles are detected"
                  >
                    <IconInfoCircle size={15} />
                  </ActionIcon>
                </Tooltip>
              </Group>
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
                        resetAxis(s, "x_axis");
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
                    (s) =>
                      void (s.aggregation.dispersion = v as AnalysisSpec["aggregation"]["dispersion"]),
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
                          v as AnalysisSpec["computation"]["polarization"]["method"]),
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
                          v as AnalysisSpec["computation"]["polarization"]["direction"]),
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
                    (s) =>
                      void (s.computation.retention_reference.mode =
                        v as "max_first_n" | "cycle"),
                  )
                }
              />
              {spec.computation.retention_reference.mode === "max_first_n" ? (
                <DebouncedNumberInput
                  label="First N"
                  min={1}
                  value={spec.computation.retention_reference.n}
                  onCommit={(v) =>
                    update((s) => void (s.computation.retention_reference.n = v ?? 5))
                  }
                />
              ) : (
                <DebouncedNumberInput
                  label="Reference cycle"
                  min={1}
                  value={spec.computation.retention_reference.cycle ?? 3}
                  onCommit={(v) =>
                    update((s) => void (s.computation.retention_reference.cycle = v ?? 3))
                  }
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

export function CyclePlotCard({
  analysisId,
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
  analysisId: number;
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
  const selectionContainerRef = useRef<HTMLDivElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const plotSizeContainerRef = useRef(containerRef);
  plotSizeContainerRef.current = containerRef;
  const attachSelectionContainer = useCallback((node: HTMLDivElement | null) => {
    selectionContainerRef.current = node;
    plotSizeContainerRef.current(node);
  }, []);
  // Rebuild traces/layout only when the fields they actually read change —
  // unrelated spec edits (other tabs' styles, persistence echoes) must not
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
        normalize: spec.presentation.normalize_by_mass ?? false,
        ce: spec.presentation.ce_overlay,
        individual: spec.presentation.show_individual_cells,
        legend: spec.presentation.legend,
        hideDiagnostics: spec.presentation.hide_diagnostic_cycles ?? false,
        reindexDiagnostics: spec.presentation.reindex_diagnostic_cycles ?? false,
        diagnosticTolerance: spec.presentation.diagnostic_tolerance ?? null,
        formationCycles: spec.computation.formation_cycles,
        visibility: {
          exclusions: spec.selection.exclusions,
          hiddenReplicateGroups: spec.selection.hidden_replicate_group_ids ?? [],
          hiddenSeries: spec.presentation.hidden_series_ids ?? [],
        },
        style: currentPlotStyle(spec, "cycles"),
      }),
    [spec],
  );
  // Build one canonical SVG-capable trace set, then change only the renderer
  // type for the interactive graph. Data, style, order and layout stay shared.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selectableTraces = useMemo(
    () => (result ? cycleTracesForResult(result, spec, false, true) : []),
    [result, viewSignature],
  );
  const exportTraces = useMemo(
    () => withoutCyclePointSelectionMetadata(selectableTraces),
    [selectableTraces],
  );
  const traces = useMemo(() => interactivePlotTraces(selectableTraces), [selectableTraces]);
  const pointSelectionIdentity = useMemo(
    () =>
      JSON.stringify({
        result: {
          dataSignature: result?.data_signature ?? "no-data",
          computedAt: result?.computed_at ?? "no-data",
        },
        quantity: spec.presentation.quantity,
        normalize: spec.presentation.normalize_by_mass ?? false,
        diagnostics: {
          hidden: spec.presentation.hide_diagnostic_cycles ?? false,
          reindexed: spec.presentation.reindex_diagnostic_cycles ?? false,
          tolerance: spec.presentation.diagnostic_tolerance ?? null,
        },
        formationCycles: spec.computation.formation_cycles,
        aggregation: spec.aggregation,
        entries: spec.selection.entries,
      }),
    [result?.computed_at, result?.data_signature, spec],
  );
  const pointSelection = useCyclePointSelection({
    traces,
    graphDivRef: plotDivRef,
    containerRef: selectionContainerRef,
    selectionIdentity: pointSelectionIdentity,
  });
  const diagnostics = useMemo(() => {
    if (!result || !spec.presentation.hide_diagnostic_cycles) return null;
    const hidden = diagnosticCyclesFor(result, spec);
    const everyCycle = result.cell_series
      .filter((s) => !cycleSeriesIsHidden(s, spec))
      .flatMap((s) => s.x);
    return summarizeHidden(everyCycle, hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    result,
    viewSignature,
    spec.computation.formation_cycles,
    spec.presentation.hide_diagnostic_cycles,
    spec.presentation.diagnostic_tolerance,
  ]);
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
    [result, viewSignature, exportTraces],
  );
  const style = currentPlotStyle(spec, "cycles");
  const plotConfig = useMemo(
    () => ({
      displaylogo: false,
      edits: { legendPosition: style.legend_mode !== "outside" },
    }),
    [style.legend_mode],
  );
  const seriesVisibilityCandidates = useMemo(
    () => (result ? cycleSeriesVisibilityCandidates(result, spec) : []),
    [result, spec],
  );
  const seriesVisibilityItems = useMemo(
    () => plotSeriesVisibilityItems(seriesVisibilityCandidates, spec),
    [seriesVisibilityCandidates, spec],
  );
  const showOnlySeries = (key: string) =>
    update((draft) => {
      draft.presentation.hidden_series_ids = hiddenSeriesIdsAfterShowOnly(
        draft.presentation.hidden_series_ids,
        seriesVisibilityCandidates,
        key,
      );
    });
  const showAllSeries = () =>
    update((draft) => {
      draft.presentation.hidden_series_ids = hiddenSeriesIdsAfterShowAll(
        draft.presentation.hidden_series_ids,
        seriesVisibilityCandidates,
      );
    });
  const explainer = getCycleQuantityExplainer(
    spec.presentation.quantity ?? "discharge_capacity",
    Boolean(spec.presentation.normalize_by_mass),
  );
  const rememberPlotDiv = (graphDiv: unknown) => {
    const element = graphDiv as HTMLElement;
    plotDivRef.current = element;
    const rect = element.getBoundingClientRect();
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    setPlotSize((current) =>
      current && current.width === next.width && current.height === next.height ? current : next,
    );
  };
  const updatePlotStyle = (fn: (style: PlotStyle) => void) => {
    update((s) => writeScopedStyle(s, "cycles", fn));
  };
  const handlePlotRelayout = (event: Readonly<Plotly.PlotRelayoutEvent>) => {
    zoom.onRelayout(event);
    window.requestAnimationFrame(pointSelection.invalidateGeometry);
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

  const getExportPreview = async (exportStyle: PlotStyle = style): Promise<string | null> => {
    if (!plotDivRef.current || exportTraces.length === 0) return null;
    const plan = resolveExportPlan(exportStyle, currentViewSize(), layout);
    const toImage = (
      PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
    ).toImage;
    const previewTraces = exportStyle.export_format === "png" ? traces : exportTraces;
    return toImage(exportFigure(previewTraces, layout, exportStyle, plotName, plan), {
      format: "png",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      scale: Math.min(1, 420 / plan.layoutWidth),
    });
  };

  const handleDataExport = (baseName: string, exportStyle: PlotStyle = style) => {
    downloadDataExport(tracesToColumns(exportTraces, layout), exportStyle, baseName).catch(
      (e: Error) => notifications.show({ message: e.message || "Data export failed.", color: "red" }),
    );
  };

  const exportPlot = async (
    format: PlotExportFormat,
    baseName: string,
    exportStyle: PlotStyle = style,
  ) => {
    if (!plotDivRef.current || !result) return;
    try {
      const plan = resolveExportPlan(exportStyle, currentViewSize(), layout);
      const ppi = Math.max(36, exportStyle.export_ppi ?? 96);
      const filename = slugFilename(baseName);
      const outputTraces = format === "png" ? interactivePlotTraces(exportTraces) : exportTraces;
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
            exportStyle.export_aspect_ratio,
          ),
          `${filename}.pdf`,
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
        format === "png" ? pngWithPpi(dataUrl, ppi) : blobFromDataUrl(dataUrl, "image/svg+xml");
      await downloadBlob(blob, `${filename}.${format}`);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Plot export failed.",
        color: "red",
      });
    }
  };

  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const ceOverlayActive =
    (spec.presentation.ce_overlay ?? false) && CAPACITY_LIKE_KEYS.has(quantity);
  const yTitlePlaceholder = result ? cycleQuantityLabel(result, spec) : "Voltage (V)";
  /**
   * The preview is the real plot: the same trace and layout builders, called
   * with the draft overrides applied. Rebuilding a simplified version here
   * would let the preview drift from the result.
   */
  const buildSeriesPreview = useCallback(
    (draft: {
      overrides: Record<string, SeriesStyleOverride>;
      rules: SeriesStyleRule[];
      styleOverlay?: Partial<PlotStyle>;
    }) => {
      if (!result) return { data: [] as Plotly.Data[], layout: {} as Partial<Plotly.Layout> };
      const draftSpec: AnalysisSpec = {
        ...spec,
        presentation: {
          ...spec.presentation,
          plot_styles: {
            ...(spec.presentation.plot_styles ?? {}),
            cycles: {
              ...currentPlotStyle(spec, "cycles"),
              ...(draft.styleOverlay ?? {}),
              series_overrides: draft.overrides,
              series_rules: draft.rules,
            },
          },
        },
      };
      const data = decimatePreviewTraces(cycleTracesForResult(result, draftSpec));
      return { data, layout: cyclePlotLayout(result, draftSpec, data) };
    },
    [result, spec],
  );

  return (
    <Group align="stretch" wrap="nowrap">
      <Paper
        p="sm"
        withBorder
        style={{ minHeight: 590, position: "relative", flex: 1, minWidth: 520, overflow: "hidden" }}
      >
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
          quantityName={resolveCycleQuantity(result, spec).label}
          xAxisName={style.x_title ?? "Cycle"}
          sampleSummary={`${spec.selection.entries.length} ${
            spec.selection.entries.length === 1 ? "sample" : "samples"
          }`}
          explainer={explainer}
          onExport={exportPlot}
          onDataExport={handleDataExport}
          getExportPreview={getExportPreview}
          style={style}
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
                (spec.presentation.diagnostic_tolerance ?? DIAGNOSTIC_DEFAULTS.tolerance) * 100,
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
            ref={attachSelectionContainer}
            onPointerDownCapture={(event) => {
              pointSelection.onPointerDownCapture(event);
              if (!event.defaultPrevented) zoom.armOnPointerDown();
            }}
            onPointerMoveCapture={pointSelection.onPointerMoveCapture}
            onPointerUpCapture={pointSelection.onPointerUpCapture}
            onPointerCancelCapture={pointSelection.onPointerCancelCapture}
            style={{
              width: "100%",
              minWidth: 0,
              position: "relative",
              opacity: updating ? 0.42 : 1,
              transition: "opacity 160ms ease",
            }}
          >
            <Plot
              data={traces}
              layout={layout}
              config={plotConfig}
              style={{ width: "100%" }}
              onRelayout={handlePlotRelayout}
              onInitialized={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                window.requestAnimationFrame(pointSelection.refresh);
              }}
              onUpdate={(_, graphDiv) => {
                rememberPlotDiv(graphDiv);
                syncPlotSize();
                window.requestAnimationFrame(pointSelection.refresh);
              }}
            />
            <Box
              data-cycle-point-inspector
              style={{ position: "absolute", left: 6, top: 6, zIndex: 4 }}
            >
              <Tooltip
                label="Ctrl+drag: rectangle · Ctrl+click: polygon; release Ctrl to select"
                multiline
                maw={300}
                withArrow
              >
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label="How to select cycle points"
                >
                  <IconInfoCircle size={15} />
                </ActionIcon>
              </Tooltip>
            </Box>
            <CyclePointSelectionOverlay
              completedShape={pointSelection.completedShape}
              constructionVertices={pointSelection.constructionVertices}
              dragPreview={pointSelection.dragPreview}
              halos={pointSelection.halos}
            />
            {pointSelection.records.length > 0 &&
              pointSelection.anchorBounds &&
              plotSize && (
                <CyclePointInspector
                  key={pointSelection.records.map((record) => record.key).join("|")}
                  analysisId={analysisId}
                  records={pointSelection.records}
                  anchorBounds={pointSelection.anchorBounds}
                  containerWidth={plotSize.width}
                  containerHeight={plotSize.height}
                  spec={spec}
                  cyclesResult={result}
                  onClose={pointSelection.clear}
                />
              )}
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
        buildSeriesPreview={buildSeriesPreview}
        ceOverlayActive={ceOverlayActive}
        yTitlePlaceholder={yTitlePlaceholder}
      />
    </Group>
  );
}
