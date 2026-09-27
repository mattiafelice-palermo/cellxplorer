import { ActionIcon, Alert, Box, Button, Center, Group, Loader, Modal, NumberInput, SegmentedControl, Stack, Switch, Tabs, Text, Tooltip, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  ContinuationPreviewResult,
  ImportPreview,
  inspectContinuationSources,
  previewQuickNdaxVoltage,
  previewContinuationSources,
} from "../api";
import {
  scaleContinuationPreviewTimeAxis,
  type ContinuationPreviewQuantity,
} from "../continuedImportPreviewPolicy";
import { fullPreviewCycleWindow, shiftPreviewCycleWindow } from "../analysisCellPreviewPolicy";
import { CellPreviewPlot, CellPreviewToolbar, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import {
  cellPreviewCapacityLayout,
  cellPreviewCapacityTraces,
  cellPreviewVoltageLayout,
  cellPreviewVoltageTraces,
  paddedEfficiencyRange,
  type CellPreviewCycleSeries,
} from "./cellPreviewPlotModel";
import { IconAlertTriangle, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

export type ImportPreviewView = "voltage" | "cycles";
export type ImportPreviewVoltageXAxis = "time" | "capacity";
export type ImportPreviewCapacityView = "discharge" | "both" | "charge";

export type ImportSourcePreviewPreferences = {
  view: ImportPreviewView;
  voltageXAxis: ImportPreviewVoltageXAxis;
  capacityView: ImportPreviewCapacityView;
  surfaceMode: CellPreviewSurfaceMode;
};

export const DEFAULT_IMPORT_SOURCE_PREVIEW_PREFERENCES: ImportSourcePreviewPreferences = {
  view: "voltage",
  voltageXAxis: "time",
  capacityView: "both",
  surfaceMode: "theme",
};

function requestFor(
  source: ImportPreview,
  quantity: ContinuationPreviewQuantity,
  voltageXAxis: ImportPreviewVoltageXAxis,
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

function formatParserWarningExample(example: Record<string, number | string | boolean | null>): string | null {
  const scope = typeof example.step === "number"
    ? `Step ${example.step}`
    : typeof example.cycle === "number"
      ? `Cycle ${example.cycle}`
      : null;
  if (!scope) return null;
  const quantity = typeof example.quantity === "string" ? example.quantity : "summary";
  if (typeof example.summary_pct === "number" && typeof example.measurement_pct === "number") {
    const impliedRange = typeof example.rounding_min_pct === "number" && typeof example.rounding_max_pct === "number"
      ? `; rounded capacities imply ${example.rounding_min_pct.toFixed(2)}–${example.rounding_max_pct.toFixed(2)}%`
      : "";
    return `${scope} ${quantity}: workbook ${example.summary_pct.toFixed(2)}%; raw records ${example.measurement_pct.toFixed(2)}%${impliedRange}.`;
  }
  const summary = typeof example.summary_mwh === "number" ? example.summary_mwh : null;
  const measurement = typeof example.measurement_integration_mwh === "number"
    ? example.measurement_integration_mwh
    : typeof example.calculated_mwh === "number"
      ? example.calculated_mwh
      : null;
  if (summary !== null && measurement !== null) {
    return `${scope} ${quantity}: workbook ${summary.toPrecision(6)} mWh; raw-record calculation ${measurement.toPrecision(6)} mWh.`;
  }
  return null;
}

export function ImportSourcePreview({
  source: inspectedSource,
  quickSourcePath,
  quickSourceVersion,
  onQuickPreviewSettled,
  inspectionError,
  activeMassMgOverride,
  plotHeight = 352,
  stablePlotHeight = false,
  preferences,
  onPreferencesChange,
}: {
  source: ImportPreview | null;
  quickSourcePath?: string;
  quickSourceVersion?: string;
  onQuickPreviewSettled?: (path: string) => void;
  inspectionError?: string;
  activeMassMgOverride?: number | null;
  plotHeight?: number;
  stablePlotHeight?: boolean;
  preferences?: ImportSourcePreviewPreferences;
  onPreferencesChange?: (update: Partial<ImportSourcePreviewPreferences>) => void;
}) {
  // The file picker mounts this plot immediately. Full identity and header
  // inspection continues separately and replaces these display-only values.
  const source = inspectedSource ?? ({
    staged_name: quickSourcePath ?? "",
    source_path: quickSourcePath ?? null,
    hash: "quick-preview",
    active_mass_mg: null,
    metadata_only: false,
    technique: null,
    capacity_preview: null,
    inspection: { hash: "", size: 0, mtime_ns: "0" },
  } as ImportPreview);
  const [localPreferences, setLocalPreferences] = useState(DEFAULT_IMPORT_SOURCE_PREVIEW_PREFERENCES);
  const currentPreferences = preferences ?? localPreferences;
  const { view, voltageXAxis, capacityView, surfaceMode } = currentPreferences;
  const updatePreferences = (update: Partial<ImportSourcePreviewPreferences>) => {
    if (!preferences) setLocalPreferences((current) => ({ ...current, ...update }));
    onPreferencesChange?.(update);
  };
  const setView = (value: ImportPreviewView) => updatePreferences({ view: value });
  const setVoltageXAxis = (value: ImportPreviewVoltageXAxis) => updatePreferences({ voltageXAxis: value });
  const setCapacityView = (value: ImportPreviewCapacityView) => updatePreferences({ capacityView: value });
  const setSurfaceMode = (value: CellPreviewSurfaceMode) => updatePreferences({ surfaceMode: value });
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
  const [warningsOpen, setWarningsOpen] = useState(false);
  const { ref: plotSurfaceRef, width: plotSurfaceWidth } = useElementSize();
  const responsivePlotHeight = !stablePlotHeight && plotSurfaceWidth > 0
    ? Math.max(240, Math.min(plotHeight, Math.round(plotSurfaceWidth - 34)))
    : plotHeight;
  const plotStackHeight = responsivePlotHeight + 20;
  useEffect(() => {
    setNormalizeByMass(activeMassG !== null);
  }, [source.staged_name, source.hash, activeMassG]);
  useEffect(() => {
    if (!preferences) setSurfaceMode("theme");
  }, [source.staged_name, source.hash, preferences]);
  const quickVoltageQuery = useQuery({
    queryKey: ["import-quick-ndax-voltage", quickSourcePath, quickSourceVersion, voltageXAxis, voltageCycleRange?.start, voltageCycleRange?.end],
    queryFn: ({ signal }) => previewQuickNdaxVoltage({
      source_path: quickSourcePath!,
      voltage_x_axis: voltageXAxis,
      ...(voltageCycleRange ? { cycle_start: voltageCycleRange.start, cycle_end: voltageCycleRange.end } : {}),
    }, { signal }),
    enabled: view === "voltage" && Boolean(quickSourcePath && /\.ndax$/i.test(quickSourcePath)),
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
  useEffect(() => {
    if (quickSourcePath && !quickVoltageQuery.isFetching && (quickVoltageQuery.isSuccess || quickVoltageQuery.isError)) {
      onQuickPreviewSettled?.(quickSourcePath);
    }
  }, [quickSourcePath, quickVoltageQuery.isSuccess, quickVoltageQuery.isError, quickVoltageQuery.isFetching, onQuickPreviewSettled]);
  const freshQuickPreview = quickVoltageQuery.isFetching ? null : quickVoltageQuery.data?.preview;
  const quickVoltageAvailable = Boolean(freshQuickPreview);
  const quickVoltageTerminal = quickVoltageQuery.isError || (!quickVoltageQuery.isFetching && quickVoltageQuery.data?.preview === null);
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
    enabled: Boolean(inspectedSource) && (
      view === "cycles" || !quickSourcePath || !/\.ndax$/i.test(quickSourcePath) || quickVoltageTerminal
    ),
    staleTime: Infinity,
    refetchInterval: (query) => {
      const data = query.state.data;
      const terminalSourceError = data?.sources.some((item) =>
        item.inspection_status === "error" || item.cache_build_status === "failed" || item.parse_status === "error",
      );
      return data?.inspection_complete || terminalSourceError ? false : 500;
    },
  });
  const inspectionFailure = inspectionQuery.data?.sources.find((item) =>
    item.inspection_status === "error" || item.cache_build_status === "failed" || item.parse_status === "error",
  );
  const inspectionFailureMessage = inspectionFailure?.inspection_error
    || (inspectionFailure?.cache_build_status === "failed" ? "The source cache could not be prepared." : null)
    || "Source inspection failed.";
  const continuationReady = inspectionQuery.data?.inspection_complete === true && !inspectionFailure;
  const usesCapacityBundlePreview = /\.ndax$/i.test(source.source_path ?? source.staged_name);
  const canRequestFastVoltagePreview = view === "voltage"
    && usesCapacityBundlePreview;
  const sourceSupportsCycles = !source.metadata_only && source.technique?.trim().toLocaleUpperCase() !== "OCV";
  const inspectionCycleCount = Math.max(0, ...((inspectionQuery.data?.sources ?? []).map((item) => item.local_cycle_count ?? 0)));
  const requestedVoltageCycleRange = voltageCycleRange ?? (inspectionCycleCount > 0
    ? { start: Math.max(1, inspectionCycleCount - 19), end: inspectionCycleCount }
    : null);
  const parserWarnings = inspectionQuery.data?.sources.flatMap((item) => item.parser_warnings ?? []) ?? [];
  const parserWarningCount = parserWarnings.reduce((total, warning) => total + warning.count, 0);
  const voltageQuery = useQuery({
    queryKey: ["import-source-preview", source.staged_name, source.hash, "voltage", voltageXAxis, requestedVoltageCycleRange?.start, requestedVoltageCycleRange?.end, continuationReady],
    queryFn: ({ signal }) => previewContinuationSources(
      requestFor(source, "voltage", voltageXAxis, requestedVoltageCycleRange),
      { signal },
    ),
    enabled: view === "voltage" && Boolean(inspectedSource)
      && (!quickSourcePath || !/\.ndax$/i.test(quickSourcePath) || quickVoltageTerminal)
      && (continuationReady || canRequestFastVoltagePreview),
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const capacityBundleCycleRange = continuationReady ? cycleRange : null;
  const capacityBundleQuery = useQuery({
    queryKey: [
      "import-source-preview",
      source.staged_name,
      source.hash,
      "capacity_bundle",
      continuationReady,
      capacityBundleCycleRange?.start,
      capacityBundleCycleRange?.end,
    ],
    queryFn: ({ signal }) => previewContinuationSources(
      requestFor(source, "capacity_bundle", voltageXAxis, capacityBundleCycleRange),
      { signal },
    ),
    enabled: view === "cycles" && Boolean(inspectedSource) && !source.metadata_only && usesCapacityBundlePreview,
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
      enabled: view === "cycles" && Boolean(inspectedSource) && !source.metadata_only && continuationReady && !usesCapacityBundlePreview,
      staleTime: Infinity,
      placeholderData: (previous: ContinuationPreviewResult | undefined) => previous,
      retry: false,
    })),
  });
  const voltageResponse = freshQuickPreview ?? voltageQuery.data;
  const voltagePreview = useMemo(
    () => voltageResponse
      ? (voltageResponse.x_label?.toLocaleLowerCase().startsWith("time") ?? voltageXAxis === "time")
        ? scaleContinuationPreviewTimeAxis(voltageResponse)
        : voltageResponse
      : null,
    [voltageResponse, voltageXAxis],
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
    const bundlePreview = usesCapacityBundlePreview
      ? capacityBundleQuery.data as ContinuationPreviewResult | undefined
      : undefined;
    const dischargePreview = capacityQueries[0]?.data as ContinuationPreviewResult | undefined;
    const chargePreview = capacityQueries[1]?.data as ContinuationPreviewResult | undefined;
    const keys = new Set([
      ...(bundlePreview?.segments.map((segment) => segment.source_key) ?? []),
      ...(dischargePreview?.segments.map((segment) => segment.source_key) ?? []),
      ...(chargePreview?.segments.map((segment) => segment.source_key) ?? []),
    ]);
    return [...keys].map((key) => {
      const bundle = bundlePreview?.segments.find((segment) => segment.source_key === key);
      const discharge = dischargePreview?.segments.find((segment) => segment.source_key === key);
      const charge = chargePreview?.segments.find((segment) => segment.source_key === key);
      const efficiency = [bundle, discharge, charge].find((segment) =>
        segment?.coulombic_efficiency_x?.length && segment.coulombic_efficiency_pct?.length,
      );
      const inRange = (cycle: number | null) => cycle !== null
        && (!cycleRange || (cycle >= cycleRange.start && cycle <= cycleRange.end));
      const dischargeX = bundle?.discharge_capacity_x ?? discharge?.x ?? [];
      const dischargeY = bundle?.discharge_capacity_y ?? discharge?.y ?? [];
      const chargeX = bundle?.charge_capacity_x ?? charge?.x ?? [];
      const chargeY = bundle?.charge_capacity_y ?? charge?.y ?? [];
      const efficiencyX = efficiency?.coulombic_efficiency_x ?? [];
      const efficiencyPct = efficiency?.coulombic_efficiency_pct ?? [];
      return {
        x: [],
        dischargeX: dischargeX.filter(inRange),
        dischargeCapacityMah: dischargeY.filter((_, index) => inRange(dischargeX[index])) ?? [],
        chargeX: chargeX.filter(inRange),
        chargeCapacityMah: chargeY.filter((_, index) => inRange(chargeX[index])) ?? [],
        efficiencyX: efficiencyX.filter(inRange),
        efficiencyPct: efficiencyPct.filter((_, index) => inRange(efficiencyX[index] ?? null)),
        massG: activeMassG,
      };
    });
  }, [activeMassG, capacityBundleQuery.data, capacityQueries, cycleRange, usesCapacityBundlePreview]);
  const capacityTraces = useMemo(
    () => cellPreviewCapacityTraces(capacitySeries, capacityView, normalizeByMass),
    [capacitySeries, capacityView, normalizeByMass],
  );
  const efficiencyRange = useMemo(
    () => paddedEfficiencyRange(capacitySeries.flatMap((series) => series.efficiencyPct ?? [])),
    [capacitySeries],
  );
  const cycleCount = Math.max(
    inspectionCycleCount,
    freshQuickPreview?.cycle_count ?? 0,
    voltageQuery.isPlaceholderData ? 0 : voltageQuery.data?.cycle_count ?? 0,
    capacityBundleQuery.isPlaceholderData ? 0 : capacityBundleQuery.data?.cycle_count ?? 0,
    ...capacityQueries.flatMap((query) => {
    if (query.isPlaceholderData) return [];
    const preview = query.data as ContinuationPreviewResult | undefined;
    return [preview?.cycle_count ?? 0, ...(preview?.segments.map((segment) => segment.global_cycle_end ?? 0) ?? [])];
    }),
  );
  const hasNavigableCycles = sourceSupportsCycles && cycleCount > 0;
  const [cycleRangeUserEdited, setCycleRangeUserEdited] = useState(false);
  useEffect(() => {
    setCycleRange(null);
    setVoltageCycleRange(null);
    setCycleRangeUserEdited(false);
  }, [source.staged_name, source.hash]);
  useEffect(() => {
    const fullRange = fullPreviewCycleWindow(cycleCount);
    if (!fullRange) return;
    setCycleRange((current) => current === null || (!cycleRangeUserEdited && current.start === 1)
      ? fullRange
      : current);
  }, [source.staged_name, source.hash, cycleCount, cycleRangeUserEdited]);
  useEffect(() => {
    if (!inspectionCycleCount) return;
    setVoltageCycleRange((current) => current ?? {
      start: Math.max(1, inspectionCycleCount - 19),
      end: inspectionCycleCount,
    });
  }, [source.staged_name, source.hash, inspectionCycleCount]);
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
  const capacityError = usesCapacityBundlePreview
    ? capacityBundleQuery.error
    : capacityQueries.find((query) => query.isError)?.error;
  const isCapacityLoading = usesCapacityBundlePreview
    ? capacityBundleQuery.isPending
      || capacityBundleQuery.isFetching
      || (!capacityBundleQuery.data && !continuationReady && !inspectionFailure)
    : inspectionQuery.isFetching || capacityQueries.some((query) => query.isPending || query.isFetching);
  const activeCycleRange = view === "cycles"
    ? cycleRange
    : voltageCycleRange ?? (cycleCount > 0
      ? { start: Math.max(1, cycleCount - 19), end: cycleCount }
      : null);
  const updateActiveCycleRange = (next: { start: number; end: number }) => {
    if (view === "cycles") {
      setCycleRangeUserEdited(true);
      setCycleRange(next);
    }
    else setVoltageCycleRange(next);
  };
  const shiftCycleRange = (direction: -1 | 1) => {
    if (!activeCycleRange || cycleCount <= 0) return;
    updateActiveCycleRange(shiftPreviewCycleWindow(activeCycleRange, cycleCount, direction));
  };
  const voltageHasPoints = Boolean(voltagePreview?.segments.some((segment) => segment.x.length > 0));
  const voltageReady = view === "voltage"
    && (quickVoltageAvailable || (!voltageQuery.isPending && !voltageQuery.isFetching && !voltageQuery.isPlaceholderData))
    && voltageHasPoints;
  const capacityReady = view === "cycles"
    && !isCapacityLoading
    && (usesCapacityBundlePreview
      ? Boolean(capacityBundleQuery.data && !capacityBundleQuery.isPlaceholderData)
      : continuationReady && capacityQueries.some((query) => query.data && !query.isPlaceholderData))
    && displayedCapacityTraces.length > 0;
  const voltagePlot: ReactNode = voltageHasPoints && voltagePreview ? (
    <CellPreviewPlot
      data={voltageTraces as never}
      layout={{
        ...cellPreviewVoltageLayout(
          plotColors,
          voltagePreview.x_label ?? (voltageXAxis === "time" ? "Time (minutes)" : "Capacity (mAh)"),
          `import-preview-voltage-${voltageXAxis}`,
        ),
        height: responsivePlotHeight,
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: responsivePlotHeight, fontWeight: 400 }}
      surfaceMode={surfaceMode}
      onSurfaceModeChange={setSurfaceMode}
      showToolbar={false}
      legend={voltageTraces.some((trace) => trace.name.startsWith("Current"))
        ? [{ name: "Voltage", color: "#12b886" }, { name: "Current", color: "#2E86AB" }]
        : []}
    />
  ) : null;
  const capacityPlot: ReactNode = displayedCapacityTraces.length > 0 ? (
    <CellPreviewPlot
      data={displayedCapacityTraces as never}
      layout={{
        ...cellPreviewCapacityLayout(
          plotColors,
          `Capacity (${normalizeByMass && activeMassG ? "mAh/g" : "mAh"})`,
          efficiencyRange,
          `import-preview-cycles-${normalizeByMass && activeMassG !== null ? "mAh-per-g" : "mAh"}`,
        ),
        height: responsivePlotHeight,
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: responsivePlotHeight, fontWeight: 400 }}
      surfaceMode={surfaceMode}
      onSurfaceModeChange={setSurfaceMode}
      showToolbar={false}
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
    capacityBundleQuery.data,
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
    responsivePlotHeight,
  ]);

  const capacitySelector = (
    <SegmentedControl
      size="sm"
      aria-label="Capacity series to show"
      value={capacityView}
      onChange={(value) => setCapacityView(value as ImportPreviewCapacityView)}
      data={[
        { value: "discharge", label: "Dchg" },
        { value: "both", label: "Both" },
        { value: "charge", label: "Chg" },
      ]}
    />
  );
  const normalizeSwitch = (
    <Switch
      size="sm"
      label="Normalize by mass"
      checked={activeMassG !== null && normalizeByMass}
      disabled={activeMassG === null}
      onChange={(event) => setNormalizeByMass(event.currentTarget.checked)}
    />
  );
  const toolbarContent = view === "voltage" ? (
    <Group justify="center" gap="xs" wrap="nowrap">
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
    <Group gap="xs" justify="center" wrap="nowrap">
      {capacitySelector}
      {normalizeSwitch}
    </Group>
  );
  const compactToolbarChildren = view === "cycles" ? capacitySelector : toolbarContent;
  const compactToolbarSecondaryContent = view === "cycles" ? normalizeSwitch : undefined;

  return (
    <>
      <Stack gap="xs">
      {parserWarnings.length > 0 && (
        <Group justify="flex-end">
          <Button
            size="compact-sm"
            variant="light"
            color="orange"
            leftSection={<IconAlertTriangle size={15} />}
            onClick={() => setWarningsOpen(true)}
          >
            Data warnings · {parserWarningCount}
          </Button>
        </Group>
      )}
      <Tabs value={view} onChange={(value) => value && setView(value as ImportPreviewView)} keepMounted>
        <Tabs.List grow>
          <Tabs.Tab value="voltage">Voltage</Tabs.Tab>
          <Tabs.Tab value="cycles" disabled={!hasNavigableCycles}>Cycles</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <Box ref={plotSurfaceRef} className="preview-plot-surface" style={{ position: "relative" }}>
        <CellPreviewToolbar
          surfaceMode={surfaceMode}
          onSurfaceModeChange={setSurfaceMode}
          compactChildren={compactToolbarChildren}
          compactSecondaryContent={compactToolbarSecondaryContent}
        >
          {toolbarContent}
        </CellPreviewToolbar>
        <Box h={plotStackHeight} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {view === "voltage" ? (
            voltageReady && voltagePlot ? (
              <Box w="100%">{voltagePlot}</Box>
            ) : inspectionError ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionError}</Alert>
            ) : inspectionQuery.isError ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Source inspection failed."}</Alert>
            ) : inspectionFailure ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionFailureMessage}</Alert>
            ) : retainedPlot && (inspectionQuery.isPending || inspectionQuery.isFetching || voltageQuery.isPending || voltageQuery.isFetching || voltageQuery.isPlaceholderData) ? (
              <Box w="100%" h={plotStackHeight} style={{ position: "relative" }}>
                <Box style={{ opacity: 0.48, transition: "opacity 100ms linear" }}>{retainedPlot}</Box>
                <Text size="xs" c="dimmed" style={{ position: "absolute", top: 30, right: 8, pointerEvents: "none" }}>Updating preview…</Text>
              </Box>
            ) : !continuationReady || voltageQuery.isPending ? (
              <Center h={plotStackHeight}><Loader size="sm" /></Center>
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
          ) : retainedPlot && (
            isCapacityLoading
            || (!usesCapacityBundlePreview && (inspectionQuery.isPending || inspectionQuery.isFetching))
            || capacityBundleQuery.isPlaceholderData
            || capacityQueries.some((query) => query.isPlaceholderData)
          ) ? (
            <Box w="100%" h={plotStackHeight} style={{ position: "relative" }}>
              <Box style={{ opacity: 0.48, transition: "opacity 100ms linear" }}>{retainedPlot}</Box>
              <Text size="xs" c="dimmed" style={{ position: "absolute", top: 30, right: 8, pointerEvents: "none" }}>Updating preview…</Text>
            </Box>
          ) : isCapacityLoading ? (
            <Center h={plotStackHeight}><Loader size="sm" /></Center>
          ) : (
            <Alert color={capacityError ? "orange" : "gray"} title="Cycle preview unavailable">
              {capacityError instanceof Error ? capacityError.message : "No charge or discharge capacity points were found."}
            </Alert>
          )}
        </Box>
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
      <Modal
        opened={warningsOpen}
        onClose={() => setWarningsOpen(false)}
        title="Neware summary warnings"
        centered
        size="md"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Some workbook summary values differ from values calculated from the recorded measurements. The preview and import remain available; the recorded measurements are used for the cell data.
          </Text>
          {parserWarnings.map((warning, index) => {
            const examples = (warning.examples ?? [])
              .map(formatParserWarningExample)
              .filter((example): example is string => example !== null)
              .slice(0, 3);
            return (
              <Alert
                key={`${warning.code}-${warning.scope}-${index}`}
                color="orange"
                title={`${warning.message} (${warning.count})`}
              >
                {examples.length > 0 && (
                  <Stack gap={4} mt="xs">
                    {examples.map((example) => <Text key={example} size="xs">{example}</Text>)}
                  </Stack>
                )}
              </Alert>
            );
          })}
        </Stack>
      </Modal>
    </>
  );
}
