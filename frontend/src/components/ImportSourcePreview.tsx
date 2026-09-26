import { ActionIcon, Alert, Box, Center, Group, Loader, NumberInput, SegmentedControl, Stack, Switch, Tabs, Text, Tooltip, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  ContinuationPreviewResult,
  ImportPreview,
  inspectContinuationSources,
  previewContinuationSources,
} from "../api";
import {
  scaleContinuationPreviewTimeAxis,
  type ContinuationPreviewQuantity,
} from "../continuedImportPreviewPolicy";
import { shiftPreviewCycleWindow } from "../analysisCellPreviewPolicy";
import { CellPreviewPlot, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import {
  cellPreviewCapacityLayout,
  cellPreviewCapacityTraces,
  cellPreviewVoltageLayout,
  cellPreviewVoltageTraces,
  paddedEfficiencyRange,
  type CellPreviewCycleSeries,
} from "./cellPreviewPlotModel";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

type PreviewView = "voltage" | "cycles";
type VoltageXAxis = "time" | "capacity";
type CapacityView = "discharge" | "both" | "charge";

function requestFor(
  source: ImportPreview,
  quantity: ContinuationPreviewQuantity,
  voltageXAxis: VoltageXAxis,
  cycleRange?: { start: number; end: number } | null,
) {
  return {
    sources: [{
      staged_name: source.staged_name,
      source_path: source.source_path,
      inspection: source.inspection,
      allow_metadata_only: source.metadata_only,
    }],
    proposed_order: [source.staged_name],
    quantity,
    interpretation: "source_chain" as const,
    voltage_x_axis: voltageXAxis,
    ...(cycleRange
      ? { cycle_start: cycleRange.start, cycle_end: cycleRange.end }
      : {}),
  };
}

export function ImportSourcePreview({
  source,
  activeMassMgOverride,
}: {
  source: ImportPreview;
  activeMassMgOverride?: number | null;
}) {
  const [view, setView] = useState<PreviewView>("voltage");
  const [voltageXAxis, setVoltageXAxis] = useState<VoltageXAxis>("time");
  const [capacityView, setCapacityView] = useState<CapacityView>("both");
  const [surfaceMode, setSurfaceMode] = useState<CellPreviewSurfaceMode>("theme");
  const scheme = useComputedColorScheme("light");
  const theme = useMantineTheme();
  const plotColors = useMemo(() => surfaceMode === "theme"
    ? scheme === "dark"
      ? { background: theme.colors.dark[7], text: theme.colors.gray[0], border: theme.colors.dark[3], grid: theme.colors.dark[5] }
      : { background: theme.white, text: theme.black, border: theme.colors.gray[5], grid: theme.colors.gray[3] }
    : surfaceMode === "sun"
      ? { background: theme.white, text: theme.black, border: theme.colors.gray[5], grid: theme.colors.gray[3] }
      : surfaceMode === "moon"
        ? { background: scheme === "dark" ? theme.colors.dark[7] : "#000000", text: theme.colors.gray[0], border: scheme === "dark" ? theme.colors.dark[3] : theme.colors.dark[1], grid: scheme === "dark" ? theme.colors.dark[5] : theme.colors.dark[3] }
        : { background: theme.colors.dark[4], text: theme.colors.gray[0], border: theme.colors.dark[1], grid: theme.colors.dark[3] },
  [surfaceMode, scheme, theme]);
  const activeMassMg = activeMassMgOverride ?? source.active_mass_mg;
  const activeMassG = activeMassMg && activeMassMg > 0 ? activeMassMg / 1000 : null;
  const [normalizeByMass, setNormalizeByMass] = useState(activeMassG !== null);
  const [cycleRange, setCycleRange] = useState<{ start: number; end: number } | null>(null);
  const [voltageCycleRange, setVoltageCycleRange] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    setNormalizeByMass(activeMassG !== null);
  }, [source.staged_name, source.hash, activeMassG]);
  useEffect(() => {
    setSurfaceMode("theme");
  }, [source.staged_name, source.hash]);
  const inspectRequest = {
    sources: [{
      staged_name: source.staged_name,
      source_path: source.source_path,
      inspection: source.inspection,
      allow_metadata_only: source.metadata_only,
    }],
    proposed_order: [source.staged_name],
  };
  const inspectionQuery = useQuery({
    queryKey: ["import-source-continuation-inspection", source.staged_name, source.hash],
    queryFn: () => inspectContinuationSources(inspectRequest),
    enabled: view === "voltage" || view === "cycles",
    staleTime: Infinity,
    refetchInterval: (query) => {
      const data = query.state.data;
      const terminalSourceError = data?.sources.some((item) =>
        item.inspection_status === "error" || item.cache_build_status === "failed" || item.parse_status === "error",
      );
      return data?.inspection_complete || terminalSourceError ? false : 1000;
    },
  });
  const inspectionFailure = inspectionQuery.data?.sources.find((item) =>
    item.inspection_status === "error" || item.cache_build_status === "failed" || item.parse_status === "error",
  );
  const inspectionFailureMessage = inspectionFailure?.inspection_error
    || (inspectionFailure?.cache_build_status === "failed" ? "The source cache could not be prepared." : null)
    || "Source inspection failed.";
  const continuationReady = inspectionQuery.data?.inspection_complete === true && !inspectionFailure;
  const sourceSupportsCycles = !source.metadata_only && source.technique?.trim().toLocaleUpperCase() !== "OCV";
  const inspectionCycleCount = Math.max(0, ...((inspectionQuery.data?.sources ?? []).map((item) => item.local_cycle_count ?? 0)));
  const voltageQuery = useQuery({
    queryKey: ["import-source-preview", source.staged_name, source.hash, "voltage", voltageXAxis, voltageCycleRange?.start, voltageCycleRange?.end],
    queryFn: ({ signal }) => previewContinuationSources(
      requestFor(source, "voltage", voltageXAxis, voltageCycleRange),
      { signal },
    ),
    enabled: view === "voltage" && continuationReady,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const capacityQueries = useQueries({
    queries: (["discharge_capacity_mah", "charge_capacity_mah"] as const).map((quantity) => ({
      queryKey: ["import-source-preview", source.staged_name, source.hash, quantity, cycleRange?.start ?? null, cycleRange?.end ?? null],
      queryFn: ({ signal }: { signal: AbortSignal }) => previewContinuationSources(
        requestFor(source, quantity, voltageXAxis, cycleRange),
        { signal },
      ),
      enabled: view === "cycles" && !source.metadata_only && continuationReady,
      staleTime: Infinity,
      placeholderData: (previous: ContinuationPreviewResult | undefined) => previous,
      retry: false,
    })),
  });
  const voltagePreview = useMemo(
    () => voltageQuery.data
      ? (voltageQuery.data.x_label?.toLocaleLowerCase().startsWith("time") ?? voltageXAxis === "time")
        ? scaleContinuationPreviewTimeAxis(voltageQuery.data)
        : voltageQuery.data
      : null,
    [voltageQuery.data, voltageXAxis],
  );
  const voltageTraces = useMemo(() => voltagePreview
    ? cellPreviewVoltageTraces(voltagePreview.segments.map((segment) => ({
        x: segment.x,
        voltage: segment.y,
        current: segment.current_ma,
        name: segment.filename,
      })))
    : [], [voltagePreview]);
  const capacitySeries = useMemo<CellPreviewCycleSeries[]>(() => {
    const dischargePreview = capacityQueries[0]?.data as ContinuationPreviewResult | undefined;
    const chargePreview = capacityQueries[1]?.data as ContinuationPreviewResult | undefined;
    const keys = new Set([
      ...(dischargePreview?.segments.map((segment) => segment.source_key) ?? []),
      ...(chargePreview?.segments.map((segment) => segment.source_key) ?? []),
    ]);
    return [...keys].map((key) => {
      const discharge = dischargePreview?.segments.find((segment) => segment.source_key === key);
      const charge = chargePreview?.segments.find((segment) => segment.source_key === key);
      const efficiency = [discharge, charge].find((segment) =>
        segment?.coulombic_efficiency_x?.length && segment.coulombic_efficiency_pct?.length,
      );
      const inRange = (cycle: number | null) => cycle !== null
        && (!cycleRange || (cycle >= cycleRange.start && cycle <= cycleRange.end));
      const dischargeX = discharge?.x ?? [];
      const chargeX = charge?.x ?? [];
      const efficiencyX = efficiency?.coulombic_efficiency_x ?? [];
      const efficiencyPct = efficiency?.coulombic_efficiency_pct ?? [];
      return {
        x: [],
        dischargeX: dischargeX.filter(inRange),
        dischargeCapacityMah: discharge?.y.filter((_, index) => inRange(dischargeX[index])) ?? [],
        chargeX: chargeX.filter(inRange),
        chargeCapacityMah: charge?.y.filter((_, index) => inRange(chargeX[index])) ?? [],
        efficiencyX: efficiencyX.filter(inRange),
        efficiencyPct: efficiencyPct.filter((_, index) => inRange(efficiencyX[index] ?? null)),
        massG: activeMassG,
      };
    });
  }, [activeMassG, capacityQueries, cycleRange]);
  const capacityTraces = useMemo(
    () => cellPreviewCapacityTraces(capacitySeries, capacityView, normalizeByMass),
    [capacitySeries, capacityView, normalizeByMass],
  );
  const efficiencyRange = useMemo(
    () => paddedEfficiencyRange(capacitySeries.flatMap((series) => series.efficiencyPct ?? [])),
    [capacitySeries],
  );
  const cycleCount = Math.max(inspectionCycleCount, ...capacityQueries.flatMap((query) => {
    if (query.isPlaceholderData) return [];
    const preview = query.data as ContinuationPreviewResult | undefined;
    return [preview?.cycle_count ?? 0, ...(preview?.segments.map((segment) => segment.global_cycle_end ?? 0) ?? [])];
  }));
  const hasNavigableCycles = sourceSupportsCycles && cycleCount > 0;
  useEffect(() => {
    setCycleRange(null);
    setVoltageCycleRange(null);
  }, [source.staged_name, source.hash]);
  useEffect(() => {
    if (!cycleCount) return;
    setCycleRange({ start: 1, end: cycleCount });
    setVoltageCycleRange({ start: Math.max(1, cycleCount - 19), end: cycleCount });
  }, [source.staged_name, source.hash, cycleCount]);
  useEffect(() => {
    if (!sourceSupportsCycles) {
      if (view === "cycles") setView("voltage");
      setVoltageXAxis("time");
      setCycleRange(null);
      setVoltageCycleRange(null);
    }
  }, [sourceSupportsCycles, view]);
  const fallbackCapacityPoints = source.capacity_preview
    ? source.capacity_preview.x.flatMap((x, index) => (
        !cycleRange || (x >= cycleRange.start && x <= cycleRange.end)
          ? [{ x, y: source.capacity_preview?.y[index] ?? null }]
          : []
      ))
    : [];
  const fallbackDischargeTrace = fallbackCapacityPoints.length
    ? cellPreviewCapacityTraces([{
        x: fallbackCapacityPoints.map((point) => point.x),
        dischargeX: fallbackCapacityPoints.map((point) => point.x),
        dischargeCapacityMah: fallbackCapacityPoints.map((point) => point.y),
        massG: activeMassG,
      }], capacityView, normalizeByMass)
    : [];
  const displayedCapacityTraces = capacityTraces.length > 0
    ? capacityTraces
    : capacityView !== "charge" ? fallbackDischargeTrace : [];
  const voltageError = voltageQuery.error instanceof Error ? voltageQuery.error.message : "Voltage preview is unavailable.";
  const capacityError = capacityQueries.find((query) => query.isError)?.error;
  const isCapacityLoading = inspectionQuery.isFetching || capacityQueries.some((query) => query.isPending || query.isFetching);
  const activeCycleRange = view === "cycles" ? cycleRange : voltageCycleRange;
  const updateActiveCycleRange = (next: { start: number; end: number }) => {
    if (view === "cycles") setCycleRange(next);
    else setVoltageCycleRange(next);
  };
  const shiftCycleRange = (direction: -1 | 1) => {
    if (!activeCycleRange || cycleCount <= 0) return;
    updateActiveCycleRange(shiftPreviewCycleWindow(activeCycleRange, cycleCount, direction));
  };
  const voltageHasPoints = Boolean(voltagePreview?.segments.some((segment) => segment.x.length > 0));
  const voltageReady = view === "voltage"
    && continuationReady
    && !voltageQuery.isPending
    && !voltageQuery.isFetching
    && !voltageQuery.isPlaceholderData
    && voltageHasPoints;
  const capacityReady = view === "cycles"
    && continuationReady
    && !isCapacityLoading
    && capacityQueries.some((query) => query.data && !query.isPlaceholderData)
    && displayedCapacityTraces.length > 0;
  const voltagePlot: ReactNode = voltageHasPoints && voltagePreview ? (
    <CellPreviewPlot
      data={voltageTraces as never}
      layout={cellPreviewVoltageLayout(
        plotColors,
        voltagePreview.x_label ?? (voltageXAxis === "time" ? "Time (minutes)" : "Capacity (mAh)"),
        `import-preview-voltage-${voltageXAxis}`,
      )}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: 352, fontWeight: 400 }}
      surfaceMode={surfaceMode}
      onSurfaceModeChange={setSurfaceMode}
      legend={voltageTraces.some((trace) => trace.name.startsWith("Current"))
        ? [{ name: "Voltage", color: "#12b886" }, { name: "Current", color: "#2E86AB" }]
        : []}
    />
  ) : null;
  const capacityPlot: ReactNode = displayedCapacityTraces.length > 0 ? (
    <CellPreviewPlot
      data={displayedCapacityTraces as never}
      layout={cellPreviewCapacityLayout(
        plotColors,
        `Capacity (${normalizeByMass && activeMassG ? "mAh/g" : "mAh"})`,
        efficiencyRange,
        `import-preview-cycles-${normalizeByMass && activeMassG !== null ? "mAh-per-g" : "mAh"}`,
      )}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: 352, fontWeight: 400 }}
      surfaceMode={surfaceMode}
      onSurfaceModeChange={setSurfaceMode}
    />
  ) : null;
  const [retainedPlot, setRetainedPlot] = useState<ReactNode>(null);
  useEffect(() => {
    if (voltageReady && voltagePlot) setRetainedPlot(voltagePlot);
    else if (capacityReady && capacityPlot) setRetainedPlot(capacityPlot);
  }, [
    source.staged_name,
    source.hash,
    view,
    voltageReady,
    voltagePreview,
    voltageTraces,
    voltageXAxis,
    capacityReady,
    capacityQueries[0]?.data,
    capacityQueries[1]?.data,
    cycleRange?.start,
    cycleRange?.end,
    capacityView,
    normalizeByMass,
    activeMassG,
    plotColors.background,
    plotColors.text,
    plotColors.grid,
    plotColors.border,
    surfaceMode,
  ]);

  return (
    <Stack gap="xs">
      <Tabs value={view} onChange={(value) => value && setView(value as PreviewView)} keepMounted>
        <Tabs.List grow>
          <Tabs.Tab value="voltage">Voltage</Tabs.Tab>
          <Tabs.Tab value="cycles" disabled={!hasNavigableCycles}>Cycles</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <Box h={58} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      {view === "voltage" ? (
        <Group justify="center" gap="xs">
          <Text size="sm" c={voltageXAxis === "time" ? undefined : "dimmed"}>Time</Text>
          <Switch
            aria-label="Voltage x-axis: time or capacity"
            checked={voltageXAxis === "capacity"}
            disabled={!hasNavigableCycles}
            onChange={(event) => setVoltageXAxis(event.currentTarget.checked ? "capacity" : "time")}
          />
          <Text size="sm" c={voltageXAxis === "capacity" ? undefined : "dimmed"}>Capacity</Text>
        </Group>
      ) : (
        <Group gap="md" justify="center" wrap="nowrap">
          <SegmentedControl
            aria-label="Capacity series to show"
            value={capacityView}
            onChange={(value) => setCapacityView(value as CapacityView)}
            data={[
              { value: "discharge", label: "Dchg" },
              { value: "both", label: "Both" },
              { value: "charge", label: "Chg" },
            ]}
          />
          <Switch
            size="sm"
            label="Normalize by mass"
            checked={activeMassG !== null && normalizeByMass}
            disabled={activeMassG === null}
            onChange={(event) => setNormalizeByMass(event.currentTarget.checked)}
          />
        </Group>
      )}
      </Box>
      <Box h={404} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        {view === "voltage" ? (
          voltageReady && voltagePlot ? (
            <Box w="100%">{voltagePlot}</Box>
          ) : inspectionQuery.isError ? (
            <Alert color="orange" title="Voltage preview unavailable">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Source inspection failed."}</Alert>
          ) : inspectionFailure ? (
            <Alert color="orange" title="Voltage preview unavailable">{inspectionFailureMessage}</Alert>
          ) : retainedPlot && (inspectionQuery.isPending || inspectionQuery.isFetching || voltageQuery.isPending || voltageQuery.isFetching || voltageQuery.isPlaceholderData) ? (
            <Box w="100%" h={404} style={{ position: "relative" }}>
              <Box style={{ opacity: 0.48, transition: "opacity 100ms linear" }}>{retainedPlot}</Box>
              <Text size="xs" c="dimmed" style={{ position: "absolute", top: 30, right: 8, pointerEvents: "none" }}>Updating preview…</Text>
            </Box>
          ) : !continuationReady || voltageQuery.isPending ? (
            <Center h={404}><Loader size="sm" /></Center>
          ) : voltageQuery.isError ? (
            <Alert color="orange" title="Voltage preview unavailable">{voltageError}</Alert>
          ) : (
            <Alert color="gray">No voltage points were found for this source.</Alert>
          )
        ) : source.metadata_only ? (
          <Alert color="gray">Cycle preview is unavailable for this metadata-only source.</Alert>
        ) : capacityReady && capacityPlot ? (
          <Box w="100%">{capacityPlot}</Box>
        ) : inspectionQuery.isError ? (
          <Alert color="orange" title="Cycle preview unavailable">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Source inspection failed."}</Alert>
        ) : inspectionFailure ? (
          <Alert color="orange" title="Cycle preview unavailable">{inspectionFailureMessage}</Alert>
        ) : retainedPlot && (inspectionQuery.isPending || inspectionQuery.isFetching || isCapacityLoading || capacityQueries.some((query) => query.isPlaceholderData)) ? (
          <Box w="100%" h={350} style={{ position: "relative" }}>
            <Box style={{ opacity: 0.48, transition: "opacity 100ms linear" }}>{retainedPlot}</Box>
            <Text size="xs" c="dimmed" style={{ position: "absolute", top: 30, right: 8, pointerEvents: "none" }}>Updating preview…</Text>
          </Box>
        ) : isCapacityLoading ? (
          <Center h={404}><Loader size="sm" /></Center>
        ) : (
          <Alert color={capacityError ? "orange" : "gray"} title="Cycle preview unavailable">
            {capacityError instanceof Error ? capacityError.message : "No charge or discharge capacity points were found."}
          </Alert>
        )}
      </Box>
      <Group gap="xs" justify="center" wrap="nowrap" h={40}>
        <Tooltip label="Previous cycle window"><ActionIcon variant="default" aria-label="Previous cycle window" disabled={!hasNavigableCycles || !activeCycleRange || activeCycleRange.start <= 1} onClick={() => shiftCycleRange(-1)}><IconChevronLeft size={15} /></ActionIcon></Tooltip>
        <NumberInput aria-label="First preview cycle" min={1} max={cycleCount || undefined} value={activeCycleRange?.start ?? ""} disabled={!hasNavigableCycles} onChange={(value) => {
          const start = Math.max(1, Math.min(Math.trunc(Number(value) || 1), activeCycleRange?.end ?? cycleCount));
          updateActiveCycleRange({ start, end: activeCycleRange?.end ?? cycleCount });
        }} w={86} />
        <Text size="sm" c="dimmed">–</Text>
        <NumberInput aria-label="Last preview cycle" min={activeCycleRange?.start ?? 1} max={cycleCount || undefined} value={activeCycleRange?.end ?? ""} disabled={!hasNavigableCycles} onChange={(value) => {
          const end = Math.max(activeCycleRange?.start ?? 1, Math.min(Math.trunc(Number(value) || 1), cycleCount));
          updateActiveCycleRange({ start: activeCycleRange?.start ?? 1, end });
        }} w={86} />
        <Tooltip label="Next cycle window"><ActionIcon variant="default" aria-label="Next cycle window" disabled={!hasNavigableCycles || !activeCycleRange || activeCycleRange.end >= cycleCount} onClick={() => shiftCycleRange(1)}><IconChevronRight size={15} /></ActionIcon></Tooltip>
      </Group>
    </Stack>
  );
}
