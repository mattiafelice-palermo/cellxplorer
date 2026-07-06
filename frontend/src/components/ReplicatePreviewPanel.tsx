import { ActionIcon, Alert, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import type { Data } from "plotly.js";

import { ReplicateGroupPreview } from "../api";
import Plot from "./Plot";

const TEAL = [18, 184, 134];
const GRAY = [173, 181, 189];

function blendColor(count: number, minCount: number, maxCount: number, alpha = 1) {
  const t = maxCount === minCount ? 1 : (count - minCount) / (maxCount - minCount);
  const rgb = TEAL.map((value, index) => Math.round(GRAY[index] + (value - GRAY[index]) * t));
  return alpha === 1 ? `rgb(${rgb.join(",")})` : `rgba(${rgb.join(",")},${alpha})`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function valueAt(values: number[] | undefined, index: number, fallback?: number | null) {
  const value =
    finiteNumber(values?.[index]) ??
    finiteNumber(values?.[index - 1]) ??
    finiteNumber(values?.[index + 1]) ??
    finiteNumber(fallback);
  return value;
}

export function ReplicatePreviewPanel({
  title,
  preview,
  onClose,
}: {
  title: string;
  preview?: ReplicateGroupPreview;
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<"individual" | "aggregate">("aggregate");
  if (!preview) return <Alert color="gray">Loading replicate preview.</Alert>;

  const aggregate = preview.aggregate;
  const cycles = aggregate.cycle ?? [];
  const median = (aggregate.median?.length ? aggregate.median : aggregate.mean) ?? [];
  const q1 = (aggregate.q1?.length ? aggregate.q1 : aggregate.min) ?? median;
  const q3 = (aggregate.q3?.length ? aggregate.q3 : aggregate.max) ?? median;
  const pointCounts =
    aggregate.count?.length === cycles.length
      ? aggregate.count
      : cycles.map(() => preview.stats.n_plotted_cells || 1);
  const counts = pointCounts.length ? pointCounts : [0];
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const individualTraces: Data[] = preview.series.map((series) => ({
    x: series.x,
    y: series.y,
    type: "scatter",
    mode: "lines",
    line: { width: 1, color: "rgba(18, 184, 134, 0.22)" },
    name: series.cell_name,
    hovertemplate: `${series.cell_name}<br>Cycle %{x}<br>Capacity %{y:.3f}<extra></extra>`,
    showlegend: mode === "individual",
  }));
  const bandTraces: Data[] = cycles.slice(0, -1).flatMap((cycle, index) => {
    const nextCycle = cycles[index + 1];
    const leftTop = valueAt(q3, index, valueAt(median, index));
    const rightTop = valueAt(q3, index + 1, valueAt(median, index + 1));
    const rightBottom = valueAt(q1, index + 1, valueAt(median, index + 1));
    const leftBottom = valueAt(q1, index, valueAt(median, index));
    if (
      !Number.isFinite(cycle) ||
      !Number.isFinite(nextCycle) ||
      leftTop === null ||
      rightTop === null ||
      rightBottom === null ||
      leftBottom === null
    ) {
      return [];
    }
    const count = Math.min(pointCounts[index] ?? maxCount, pointCounts[index + 1] ?? maxCount);
    return {
      x: [cycle, nextCycle, nextCycle, cycle],
      y: [leftTop, rightTop, rightBottom, leftBottom],
      type: "scatter",
      mode: "lines",
      fill: "toself",
      fillcolor: blendColor(count, minCount, maxCount, 0.18),
      line: { color: "rgba(0,0,0,0)", width: 0 },
      hoverinfo: "skip",
      showlegend: false,
      name: "IQR",
    };
  });
  const lineTraces: Data[] = cycles.slice(0, -1).flatMap((cycle, index) => {
    const nextCycle = cycles[index + 1];
    const y1 = valueAt(median, index);
    const y2 = valueAt(median, index + 1);
    const q1Left = valueAt(q1, index, y1);
    const q3Left = valueAt(q3, index, y1);
    const q1Right = valueAt(q1, index + 1, y2);
    const q3Right = valueAt(q3, index + 1, y2);
    if (!Number.isFinite(cycle) || !Number.isFinite(nextCycle) || y1 === null || y2 === null) {
      return [];
    }
    const count = Math.min(pointCounts[index] ?? maxCount, pointCounts[index + 1] ?? maxCount);
    return {
      x: [cycle, nextCycle],
      y: [y1, y2],
      type: "scatter",
      mode: "lines",
      line: { color: blendColor(count, minCount, maxCount), width: 2.4 },
      customdata: [
        [q1Left, q3Left, pointCounts[index] ?? count],
        [q1Right, q3Right, pointCounts[index + 1] ?? count],
      ],
      hovertemplate:
        "Cycle %{x}<br>Median %{y:.3f}<br>Q1 %{customdata[0]:.3f}<br>Q3 %{customdata[1]:.3f}<br>n %{customdata[2]}<extra></extra>",
      showlegend: false,
      name: "median",
    };
  });
  const markerX: number[] = [];
  const markerY: number[] = [];
  const markerColor: string[] = [];
  const markerCustomData: [number | null, number | null, number][] = [];
  cycles.forEach((cycle, index) => {
    const y = valueAt(median, index);
    if (!Number.isFinite(cycle) || y === null) return;
    const count = pointCounts[index] ?? maxCount;
    markerX.push(cycle);
    markerY.push(y);
    markerColor.push(blendColor(count, minCount, maxCount));
    markerCustomData.push([valueAt(q1, index, y), valueAt(q3, index, y), count]);
  });
  const markerTrace: Data = {
    x: markerX,
    y: markerY,
    type: "scatter",
    mode: "markers",
    marker: {
      size: 5,
      color: markerColor,
      line: { color: "white", width: 0.7 },
    },
    customdata: markerCustomData,
    hovertemplate:
      "Cycle %{x}<br>Median %{y:.3f}<br>Q1 %{customdata[0]:.3f}<br>Q3 %{customdata[1]:.3f}<br>n %{customdata[2]}<extra></extra>",
    showlegend: false,
    name: "median",
  };
  const aggregateTraces: Data[] = [...individualTraces, ...bandTraces, ...lineTraces, markerTrace];
  const hasAggregateData = markerX.length > 0;

  return (
    <Stack>
      <Group justify="space-between" align="start">
        <div>
          <Text fw={700}>{title}</Text>
          <Text size="xs" c="dimmed">
            {preview.stats.n_cells} cells - {preview.stats.n_plotted_cells} plotted
          </Text>
        </div>
        {onClose && (
          <ActionIcon variant="subtle" onClick={onClose}>
            <IconChevronRight size={16} />
          </ActionIcon>
        )}
      </Group>

      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(value) => setMode(value as "individual" | "aggregate")}
        data={[
          { value: "aggregate", label: "Median + IQR" },
          { value: "individual", label: "Individual" },
        ]}
      />

      {mode === "aggregate" && (
        <Group gap="xs" justify="end">
          <Text size="xs" c="dimmed">
            cells contributing
          </Text>
          <div
            style={{
              width: 94,
              height: 8,
              borderRadius: 4,
              background: `linear-gradient(90deg, ${blendColor(minCount, minCount, maxCount)} 0%, ${blendColor(maxCount, minCount, maxCount)} 100%)`,
              border: "1px solid var(--mantine-color-gray-3)",
            }}
          />
          <Text size="xs" c="dimmed">
            {minCount}
          </Text>
          <Text size="xs" c="dimmed">
            {maxCount}
          </Text>
        </Group>
      )}

      {mode === "aggregate" && !hasAggregateData ? (
        <Alert color="gray">No plottable replicate capacity data is available yet.</Alert>
      ) : (
        <Plot
          data={mode === "individual" ? individualTraces : aggregateTraces}
          layout={{
            height: 260,
            margin: { l: 55, r: 10, t: 10, b: 40 },
            xaxis: { title: { text: "Cycle" } },
            yaxis: { title: { text: "Discharge capacity (mAh)" } },
            showlegend: mode === "individual",
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
          }}
          config={{ displaylogo: false, responsive: true }}
          style={{ width: "100%" }}
        />
      )}

      <Table withTableBorder>
        <Table.Tbody>
          {[
            ["Average cycles", preview.stats.average_cycle_count],
            ["Average initial capacity", preview.stats.average_initial_capacity],
            ["Average max capacity", preview.stats.average_max_capacity],
            ["Average final capacity", preview.stats.average_final_capacity],
            ["Average total charge capacity", preview.stats.average_total_charge_capacity],
            ["Average total discharge capacity", preview.stats.average_total_discharge_capacity],
          ].map(([label, value]) => (
            <Table.Tr key={label}>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {label}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{value === null ? "-" : Number(value).toFixed(3)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
