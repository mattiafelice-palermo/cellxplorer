import {
  Alert,
  Badge,
  Box,
  Center,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { post, type AnalysisSpec } from "../api";
import Plot from "./Plot";

/**
 * The steps analysis: one point per execution of a chosen protocol segment.
 *
 * Deliberately its own file rather than another branch in the 9k-line analysis
 * page. Where the cycle tab treats a segment as a hiding filter, here the
 * segment *is* the x-axis unit, so a sub-cycle quantity — CV time inside fast
 * charge — can be plotted in isolation. It fetches its own result and builds
 * its own traces so it shares no state with the cycle plot machinery.
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

interface StepsResult {
  quantities: StepQuantity[];
  cell_series: StepSeries[];
  aggregates: StepAggregate[];
  steps: { segment_id: string | null; mode: string; x_axis: string };
}

const PALETTE = [
  "#1D9E75",
  "#378ADD",
  "#D85A30",
  "#7F77DD",
  "#BA7517",
  "#D4537E",
  "#639922",
  "#0F6E56",
];

export function StepsPlotCard({
  analysisId,
  spec,
  update,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const stepsCfg = (spec.computation as Record<string, unknown>).steps as
    | { segment_id?: string; mode?: string; x_axis?: string }
    | undefined;
  const segmentId = stepsCfg?.segment_id ?? null;
  const mode = stepsCfg?.mode === "contiguous" ? "contiguous" : "union";
  const xAxis = stepsCfg?.x_axis === "cycle" ? "cycle" : "occurrence";
  const quantity = spec.presentation.quantity ?? "cv_charge_time";
  const segments = spec.protocol_segments ?? [];

  const patchSteps = (patch: Record<string, string>) =>
    update((s) => {
      const current = ((s.computation as Record<string, unknown>).steps as object) ?? {};
      (s.computation as Record<string, unknown>).steps = { ...current, ...patch };
    });

  const signature = useMemo(
    () =>
      JSON.stringify({
        selection: spec.selection,
        segments,
        segmentId,
        mode,
        xAxis,
        aggregation: spec.aggregation,
      }),
    [spec.selection, segments, segmentId, mode, xAxis, spec.aggregation]
  );

  const result = useQuery({
    queryKey: ["steps", analysisId, signature],
    queryFn: () => post<StepsResult>(`/api/analyses/${analysisId}/steps`, { spec }),
    enabled: Boolean(segmentId) && spec.selection.entries.length > 0,
    staleTime: 5 * 60_000,
  });

  const data = result.data;
  const column =
    data?.quantities.find((q) => q.key === quantity)?.column ??
    data?.quantities[0]?.column ??
    "";
  const quantityLabel =
    data?.quantities.find((q) => q.column === column)?.label ?? "value";
  const xLabel = xAxis === "cycle" ? "Cycle of block" : "Block occurrence";

  const traces = useMemo(() => {
    if (!data || !column) return [];
    const out: Plotly.Data[] = [];
    let colorIndex = 0;
    const colorFor = new Map<string, string>();
    const pick = (key: string) => {
      if (!colorFor.has(key)) colorFor.set(key, PALETTE[colorIndex++ % PALETTE.length]);
      return colorFor.get(key)!;
    };

    for (const agg of data.aggregates) {
      const q = agg.quantities[column];
      if (!q) continue;
      const color = pick(`g${agg.group_id}`);
      // Band first so the mean line draws over it.
      out.push({
        x: [...agg.x, ...[...agg.x].reverse()],
        y: [...q.band_high, ...[...q.band_low].reverse()],
        fill: "toself",
        fillcolor: color,
        opacity: 0.15,
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
        line: { color, width: 2 },
        marker: { color, size: 5 },
        type: "scatter",
        mode: "lines+markers",
      } as Plotly.Data);
    }

    const showIndividual =
      spec.presentation.show_individual_cells || data.aggregates.length === 0;
    for (const series of data.cell_series) {
      if (series.excluded || !series.x.length) continue;
      const grouped = series.group_id !== null;
      if (grouped && !showIndividual) continue;
      const color = grouped ? pick(`g${series.group_id}`) : pick(`c${series.cell_id}`);
      out.push({
        x: series.x,
        y: series.quantities[column] ?? [],
        name: series.group_name ? `${series.label} (${series.group_name})` : series.label,
        line: { color, width: grouped ? 1 : 2 },
        marker: { color, size: grouped ? 3 : 5 },
        opacity: grouped ? 0.5 : 0.95,
        type: "scatter",
        mode: "lines+markers",
        showlegend: !grouped,
      } as Plotly.Data);
    }
    return out;
  }, [data, column, spec.presentation.show_individual_cells]);

  const layout = useMemo(
    () =>
      ({
        margin: { l: 64, r: 20, t: 12, b: 48 },
        xaxis: { title: { text: xLabel }, zeroline: false },
        yaxis: { title: { text: quantityLabel }, zeroline: false },
        showlegend: true,
        legend: { orientation: "h" as const, y: -0.2 },
        hovermode: "closest" as const,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
      }) as Partial<Plotly.Layout>,
    [xLabel, quantityLabel]
  );

  return (
    <Paper p="sm" withBorder style={{ minHeight: 590 }}>
      <Group gap="sm" align="end" wrap="wrap" mb="sm">
        <Select
          size="xs"
          label="Protocol segment"
          w={220}
          placeholder="Choose a segment"
          data={segments.map((seg) => ({ value: String(seg.id), label: seg.name }))}
          value={segmentId}
          onChange={(value) => value && patchSteps({ segment_id: value })}
          comboboxProps={{ withinPortal: true }}
        />
        <Box>
          <Text size="xs" fw={500} mb={4}>
            Group by
          </Text>
          <SegmentedControl
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
          <Text size="xs" fw={500} mb={4}>
            X axis
          </Text>
          <SegmentedControl
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
          size="xs"
          label="Quantity"
          w={200}
          data={(data?.quantities ?? []).map((q) => ({ value: q.key, label: q.label }))}
          value={quantity}
          onChange={(value) => value && update((s) => void (s.presentation.quantity = value))}
          comboboxProps={{ withinPortal: true }}
          disabled={!data}
        />
      </Group>

      {!segmentId ? (
        <Center h={480}>
          <Stack align="center" gap={6} maw={360}>
            <IconInfoCircle size={28} color="var(--mantine-color-gray-5)" />
            <Text size="sm" fw={500}>
              Choose a protocol segment
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              The steps view plots one point per execution of a set of protocol steps — for
              example the time spent in CV during each fast-charge block. Define a segment on the
              cycles tab, then pick it here.
            </Text>
          </Stack>
        </Center>
      ) : result.isError ? (
        <Alert color="red">{(result.error as Error).message || "Could not compute steps."}</Alert>
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
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="light" color="teal">
              {data?.cell_series.reduce((n, s) => n + (s.excluded ? 0 : s.x.length ? 1 : 0), 0)}{" "}
              cells
            </Badge>
            <Text size="xs" c="dimmed">
              {mode === "union"
                ? "Each point is one occurrence of the whole selected block."
                : "Each point is one uninterrupted run of the selected steps."}
            </Text>
          </Group>
          <Plot
            data={traces}
            layout={layout}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: "100%", height: 470 }}
            useResizeHandler
          />
        </>
      )}
    </Paper>
  );
}
