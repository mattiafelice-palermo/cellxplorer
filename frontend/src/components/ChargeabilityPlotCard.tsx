import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
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
  type ChargeabilityComputationSpec,
  type ChargeabilityViewSpec,
  type PlotExportFormat,
  type PlotStyle,
  type SeriesStyleOverride,
  type SeriesStyleRule,
} from "../api";
import {
  axisTitleFont,
  currentPlotStyle,
  downloadDataExport,
  downloadStyledPlotExport,
  isCellHiddenInAnalysis,
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

export interface ChargeabilityMatch {
  id: string;
  cell_id: number;
  cell_name: string;
  label: string;
  filename: string;
  source_hash: string;
  protocol_signature: string;
  step_index: number;
  occurrence: number;
  cycle: number | null;
  initial_soc_pct: number;
  final_soc_pct: number;
  observed_final_soc_pct: number | null;
  current_ceiling_c: number;
  current_ceiling_ma: number | null;
  target_voltage_v: number | null;
  mode: string;
  fingerprint: string;
  reference_capacity_mah: number | null;
  duration_s: number | null;
  delivered_capacity_mah: number | null;
  actual_peak_current_ma: number | null;
  actual_peak_c_rate: number | null;
  x: {
    time_s: (number | null)[];
    soc_pct: (number | null)[];
    capacity_mah: (number | null)[];
    capacity_mah_g: (number | null)[];
    capacity_mah_cm2: (number | null)[];
  };
  y: {
    current_ma: (number | null)[];
    c_rate: (number | null)[];
    current_ma_g: (number | null)[];
    current_ma_cm2: (number | null)[];
  };
}

interface ChargeabilityCandidate {
  cell_id: number;
  cell_name: string;
  filename: string;
  step_index: number;
  initial_soc_pct: number;
  final_soc_pct: number;
  current_ceiling_c: number;
  target_voltage_v: number | null;
  matches_filters: boolean;
}

interface ChargeabilityCellResult {
  cell_id: number;
  cell_name: string;
  candidate_count: number;
  match_count: number;
  status: "matched" | "no_match" | "no_candidates";
}

export interface ChargeabilityResult {
  matches: ChargeabilityMatch[];
  candidates: ChargeabilityCandidate[];
  cells: ChargeabilityCellResult[];
  available_filters: {
    initial_soc_pct: number[];
    final_soc_pct: number[];
    current_ceiling_c: number[];
    target_voltage_v: number[];
  };
  compatibility: {
    compatible: boolean;
    complete: boolean;
    fingerprints: string[];
  };
  badges: { kind: string; cell_id?: number; cell_name?: string; detail: string }[];
}

const DEFAULT_COMPUTATION: ChargeabilityComputationSpec = {
  initial_soc_max_pct: 20,
  final_soc_min_pct: 80,
  min_current_ceiling_c: 7,
  soc_tolerance_pct: 2,
};

const DEFAULT_VIEW: ChargeabilityViewSpec = {
  x_axis: "soc_pct",
  y_axis: "c_rate",
  time_unit: "min",
};

export function chargeabilityComputationFor(
  spec: AnalysisSpec,
): ChargeabilityComputationSpec {
  return {
    ...DEFAULT_COMPUTATION,
    ...(spec.computation.chargeability ?? {}),
  };
}

export function chargeabilityViewFor(spec: AnalysisSpec): ChargeabilityViewSpec {
  return {
    ...DEFAULT_VIEW,
    ...(spec.presentation.chargeability_view ?? {}),
  };
}

function percent(value: number) {
  return `${Number(value.toFixed(3))}%`;
}

function cRate(value: number) {
  if (value <= 0) return "0C";
  if (value >= 1) return `${Number(value.toFixed(3))}C`;
  const reciprocal = Math.round(1 / value);
  if (reciprocal >= 2 && Math.abs(value - 1 / reciprocal) <= 0.015) {
    return `C/${reciprocal}`;
  }
  return `${Number(value.toFixed(3))}C`;
}

function detectedOptions(values: number[], suffix: "%" | "C") {
  return [...new Set(values.map((value) => Number(value.toFixed(6))))]
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label: suffix === "%" ? percent(value) : cRate(value),
    }));
}

function detectedValue(values: number[], configured: number) {
  const match = values.find((value) => Math.abs(value - configured) < 1e-6);
  return match == null ? null : String(Number(match.toFixed(6)));
}

