import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { IconListSearch } from "@tabler/icons-react";
import Plotly from "plotly.js-dist-min";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  post,
  type AnalysisSpec,
  type PlotExportFormat,
  type PlotStyle,
  type RateCapabilityComputationSpec,
  type RateCapabilityFamilyPatternSpec,
  type RateCapabilityViewSpec,
  type SeriesStyleOverride,
  type SeriesStyleRule,
} from "../api";
import {
  isCellHiddenInAnalysis,
  type CellSelectionContext,
} from "../analysisVisibility";
import {
  axisTitleFont,
  currentPlotStyle,
  downloadDataExport,
  downloadStyledPlotExport,
  plotAxisStyle,
  markerSymbol,
  plotLayoutStyle,
  plotPalette,
  PlotHeader,
  PlotStylePanel,
  styledPlotExportPreview,
  tracesToColumns,
  usePlotSizeSync,
} from "../pages/AnalysisPage";
import {
  decimatePreviewTraces,
  resolveSeriesStyle,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  type SeriesDescriptor,
} from "../seriesStyling";
import {
  clearRecognitionToken,
  newRecognitionToken,
  setRecognitionToken,
  useDelayedRecognitionProgress,
  useSharedRecognitionToken,
} from "../recognitionProgress";
import Plot from "./Plot";
import { ProtocolStructureViewer } from "./ProtocolStructureViewer";
import { RecognitionProgress } from "./RecognitionProgress";

export interface RateCapabilityPoint {
  id: string;
  family: "charge" | "discharge";
  cell_id: number;
  cell_name: string;
  label: string;
  filename: string;
  source_hash: string;
  pair_ordinal: number;
  charge_structure: "cc_cv" | "cccv" | "cc";
  measurement_step_index: number;
  cycle: number | null;
  rate_c: number;
  fixed_rate_c: number;
  charge_rate_c: number;
  discharge_rate_c: number;
  upper_voltage_v: number;
  lower_voltage_v: number;
  capacity_mah: number | null;
  capacity_mah_g: number | null;
  capacity_mah_cm2: number | null;
  current_ma: number | null;
  current_ma_g: number | null;
  current_ma_cm2: number | null;
  observed_c_rate: number | null;
  retention_pct: number | null;
  retention_reference_rate_c: number | null;
}

export interface RateCapabilityBlock {
  id: string;
  family: "charge" | "discharge";
  cell_id: number;
  cell_name: string;
  label: string;
  filename: string;
  charge_structure: "cc_cv" | "cccv" | "cc";
  fixed_rate_c: number;
  rates_c: number[];
  upper_voltage_v: number;
  lower_voltage_v: number;
  monotonic: boolean;
  scaffold_consistency: number;
  fingerprint: string;
  points: RateCapabilityPoint[];
}

interface RateCapabilityCellResult {
  cell_id: number;
  cell_name: string;
  families: Record<
    "charge" | "discharge",
    {
      status: "matched" | "not_detected";
      block_id: string | null;
      point_count: number;
      rate_count: number;
    }
  >;
}

interface RateCapabilityComparisonPoint {
  id: string;
  cell_id: number;
  cell_name: string;
  label: string;
  rate_c: number;
  reference_rate_c: number;
  charge_capacity_mah: number;
  discharge_capacity_mah: number;
  charge_retention_pct: number;
  discharge_retention_pct: number;
  asymmetry_ratio: number | null;
}

export interface RateCapabilityResult {
  blocks: RateCapabilityBlock[];
  detected_blocks: Omit<RateCapabilityBlock, "points">[];
  points: RateCapabilityPoint[];
  available: {
    charge_rates_c: number[];
    discharge_rates_c: number[];
    charge_fixed_rates_c: number[];
    discharge_fixed_rates_c: number[];
    charge_structures: ("cc_cv" | "cccv" | "cc")[];
  };
  invalid_execution_count: number;
  cells: RateCapabilityCellResult[];
  selection_contexts: CellSelectionContext[];
  comparison: {
    available: boolean;
    reason: string | null;
    reference_rate_c: number | null;
    common_rates_c: number[];
    points: RateCapabilityComparisonPoint[];
  };
  compatibility: Record<
    "charge" | "discharge",
    {
      compatible: boolean;
      complete: boolean;
      fingerprints: string[];
    }
  >;
  badges: {
    kind: string;
    family?: "charge" | "discharge";
    cell_id?: number;
    cell_name?: string;
    detail: string;
  }[];
}

const DEFAULT_FAMILY: RateCapabilityFamilyPatternSpec = {
  enabled: true,
  charge_structure: "auto",
  fixed_rate_c: null,
  selected_rates_c: [],
  monotonic: "prefer",
  scaffold: "prefer",
};

const DEFAULT_COMPUTATION: RateCapabilityComputationSpec = {
  min_points: 3,
  cutoff_tolerance_v: 0.03,
  rate_tolerance_fraction: 0.03,
  families: {
    charge: { ...DEFAULT_FAMILY },
    discharge: { ...DEFAULT_FAMILY },
  },
};

const DEFAULT_VIEW: RateCapabilityViewSpec = {
  x_axis: "c_rate",
  y_axis: "capacity_mah",
  show_charge: true,
  show_discharge: true,
  x_spacing: "equal",
  visualization: "line",
};

export function rateCapabilityComputationFor(
  spec: AnalysisSpec,
): RateCapabilityComputationSpec {
  const configured = spec.computation.rate_capability;
  return {
    ...DEFAULT_COMPUTATION,
    ...(configured ?? {}),
    families: {
      charge: {
        ...DEFAULT_FAMILY,
        ...(configured?.families?.charge ?? {}),
      },
      discharge: {
        ...DEFAULT_FAMILY,
        ...(configured?.families?.discharge ?? {}),
      },
    },
  };
}

