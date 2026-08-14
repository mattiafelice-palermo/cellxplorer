// Quick per-cycle plot for one cell — usable seconds after import,
// no classification or analysis required.
import { Alert, Center, Loader, SegmentedControl, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { get } from "../api";
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
    return (
      <Alert color="gray">
        No cycle data yet — this cell has no parsed files (or sources are offline).
      </Alert>
    );

  return (
    <Stack gap="xs">
      <SegmentedControl size="xs" data={QUICK_QUANTITIES} value={qty} onChange={setQty} />
      <Plot
        data={[
          {
            x: rows.map((r) => r.cycle as number),
            y: rows.map((r) => r[qty] as number | null),
            type: "scatter",
            mode: "lines+markers",
            marker: { size: 4, color: "#12b886" },
            line: { color: "#12b886" },
            name: cellName,
          },
        ]}
        layout={{
          height: 260,
          margin: { l: 55, r: 10, t: 10, b: 40 },
          xaxis: { title: { text: "Cycle" } },
          yaxis: {
            title: { text: QUICK_QUANTITIES.find((q) => q.value === qty)?.label ?? qty },
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