export function useChargeabilityResult(
  analysisId: number,
  spec: AnalysisSpec,
) {
  const computation = chargeabilityComputationFor(spec);
  const signature = useMemo(
    () =>
      JSON.stringify({
        // Only the sample set (not display-only exclusions) changes the data,
        // so hiding a cell filters client-side without a recompute.
        entries: spec.selection.entries,
        chargeability: computation,
      }),
    [spec.selection.entries, computation],
  );
  const tokenKey = `chargeability:${analysisId}:${signature}`;
  const result = useQuery({
    queryKey: ["chargeability", analysisId, signature],
    queryFn: async () => {
      const token = newRecognitionToken();
      setRecognitionToken(tokenKey, token);
      try {
        return await post<ChargeabilityResult>(
          `/api/analyses/${analysisId}/chargeability`,
          { spec, job_token: token },
        );
      } finally {
        window.setTimeout(() => {
          clearRecognitionToken(tokenKey, token);
        }, 300);
      }
    },
    enabled: spec.selection.entries.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const computeToken = useSharedRecognitionToken(
    result.isLoading || result.isFetching ? tokenKey : null,
  );
  return { ...result, computeToken };
}

function xTitle(view: ChargeabilityViewSpec) {
  if (view.x_axis === "soc_pct") return "Capacity-based SoC (%)";
  if (view.x_axis === "capacity_mah") return "Added capacity (mAh)";
  if (view.x_axis === "capacity_mah_g") return "Specific added capacity (mAh/g)";
  if (view.x_axis === "capacity_mah_cm2") return "Areal added capacity (mAh/cm²)";
  return `Elapsed time (${view.time_unit})`;
}

function yTitle(view: ChargeabilityViewSpec) {
  if (view.y_axis === "current_ma") return "Current (mA)";
  if (view.y_axis === "current_ma_g") return "Specific current (mA/g)";
  if (view.y_axis === "current_ma_cm2") return "Areal current density (mA/cm²)";
  return "C-rate";
}

function timeFactor(unit: ChargeabilityViewSpec["time_unit"]) {
  return unit === "h" ? 3600 : unit === "min" ? 60 : 1;
}

function xValues(match: ChargeabilityMatch, view: ChargeabilityViewSpec) {
  if (view.x_axis === "time") {
    const factor = timeFactor(view.time_unit);
    return match.x.time_s.map((value) => (value == null ? null : value / factor));
  }
  return match.x[view.x_axis];
}

function hasFinite(values: (number | null)[]) {
  return values.some((value) => value != null && Number.isFinite(value));
}

/**
 * Per-series appearance descriptors for the style editor. Maps Chargeability result
 * matches to their stable keys and display labels.
 */
export function chargeabilitySeriesDescriptors(
  matches: ChargeabilityMatch[],
  result: ChargeabilityResult,
): SeriesDescriptor[] {
  return matches.map((match) => {
    const name =
      result.matches.filter((other) => other.cell_id === match.cell_id).length > 1
        ? `${match.label} — cycle ${match.cycle ?? "—"}`
        : match.label;
    return {
      key: `chargeability-${match.id}`,
      kind: "cell",
      label: name,
      cellName: match.cell_name,
      groupName: null,
    };
  });
}

export function chargeabilityTracesForResult(
  result: ChargeabilityResult,
  spec: AnalysisSpec,
): Plotly.Data[] {
  const view = chargeabilityViewFor(spec);
  const style = currentPlotStyle(spec, "chargeability");
  const palette = plotPalette(style);
  const visibleMatches = (result.matches ?? []).filter((match) => {
    const x = xValues(match, view);
    return (
      hasFinite(x) &&
      hasFinite(match.y[view.y_axis]) &&
      // Respect the "Analysis samples" eye toggle: a hidden cell draws nothing.
      !isCellHiddenInAnalysis(spec, match.cell_id)
    );
  });
  const descriptors = chargeabilitySeriesDescriptors(visibleMatches, result);
  return visibleMatches
    .map((match, index) => {
      const descriptor = descriptors[index];
      const color =
        style.custom_colors[`chargeability-${match.id}`] ??
        palette[index % palette.length];
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
      if (resolved.hidden) return null;
      return {
        type: "scatter",
        mode: seriesPlotlyMode(resolved),
        x: xValues(match, view),
        y: match.y[view.y_axis],
        name: resolved.name,
        showlegend: resolved.showInLegend,
        opacity: resolved.opacity,
        line: { color: resolved.color, width: resolved.lineWidth, dash: resolved.lineDash, shape: resolved.lineShape },
        marker: { color: resolved.color, size: resolved.markerSize, symbol: seriesPlotlySymbol(resolved) },
        customdata: (match.y[view.y_axis] ?? []).map(() => [
          match.initial_soc_pct,
          match.final_soc_pct,
          match.current_ceiling_c,
          match.target_voltage_v,
          match.duration_s,
        ]),
        hovertemplate:
          "%{fullData.name}<br>" +
          `${xTitle(view)}: %{x:.4g}<br>` +
          `${yTitle(view)}: %{y:.4g}<br>` +
          `Window: ${percent(match.initial_soc_pct)} → ${percent(match.final_soc_pct)}<br>` +
          `Ceiling: ${cRate(match.current_ceiling_c)}` +
          "<extra></extra>",
      } as Plotly.Data;
    })
    .filter((trace): trace is Plotly.Data => trace !== null);
}

function cRateTicks(result?: ChargeabilityResult) {
  let maximum = 1;
  for (const match of result?.matches ?? []) {
    for (const value of match.y.c_rate) {
      if (value != null && Number.isFinite(value)) maximum = Math.max(maximum, value);
    }
  }
  const common = [0, 0.05, 0.1, 0.2, 1 / 3, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20];
  const tickvals = common.filter((value) => value <= maximum * 1.05);
  return { tickvals, ticktext: tickvals.map(cRate) };
}

export function chargeabilityLayoutForSpec(
  spec: AnalysisSpec,
  result?: ChargeabilityResult,
): Partial<Plotly.Layout> {
  const view = chargeabilityViewFor(spec);
  const style = currentPlotStyle(spec, "chargeability");
  const rateTicks = view.y_axis === "c_rate" ? cRateTicks(result) : null;
  return {
    ...plotLayoutStyle(style, spec),
    margin: { l: 76, r: 20, t: 12, b: 58 },
    xaxis: {
      ...plotAxisStyle(style, { axis: style.x_axis }),
      title: { text: style.x_title ?? xTitle(view), font: axisTitleFont(style) },
    },
    yaxis: {
      ...plotAxisStyle(style, { zeroLine: true, axis: style.y_axis }),
      title: { text: style.y_title ?? yTitle(view), font: axisTitleFont(style) },
      ...(rateTicks
        ? { tickmode: "array", tickvals: rateTicks.tickvals, ticktext: rateTicks.ticktext }
        : {}),
    },
    legend: { orientation: "h", y: -0.22, font: { size: style.legend_font_size } },
    hovermode: "closest",
  };
}

export function ChargeabilitySettings({
  analysisId,
  spec,
  update,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
}) {
  const result = useChargeabilityResult(analysisId, spec);
  const computation = chargeabilityComputationFor(spec);
  const view = chargeabilityViewFor(spec);
  const available = result.data?.available_filters;
  const initialValues = available?.initial_soc_pct ?? [];
  const finalValues = available?.final_soc_pct ?? [];
  const currentValues = available?.current_ceiling_c ?? [];

  const patchComputation = (patch: Partial<ChargeabilityComputationSpec>) =>
    update((draft) => {
      draft.computation.chargeability = {
        ...DEFAULT_COMPUTATION,
        ...(draft.computation.chargeability ?? {}),
        ...patch,
      };
    });
  const patchView = (patch: Partial<ChargeabilityViewSpec>) =>
    update((draft) => {
      draft.presentation.chargeability_view = {
        ...DEFAULT_VIEW,
        ...(draft.presentation.chargeability_view ?? {}),
        ...patch,
      };
    });

  const hasMatches = Boolean(result.data?.matches.length);
  const hasSoc = Boolean(
    result.data?.matches.some((match) => hasFinite(match.x.soc_pct)),
  );
  const hasSpecificCapacity = Boolean(
    result.data?.matches.some((match) => hasFinite(match.x.capacity_mah_g)),
  );
  const hasArealCapacity = Boolean(
    result.data?.matches.some((match) => hasFinite(match.x.capacity_mah_cm2)),
  );
  const hasSpecificCurrent = Boolean(
    result.data?.matches.some((match) => hasFinite(match.y.current_ma_g)),
  );
  const hasArealCurrent = Boolean(
    result.data?.matches.some((match) => hasFinite(match.y.current_ma_cm2)),
  );
  const [structureOpen, setStructureOpen] = useState(false);
  const highlightedByCell = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const match of result.data?.matches ?? []) {
      let steps = map.get(match.cell_id);
      if (!steps) {
        steps = new Set();
        map.set(match.cell_id, steps);
      }
      steps.add(match.step_index);
    }
    return map;
  }, [result.data?.matches]);
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
              Capacity formulas are resolved by relationship, not variable name.
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
            {result.isLoading ? (
              <Badge color="gray" variant="light">Detecting</Badge>
            ) : hasMatches ? (
              <Badge color="teal" variant="light">
                {result.data?.matches.length} matched
              </Badge>
            ) : (
              <Badge color="gray" variant="light">No match</Badge>
            )}
          </Group>
        </Group>
        <ProtocolStructureViewer
          opened={structureOpen}
          onClose={() => setStructureOpen(false)}
          cells={structureCells}
          highlightedByCell={highlightedByCell}
        />
        <Stack gap="xs">
          <Select
            label="Initial SoC at or below"
            data={detectedOptions(initialValues, "%")}
            value={detectedValue(initialValues, computation.initial_soc_max_pct)}
            placeholder={
              result.isLoading
                ? "Detecting…"
                : initialValues.length
                  ? `Current bound: ${percent(computation.initial_soc_max_pct)}`
                  : "No detected values"
            }
            disabled={!initialValues.length}
            onChange={(value) =>
              value != null &&
              patchComputation({ initial_soc_max_pct: Number(value) })
            }
          />
          <Select
            label="Final SoC at or above"
            data={detectedOptions(finalValues, "%")}
            value={detectedValue(finalValues, computation.final_soc_min_pct)}
            placeholder={
              result.isLoading
                ? "Detecting…"
                : finalValues.length
                  ? `Current bound: ${percent(computation.final_soc_min_pct)}`
                  : "No detected values"
            }
            disabled={!finalValues.length}
            onChange={(value) =>
              value != null &&
              patchComputation({ final_soc_min_pct: Number(value) })
            }
          />
          <Select
            label="Minimum current ceiling"
            data={detectedOptions(currentValues, "C")}
            value={detectedValue(currentValues, computation.min_current_ceiling_c)}
            placeholder={
              result.isLoading
                ? "Detecting…"
                : currentValues.length
                  ? `Current bound: ${cRate(computation.min_current_ceiling_c)}`
                  : "No detected values"
            }
            disabled={!currentValues.length}
            description={
              "Uses the current limit declared by the voltage-controlled step."
            }
            onChange={(value) =>
              value != null &&
              patchComputation({ min_current_ceiling_c: Number(value) })
            }
          />
          <NumberInput
            label="SoC matching tolerance"
            suffix=" %"
            min={0}
            max={20}
            value={computation.soc_tolerance_pct}
            onChange={(value) =>
              typeof value === "number" &&
              patchComputation({ soc_tolerance_pct: value })
            }
          />
        </Stack>
        {result.data && result.data.cells.length > 1 && (
          <>
            <Divider my="xs" />
            <Group justify="space-between">
              <Text size="xs" c="dimmed">Across selected cells</Text>
              <Badge
                size="sm"
                color={
                  result.data.compatibility.compatible &&
                  result.data.compatibility.complete
                    ? "teal"
                    : "yellow"
                }
                variant="light"
              >
                {result.data.compatibility.compatible &&
                result.data.compatibility.complete
                  ? "Same protocol"
                  : !result.data.compatibility.complete
                    ? "Incomplete match"
                    : "Protocol mismatch"}
              </Badge>
            </Group>
          </>
        )}
      </Paper>

      <Paper p="sm" withBorder>
        <Text size="sm" fw={700} mb="xs">Axes</Text>
        <Stack gap="xs">
          <Select
            label="X axis"
            value={view.x_axis}
            data={[
              { value: "time", label: "Elapsed time" },
              { value: "soc_pct", label: "Capacity-based SoC", disabled: hasMatches && !hasSoc },
              { value: "capacity_mah", label: "Added capacity" },
              { value: "capacity_mah_g", label: "Specific capacity", disabled: hasMatches && !hasSpecificCapacity },
              { value: "capacity_mah_cm2", label: "Areal capacity", disabled: hasMatches && !hasArealCapacity },
            ]}
            onChange={(value) =>
              value && patchView({ x_axis: value as ChargeabilityViewSpec["x_axis"] })
            }
          />
          {view.x_axis === "time" && (
            <Select
              label="Time unit"
              value={view.time_unit}
              data={[
                { value: "s", label: "Seconds" },
                { value: "min", label: "Minutes" },
                { value: "h", label: "Hours" },
              ]}
              onChange={(value) =>
                value && patchView({ time_unit: value as ChargeabilityViewSpec["time_unit"] })
              }
            />
          )}
          <Select
            label="Y axis"
            value={view.y_axis}
            data={[
              { value: "c_rate", label: "C-rate" },
              { value: "current_ma", label: "Current" },
              { value: "current_ma_g", label: "Specific current", disabled: hasMatches && !hasSpecificCurrent },
              { value: "current_ma_cm2", label: "Areal current density", disabled: hasMatches && !hasArealCurrent },
            ]}
            onChange={(value) =>
              value && patchView({ y_axis: value as ChargeabilityViewSpec["y_axis"] })
            }
          />
        </Stack>
      </Paper>
    </Stack>
  );
}