export function rateCapabilityViewFor(
  spec: AnalysisSpec,
): RateCapabilityViewSpec {
  return {
    ...DEFAULT_VIEW,
    ...(spec.presentation.rate_capability_view ?? {}),
  };
}

function cRate(value: number) {
  if (value <= 0) return "0C";
  if (value >= 1) return `${Number(value.toFixed(3))}C`;
  const reciprocal = Math.round(1 / value);
  if (
    reciprocal >= 2 &&
    Math.abs(value - 1 / reciprocal) <= Math.max(0.005, value * 0.03)
  ) {
    return `C/${reciprocal}`;
  }
  return `${Number(value.toFixed(3))}C`;
}

function rateOptions(values: number[]) {
  return [...new Set(values.map((value) => Number(value.toFixed(6))))]
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: cRate(value) }));
}

function selectedRateValues(values: number[]) {
  return values.map((value) => String(Number(value.toFixed(6))));
}

function structureLabel(structure: string) {
  if (structure === "cc_cv") return "CC → CV completion";
  if (structure === "cccv") return "Single CCCV step";
  if (structure === "cc") return "CC only";
  return "Automatically detected";
}

function familyLabel(family: "charge" | "discharge") {
  return family === "charge" ? "Charge capability" : "Discharge capability";
}

function effectiveXAxis(view: RateCapabilityViewSpec) {
  return view.y_axis === "asymmetry_ratio" ? "c_rate" : view.x_axis;
}

function xTitle(view: RateCapabilityViewSpec) {
  const axis = effectiveXAxis(view);
  if (axis === "current_ma") return "Current magnitude (mA)";
  if (axis === "current_ma_g") return "Specific current (mA/g)";
  if (axis === "current_ma_cm2") return "Areal current density (mA/cm²)";
  return "C-rate";
}

