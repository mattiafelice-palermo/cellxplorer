import {
  Alert,
  Box,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import Plotly from "plotly.js-dist-min";
import { useMemo, useState } from "react";

import { post, type AnalysisSpec, type PlotExportFormat } from "../api";
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

/**
 * The steps analysis: one point per execution of a chosen protocol segment.
 *
 * A separate file, but deliberately the same shell as the cycle tab — the
 * shared PlotHeader (export, info) and PlotStylePanel (colours, axes) — so the
 * page keeps one layout. Where the cycle tab treats a segment as a hiding
 * filter, here the segment is the x-axis unit, letting a sub-cycle quantity be
 * followed on its own. Its controls live in the sidebar via StepsSettings.
 */

interface StepQuantity {
  key: string;
  column: string;
  label: string;
}

interface StepSeries {
  cell_id: number;
  cell_name: string;
  label: string;
  group_id: number | null;
  group_name: string | null;
  excluded: boolean;
  x: number[];
  quantities: Record<string, (number | null)[]>;
}

interface StepAggregate {
  group_id: number;
  group_name: string;
  x: number[];
  quantities: Record<
    string,
    { mean: (number | null)[]; band_low: (number | null)[]; band_high: (number | null)[] }
  >;
}

export interface StepsResult {
  quantities: StepQuantity[];
  cell_series: StepSeries[];
  aggregates: StepAggregate[];
  steps: { segment_id: string | null; mode: string; x_axis: string };
}

function readStepsConfig(spec: AnalysisSpec) {
  const cfg = (spec.computation as Record<string, unknown>).steps as
    | { segment_id?: string; mode?: string; x_axis?: string }
    | undefined;
  return {
    segmentId: cfg?.segment_id ?? null,
    mode: cfg?.mode === "contiguous" ? "contiguous" : "union",
    xAxis: cfg?.x_axis === "cycle" ? "cycle" : "occurrence",
  } as const;
}

export function useStepsResult(analysisId: number, spec: AnalysisSpec) {
  const { segmentId, mode, xAxis } = readStepsConfig(spec);
  const signature = useMemo(
    () =>
      JSON.stringify({
        selection: spec.selection,
        segments: spec.protocol_segments,
        segmentId,
        mode,
        xAxis,
        aggregation: spec.aggregation,
      }),
    [spec.selection, spec.protocol_segments, segmentId, mode, xAxis, spec.aggregation]
  );
  return useQuery({
    queryKey: ["steps", analysisId, signature],
    queryFn: () => post<StepsResult>(`/api/analyses/${analysisId}/steps`, { spec }),
    enabled: Boolean(segmentId) && spec.selection.entries.length > 0,
    staleTime: 5 * 60_000,
  });
}

/**
 * The steps tab's plot settings, in the sidebar like the cycle tab's.
 *
 * Segment, grouping and x-axis are unique to this tab; quantity, individual
 * cells and the replicate/band controls mirror the cycle settings so the two
 * tabs feel the same.
 */
export function StepsSettings({
  analysisId,
  spec,
  update,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const { segmentId, mode, xAxis } = readStepsConfig(spec);
  const quantity = spec.presentation.quantity ?? "cv_charge_time";
  const segments = spec.protocol_segments ?? [];
  // Shares the card's query by key, so this issues no extra request.
  const result = useStepsResult(analysisId, spec);

  const patchSteps = (patch: Record<string, string>) =>
    update((s) => {
      const current = ((s.computation as Record<string, unknown>).steps as object) ?? {};
      (s.computation as Record<string, unknown>).steps = { ...current, ...patch };
    });

  return (
    <Paper p="sm" withBorder>
      <Text fw={700} size="sm" mb="xs">
        Plot settings
      </Text>
      <Stack gap="sm">
        <Select
          label="Protocol segment"
          placeholder="Choose a segment"
          data={segments.map((seg) => ({ value: String(seg.id), label: seg.name }))}
          value={segmentId}
          onChange={(value) => value && patchSteps({ segment_id: value })}
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
            onChange={(value) => patchSteps({ mode: value })}
            data={[
              { value: "union", label: "Whole block" },
              { value: "contiguous", label: "Each run" },
            ]}
          />
        </Box>
        <Box>
          <Text size="sm" fw={500} mb={4}>
            X axis
          </Text>
          <SegmentedControl
            fullWidth
            size="xs"
            value={xAxis}
            onChange={(value) => patchSteps({ x_axis: value })}
            data={[
              { value: "occurrence", label: "Occurrence" },
              { value: "cycle", label: "Cycle" },
            ]}
          />
        </Box>
        <Select
          label="Quantity"
          data={(result.data?.quantities ?? []).map((q) => ({ value: q.key, label: q.label }))}
          value={quantity}
          onChange={(value) => value && update((s) => void (s.presentation.quantity = value))}
          comboboxProps={{ withinPortal: true }}
          disabled={!result.data}
        />
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
        <NumberInput
          label="Min cells for band"
          min={1}
          value={spec.aggregation.min_n_for_band}
          onChange={(v) =>
            update((s) => void (s.aggregation.min_n_for_band = typeof v === "number" ? v : 2))
          }
        />
      </Stack>
    </Paper>
  );
}

export function StepsPlotCard({
  analysisId,
  analysisTitle,
  plotName,
  spec,
  update,
}: {
  analysisId: number;
  analysisTitle: string;
  plotName: string;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const { segmentId, mode, xAxis } = readStepsConfig(spec);
  const quantity = spec.presentation.quantity ?? "cv_charge_time";
  const style = currentPlotStyle(spec, "steps");
  const result = useStepsResult(analysisId, spec);
  const data = result.data;

  const column =
    data?.quantities.find((q) => q.key === quantity)?.column ??
    data?.quantities[0]?.column ??
    "";
  const quantityLabel = data?.quantities.find((q) => q.column === column)?.label ?? "value";
  const defaultXTitle = xAxis === "cycle" ? "Cycle of block" : "Block occurrence";
  const palette = plotPalette(style);

  const traces = useMemo(() => {
    if (!data || !column) return [];
    const out: Plotly.Data[] = [];
    let colorIndex = 0;
    const colorFor = new Map<string, string>();
    const pick = (key: string) => {
      if (style.custom_colors[key]) return style.custom_colors[key];
      if (!colorFor.has(key)) colorFor.set(key, palette[colorIndex++ % palette.length]);
      return colorFor.get(key)!;
    };
    const mplot =
      style.marker_mode === "none"
        ? "lines"
        : style.marker_mode === "points"
          ? "markers"
          : "lines+markers";

    for (const agg of data.aggregates) {
      const q = agg.quantities[column];
      if (!q) continue;
      const color = pick(`g${agg.group_id}`);
      out.push({
        x: [...agg.x, ...[...agg.x].reverse()],
        y: [...q.band_high, ...[...q.band_low].reverse()],
        fill: "toself",
        fillcolor: color,
        opacity: style.band_opacity ?? 0.15,
        line: { width: 0 },
        type: "scatter",
        mode: "lines",
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
      out.push({
        x: agg.x,
        y: q.mean,
        name: `${agg.group_name} mean`,
        line: { color, width: style.line_width, dash: style.line_dash },
        marker: { color, size: style.marker_size },
        type: "scatter",
        mode: mplot,
      } as Plotly.Data);
    }

    const showIndividual = spec.presentation.show_individual_cells || data.aggregates.length === 0;
    for (const series of data.cell_series) {
      if (series.excluded || !series.x.length) continue;
      const grouped = series.group_id !== null;
      if (grouped && !showIndividual) continue;
      const color = grouped ? pick(`g${series.group_id}`) : pick(`c${series.cell_id}`);
      out.push({
        x: series.x,
        y: series.quantities[column] ?? [],
        name: series.group_name ? `${series.label} (${series.group_name})` : series.label,
        line: {
          color,
          width: grouped ? Math.max(1, style.line_width - 1) : style.line_width,
          dash: style.line_dash,
        },
        marker: { color, size: style.marker_size },
        opacity: grouped ? style.individual_opacity : 0.95,
        type: "scatter",
        mode: mplot,
        showlegend: !grouped,
      } as Plotly.Data);
    }
    return out;
  }, [data, column, spec.presentation.show_individual_cells, style]);

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
          title: { text: style.y_title ?? quantityLabel },
          zeroline: false,
          showgrid: style.show_grid,
        },
        showlegend: true,
        legend: { orientation: "h" as const, y: -0.22 },
        hovermode: "closest" as const,
        paper_bgcolor: style.paper_bgcolor ?? "rgba(0,0,0,0)",
        plot_bgcolor: style.plot_bgcolor ?? "rgba(0,0,0,0)",
      }) as Partial<Plotly.Layout>,
    [style, defaultXTitle, quantityLabel]
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
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Plot export failed.",
        color: "red",
      });
    }
  };

  const handleDataExport = async (baseName: string) => {
    try {
      await downloadDataExport(tracesToColumns(traces, layout), style, baseName);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Data export failed.",
        color: "red",
      });
    }
  };

  const shownCells = data?.cell_series.filter((s) => !s.excluded && s.x.length).length ?? 0;

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
          subtitle={`${quantityLabel} vs ${defaultXTitle.toLowerCase()}`}
          quantityName={quantityLabel}
          xAxisName={style.x_title ?? defaultXTitle}
          sampleSummary={`${shownCells} ${shownCells === 1 ? "cell" : "cells"}`}
          onExport={exportPlot}
          onDataExport={handleDataExport}
          style={style}
          updateStyle={(fn) =>
            update((s) => {
              const styles = ((s.presentation as Record<string, unknown>).plot_styles ??= {}) as Record<
                string,
                unknown
              >;
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
        {!segmentId ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={360}>
              Choose a protocol segment in the sidebar. The steps view plots one point per
              execution of a set of protocol steps — for example the CV time in each fast-charge
              block.
            </Text>
          </Center>
        ) : result.isLoading ? (
          <Center h={480}>
            <Loader size="sm" />
          </Center>
        ) : traces.length === 0 ? (
          <Center h={480}>
            <Text size="sm" c="dimmed">
              No blocks matched this segment in the selected cells.
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
