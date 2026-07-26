import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import Plotly from "plotly.js-dist-min";
import { useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type AnalysisSpec,
  type CellProtocol,
  type CellSummary,
  type PlotExportFormat,
  type StepsSeriesSpec,
  type StepsViewSpec,
} from "../api";
import {
  axisTitleFont,
  currentPlotStyle,
  downloadStyledPlotExport,
  downloadDataExport,
  isAnalysisSegmentHidden,
  isCellHiddenInAnalysis,
  isSeriesHidden,
  plotAxisStyle,
  markerSymbol,
  plotLayoutStyle,
  plotPalette,
  PlotHeader,
  PlotStylePanel,
  styledPlotExportPreview,
  tracesToColumns,
  useDelayedFlag,
  usePlotSizeSync,
} from "../pages/AnalysisPage";
import Plot from "./Plot";

interface StepSeries {
  series_id: string;
  cell_id: number;
  cell_name: string;
  segment_id: string;
  segment_name: string;
  label: string;
  x_occurrence: number[];
  x_cycle: (number | null)[];
  x_time: (number | null)[];
  quantities: Record<string, (number | null)[]>;
  n_blocks: number;
}

interface StepsBadge {
  kind: string;
  series_id?: string;
  detail: string;
}

export interface StepsResult {
  cell_series: StepSeries[];
  steps: { series: StepsSeriesSpec[]; mode: "union" | "contiguous" };
  badges: StepsBadge[];
}

const DEFAULT_VIEW: StepsViewSpec = {
  quantity: "time",
  direction: "charge",
  include_rest: false,
  x_axis: "occurrence",
};

const QUANTITIES: { value: StepsViewSpec["quantity"]; label: string }[] = [
  { value: "time", label: "Time" },
  { value: "cv_charge_time", label: "CV charge time" },
  { value: "voltage", label: "Voltage" },
  { value: "capacity", label: "Capacity" },
  { value: "block_duration", label: "Block duration" },
];

function newSeriesId() {
  return globalThis.crypto?.randomUUID?.() ?? `steps-${Date.now()}-${Math.random()}`;
}

function readStepsConfig(
  spec: AnalysisSpec,
  cells: Pick<CellSummary, "id" | "name">[]
): { series: StepsSeriesSpec[]; mode: "union" | "contiguous" } {
  const cfg = spec.computation.steps;
  if (Array.isArray(cfg?.series) && cfg.series.length > 0) {
    return {
      series: cfg.series,
      mode: cfg.mode === "contiguous" ? "contiguous" : "union",
    };
  }
  if (cfg?.segment_id) {
    return {
      series: cells.map((cell) => ({
        id: `legacy-${cell.id}-${cfg.segment_id}`,
        cell_id: cell.id,
        segment_id: cfg.segment_id!,
      })),
      mode: cfg.mode === "contiguous" ? "contiguous" : "union",
    };
  }
  return { series: [], mode: cfg?.mode === "contiguous" ? "contiguous" : "union" };
}

function readStepsView(spec: AnalysisSpec): StepsViewSpec {
  return { ...DEFAULT_VIEW, ...(spec.presentation.steps_view ?? {}) };
}

function quantityColumn(view: StepsViewSpec) {
  if (view.quantity === "cv_charge_time") return "cv_charge_time_h";
  if (view.quantity === "block_duration") return "block_duration_h";
  if (view.quantity === "capacity") {
    return view.direction === "discharge"
      ? "discharge_capacity_mah"
      : "charge_capacity_mah";
  }
  if (view.quantity === "voltage") {
    if (view.direction === "discharge") return "mean_discharge_voltage_v";
    if (view.direction === "total") return "mean_voltage_v";
    return "mean_charge_voltage_v";
  }
  if (view.direction === "discharge") return "discharge_time_h";
  if (view.direction === "total") {
    return view.include_rest ? "block_duration_h" : "total_time_h";
  }
  return "charge_time_h";
}

