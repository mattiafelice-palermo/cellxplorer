// Quick scientific preview for one Cell, including recordings without complete cycles.
import { Alert, Center, Loader, SegmentedControl, Stack, Text, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { get, type ContinuationPreviewResult } from "../api";
import { CellPreviewPlot, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import { cellPreviewVoltageLayout, cellPreviewVoltageTraces } from "./cellPreviewPlotModel";
import Plot from "./Plot";

interface CyclesPayload {
  columns: string[];
  rows: Record<string, number | string | null>[];
  segments: { file_hash: string; segment: number; cycle_start: number; cycle_end: number }[];
  missing: string[];
  capability?: {
    status: "metadata_only" | string;
    metadata_only: boolean;
    canonical_cycling: boolean;
    message: string;
    sources: { source_file_id: number; filename: string; warning: string | null }[];
  };
}

const QUICK_QUANTITIES = [
  { value: "discharge_capacity_mah", label: "Discharge cap." },
  { value: "charge_capacity_mah", label: "Charge cap." },
  { value: "coulombic_efficiency_pct", label: "CE %" },
];

export function CellQuickPlot({ cellId, cellName }: { cellId: number; cellName: string }) {
  const [qty, setQty] = useState("discharge_capacity_mah");
  const cycles = useQuery({
    queryKey: ["cell-cycles", cellId],
    queryFn: () => get<CyclesPayload>(`/api/cells/${cellId}/cycles`),
  });

  if (cycles.isLoading)
    return (
      <Center h={220}>
        <Loader size="sm" />
        <Text size="sm" c="dimmed" ml="sm">
          Parsing / loading cache…
        </Text>
      </Center>
    );
  if (cycles.isError) return <Alert color="red">Could not load cycle data.</Alert>;

  const rows = cycles.data?.rows ?? [];
  if (cycles.data?.capability?.metadata_only)
    return <Alert color="orange" title="Cycle data unavailable">{cycles.data.capability.message}</Alert>;
  if (rows.length === 0)
    return <CellRecordingPreview cellId={cellId} />;

  return (
    <Stack gap="xs">
      <SegmentedControl size="xs" data={QUICK_QUANTITIES} value={qty} onChange={setQty} />
      <Plot
        data={[
          {
            x: rows.map((r) => r.cycle as number),
            y: rows.map((r) => r[qty] as number | null),
            type: "scatter",
            mode: qty === "coulombic_efficiency_pct" ? "markers" : "lines+markers",
            marker: qty === "coulombic_efficiency_pct"
              ? { size: 7, color: "#12b886", symbol: "circle-open", opacity: 0.2 }
              : { size: 4, color: "#12b886" },
            ...(qty === "coulombic_efficiency_pct" ? {} : { line: { color: "#12b886" } }),
            name: cellName,
          },
        ]}
        layout={{
          height: 260,
          margin: { l: 55, r: 10, t: 10, b: 40 },
          xaxis: { title: { text: "Cycle" }, showline: true, mirror: "all" },
          yaxis: {
            title: { text: QUICK_QUANTITIES.find((q) => q.value === qty)?.label ?? qty },
            showline: true,
            mirror: "all",
          },
          showlegend: false,
        }}
        config={{ displaylogo: false, responsive: true }}
        style={{ width: "100%" }}
      />
      {(cycles.data?.segments.length ?? 0) > 1 && (
        <Text size="xs" c="dimmed">
          {cycles.data!.segments.length} stitched file segments; boundaries at cycles{" "}
          {cycles.data!.segments.slice(1).map((s) => s.cycle_start).join(", ")}.
        </Text>
      )}
    </Stack>
  );
}


function CellRecordingPreview({ cellId }: { cellId: number }) {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("light");
  const [surfaceMode, setSurfaceMode] = useState<CellPreviewSurfaceMode>("theme");
  const preview = useQuery({
    queryKey: ["cell-cycles", cellId, "recorded-voltage"],
    queryFn: () => get<ContinuationPreviewResult>(`/api/cells/${cellId}/voltage-preview`),
    retry: false,
  });
  if (preview.isLoading) return <Center h={220}><Loader size="sm" /><Text size="sm" c="dimmed" ml="sm">Loading recorded voltage…</Text></Center>;
  if (preview.isError) return <Alert color="red">Could not load the voltage recording. {preview.error instanceof Error ? preview.error.message : ""}</Alert>;
  const segments = preview.data?.segments.filter((segment) => segment.x.some((value, index) => Number.isFinite(value) && Number.isFinite(segment.y[index]))) ?? [];
  if (!segments.length) return <Alert color="gray">No complete cycles or available voltage records. Check source preparation and availability.</Alert>;
  const dark = surfaceMode === "theme" ? scheme === "dark" : surfaceMode !== "sun";
  const colors = surfaceMode === "gray"
    ? { background: theme.colors.dark[4], text: theme.colors.gray[0], border: theme.colors.dark[1], grid: theme.colors.dark[3] }
    : dark
      ? { background: theme.colors.dark[7], text: theme.colors.gray[0], border: theme.colors.dark[3], grid: theme.colors.dark[5] }
      : { background: theme.white, text: theme.black, border: theme.colors.gray[5], grid: theme.colors.gray[3] };
  const hasCurrent = segments.some((segment) => segment.current_ma?.some((value) => value !== null && Number.isFinite(value)));
  const traces = cellPreviewVoltageTraces(segments.map((segment) => ({
    x: segment.x,
    voltage: segment.y,
    ...(segment.current_ma?.some((value) => value !== null && Number.isFinite(value)) ? { current: segment.current_ma } : {}),
    breakBefore: segment.display_break_before,
    name: segment.filename,
  })));
  return <Stack gap="xs">
    <Text size="sm" c="dimmed">No complete charge/discharge cycles. Showing the recorded voltage{hasCurrent ? " and current" : ""}.</Text>
    <CellPreviewPlot
      data={traces}
      layout={cellPreviewVoltageLayout(colors, preview.data?.x_label ?? "Time (s)", `cell-recording-${cellId}`)}
      config={{ displaylogo: false, responsive: true }}
      style={{ width: "100%" }}
      surfaceMode={surfaceMode}
      onSurfaceModeChange={setSurfaceMode}
      legend={[{ name: "Voltage", color: "#12b886" }, ...(hasCurrent ? [{ name: "Current", color: "#2E86AB" }] : [])]}
    />
  </Stack>;
}
