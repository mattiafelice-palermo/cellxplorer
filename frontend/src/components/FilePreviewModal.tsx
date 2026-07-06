// Preview plot for a single source file (registered or not).
import { Alert, Center, Loader, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { get, SourceFile } from "../api";
import Plot from "./Plot";

interface RawPreview {
  kind: "raw";
  time_s: number[];
  voltage_v: number[];
  current_ma: number[];
}
interface CyclesPreview {
  kind: "cycles";
  columns: string[];
  rows: Record<string, number | string | null>[];
}

export function FilePreviewModal({
  file,
  onClose,
}: {
  file: SourceFile | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"cycles" | "raw">("cycles");
  const preview = useQuery({
    queryKey: ["file-preview", file?.id, kind],
    queryFn: () => get<RawPreview | CyclesPreview>(`/api/files/${file!.id}/preview?kind=${kind}`),
    enabled: file !== null,
    retry: false,
  });

  return (
    <Modal opened={file !== null} onClose={onClose} title={file?.filename} size="xl">
      <Stack>
        <SegmentedControl
          size="xs"
          data={[
            { value: "cycles", label: "Per-cycle capacity" },
            { value: "raw", label: "Voltage / current vs time" },
          ]}
          value={kind}
          onChange={(v) => setKind(v as "cycles" | "raw")}
        />
        {preview.isLoading && (
          <Center h={300}>
            <Loader />
            <Text ml="sm" c="dimmed">
              Parsing file (first time may take a moment)…
            </Text>
          </Center>
        )}
        {preview.isError && (
          <Alert color="red">{(preview.error as Error).message || "Preview failed"}</Alert>
        )}
        {preview.data?.kind === "cycles" && (
          <Plot
            data={[
              {
                x: preview.data.rows.map((r) => r.cycle as number),
                y: preview.data.rows.map((r) => r.discharge_capacity_mah as number | null),
                name: "Discharge capacity",
                type: "scatter",
                mode: "lines+markers",
                marker: { size: 4 },
              },
              {
                x: preview.data.rows.map((r) => r.cycle as number),
                y: preview.data.rows.map((r) => r.coulombic_efficiency_pct as number | null),
                name: "CE %",
                yaxis: "y2",
                type: "scatter",
                mode: "markers",
                marker: { size: 3 },
              },
            ]}
            layout={{
              height: 380,
              margin: { l: 60, r: 60, t: 10, b: 40 },
              xaxis: { title: { text: "Cycle" } },
              yaxis: { title: { text: "Discharge capacity (mAh)" } },
              yaxis2: { title: { text: "CE (%)" }, overlaying: "y", side: "right" },
              legend: { orientation: "h" },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: "100%" }}
          />
        )}
        {preview.data?.kind === "raw" && (
          <Plot
            data={[
              {
                x: preview.data.time_s,
                y: preview.data.voltage_v,
                name: "Voltage (V)",
                type: "scatter",
                mode: "lines",
              },
              {
                x: preview.data.time_s,
                y: preview.data.current_ma,
                name: "Current (mA)",
                yaxis: "y2",
                type: "scatter",
                mode: "lines",
              },
            ]}
            layout={{
              height: 380,
              margin: { l: 60, r: 60, t: 10, b: 40 },
              xaxis: { title: { text: "Time (s)" } },
              yaxis: { title: { text: "Voltage (V)" } },
              yaxis2: { title: { text: "Current (mA)" }, overlaying: "y", side: "right" },
              legend: { orientation: "h" },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: "100%" }}
          />
        )}
      </Stack>
    </Modal>
  );
}