function quantityLabel(view: StepsViewSpec) {
  if (view.quantity === "cv_charge_time") return "CV charge time (h)";
  if (view.quantity === "block_duration") return "Block duration (h)";
  if (view.quantity === "capacity") {
    return view.direction === "discharge"
      ? "Discharge capacity (mAh)"
      : "Charge capacity (mAh)";
  }
  if (view.quantity === "voltage") {
    if (view.direction === "discharge") return "Mean discharge voltage (V)";
    if (view.direction === "total") return "Mean voltage (V)";
    return "Mean charge voltage (V)";
  }
  if (view.direction === "discharge") return "Discharge time (h)";
  if (view.direction === "total") {
    return view.include_rest ? "Total elapsed time (h)" : "Charge + discharge time (h)";
  }
  return "Charge time (h)";
}

function xTitle(axis: StepsViewSpec["x_axis"]) {
  if (axis === "cycle") return "Cycle at block start";
  if (axis === "time") return "Elapsed time at block start (h)";
  return "Block occurrence";
}

export function useStepsResult(
  analysisId: number,
  spec: AnalysisSpec,
  cells: Pick<CellSummary, "id" | "name">[]
) {
  const { series, mode } = readStepsConfig(spec, cells);
  const signature = useMemo(
    () =>
      JSON.stringify({
        // Only the sample set (not display-only exclusions) changes the data,
        // so hiding a line or a cell filters client-side without a recompute.
        entries: spec.selection.entries,
        segments: spec.protocol_segments,
        series,
        mode,
      }),
    [spec.selection.entries, spec.protocol_segments, series, mode]
  );
  return useQuery({
    queryKey: ["steps", analysisId, signature],
    queryFn: () => post<StepsResult>(`/api/analyses/${analysisId}/steps`, { spec }),
    enabled: series.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
}

export function StepsSettings({
  analysisId,
  spec,
  cells,
  update,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  cells: Pick<CellSummary, "id" | "name">[];
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const { series, mode } = readStepsConfig(spec, cells);
  const view = readStepsView(spec);
  const segments = spec.protocol_segments ?? [];
  const result = useStepsResult(analysisId, spec, cells);
  const protocolQueries = useQueries({
    queries: cells.map((cell) => ({
      queryKey: ["cell-protocol", cell.id],
      queryFn: () => get<CellProtocol>(`/api/cells/${cell.id}/protocol`),
      staleTime: 5 * 60_000,
    })),
  });
  const protocolSignaturesByCell = useMemo(() => {
    const signatures = new Map<number, Set<string>>();
    protocolQueries.forEach((query, index) => {
      const cellId = cells[index]?.id;
      if (cellId == null || !query.data) return;
      signatures.set(
        cellId,
        new Set(
          query.data.tests.flatMap((test) =>
            test.files
              .map((file) => file.protocol.signature)
              .filter((signature): signature is string => Boolean(signature))
          )
        )
      );
    });
    return signatures;
  }, [cells, protocolQueries]);
  const protocolsLoading = protocolQueries.some((query) => query.isPending);
  const applicableSegments = (cellId: number | null) => {
    if (cellId == null) return [];
    const signatures = protocolSignaturesByCell.get(cellId);
    if (!signatures) return [];
    return segments.filter((segment) =>
      segment.targets.some((target) => signatures.has(target.protocol_signature))
    );
  };
  const firstValidPair = () => {
    for (const cell of cells) {
      const segment = applicableSegments(cell.id)[0];
      if (segment) return { cellId: cell.id, segmentId: segment.id };
    }
    return { cellId: cells[0]?.id ?? null, segmentId: null };
  };
  const unmatched = new Set(
    (result.data?.badges ?? [])
      .filter((badge) => badge.kind === "steps_no_match" && badge.series_id)
      .map((badge) => badge.series_id!)
  );

  const writeSeries = (next: StepsSeriesSpec[]) =>
    update((draft) => {
      draft.computation.steps = { series: next, mode };
    });
  const toggleSeriesHidden = (seriesId: string) =>
    update((draft) => {
      const hidden = new Set(draft.presentation.hidden_series_ids ?? []);
      if (hidden.has(seriesId)) hidden.delete(seriesId);
      else hidden.add(seriesId);
      draft.presentation.hidden_series_ids = [...hidden];
    });
  const patchView = (patch: Partial<StepsViewSpec>) =>
    update((draft) => {
      draft.presentation.steps_view = {
        ...DEFAULT_VIEW,
        ...(draft.presentation.steps_view ?? {}),
        ...patch,
      };
    });

  const [seriesCollapsed, setSeriesCollapsed] = useState(false);
  const [editor, setEditor] = useState<{
    open: boolean;
    id: string | null;
    cellId: number | null;
    segmentId: string | null;
    error: string | null;
  }>({ open: false, id: null, cellId: null, segmentId: null, error: null });

  // Match each row's dot to the swatch the plot draws, which palettes over the
  // visible series (drawable and not hidden by any layer).
  const seriesColor = useMemo(() => {
    const style = currentPlotStyle(spec, "steps");
    const palette = plotPalette(style);
    const map = new Map<string, string>();
    (result.data ? stepsVisibleSeries(result.data, spec) : [])
      .forEach((item, index) => {
        map.set(
          item.series_id,
          style.custom_colors[`steps-${item.series_id}`] ??
            palette[index % palette.length]
        );
      });
    return map;
  }, [result.data, spec]);

  const openSeriesEditor = (item: StepsSeriesSpec | null) => {
    const fallback = firstValidPair();
    const cellId = item?.cell_id ?? fallback.cellId;
    const validSegments = applicableSegments(cellId);
    const segmentId =
      item && validSegments.some((segment) => segment.id === item.segment_id)
        ? item.segment_id
        : validSegments[0]?.id ?? fallback.segmentId;
    setEditor({
      open: true,
      id: item?.id ?? null,
      cellId,
      segmentId,
      error: null,
    });
  };

  const closeSeriesEditor = () =>
    setEditor((current) => ({ ...current, open: false, error: null }));

  const saveSeriesEditor = () => {
    if (editor.cellId == null || !editor.segmentId) return;
    const duplicate = series.some(
      (entry) =>
        entry.id !== editor.id &&
        entry.cell_id === editor.cellId &&
        entry.segment_id === editor.segmentId
    );
    if (duplicate) {
      setEditor((current) => ({
        ...current,
        error: "This cell and segment pair is already a series.",
      }));
      return;
    }
    if (editor.id) {
      writeSeries(
        series.map((entry) =>
          entry.id === editor.id
            ? { ...entry, cell_id: editor.cellId!, segment_id: editor.segmentId! }
            : entry
        )
      );
    } else {
      writeSeries([
        ...series,
        { id: newSeriesId(), cell_id: editor.cellId!, segment_id: editor.segmentId! },
      ]);
    }
    closeSeriesEditor();
  };

  return (
    <Stack gap="xs">
      <Paper p="sm" withBorder>
        <Group justify="space-between" mb={seriesCollapsed ? 0 : "xs"} wrap="nowrap">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={seriesCollapsed ? "Expand series" : "Collapse series"}
              onClick={() => setSeriesCollapsed((value) => !value)}
            >
              {seriesCollapsed ? (
                <IconChevronRight size={16} />
              ) : (
                <IconChevronDown size={16} />
              )}
            </ActionIcon>
            <Text fw={700} size="sm">
              Step series
            </Text>
            {series.length > 0 && (
              <Badge size="xs" variant="light" color="gray">
                {series.length}
              </Badge>
            )}
          </Group>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => openSeriesEditor(null)}
            disabled={
              !cells.length ||
              !segments.length ||
              protocolsLoading ||
              !cells.some((cell) => applicableSegments(cell.id).length > 0)
            }
          >
            Add series
          </Button>
        </Group>
        <Collapse in={!seriesCollapsed}>
          {series.length === 0 ? (
            <Text size="xs" c="dimmed">
              Add a cell and segment pair to plot one line per block series.
            </Text>
          ) : (
            <Box className="cx-vertical-scroll" style={{ maxHeight: 280 }}>
              <Stack gap={4} pr={4}>
                {series.map((item) => {
                  const cellName =
                    cells.find((cell) => cell.id === item.cell_id)?.name ??
                    `Cell ${item.cell_id}`;
                  const segmentName =
                    segments.find((segment) => segment.id === item.segment_id)?.name ??
                    "Unknown segment";
                  const noMatch = unmatched.has(item.id);
                  const cellHidden = isCellHiddenInAnalysis(spec, item.cell_id);
                  const segmentHidden = isAnalysisSegmentHidden(spec, item.segment_id);
                  const selfHidden = isSeriesHidden(spec, item.id);
                  const hidden = cellHidden || segmentHidden || selfHidden;
                  const forcedHidden = cellHidden || segmentHidden;
                  return (
                    <Group
                      key={item.id}
                      gap={8}
                      wrap="nowrap"
                      justify="space-between"
                      style={{
                        border: "1px solid var(--mantine-color-gray-2)",
                        borderRadius: 6,
                        padding: "5px 8px",
                        opacity: hidden ? 0.5 : 1,
                      }}
                    >
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            flexShrink: 0,
                            background: hidden
                              ? "var(--mantine-color-gray-4)"
                              : seriesColor.get(item.id) ??
                                "var(--mantine-color-gray-4)",
                          }}
                        />
                        <Tooltip
                          label={`${cellName} — ${segmentName}`}
                          openDelay={400}
                          withArrow
                          multiline
                        >
                          <Box style={{ minWidth: 0 }}>
                            <Text size="xs" fw={600} truncate>
                              {cellName}
                            </Text>
                            <Text size="10px" c={noMatch ? "red" : "dimmed"} truncate>
                              {segmentName}
                              {noMatch ? " · no match" : ""}
                            </Text>
                          </Box>
                        </Tooltip>
                      </Group>
                      <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                        <Tooltip
                          label={
                            forcedHidden
                              ? "Hidden with its cell or segment"
                              : hidden
                                ? "Show series"
                                : "Hide series"
                          }
                          openDelay={300}
                          withArrow
                        >
                          <ActionIcon
                            variant="subtle"
                            color={hidden ? "gray" : "teal"}
                            size="sm"
                            aria-label={hidden ? "Show series" : "Hide series"}
                            onClick={() => toggleSeriesHidden(item.id)}
                          >
                            {hidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label="Edit series"
                          onClick={() => openSeriesEditor(item)}
                        >
                          <IconPencil size={14} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="sm"
                          aria-label="Remove series"
                          onClick={() =>
                            writeSeries(series.filter((entry) => entry.id !== item.id))
                          }
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Group>
                  );
                })}
              </Stack>
            </Box>
          )}
        </Collapse>
      </Paper>

      <Modal
        opened={editor.open}
        onClose={closeSeriesEditor}
        title={editor.id ? "Edit step series" : "Add step series"}
        centered
        size="sm"
      >
        <Stack gap="sm">
          <Select
            label="Cell"
            searchable
            data={cells.map((cell) => ({
              value: String(cell.id),
              label: cell.name,
            }))}
            value={editor.cellId != null ? String(editor.cellId) : null}
            onChange={(value) =>
              setEditor((current) => {
                const cellId = value ? Number(value) : null;
                return {
                  ...current,
                  cellId,
                  segmentId: applicableSegments(cellId)[0]?.id ?? null,
                  error: null,
                };
              })
            }
          />
          <Select
            label="Protocol segment"
            searchable
            data={applicableSegments(editor.cellId).map((segment) => ({
              value: segment.id,
              label: segment.name,
            }))}
            value={editor.segmentId}
            onChange={(value) =>
              setEditor((current) => ({ ...current, segmentId: value, error: null }))
            }
            disabled={editor.cellId == null || protocolsLoading}
            description={
              editor.cellId != null &&
              !protocolsLoading &&
              applicableSegments(editor.cellId).length === 0
                ? "No protocol segments apply to this cell."
                : undefined
            }
          />
          {editor.error && (
            <Text size="xs" c="red">
              {editor.error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={closeSeriesEditor}>
              Cancel
            </Button>
            <Button
              onClick={saveSeriesEditor}
              disabled={editor.cellId == null || !editor.segmentId}
            >
              {editor.id ? "Save changes" : "Add series"}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Paper p="sm" withBorder>
        <Text fw={700} size="sm" mb="xs">
          Plot settings
        </Text>
        <Stack gap="sm">
          <Select
            label="Quantity"
            data={QUANTITIES}
            value={view.quantity}
            onChange={(value) => {
              if (!value) return;
              const quantity = value as StepsViewSpec["quantity"];
              patchView({
                quantity,
                direction:
                  quantity === "capacity" && view.direction === "total"
                    ? "charge"
                    : view.direction,
              });
            }}
            comboboxProps={{ withinPortal: true }}
          />
          {(view.quantity === "time" ||
            view.quantity === "voltage" ||
            view.quantity === "capacity") && (
            <Box>
              <Text size="sm" fw={500} mb={4}>
                Direction
              </Text>
              <SegmentedControl
                fullWidth
                size="xs"
                value={view.direction}
                onChange={(value) =>
                  patchView({ direction: value as StepsViewSpec["direction"] })
                }
                data={[
                  { value: "charge", label: "Charge" },
                  { value: "discharge", label: "Discharge" },
                  ...(view.quantity === "capacity"
                    ? []
                    : [{ value: "total", label: "Total" }]),
                ]}
              />
            </Box>
          )}
          {view.quantity === "time" && view.direction === "total" && (
            <Checkbox
              label="Include rest and elapsed gaps"
              checked={view.include_rest}
              onChange={(event) => patchView({ include_rest: event.currentTarget.checked })}
            />
          )}
          <Select
            label="X axis"
            value={view.x_axis}
            data={[
              { value: "occurrence", label: "Occurrence" },
              { value: "cycle", label: "Cycle" },
              { value: "time", label: "Elapsed time" },
            ]}
            onChange={(value) =>
              value && patchView({ x_axis: value as StepsViewSpec["x_axis"] })
            }
            comboboxProps={{ withinPortal: true }}
          />
          <Box>
            <Text size="sm" fw={500} mb={4}>
              Group steps by
            </Text>
            <SegmentedControl
              fullWidth
              size="xs"
              value={mode}
              onChange={(value) =>
                update((draft) => {
                  draft.computation.steps = {
                    series,
                    mode: value as "union" | "contiguous",
                  };
                })
              }
              data={[
                { value: "union", label: "Whole block" },
                { value: "contiguous", label: "Each run" },
              ]}
            />
          </Box>
        </Stack>
      </Paper>
    </Stack>
  );
}

/**
 * The step series that actually draw: blocks matched, and not switched off by
 * the cell (sidebar), the segment, or this line individually. The plot and the
 * sidebar swatches both palette over this list so their colours stay aligned.
 */
export function stepsVisibleSeries(result: StepsResult, spec: AnalysisSpec): StepSeries[] {
  return result.cell_series.filter(
    (item) =>
      item.n_blocks > 0 &&
      !isCellHiddenInAnalysis(spec, item.cell_id) &&
      !isAnalysisSegmentHidden(spec, item.segment_id) &&
      !isSeriesHidden(spec, item.series_id)
  );
}

export function stepsTracesForResult(result: StepsResult, spec: AnalysisSpec): Plotly.Data[] {
  const view = readStepsView(spec);
  const style = currentPlotStyle(spec, "steps");
  const column = quantityColumn(view);
  const palette = plotPalette(style);
  const mode =
    style.marker_mode === "none"
      ? "lines"
      : style.marker_mode === "points"
        ? "markers"
        : "lines+markers";
  return stepsVisibleSeries(result, spec)
    .map((item, index) => {
      const color =
        style.custom_colors[`steps-${item.series_id}`] ?? palette[index % palette.length];
      const x =
        view.x_axis === "cycle"
          ? item.x_cycle
          : view.x_axis === "time"
            ? item.x_time
            : item.x_occurrence;
      return {
        x,
        y: item.quantities[column] ?? [],
        name: item.label,
        line: { color, width: style.line_width, dash: style.line_dash },
        marker: { color, size: style.marker_size, symbol: markerSymbol(style) },
        type: "scatter",
        mode,
      } as Plotly.Data;
    });
}

export function stepsLayoutForSpec(spec: AnalysisSpec): Partial<Plotly.Layout> {
  const view = readStepsView(spec);
  const style = currentPlotStyle(spec, "steps");
  const defaultXTitle = xTitle(view.x_axis);
  const yLabel = quantityLabel(view);
  return {
    ...plotLayoutStyle(style, spec),
    margin: { l: 66, r: 20, t: 12, b: 52 },
    xaxis: {
      ...plotAxisStyle(style, { axis: style.x_axis }),
      title: { text: style.x_title ?? defaultXTitle, font: axisTitleFont(style) },
    },
    yaxis: {
      ...plotAxisStyle(style, { zeroLine: true, axis: style.y_axis }),
      title: { text: style.y_title ?? yLabel, font: axisTitleFont(style) },
    },
    legend: { orientation: "h", y: -0.22, font: { size: style.legend_font_size } },
    hovermode: "closest",
  } as Partial<Plotly.Layout>;
}

export function StepsPlotCard({
  analysisId,
  analysisTitle,
  plotName,
  spec,
  cells,
  update,
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
  cells: Pick<CellSummary, "id" | "name">[];
  update: (fn: (s: AnalysisSpec) => void) => void;
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
  const { series, mode } = readStepsConfig(spec, cells);
  const view = readStepsView(spec);
  const style = currentPlotStyle(spec, "steps");
  const result = useStepsResult(analysisId, spec, cells);
  const data = result.data;
  const yLabel = quantityLabel(view);
  const defaultXTitle = xTitle(view.x_axis);
  const traces = useMemo(() => (data ? stepsTracesForResult(data, spec) : []), [data, spec]);
  const layout = useMemo(() => stepsLayoutForSpec(spec), [spec]);
  const showComputeProgress = useDelayedFlag(result.isLoading);
  const plotUpdating = result.isFetching && traces.length > 0;
  const rememberPlotDiv = (graphDiv: unknown) => {
    const element = graphDiv as HTMLElement;
    plotDivRef.current = element;
    const rect = element.getBoundingClientRect();
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    setPlotSize((current) =>
      current && current.width === next.width && current.height === next.height
        ? current
        : next
    );
  };

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
        message: error instanceof Error ? error.message : "Plot export failed.",
        color: "red",
      });
    }
  };

  const getExportPreview = () =>
    styledPlotExportPreview(traces, layout, style, plotName, plotSize);

  const handleDataExport = async (baseName: string) => {
    try {
      await downloadDataExport(tracesToColumns(traces, layout), style, baseName);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Data export failed.",
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
        <PlotHeader
          analysisTitle={analysisTitle}
          tabName="Steps"
          plotName={plotName}
          subtitle={`${yLabel} vs ${defaultXTitle.toLowerCase()}`}
          quantityName={yLabel}
          xAxisName={style.x_title ?? defaultXTitle}
          sampleSummary={`${traces.length} ${traces.length === 1 ? "series" : "series"}`}
          onExport={exportPlot}
          onDataExport={handleDataExport}
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
              const current = (styles.steps ?? {}) as Record<string, unknown>;
              fn(current as never);
              styles.steps = current;
            })
          }
          layout={layout}
          viewSize={plotSize}
          canExport={traces.length > 0}
        />
        {result.isError && (
          <Alert color="red">{(result.error as Error).message || "Could not compute steps."}</Alert>
        )}
        {(data?.badges ?? []).some((badge) => badge.kind === "steps_no_match") && (
          <Alert color="yellow" py="xs" mb="xs">
            {(data?.badges ?? []).filter((badge) => badge.kind === "steps_no_match").length} series
            did not match the selected cell protocol.
          </Alert>
        )}
        {series.length === 0 ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={360}>
              Add a cell and protocol segment in the sidebar. Each pair becomes an independent
              line, with one point per execution of that step block.
            </Text>
          </Center>
        ) : result.isLoading ? (
          <Center h={480}>
            {showComputeProgress ? <Loader size="sm" /> : null}
          </Center>
        ) : traces.length === 0 ? (
          <Center h={480}>
            <Text size="sm" c="dimmed">
              No blocks matched the configured series.
            </Text>
          </Center>
        ) : (
          <>
            <Text size="xs" c="dimmed" mb={4}>
              {mode === "union"
                ? "Each point is one occurrence of the whole selected block."
                : "Each point is one uninterrupted run of the selected steps."}
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
        axisScope="steps"
      />
    </Group>
  );
}