function yTitle(view: RateCapabilityViewSpec) {
  if (view.y_axis === "capacity_mah_g") return "CC capacity (mAh/g)";
  if (view.y_axis === "capacity_mah_cm2") return "CC areal capacity (mAh/cm²)";
  if (view.y_axis === "retention_pct") {
    return "Retention from lowest common rate (%)";
  }
  if (view.y_axis === "asymmetry_ratio") {
    return "Rate-capability asymmetry (discharge / charge)";
  }
  return "CC capacity (mAh)";
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Per-series appearance descriptors for the style editor. Maps Rate Capability result
 * blocks and cells to their stable keys and display labels. Produces both block-level
 * descriptors (one per block) and cell-level descriptors (one per visible cell).
 */
export function rateCapabilitySeriesDescriptors(
  result: RateCapabilityResult,
  spec: AnalysisSpec,
): SeriesDescriptor[] {
  const view = rateCapabilityViewFor(spec);
  const visibleFamilies = new Set([
    ...(view.show_charge ? ["charge"] : []),
    ...(view.show_discharge ? ["discharge"] : []),
  ]);
  const visibleBlocks = result.blocks.filter(
    (block) =>
      visibleFamilies.has(block.family) &&
      !isCellHiddenInAnalysis(spec, block.cell_id, result.selection_contexts) &&
      block.points.some(
        (point) => finite(pointX(point, view)) && finite(pointY(point, view)),
      ),
  );

  const descriptors: SeriesDescriptor[] = [];

  // Add descriptors for each visible block
  const multipleCells = new Set(visibleBlocks.map((block) => block.cell_id)).size > 1;
  for (const block of visibleBlocks) {
    const name = multipleCells
      ? `${block.label} — ${familyLabel(block.family)}`
      : familyLabel(block.family);
    descriptors.push({
      key: `rate-capability-${block.id}`,
      kind: "cell",
      label: name,
      cellName: block.cell_name,
      groupName: null,
    });
  }

  // Add descriptors for each visible cell
  const cellIds = [
    ...new Set(visibleBlocks.map((block) => block.cell_id)),
  ].sort((a, b) => a - b);
  for (const cellId of cellIds) {
    const cellName = visibleBlocks.find((b) => b.cell_id === cellId)?.cell_name ?? `Cell ${cellId}`;
    descriptors.push({
      key: `rate-capability-cell-${cellId}`,
      kind: "cell",
      label: cellName,
      cellName,
      groupName: null,
    });
  }

  return descriptors;
}

function pointX(point: RateCapabilityPoint, view: RateCapabilityViewSpec) {
  const axis = effectiveXAxis(view);
  if (axis === "c_rate") return point.rate_c;
  return point[axis];
}

function pointY(point: RateCapabilityPoint, view: RateCapabilityViewSpec) {
  if (view.y_axis === "retention_pct") return point.retention_pct;
  if (view.y_axis === "asymmetry_ratio") return null;
  return point[view.y_axis];
}

function xCategory(value: number, view: RateCapabilityViewSpec) {
  if (effectiveXAxis(view) === "c_rate") return cRate(value);
  return String(Number(value.toPrecision(6)));
}

function orderedXCategories(
  result: RateCapabilityResult | undefined,
  view: RateCapabilityViewSpec,
) {
  const categories = new Map<string, number>();
  const visibleFamilies = new Set([
    ...(view.show_charge ? ["charge"] : []),
    ...(view.show_discharge ? ["discharge"] : []),
  ]);
  const values =
    view.y_axis === "asymmetry_ratio"
      ? (result?.comparison?.points ?? []).map((point) => point.rate_c)
      : (result?.blocks ?? [])
          .filter((block) => visibleFamilies.has(block.family))
          .flatMap((block) => block.points)
          .filter((point) => finite(pointY(point, view)))
          .map((point) => pointX(point, view))
          .filter(finite);
  for (const value of values) {
    if (!finite(value)) continue;
    const category = xCategory(value, view);
    const current = categories.get(category);
    if (current === undefined || value < current) categories.set(category, value);
  }
  return [...categories.entries()]
    .sort((first, second) => first[1] - second[1])
    .map(([category]) => category);
}

export function useRateCapabilityResult(
  analysisId: number,
  spec: AnalysisSpec,
  enabled = true,
) {
  const computation = rateCapabilityComputationFor(spec);
  const signature = useMemo(
    () =>
      JSON.stringify({
        // Only the sample set (not display-only exclusions) changes the data,
        // so hiding a cell filters client-side without a recompute.
        entries: spec.selection.entries,
        rate_capability: computation,
      }),
    [spec.selection.entries, computation],
  );
  const tokenKey = `rate-capability:${analysisId}:${signature}`;
  const result = useQuery({
    queryKey: ["rate-capability", analysisId, signature],
    queryFn: async () => {
      const token = newRecognitionToken();
      setRecognitionToken(tokenKey, token);
      try {
        return await post<RateCapabilityResult>(
          `/api/analyses/${analysisId}/rate-capability`,
          { spec, job_token: token },
        );
      } finally {
        window.setTimeout(() => {
          clearRecognitionToken(tokenKey, token);
        }, 300);
      }
    },
    enabled: enabled && spec.selection.entries.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const computeToken = useSharedRecognitionToken(
    result.isLoading || result.isFetching ? tokenKey : null,
  );
  return { ...result, computeToken };
}

export function rateCapabilityTracesForResult(
  result: RateCapabilityResult,
  spec: AnalysisSpec,
): Plotly.Data[] {
  const view = rateCapabilityViewFor(spec);
  const style = currentPlotStyle(spec, "crate");
  const palette = plotPalette(style);
  const comparisonPoints = result.comparison?.points ?? [];
  const descriptors = rateCapabilitySeriesDescriptors(result, spec);
  const cellIds = [
    ...new Set([
      ...result.blocks.map((block) => block.cell_id),
      ...comparisonPoints.map((point) => point.cell_id),
    ]),
  ]
    .sort((first, second) => first - second)
    // Respect the "Analysis samples" eye toggle: a hidden cell draws nothing.
    .filter(
      (cellId) =>
        !isCellHiddenInAnalysis(spec, cellId, result.selection_contexts),
    );
  const colorForCell = (cellId: number, blockId?: string) =>
    style.custom_colors[`rate-capability-cell-${cellId}`] ??
    (blockId
      ? style.custom_colors[`rate-capability-${blockId}`]
      : undefined) ??
    palette[Math.max(0, cellIds.indexOf(cellId)) % palette.length];
  const plottedX = (value: number) =>
    view.x_spacing === "equal" ? xCategory(value, view) : value;
  const isBar = view.visualization === "bar";

  if (view.y_axis === "asymmetry_ratio") {
    return cellIds.flatMap((cellId) => {
      const points = comparisonPoints
        .filter(
          (point) =>
            point.cell_id === cellId && finite(point.asymmetry_ratio),
        )
        .sort((first, second) => first.rate_c - second.rate_c);
      if (!points.length) return [];
      const descriptor = descriptors.find((d) => d.key === `rate-capability-cell-${cellId}`);
      if (!descriptor) return [];
      const color = colorForCell(cellId);
      const baseStyle = {
        color,
        lineWidth: style.line_width,
        lineDash: style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      };
      const resolved = resolveSeriesStyle(
        baseStyle,
        descriptor,
        style.series_rules,
        style.series_overrides
      );
      if (resolved.hidden) return [];
      const actualX = points.map((point) => point.rate_c);
      const common = {
        name: resolved.name,
        showlegend: resolved.showInLegend,
        opacity: resolved.opacity,
        x: actualX.map(plottedX),
        y: points.map((point) => point.asymmetry_ratio),
        meta: { cellxplorer_export_x: actualX },
        legendgroup: `cell-${cellId}`,
        customdata: points.map((point) => [
          point.rate_c,
          point.reference_rate_c,
          point.charge_retention_pct,
          point.discharge_retention_pct,
          point.charge_capacity_mah,
          point.discharge_capacity_mah,
        ]),
        hovertemplate:
          "%{fullData.name}<br>" +
          "C-rate: %{customdata[0]:.4g}C<br>" +
          "Asymmetry: %{y:.4g}<br>" +
          "Charge retention: %{customdata[2]:.3g}%<br>" +
          "Discharge retention: %{customdata[3]:.3g}%<br>" +
          "Reference: %{customdata[1]:.4g}C<extra></extra>",
      };
      if (isBar) {
        return [
          {
            ...common,
            type: "bar",
            offsetgroup: `cell-${cellId}`,
            alignmentgroup: "rate-capability",
            marker: {
              color: resolved.color,
              line: { color: "#1f2937", width: 0.5 },
            },
          } as Plotly.Data,
        ];
      }
      return [
        {
          ...common,
          type: "scatter",
          mode: seriesPlotlyMode(resolved),
          line: {
            color: resolved.color,
            width: resolved.lineWidth,
            dash: resolved.lineDash,
            shape: resolved.lineShape,
          },
          marker: { color: resolved.color, size: resolved.markerSize, symbol: seriesPlotlySymbol(resolved) },
        } as Plotly.Data,
      ];
    });
  }

  const visibleFamilies = new Set([
    ...(view.show_charge ? ["charge"] : []),
    ...(view.show_discharge ? ["discharge"] : []),
  ]);
  const visibleBlocks = result.blocks.filter(
    (block) =>
      visibleFamilies.has(block.family) &&
      !isCellHiddenInAnalysis(
        spec,
        block.cell_id,
        result.selection_contexts,
      ) &&
      block.points.some(
        (point) => finite(pointX(point, view)) && finite(pointY(point, view)),
      ),
  );
  const multipleCells = new Set(visibleBlocks.map((block) => block.cell_id)).size > 1;
  return visibleBlocks
    .map((block) => {
      const descriptor = descriptors.find((d) => d.key === `rate-capability-${block.id}`);
      if (!descriptor) return null;
      const points = [...block.points]
        .filter(
          (point) => finite(pointX(point, view)) && finite(pointY(point, view)),
        )
        .sort((first, second) => pointX(first, view)! - pointX(second, view)!);
      const color = colorForCell(block.cell_id, block.id);
      const baseStyle = {
        color,
        lineWidth: style.line_width,
        lineDash: block.family === "discharge" ? "dash" : style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      };
      const resolved = resolveSeriesStyle(
        baseStyle,
        descriptor,
        style.series_rules,
        style.series_overrides
      );
      if (resolved.hidden) return null;
      const actualX = points.map((point) => pointX(point, view)!);
      const common = {
        name: resolved.name,
        showlegend: resolved.showInLegend,
        opacity: resolved.opacity,
        x: actualX.map(plottedX),
        y: points.map((point) => pointY(point, view)),
        meta: { cellxplorer_export_x: actualX },
        legendgroup: `cell-${block.cell_id}`,
        customdata: points.map((point) => [
          pointX(point, view),
          point.family,
          point.rate_c,
          point.current_ma,
          point.capacity_mah,
          point.fixed_rate_c,
          point.cycle,
          point.measurement_step_index,
        ]),
        hovertemplate:
          "%{fullData.name}<br>" +
          `${xTitle(view)}: %{customdata[0]:.4g}<br>` +
          `${yTitle(view)}: %{y:.4g}<br>` +
          "Sweep rate: %{customdata[2]:.4g}C<br>" +
          "Fixed complementary rate: %{customdata[5]:.4g}C<br>" +
          "Cycle: %{customdata[6]}<extra></extra>",
      };
      if (isBar) {
        return {
          ...common,
          type: "bar",
          offsetgroup: `cell-${block.cell_id}-${block.family}`,
          alignmentgroup: "rate-capability",
          marker: {
            color: resolved.color,
            line: { color: "#1f2937", width: 0.5 },
            pattern:
              block.family === "discharge"
                ? {
                    shape: "/",
                    fgcolor: "#1f2937",
                    fillmode: "overlay",
                    solidity: 0.22,
                  }
                : { shape: "" },
          },
        } as Plotly.Data;
      }
      return {
        ...common,
        type: "scatter",
        mode: seriesPlotlyMode(resolved),
        line: {
          color: resolved.color,
          width: resolved.lineWidth,
          dash: resolved.lineDash,
          shape: resolved.lineShape,
        },
        marker: {
          color: resolved.color,
          size: resolved.markerSize,
          // Charge/discharge stay distinguishable by shape here; the style panel's
          // open/filled choice still applies on top of that family shape.
          symbol:
            (block.family === "charge" ? "circle" : "diamond") +
            (resolved.markerOpen ? "-open" : ""),
        },
      } as Plotly.Data;
    })
    .filter((trace): trace is Plotly.Data => trace !== null);
}

export function rateCapabilityLayoutForSpec(
  spec: AnalysisSpec,
  result?: RateCapabilityResult,
): Partial<Plotly.Layout> {
  const view = rateCapabilityViewFor(spec);
  const style = currentPlotStyle(spec, "crate");
  const categories = orderedXCategories(result, view);
  const equalSpacing = view.x_spacing === "equal";
  const referenceLine =
    view.y_axis === "asymmetry_ratio"
      ? 1
      : view.y_axis === "retention_pct"
        ? 100
        : null;
  return {
    ...plotLayoutStyle(style, spec),
    margin: { l: 76, r: 20, t: 12, b: 58 },
    xaxis: {
      ...plotAxisStyle(style, { axis: style.x_axis }),
      title: { text: style.x_title ?? xTitle(view), font: axisTitleFont(style) },
      type: equalSpacing ? "category" : "linear",
      ...(equalSpacing
        ? {
            categoryorder: "array",
            categoryarray: categories,
          }
        : {}),
    },
    yaxis: {
      ...plotAxisStyle(style, { zeroLine: true, axis: style.y_axis }),
      title: { text: style.y_title ?? yTitle(view), font: axisTitleFont(style) },
      ...(view.visualization === "bar" ? { rangemode: "tozero" } : {}),
    },
    barmode: "group",
    bargap: 0.16,
    bargroupgap: 0.06,
    shapes:
      referenceLine == null
        ? []
        : [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              y0: referenceLine,
              y1: referenceLine,
              line: { color: "#868e96", width: 1, dash: "dot" },
            },
          ],
    legend: { orientation: "h", y: -0.22, font: { size: style.legend_font_size } },
    hovermode: "closest",
  };
}

function compatibilityLabel(
  result: RateCapabilityResult,
  family: "charge" | "discharge",
) {
  const compatibility = result.compatibility[family];
  if (compatibility.compatible && compatibility.complete) return "Same protocol";
  if (!compatibility.complete) return "Incomplete match";
  return "Protocol mismatch";
}

function FamilyRecognitionRules({
  family,
  computation,
  result,
  patch,
}: {
  family: "charge" | "discharge";
  computation: RateCapabilityComputationSpec;
  result?: RateCapabilityResult;
  patch: (patch: Partial<RateCapabilityFamilyPatternSpec>) => void;
}) {
  const pattern = computation.families[family];
  const fixedValues =
    family === "charge"
      ? result?.available.charge_fixed_rates_c ?? []
      : result?.available.discharge_fixed_rates_c ?? [];
  const structures = result?.available.charge_structures ?? [];
  return (
    <Stack gap="xs">
      <Switch
        size="sm"
        label={`Detect ${family}-rate capability`}
        checked={pattern.enabled}
        onChange={(event) => patch({ enabled: event.currentTarget.checked })}
      />
      <Select
        label="Charge-step structure"
        description={
          family === "charge"
            ? "The CC step supplies the plotted capacity; CV is completion evidence only."
            : "The fixed charge phase preceding each swept discharge."
        }
        value={pattern.charge_structure}
        data={[
          { value: "auto", label: "Automatically detected" },
          ...structures.map((structure) => ({
            value: structure,
            label: structureLabel(structure),
          })),
        ]}
        disabled={!pattern.enabled}
        onChange={(value) =>
          value &&
          patch({
            charge_structure:
              value as RateCapabilityFamilyPatternSpec["charge_structure"],
          })
        }
      />
      <Select
        label={`Fixed ${family === "charge" ? "discharge" : "charge"} rate`}
        value={
          pattern.fixed_rate_c == null
            ? "auto"
            : String(Number(pattern.fixed_rate_c.toFixed(6)))
        }
        data={[
          { value: "auto", label: "Automatically detected" },
          ...rateOptions(fixedValues),
        ]}
        disabled={!pattern.enabled}
        onChange={(value) =>
          value &&
          patch({ fixed_rate_c: value === "auto" ? null : Number(value) })
        }
      />
      <Select
        label="Rate progression"
        value={pattern.monotonic}
        data={[
          { value: "prefer", label: "Prefer monotonic sweeps" },
          { value: "require", label: "Require monotonic sweeps" },
          { value: "ignore", label: "Ignore rate order" },
        ]}
        disabled={!pattern.enabled}
        onChange={(value) =>
          value &&
          patch({
            monotonic: value as RateCapabilityFamilyPatternSpec["monotonic"],
          })
        }
      />
      <Select
        label="Rest/control scaffold"
        value={pattern.scaffold}
        data={[
          { value: "prefer", label: "Use as supporting evidence" },
          { value: "require", label: "Require repeated scaffold" },
          { value: "ignore", label: "Ignore rests and controls" },
        ]}
        disabled={!pattern.enabled}
        onChange={(value) =>
          value &&
          patch({
            scaffold: value as RateCapabilityFamilyPatternSpec["scaffold"],
          })
        }
      />
    </Stack>
  );
}

export function RateCapabilitySettings({
  analysisId,
  spec,
  update,
  recognitionEnabled = true,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
  recognitionEnabled?: boolean;
}) {
  const result = useRateCapabilityResult(analysisId, spec, recognitionEnabled);
  const computation = rateCapabilityComputationFor(spec);
  const view = rateCapabilityViewFor(spec);

  const patchComputation = (patch: Partial<RateCapabilityComputationSpec>) =>
    update((draft) => {
      const current = rateCapabilityComputationFor(draft);
      draft.computation.rate_capability = {
        ...current,
        ...patch,
        families: patch.families ?? current.families,
      };
    });
  const patchFamily = (
    family: "charge" | "discharge",
    patch: Partial<RateCapabilityFamilyPatternSpec>,
  ) =>
    update((draft) => {
      const current = rateCapabilityComputationFor(draft);
      draft.computation.rate_capability = {
        ...current,
        families: {
          ...current.families,
          [family]: {
            ...current.families[family],
            ...patch,
          },
        },
      };
    });
  const patchView = (patch: Partial<RateCapabilityViewSpec>) =>
    update((draft) => {
      draft.presentation.rate_capability_view = {
        ...DEFAULT_VIEW,
        ...(draft.presentation.rate_capability_view ?? {}),
        ...patch,
      };
    });

  const blockFor = (family: "charge" | "discharge") =>
    result.data?.blocks.find((block) => block.family === family);
  const chargeBlock = blockFor("charge");
  const dischargeBlock = blockFor("discharge");
  const chargeRates = result.data?.available.charge_rates_c ?? [];
  const dischargeRates = result.data?.available.discharge_rates_c ?? [];
  const selectedCells = result.data?.cells.length ?? 0;
  const availablePoints = result.data?.points ?? [];
  const hasSpecificCurrent = availablePoints.some((point) =>
    finite(point.current_ma_g),
  );
  const hasArealCurrent = availablePoints.some((point) =>
    finite(point.current_ma_cm2),
  );
  const hasSpecificCapacity = availablePoints.some((point) =>
    finite(point.capacity_mah_g),
  );
  const hasArealCapacity = availablePoints.some((point) =>
    finite(point.capacity_mah_cm2),
  );
  const comparisonAvailable = Boolean(result.data?.comparison?.available);
  const comparisonReference = result.data?.comparison?.reference_rate_c;
  const asymmetrySelected = view.y_axis === "asymmetry_ratio";
  const [structureOpen, setStructureOpen] = useState(false);
  const highlightedByCell = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const block of result.data?.blocks ?? []) {
      let steps = map.get(block.cell_id);
      if (!steps) {
        steps = new Set();
        map.set(block.cell_id, steps);
      }
      for (const point of block.points) steps.add(point.measurement_step_index);
    }
    return map;
  }, [result.data?.blocks]);
  const structureCells = useMemo(
    () =>
      (result.data?.cells ?? []).map((cell) => ({
        id: cell.cell_id,
        name: cell.cell_name,
      })),
    [result.data?.cells],
  );
  return (
    <Stack gap="xs">
      <Paper p="sm" withBorder>
        <Group justify="space-between" mb="xs" align="flex-start">
          <div>
            <Text size="sm" fw={700}>Automatic identification</Text>
            <Text size="xs" c="dimmed">
              Finds fixed-rate/variable-rate sequences and validates their cutoffs.
            </Text>
          </div>
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconListSearch size={14} />}
              disabled={!structureCells.length}
              onClick={() => setStructureOpen(true)}
            >
              Show detected steps
            </Button>
            <Badge
              color={
                result.isLoading
                  ? "gray"
                  : chargeBlock || dischargeBlock
                    ? "teal"
                    : "gray"
              }
              variant="light"
            >
              {result.isLoading
                ? "Detecting"
                : `${Number(Boolean(chargeBlock)) + Number(Boolean(dischargeBlock))} detected`}
            </Badge>
          </Group>
        </Group>
        <ProtocolStructureViewer
          opened={structureOpen}
          onClose={() => setStructureOpen(false)}
          cells={structureCells}
          highlightedByCell={highlightedByCell}
        />

        {(["charge", "discharge"] as const).map((family) => {
          const block = blockFor(family);
          const compatibility = result.data?.compatibility[family];
          return (
            <Box key={family} mb="xs">
              <Group justify="space-between" gap="xs">
                <Text size="xs" fw={700}>{familyLabel(family)}</Text>
                {selectedCells > 1 && compatibility && (
                  <Badge
                    size="xs"
                    color={
                      compatibility.compatible && compatibility.complete
                        ? "teal"
                        : "yellow"
                    }
                    variant="light"
                  >
                    {compatibilityLabel(result.data!, family)}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c={block ? undefined : "dimmed"}>
                {block
                  ? `${structureLabel(block.charge_structure)} · ${block.rates_c
                      .map(cRate)
                      .join(", ")} · ${
                      family === "charge" ? "discharge" : "charge"
                    } fixed at ${cRate(block.fixed_rate_c)}`
                  : "No confident completed sweep detected."}
              </Text>
            </Box>
          );
        })}

        {Boolean(result.data?.invalid_execution_count) && (
          <Text size="xs" c="orange">
            {result.data?.invalid_execution_count} incomplete candidate{" "}
            {result.data?.invalid_execution_count === 1 ? "pair was" : "pairs were"} excluded.
          </Text>
        )}
        {comparisonAvailable && finite(comparisonReference) && (
          <Text size="xs" c="dimmed">
            Shared charge/discharge reference: {cRate(comparisonReference)}
            {selectedCells > 1 ? " across all selected cells" : ""}
          </Text>
        )}
        <Divider my="xs" />
        <MultiSelect
          label="Charge rates to plot"
          data={rateOptions(chargeRates)}
          value={selectedRateValues(
            computation.families.charge.selected_rates_c,
          )}
          placeholder={chargeRates.length ? "All detected rates" : "No detected rates"}
          searchable
          clearable
          disabled={!chargeRates.length}
          onChange={(values) =>
            patchFamily("charge", {
              selected_rates_c: values.map(Number),
            })
          }
        />
        <MultiSelect
          mt="xs"
          label="Discharge rates to plot"
          data={rateOptions(dischargeRates)}
          value={selectedRateValues(
            computation.families.discharge.selected_rates_c,
          )}
          placeholder={
            dischargeRates.length ? "All detected rates" : "No detected rates"
          }
          searchable
          clearable
          disabled={!dischargeRates.length}
          onChange={(values) =>
            patchFamily("discharge", {
              selected_rates_c: values.map(Number),
            })
          }
        />

        <Accordion variant="contained" mt="xs">
          <Accordion.Item value="rules">
            <Accordion.Control>
              <Text size="xs" fw={700}>Edit recognition rules</Text>
            </Accordion.Control>
            <Accordion.Panel>
              <NumberInput
                label="Minimum distinct rates"
                min={2}
                max={20}
                value={computation.min_points}
                onChange={(value) =>
                  typeof value === "number" &&
                  patchComputation({ min_points: value })
                }
              />
              <NumberInput
                mt="xs"
                label="Cutoff tolerance"
                suffix=" V"
                min={0.001}
                max={0.2}
                decimalScale={3}
                value={computation.cutoff_tolerance_v}
                onChange={(value) =>
                  typeof value === "number" &&
                  patchComputation({ cutoff_tolerance_v: value })
                }
              />
              <NumberInput
                mt="xs"
                label="C-rate matching tolerance"
                suffix=" %"
                min={0.1}
                max={20}
                decimalScale={1}
                value={computation.rate_tolerance_fraction * 100}
                onChange={(value) =>
                  typeof value === "number" &&
                  patchComputation({
                    rate_tolerance_fraction: value / 100,
                  })
                }
              />
              <Accordion variant="separated" mt="xs">
                <Accordion.Item value="charge">
                  <Accordion.Control>
                    <Text size="xs" fw={700}>Charge pattern</Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <FamilyRecognitionRules
                      family="charge"
                      computation={computation}
                      result={result.data}
                      patch={(patch) => patchFamily("charge", patch)}
                    />
                  </Accordion.Panel>
                </Accordion.Item>
                <Accordion.Item value="discharge">
                  <Accordion.Control>
                    <Text size="xs" fw={700}>Discharge pattern</Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <FamilyRecognitionRules
                      family="discharge"
                      computation={computation}
                      result={result.data}
                      patch={(patch) => patchFamily("discharge", patch)}
                    />
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Paper>

      <Paper p="sm" withBorder>
        <Text size="sm" fw={700} mb="xs">Series and axes</Text>
        <Group gap="lg">
          <Switch
            size="sm"
            label="Charge"
            checked={view.show_charge}
            disabled={asymmetrySelected}
            onChange={(event) =>
              patchView({ show_charge: event.currentTarget.checked })
            }
          />
          <Switch
            size="sm"
            label="Discharge"
            checked={view.show_discharge}
            disabled={asymmetrySelected}
            onChange={(event) =>
              patchView({ show_discharge: event.currentTarget.checked })
            }
          />
        </Group>
        <Select
          mt="xs"
          label="Visualization"
          value={view.visualization}
          data={[
            { value: "line", label: "Line plot" },
            { value: "bar", label: "Grouped bars" },
          ]}
          onChange={(value) =>
            value &&
            patchView({
              visualization:
                value as RateCapabilityViewSpec["visualization"],
            })
          }
        />
        <Select
          mt="xs"
          label="X axis"
          description={
            asymmetrySelected
              ? "Asymmetry compares charge and discharge at the same C-rate."
              : undefined
          }
          value={asymmetrySelected ? "c_rate" : view.x_axis}
          disabled={asymmetrySelected}
          data={[
            { value: "c_rate", label: "C-rate" },
            { value: "current_ma", label: "Current magnitude" },
            {
              value: "current_ma_g",
              label: "Specific current",
              disabled: availablePoints.length > 0 && !hasSpecificCurrent,
            },
            {
              value: "current_ma_cm2",
              label: "Areal current density",
              disabled: availablePoints.length > 0 && !hasArealCurrent,
            },
          ]}
          onChange={(value) =>
            value &&
            patchView({ x_axis: value as RateCapabilityViewSpec["x_axis"] })
          }
        />
        <Select
          mt="xs"
          label="X-axis spacing"
          value={view.x_spacing}
          data={[
            {
              value: "equal",
              label: "Equal spacing between conditions",
            },
            {
              value: "proportional",
              label: "Proportional to numerical value",
            },
          ]}
          onChange={(value) =>
            value &&
            patchView({
              x_spacing: value as RateCapabilityViewSpec["x_spacing"],
            })
          }
        />
        <Select
          mt="xs"
          label="Y axis"
          value={view.y_axis}
          data={[
            { value: "capacity_mah", label: "CC capacity" },
            {
              value: "capacity_mah_g",
              label: "Specific CC capacity",
              disabled: availablePoints.length > 0 && !hasSpecificCapacity,
            },
            {
              value: "capacity_mah_cm2",
              label: "Areal CC capacity",
              disabled: availablePoints.length > 0 && !hasArealCapacity,
            },
            {
              value: "retention_pct",
              label: "Retention from lowest common rate",
              disabled: !comparisonAvailable,
            },
            {
              value: "asymmetry_ratio",
              label: "Rate-capability asymmetry",
              disabled: !comparisonAvailable,
            },
          ]}
          onChange={(value) =>
            value &&
            patchView({ y_axis: value as RateCapabilityViewSpec["y_axis"] })
          }
        />
        {view.visualization === "bar" &&
          view.y_axis !== "asymmetry_ratio" && (
            <Text size="xs" c="dimmed" mt="xs">
              Cell identity uses color. Charge bars are solid; discharge bars
              use diagonal hatching.
            </Text>
          )}
        {!comparisonAvailable && (
          <Text size="xs" c="dimmed" mt="xs">
            Normalized retention and asymmetry require charge and discharge
            sweeps with at least one shared rate for every selected cell.
          </Text>
        )}
      </Paper>
    </Stack>
  );
}

