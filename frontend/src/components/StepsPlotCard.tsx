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
  LoadingOverlay,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import Plotly from "plotly.js-dist-min";
import { useMemo, useState } from "react";

import {
  post,
  type AnalysisSpec,
  type CellSummary,
  type PlotExportFormat,
  type StepsSeriesSpec,
  type StepsViewSpec,
} from "../api";
import { saveDownload } from "../downloads";
import {
  currentPlotStyle,
  downloadDataExport,
  plotPalette,
  PlotHeader,
  PlotStylePanel,
  tracesToColumns,
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
        selection: spec.selection,
        segments: spec.protocol_segments,
        series,
        mode,
      }),
    [spec.selection, spec.protocol_segments, series, mode]
  );
  return useQuery({
    queryKey: ["steps", analysisId, signature],
    queryFn: () => post<StepsResult>(`/api/analyses/${analysisId}/steps`, { spec }),
    enabled: series.length > 0,
    staleTime: 5 * 60_000,
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
  const unmatched = new Set(
    (result.data?.badges ?? [])
      .filter((badge) => badge.kind === "steps_no_match" && badge.series_id)
      .map((badge) => badge.series_id!)
  );

  const writeSeries = (next: StepsSeriesSpec[]) =>
    update((draft) => {
      draft.computation.steps = { series: next, mode };
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

  // Match each row's dot to the swatch the plot draws, which palettes by the
  // order of drawable (n_blocks > 0) result series rather than the spec order.
  const seriesColor = useMemo(() => {
    const style = currentPlotStyle(spec, "steps");
    const palette = plotPalette(style);
    const map = new Map<string, string>();
    (result.data?.cell_series ?? [])
      .filter((item) => item.n_blocks > 0)
      .forEach((item, index) => {
        map.set(
          item.series_id,
          style.custom_colors[`steps-${item.series_id}`] ??
            palette[index % palette.length]
        );
      });
    return map;
  }, [result.data, spec]);

  const openSeriesEditor = (item: StepsSeriesSpec | null) =>
    setEditor({
      open: true,
      id: item?.id ?? null,
      cellId: item?.cell_id ?? cells[0]?.id ?? null,
      segmentId: item?.segment_id ?? segments[0]?.id ?? null,
      error: null,
    });

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
            disabled={!cells.length || !segments.length}
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
            <ScrollArea.Autosize mah={280} type="auto" offsetScrollbars>
              <Stack gap={4} pr={4}>
                {series.map((item) => {
                  const cellName =
                    cells.find((cell) => cell.id === item.cell_id)?.name ??
                    `Cell ${item.cell_id}`;
                  const segmentName =
                    segments.find((segment) => segment.id === item.segment_id)?.name ??
                    "Unknown segment";
                  const noMatch = unmatched.has(item.id);
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
                      }}
                    >
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            flexShrink: 0,
                            background:
                              seriesColor.get(item.id) ??
                              "var(--mantine-color-gray-4)",
                          }}
                        />
                        <Box style={{ minWidth: 0 }}>
                          <Text size="xs" fw={600} truncate>
                            {cellName}
                          </Text>
                          <Text size="10px" c={noMatch ? "red" : "dimmed"} truncate>
                            {segmentName}
                            {noMatch ? " · no match" : ""}
                          </Text>
                        </Box>
                      </Group>
                      <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
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
            </ScrollArea.Autosize>
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
              setEditor((current) => ({
                ...current,
                cellId: value ? Number(value) : null,
                error: null,
              }))
            }
          />
          <Select
            label="Protocol segment"
            searchable
            data={segments.map((segment) => ({
              value: segment.id,
              label: segment.name,
            }))}
            value={editor.segmentId}
            onChange={(value) =>
              setEditor((current) => ({ ...current, segmentId: value, error: null }))
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

export function StepsPlotCard({
  analysisId,
  analysisTitle,
  plotName,
  spec,
  cells,
  update,
}: {
  analysisId: number;
  analysisTitle: string;
  plotName: string;
  spec: AnalysisSpec;
  cells: Pick<CellSummary, "id" | "name">[];
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const { series, mode } = readStepsConfig(spec, cells);
  const view = readStepsView(spec);
  const style = currentPlotStyle(spec, "steps");
  const result = useStepsResult(analysisId, spec, cells);
  const data = result.data;
  const column = quantityColumn(view);
  const yLabel = quantityLabel(view);
  const defaultXTitle = xTitle(view.x_axis);
  const palette = plotPalette(style);

  const traces = useMemo(() => {
    if (!data) return [];
    const mplot =
      style.marker_mode === "none"
        ? "lines"
        : style.marker_mode === "points"
          ? "markers"
          : "lines+markers";
    return data.cell_series
      .filter((item) => item.n_blocks > 0)
      .map((item, index) => {
        const color =
          style.custom_colors[`steps-${item.series_id}`] ??
          palette[index % palette.length];
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
          marker: { color, size: style.marker_size },
          type: "scatter",
          mode: mplot,
        } as Plotly.Data;
      });
  }, [data, column, palette, style, view.x_axis]);

  const layout = useMemo(
    () =>
      ({
        margin: { l: 66, r: 20, t: 12, b: 52 },
        xaxis: {
          title: { text: style.x_title ?? defaultXTitle },
          zeroline: false,
          showgrid: style.show_grid,
        },
        yaxis: {
          title: { text: style.y_title ?? yLabel },
          zeroline: false,
          showgrid: style.show_grid,
        },
        showlegend: true,
        legend: { orientation: "h" as const, y: -0.22 },
        hovermode: "closest" as const,
        paper_bgcolor: style.paper_bgcolor ?? "rgba(0,0,0,0)",
        plot_bgcolor: style.plot_bgcolor ?? "rgba(0,0,0,0)",
      }) as Partial<Plotly.Layout>,
    [style, defaultXTitle, yLabel]
  );

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    if (traces.length === 0) return;
    try {
      const toImage = (
        Plotly as unknown as { toImage: (fig: unknown, opts: unknown) => Promise<string> }
      ).toImage;
      const dataUrl = await toImage(
        { data: traces, layout: { ...layout, title: { text: plotName } } },
        { format: format === "pdf" ? "svg" : format, width: 1000, height: 600, scale: 2 }
      );
      const blob = await (await fetch(dataUrl)).blob();
      await saveDownload(blob, `${baseName}.${format === "pdf" ? "svg" : format}`);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Plot export failed.",
        color: "red",
      });
    }
  };

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
        <LoadingOverlay
          visible={result.isFetching && traces.length === 0}
          overlayProps={{ blur: 1.5, backgroundOpacity: 0.18 }}
          loaderProps={{ size: "sm", color: "teal" }}
        />
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
          style={style}
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
            <Loader size="sm" />
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
            <Box style={{ width: "100%", minWidth: 0 }}>
              <Plot
                data={traces}
                layout={layout}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: "100%", height: 470 }}
                useResizeHandler
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