export function ChargeabilityPlotCard({
  analysisId,
  analysisTitle,
  plotName,
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
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
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
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
  const result = useChargeabilityResult(analysisId, spec);
  const view = chargeabilityViewFor(spec);
  const style = currentPlotStyle(spec, "chargeability");
  const traces = useMemo(
    () => (result.data ? chargeabilityTracesForResult(result.data, spec) : []),
    [result.data, spec],
  );
  const layout = useMemo(
    () => chargeabilityLayoutForSpec(spec, result.data),
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
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    setPlotSize((current) =>
      current && current.width === next.width && current.height === next.height
        ? current
        : next,
    );
  };

  const visibleSeriesItems = useMemo(
    () => {
      if (!result.data) return [];
      const matches = result.data.matches ?? [];
      return matches.filter((match) => {
        const x = xValues(match, view);
        return (
          hasFinite(x) &&
          hasFinite(match.y[view.y_axis]) &&
          !isCellHiddenInAnalysis(spec, match.cell_id)
        );
      });
    },
    [result.data, spec, view]
  );
  const seriesDescriptors = useMemo(
    () =>
      result.data
        ? chargeabilitySeriesDescriptors(visibleSeriesItems, result.data)
        : [],
    [visibleSeriesItems, result.data]
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
            chargeability: {
              ...currentPlotStyle(spec, "chargeability"),
              ...(draft.styleOverlay ?? {}),
              series_overrides: draft.overrides,
              series_rules: draft.rules,
            },
          },
        },
      };
      const data = decimatePreviewTraces(chargeabilityTracesForResult(result.data, draftSpec));
      return { data, layout: chargeabilityLayoutForSpec(draftSpec, result.data) };
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
        message: error instanceof Error ? error.message : "Plot export failed.",
      });
    }
  };
  const getExportPreview = () =>
    styledPlotExportPreview(traces, layout, style, plotName, plotSize);
  const dataExport = async (baseName: string) => {
    try {
      await downloadDataExport(tracesToColumns(traces, layout), style, baseName);
    } catch (error) {
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : "Data export failed.",
      });
    }
  };

  const mismatch = result.data?.badges.some(
    (badge) => badge.kind === "chargeability_protocol_mismatch",
  );
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
          tabName="Chargeability"
          plotName={plotName}
          subtitle={`${yTitle(view)} vs ${xTitle(view).toLowerCase()}`}
          quantityName={yTitle(view)}
          xAxisName={style.x_title ?? xTitle(view)}
          sampleSummary={`${traces.length} ${traces.length === 1 ? "match" : "matches"}`}
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
              const styles = ((draft.presentation as Record<string, unknown>).plot_styles ??=
                {}) as Record<string, unknown>;
              const current = (styles.chargeability ?? {}) as Record<string, unknown>;
              fn(current as never);
              styles.chargeability = current;
            })
          }
          layout={layout}
          viewSize={plotSize}
          canExport={traces.length > 0}
        />
        {result.isError && (
          <Alert color="red">
            {(result.error as Error).message || "Could not compute chargeability."}
          </Alert>
        )}
        {mismatch && (
          <Alert color="yellow" py="xs" mb="xs">
            Selected cells resolved to different chargeability protocols. Curves are
            shown for inspection but are not directly equivalent.
          </Alert>
        )}
        {!spec.selection.entries.length ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={390}>
              Add cells or replicates to identify voltage-controlled chargeability
              events automatically.
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
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              No executed voltage-controlled charge step satisfies the selected SoC
              window and current ceiling.
            </Text>
          </Center>
        ) : (
          <>
            <Text size="xs" c="dimmed" mb={4}>
              {result.data?.matches
                .map(
                  (match) =>
                    `${match.cell_name}: ${percent(match.initial_soc_pct)}→${percent(match.final_soc_pct)} in ${
                      match.duration_s == null
                        ? "—"
                        : `${Number((match.duration_s / 60).toFixed(2))} min`
                    }`,
                )
                .join(" · ")}
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
        axisScope="chargeability"
        seriesDescriptors={seriesDescriptors}
        buildSeriesPreview={buildSeriesPreview}
      />
    </Group>
  );
}