export function RateCapabilityPlotCard({
  analysisId,
  analysisTitle,
  plotName,
  spec,
  update,
  recognitionEnabled = true,
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
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
  recognitionEnabled?: boolean;
  onReadyChange?: (ready: boolean) => void;
  edited?: boolean;
  onNewPlot?: () => void;
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  updatePlotEnabled?: boolean;
  updatePlotLabel?: string;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const result = useRateCapabilityResult(analysisId, spec, recognitionEnabled);
  const view = rateCapabilityViewFor(spec);
  const style = currentPlotStyle(spec, "crate");
  const traces = useMemo(
    () => (result.data ? rateCapabilityTracesForResult(result.data, spec) : []),
    [result.data, spec],
  );
  const layout = useMemo(
    () => rateCapabilityLayoutForSpec(spec, result.data),
    [spec, result.data],
  );
  const recognitionProgress = useDelayedRecognitionProgress(
    result.computeToken,
    result.isLoading,
  );
  const plotUpdating = result.isFetching && traces.length > 0;
  useEffect(() => {
    onReadyChange?.(
      spec.selection.entries.length === 0 ||
        Boolean(result.data) ||
        result.isError,
    );
  }, [
    onReadyChange,
    result.data,
    result.isError,
    spec.selection.entries.length,
  ]);

  const rememberPlotDiv = (graphDiv: unknown) => {
    const element = graphDiv as HTMLElement;
    plotDivRef.current = element;
    const rect = element.getBoundingClientRect();
    const next = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    setPlotSize((current) =>
      current &&
      current.width === next.width &&
      current.height === next.height
        ? current
        : next,
    );
  };

  const seriesDescriptors = useMemo(
    () =>
      result.data
        ? rateCapabilitySeriesDescriptors(result.data, spec)
        : [],
    [result.data, spec]
  );

  const buildSeriesPreview = useCallback(
    (draft: { overrides: Record<string, SeriesStyleOverride>; rules: SeriesStyleRule[]; styleOverlay?: Partial<PlotStyle> }) => {
      if (!result.data) return { data: [] as Plotly.Data[], layout: {} as Partial<Plotly.Layout> };
      const draftSpec: AnalysisSpec = {
        ...spec,
        presentation: {
          ...spec.presentation,
          plot_styles: {
            ...(spec.presentation.plot_styles ?? {}),
            crate: {
              ...currentPlotStyle(spec, "crate"),
              ...(draft.styleOverlay ?? {}),
              series_overrides: draft.overrides,
              series_rules: draft.rules,
            },
          },
        },
      };
      const data = decimatePreviewTraces(rateCapabilityTracesForResult(result.data, draftSpec));
      return { data, layout: rateCapabilityLayoutForSpec(draftSpec, result.data) };
    },
    [result.data, spec],
  );

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    try {
      await downloadStyledPlotExport(
        traces,
        layout,
        style,
        plotName,
        format,
        baseName,
        plotSize,
      );
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error ? error.message : "Plot export failed.",
      });
    }
  };
  const getExportPreview = () =>
    styledPlotExportPreview(
      traces,
      layout,
      style,
      plotName,
      plotSize,
    );
  const dataExport = async (baseName: string) => {
    try {
      await downloadDataExport(
        tracesToColumns(traces, layout),
        style,
        baseName,
      );
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error ? error.message : "Data export failed.",
      });
    }
  };
  const mismatch = result.data?.badges.some(
    (badge) => badge.kind === "rate_capability_protocol_mismatch",
  );
  const usesCommonReference =
    view.y_axis === "retention_pct" ||
    view.y_axis === "asymmetry_ratio";
  const comparison = result.data?.comparison;

  return (
    <Group align="stretch" wrap="nowrap">
      <Paper
        p="sm"
        withBorder
        style={{
          minHeight: 590,
          position: "relative",
          flex: 1,
          minWidth: 520,
          overflow: "hidden",
        }}
      >
        <PlotHeader
          analysisTitle={analysisTitle}
          tabName="C-rate"
          plotName={plotName}
          subtitle={`${yTitle(view)} vs ${xTitle(view).toLowerCase()}`}
          quantityName={yTitle(view)}
          xAxisName={style.x_title ?? xTitle(view)}
          sampleSummary={`${traces.length} ${
            traces.length === 1 ? "series" : "series"
          }`}
          onExport={exportPlot}
          onDataExport={dataExport}
          getExportPreview={getExportPreview}
          style={style}
          edited={edited}
          onNewPlot={onNewPlot}
          newPlotEnabled={newPlotEnabled}
          onUpdatePlot={onUpdatePlot}
          updatePlotEnabled={updatePlotEnabled}
          updatePlotLabel={updatePlotLabel}
          updateStyle={(fn) =>
            update((draft) => {
              const styles = ((
                draft.presentation as Record<string, unknown>
              ).plot_styles ??= {}) as Record<string, unknown>;
              const current = (styles.crate ?? {}) as Record<string, unknown>;
              fn(current as never);
              styles.crate = current;
            })
          }
          layout={layout}
          viewSize={plotSize}
          canExport={traces.length > 0}
        />
        {result.isError && (
          <Alert color="red">
            {(result.error as Error).message ||
              "Could not detect rate-capability sweeps."}
          </Alert>
        )}
        {mismatch && (
          <Alert color="yellow" py="xs" mb="xs">
            Selected cells resolved to different rate-capability patterns.
            Curves are shown for inspection but are not directly equivalent.
          </Alert>
        )}
        {!spec.selection.entries.length ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={410}>
              Add cells or replicates to detect charge- and discharge-rate
              capability sweeps.
            </Text>
          </Center>
        ) : result.isLoading ? (
          <Center h={480}>
            {recognitionProgress.show ? (
              <RecognitionProgress
                percent={recognitionProgress.percent}
                label={recognitionProgress.label}
                waiting={recognitionProgress.active && !recognitionProgress.job}
              />
            ) : null}
          </Center>
        ) : !traces.length ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {usesCommonReference && comparison?.reason
                ? comparison.reason
                : "No completed rate-capability sweep satisfies the current recognition rules and selected rates."}
            </Text>
          </Center>
        ) : (
          <>
            <Text size="xs" c="dimmed" mb={4}>
              {usesCommonReference &&
              finite(comparison?.reference_rate_c)
                ? `Normalized to the lowest rate shared by charge, discharge, and all displayed cells: ${cRate(
                    comparison.reference_rate_c,
                  )}.`
                : "Charge curves use capacity from the CC step only. Following CV capacity is excluded."}
            </Text>
            <Box
              ref={containerRef}
              style={{
                width: "100%",
                minWidth: 0,
                opacity: plotUpdating ? 0.42 : 1,
                transition: "opacity 160ms ease",
              }}
            >
              <Plot
                data={traces}
                layout={layout}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: "100%", height: 470 }}
                useResizeHandler
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
          </>
        )}
      </Paper>
      <PlotStylePanel
        opened={stylePanelOpen}
        spec={spec}
        result={undefined}
        update={update}
        onToggle={() => setStylePanelOpen((open) => !open)}
        axisScope="crate"
        seriesDescriptors={seriesDescriptors}
        buildSeriesPreview={buildSeriesPreview}
      />
    </Group>
  );
}
