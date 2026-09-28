import { ActionIcon, Alert, Box, Button, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Tabs, Text, Tooltip, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  ContinuationPreviewResult,
  ImportPreview,
  inspectContinuationSources,
  previewQuickNewareExcel,
  previewQuickNdaxVoltage,
  previewContinuationSources,
} from "../api";
import {
  scaleContinuationPreviewTimeAxis,
  type ContinuationPreviewQuantity,
} from "../continuedImportPreviewPolicy";
import { fullPreviewCycleWindow } from "../analysisCellPreviewPolicy";
import { CellPreviewPlot, CellPreviewToolbar, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import {
  cellPreviewCapacityLayout,
  cellPreviewCapacityTraces,
  cellPreviewVoltageLayout,
  cellPreviewVoltageTraces,
  paddedEfficiencyRange,
  type CellPreviewCycleSeries,
  type CellPreviewPlotColors,
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
  if (typeof example.data_point === "number") {
    const duplicatePoint = typeof example.duplicate_data_point === "number"
      ? `; matching measurements appear again at DataPoint ${example.duplicate_data_point}`
      : "";
    return `DataPoint ${example.data_point} was skipped${duplicatePoint}.`;
  }
  if (typeof example.cycle === "number" && typeof example.ambiguous_fields === "string") {
    return `Cycle ${example.cycle}: ${example.ambiguous_fields} was omitted because its units are ambiguous.`;
  }
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

const QUICK_PREVIEW_SLOW_NOTICE_MS = 5_000;

function previewCycleIdBounds(preview: ContinuationPreviewResult | null | undefined): { start: number; end: number } | null {
  if (!preview) return null;
  const reportedBounds = preview.segments.flatMap((segment) => {
    const start = segment.source_cycle_start ?? segment.global_cycle_start;
    const end = segment.source_cycle_end ?? segment.global_cycle_end;
    return start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end)
      ? [{ start, end }]
      : [];
  });
  if (reportedBounds.length > 0) {
    return {
      start: Math.min(...reportedBounds.map(({ start }) => start)),
      end: Math.max(...reportedBounds.map(({ end }) => end)),
    };
  }
  const cycleIds = preview.segments.flatMap((segment) => [
    ...(segment.discharge_capacity_x ?? []),
    ...(segment.charge_capacity_x ?? []),
    ...(segment.coulombic_efficiency_x ?? []),
  ]).filter(Number.isFinite);
  if (cycleIds.length === 0) return null;
  return { start: Math.min(...cycleIds), end: Math.max(...cycleIds) };
}

function shiftCycleWindowWithinBounds(
  window: { start: number; end: number },
  bounds: { start: number; end: number },
  direction: -1 | 1,
): { start: number; end: number } {
  const start = Math.max(bounds.start, Math.min(window.start, bounds.end));
  const end = Math.max(start, Math.min(window.end, bounds.end));
  const step = Math.max(1, end - start);
  return direction < 0
    ? { start: Math.max(bounds.start, start - step), end: Math.max(bounds.start, end - step) }
    : { start: Math.min(bounds.end, start + step), end: Math.min(bounds.end, end + step) };
}

function ImportPlotSkeleton({
  view,
  height,
  colors,
}: {
  view: ImportPreviewView;
  height: number;
  colors: CellPreviewPlotColors;
}) {
  const bands = view === "voltage"
    ? [{ top: 0, bottom: 70 }, { top: 77, bottom: 100 }]
    : [{ top: 0, bottom: 23 }, { top: 28, bottom: 100 }];
  const gridLines = bands.flatMap(({ top, bottom }) =>
    Array.from({ length: 5 }, (_, index) => top + ((bottom - top) * index) / 4),
  );
  const plotTop = 8;
  const plotAreaHeight = Math.max(1, height - 66);
  const titleCenters = view === "voltage"
    ? [0.35, 0.885]
    : [0.115, 0.64];
  const skeletonMark = (width: number, markHeight = 7): CSSProperties => ({
    position: "absolute",
    width,
    height: markHeight,
    borderRadius: 4,
    backgroundColor: colors.text,
    opacity: 0.42,
  });

  return (
    <Box
      className="import-preview-plot-skeleton"
      data-preview-skeleton-view={view}
      w="100%"
      h={height + 20}
      role="status"
      aria-label={`Loading ${view === "voltage" ? "voltage and current" : "capacity and CE"} plot`}
      aria-busy="true"
      style={{ position: "relative", backgroundColor: colors.background, overflow: "hidden" }}
    >
      <Box aria-hidden="true" style={{ position: "relative", width: "100%", height }}>
        <Box
          className="import-preview-plot-grid"
          style={{
            position: "absolute",
            left: 76,
            right: 24,
            top: 8,
            bottom: 58,
            boxSizing: "border-box",
            border: `1px solid ${colors.border}`,
          }}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            width="100%"
            height="100%"
            aria-hidden="true"
            style={{ display: "block" }}
          >
            {gridLines.map((y, index) => (
              <line key={`grid-${index}`} x1="0" x2="100" y1={y} y2={y} stroke={colors.grid} strokeWidth="0.45" />
            ))}
            {view === "cycles" && <line x1="0" x2="100" y1="23" y2="23" stroke={colors.border} strokeWidth="0.5" />}
          </svg>
        </Box>
        {titleCenters.map((center, index) => (
          <Box
            key={`axis-title-${index}`}
            style={{
              ...skeletonMark(view === "voltage" ? 72 : 68, 8),
              left: view === "voltage" ? 1 : 5,
              top: plotTop + (plotAreaHeight * center) - 4,
              transform: "rotate(-90deg)",
            }}
          />
        ))}
        {gridLines.map((y, index) => (
          <Box
            key={`y-tick-${index}`}
            style={{
              ...skeletonMark([10, 15, 12, 18, 14][index % 5], 5),
              left: 54,
              top: plotTop + (plotAreaHeight * y / 100) - 2,
            }}
          />
        ))}
        <Box
          style={{
            position: "absolute",
            left: 76,
            right: 24,
            top: height - 48,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {Array.from({ length: 5 }, (_, index) => (
            <Box key={`x-tick-${index}`} style={{ ...skeletonMark(13, 5), position: "relative" }} />
          ))}
        </Box>
        <Box
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 76,
            right: 24,
            top: height - 39,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {[10, 14, 18, 14, 10].map((width, index) => (
            <Box key={`x-tick-label-${index}`} style={{ ...skeletonMark(width, 5), position: "relative" }} />
          ))}
        </Box>
        <Box
          style={{
            ...skeletonMark(72, 8),
            left: "calc(50% - 36px)",
            top: height - 17,
          }}
        />
      </Box>
      {view === "voltage" && (
        <Group aria-hidden="true" justify="center" gap="md" h={20}>
          {[{ width: 34, color: "#12b886" }, { width: 32, color: "#2E86AB" }].map((item, index) => (
            <Group key={`legend-${index}`} gap={5} wrap="nowrap">
              <Box w={16} h={2} style={{ backgroundColor: item.color, opacity: 0.55 }} />
              <Box style={{ ...skeletonMark(item.width, 7), position: "relative" }} />
            </Group>
          ))}
        </Group>
      )}
    </Box>
  );
}

export function ImportSourcePreview({
  source: inspectedSource,
  quickSourcePath,
  quickSourceVersion,
  onQuickPreviewSettled,
  validateQuickExcel = false,
  sourceInspectionLoading = false,
  inspectionError,
  activeMassMgOverride,
  plotHeight = 352,
  stablePlotHeight = false,
  availableHeight,
  preferences,
  onPreferencesChange,
}: {
  source: ImportPreview | null;
  quickSourcePath?: string;
  quickSourceVersion?: string;
  onQuickPreviewSettled?: (path: string, sourceVersion: string | undefined, requiresFullInspection: boolean) => void;
  /** Run full XLSX validation after a quick plot when included or when the quick preview failed. */
  validateQuickExcel?: boolean;
  /** Keep the loading skeleton visible while the picker starts a full fallback inspection. */
  sourceInspectionLoading?: boolean;
  inspectionError?: string;
  activeMassMgOverride?: number | null;
  plotHeight?: number;
  stablePlotHeight?: boolean;
  availableHeight?: number;
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
  const previewContentRef = useRef<HTMLDivElement>(null);
  const plotStackRef = useRef<HTMLDivElement>(null);
  const [previewChromeHeight, setPreviewChromeHeight] = useState<number | null>(null);
  const widthLimitedPlotHeight = !stablePlotHeight && plotSurfaceWidth > 0
    ? Math.max(240, Math.min(plotHeight, Math.round(plotSurfaceWidth - 34)))
    : plotHeight;
  // Measure the controls around the plot separately. Deriving a correction from
  // total content height feeds the plot's own height back into its next target,
  // which can alternate between fitting and overflowing on ResizeObserver ticks.
  const verticalPlotBudget = availableHeight && availableHeight > 0 && previewChromeHeight !== null
    ? availableHeight - previewChromeHeight - 20
    : widthLimitedPlotHeight;
  const responsivePlotHeight = !stablePlotHeight
    ? Math.max(180, Math.min(widthLimitedPlotHeight, verticalPlotBudget))
    : plotHeight;
  const plotStackHeight = responsivePlotHeight + 20;
  const quickNewareExcelPath = Boolean(quickSourcePath && /\.xlsx$/i.test(quickSourcePath));
  const quickNdaxPath = Boolean(quickSourcePath && /\.ndax$/i.test(quickSourcePath));
  const supportsQuickVoltagePreview = quickNewareExcelPath || quickNdaxPath;
  useEffect(() => {
    setNormalizeByMass(activeMassG !== null);
  }, [source.staged_name, source.hash, activeMassG]);
  useEffect(() => {
    if (!preferences) setSurfaceMode("theme");
  }, [source.staged_name, source.hash, preferences]);
  const quickVoltageQuery = useQuery({
    queryKey: ["import-quick-voltage", quickNewareExcelPath ? "neware-excel" : "ndax", quickSourcePath, quickSourceVersion, voltageXAxis, voltageCycleRange?.start, voltageCycleRange?.end],
    queryFn: ({ signal }) => quickNewareExcelPath
      ? previewQuickNewareExcel({
          source_path: quickSourcePath!,
          quantity: "voltage",
          voltage_x_axis: voltageXAxis,
          ...(voltageCycleRange ? { cycle_start: voltageCycleRange.start, cycle_end: voltageCycleRange.end } : {}),
        }, { signal })
      : previewQuickNdaxVoltage({
          source_path: quickSourcePath!,
          voltage_x_axis: voltageXAxis,
          ...(voltageCycleRange ? { cycle_start: voltageCycleRange.start, cycle_end: voltageCycleRange.end } : {}),
        }, { signal }),
    enabled: view === "voltage" && supportsQuickVoltagePreview,
    staleTime: Infinity,
    refetchOnMount: false,
    retry: false,
  });
  // Keep a ready plot visible while a refresh is running. In particular, do
  // not turn axis/range edits into a blank preview while Plotly is waiting.
  const freshQuickPreview = quickVoltageQuery.data?.preview;
  const quickVoltageHasPoints = Boolean(freshQuickPreview?.segments.some((segment) => segment.x.length > 0));
  const quickVoltageAvailable = Boolean(freshQuickPreview);
  const quickVoltageTerminal = quickVoltageQuery.isError
    || (!quickVoltageQuery.isFetching && quickVoltageQuery.data?.preview === null)
    || (quickVoltageQuery.isSuccess && Boolean(freshQuickPreview) && !quickVoltageHasPoints);
  const quickExcelCapacityQuery = useQuery({
    queryKey: ["import-quick-excel-capacity", quickSourcePath, quickSourceVersion],
    queryFn: ({ signal }) => previewQuickNewareExcel({
      source_path: quickSourcePath!,
      quantity: "capacity_bundle",
    }, { signal }),
    enabled: view === "cycles" && quickNewareExcelPath,
    staleTime: Infinity,
    refetchOnMount: false,
    retry: false,
  });
  const quickExcelCapacityPreview = quickExcelCapacityQuery.data?.preview;
  const quickExcelCapacityTerminal = quickExcelCapacityQuery.isError
    || (!quickExcelCapacityQuery.isFetching && quickExcelCapacityQuery.data?.preview === null);
  // Once the display-only preview settles, inspect in the background for the
  // usual warning details. A failed XLSX quick preview also asks the picker to
  // start full validation, so it can show a real failure instead of spinning.
  const quickVoltageSettled = !quickVoltageQuery.isFetching
    && (quickVoltageQuery.isSuccess || quickVoltageQuery.isError);
  const quickExcelCapacitySettled = !quickExcelCapacityQuery.isFetching
    && (quickExcelCapacityQuery.isSuccess || quickExcelCapacityQuery.isError);
  const activeQuickPreviewSettled = view === "voltage" ? quickVoltageSettled : quickExcelCapacitySettled;
  const activeQuickPreviewNeedsInspection = quickNewareExcelPath && (view === "voltage"
    ? quickVoltageTerminal && !quickVoltageHasPoints
    : quickExcelCapacityTerminal && !quickExcelCapacityPreview);
  const activeQuickPreviewFetching = view === "voltage"
    ? supportsQuickVoltagePreview && quickVoltageQuery.isFetching
    : quickNewareExcelPath && quickExcelCapacityQuery.isFetching;
  const activeQuickPreviewRequestKey = [
    quickSourcePath ?? "",
    quickSourceVersion ?? "",
    view,
    view === "voltage" ? voltageXAxis : "cycles",
    view === "voltage" ? voltageCycleRange?.start ?? "" : "",
    view === "voltage" ? voltageCycleRange?.end ?? "" : "",
  ].join("\u0000");
  const activeQuickPreviewScopeKey = [quickSourcePath ?? "", quickSourceVersion ?? "", view].join("\u0000");
  const [slowQuickPreviewRequestKey, setSlowQuickPreviewRequestKey] = useState<string | null>(null);
  const [canonicalFallbackScopeKeys, setCanonicalFallbackScopeKeys] = useState<Set<string>>(() => new Set());
  const quickPreviewTakingLong = slowQuickPreviewRequestKey === activeQuickPreviewRequestKey;
  const canonicalFallbackForActiveView = canonicalFallbackScopeKeys.has(activeQuickPreviewScopeKey);
  useEffect(() => {
    if (!activeQuickPreviewFetching || !quickSourcePath) {
      setSlowQuickPreviewRequestKey((current) => current === activeQuickPreviewRequestKey ? null : current);
      return;
    }
    const timer = window.setTimeout(
      () => setSlowQuickPreviewRequestKey(activeQuickPreviewRequestKey),
      QUICK_PREVIEW_SLOW_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeQuickPreviewFetching, activeQuickPreviewRequestKey, quickSourcePath]);
  useEffect(() => {
    if (quickPreviewTakingLong && quickSourcePath) {
      // Release the picker gate without starting a duplicate full parse. If the
      // user included the file, its normal full inspection can still proceed.
      onQuickPreviewSettled?.(quickSourcePath, quickSourceVersion, false);
    }
  }, [quickPreviewTakingLong, quickSourcePath, quickSourceVersion, onQuickPreviewSettled]);
  useEffect(() => {
    if (supportsQuickVoltagePreview && quickSourcePath && activeQuickPreviewSettled) {
      onQuickPreviewSettled?.(quickSourcePath, quickSourceVersion, activeQuickPreviewNeedsInspection);
    }
  }, [supportsQuickVoltagePreview, quickSourcePath, quickSourceVersion, activeQuickPreviewSettled, activeQuickPreviewNeedsInspection, onQuickPreviewSettled]);
  const inspectRequest = {
    sources: [{
      staged_name: source.staged_name,
      source_path: source.source_path,
      inspection: source.inspection,
      allow_metadata_only: source.metadata_only,
    }],
    proposed_order: [source.staged_name],
  };
  const inspectionEnabled = Boolean(inspectedSource) && (
    quickNewareExcelPath
      ? (view === "voltage"
        ? quickVoltageTerminal || (validateQuickExcel && (quickVoltageSettled || quickPreviewTakingLong || canonicalFallbackForActiveView))
        : quickExcelCapacityTerminal || (validateQuickExcel && (quickExcelCapacitySettled || quickPreviewTakingLong || canonicalFallbackForActiveView)))
      : (view === "cycles" || !quickNdaxPath || quickVoltageTerminal)
  );
  const inspectionQuery = useQuery({
    queryKey: ["import-source-continuation-inspection", source.staged_name, source.hash],
    queryFn: () => inspectContinuationSources(inspectRequest),
    enabled: inspectionEnabled,
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
  const sourceInspectionError = inspectionFailure
    ? inspectionFailureMessage
    : inspectionQuery.isError
      ? inspectionQuery.error instanceof Error
        ? inspectionQuery.error.message
        : "Source inspection failed."
      : null;
  const quickExcelDiagnosticMessage = quickNewareExcelPath
    ? sourceInspectionError ?? inspectionError ?? null
    : null;
  const continuationReady = inspectionQuery.data?.inspection_complete === true && !inspectionFailure;
  // Remember that this source/view entered the validated fallback so a quick
  // request resolving later cannot replace the canonical preview.
  useEffect(() => {
    if (validateQuickExcel && quickNewareExcelPath && quickPreviewTakingLong && continuationReady) {
      setCanonicalFallbackScopeKeys((current) => {
        if (current.has(activeQuickPreviewScopeKey)) return current;
        const next = new Set(current);
        next.add(activeQuickPreviewScopeKey);
        return next;
      });
    }
  }, [validateQuickExcel, quickNewareExcelPath, quickPreviewTakingLong, continuationReady, activeQuickPreviewScopeKey]);
  const quickVoltageFallbackReady = quickNewareExcelPath
    && view === "voltage"
    && (quickPreviewTakingLong || canonicalFallbackForActiveView)
    && continuationReady;
  const quickExcelCapacityFallbackReady = quickNewareExcelPath
    && view === "cycles"
    && (quickPreviewTakingLong || canonicalFallbackForActiveView)
    && continuationReady;
  // If the display-only quick request stalls, a validated source can use the
  // ordinary preview route instead of remaining gated on that request forever.
  const usesCapacityBundlePreview = /\.(ndax|xlsx)$/i.test(source.source_path ?? source.staged_name);
  const canRequestFastVoltagePreview = view === "voltage"
    && quickNdaxPath;
  const sourceSupportsCycles = !source.metadata_only && source.technique?.trim().toLocaleUpperCase() !== "OCV";
  // Excel's independent cycle-summary sheet can be previewed even when its
  // raw record sheet is invalid. Let the user open Cycles so that quick path
  // can report the summary (or its own clear failure) instead of dead-ending
  // on a disabled tab before the cycle count is known.
  const canTryQuickExcelCycles = quickNewareExcelPath
    && !source.metadata_only
    && source.technique?.trim().toLocaleUpperCase() !== "OCV";
  const inspectionCycleCount = Math.max(0, ...((inspectionQuery.data?.sources ?? []).map((item) => item.local_cycle_count ?? 0)));
  const requestedVoltageCycleRange = voltageCycleRange ?? (inspectionCycleCount > 0
    ? { start: Math.max(1, inspectionCycleCount - 19), end: inspectionCycleCount }
    : null);
  const parserWarnings = inspectionQuery.data?.sources.flatMap((item) => item.parser_warnings ?? []) ?? [];
  const parserWarningCount = parserWarnings.reduce((total, warning) => total + warning.count, 0);
  useLayoutEffect(() => {
    const content = previewContentRef.current;
    const plotSlot = plotStackRef.current;
    if (!content || !plotSlot) return;

    const updateChromeHeight = () => {
      const nextHeight = Math.max(0, content.scrollHeight - plotSlot.getBoundingClientRect().height);
      setPreviewChromeHeight((current) => current !== null && Math.abs(current - nextHeight) < 1
        ? current
        : nextHeight);
    };
    updateChromeHeight();
    const observer = new ResizeObserver(updateChromeHeight);
    observer.observe(content);
    observer.observe(plotSlot);
    return () => observer.disconnect();
  }, [availableHeight, plotSurfaceWidth, view, parserWarningCount, quickExcelDiagnosticMessage]);
  const voltageQueryEnabled = view === "voltage" && Boolean(inspectedSource)
    && ((!quickNdaxPath && !quickNewareExcelPath) || quickVoltageTerminal || quickVoltageFallbackReady)
    && (continuationReady || canRequestFastVoltagePreview);
  const voltageQuery = useQuery({
    queryKey: ["import-source-preview", source.staged_name, source.hash, "voltage", voltageXAxis, requestedVoltageCycleRange?.start, requestedVoltageCycleRange?.end, continuationReady],
    queryFn: ({ signal }) => previewContinuationSources(
      requestFor(source, "voltage", voltageXAxis, requestedVoltageCycleRange),
      { signal },
    ),
    enabled: voltageQueryEnabled,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const capacityBundleCycleRange = continuationReady ? cycleRange : null;
  const capacityBundleQueryEnabled = view === "cycles" && Boolean(inspectedSource) && !source.metadata_only && usesCapacityBundlePreview
    && (!quickNewareExcelPath || quickExcelCapacityTerminal || quickExcelCapacityFallbackReady);
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
    enabled: capacityBundleQueryEnabled,
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
  const preferCanonicalCapacityPreview = canonicalFallbackForActiveView
    && Boolean(capacityBundleQuery.data && !capacityBundleQuery.isPlaceholderData);
  const preferCanonicalVoltagePreview = canonicalFallbackForActiveView
    && Boolean(voltageQuery.data && !voltageQuery.isPlaceholderData);
  const voltageResponse = preferCanonicalVoltagePreview
    ? voltageQuery.data
    : quickVoltageHasPoints
      ? freshQuickPreview
      : voltageQuery.data ?? freshQuickPreview;
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
    const bundlePreview = (preferCanonicalCapacityPreview
      ? capacityBundleQuery.data as ContinuationPreviewResult | undefined
      : quickExcelCapacityPreview as ContinuationPreviewResult | null | undefined)
      ?? (usesCapacityBundlePreview
        ? capacityBundleQuery.data as ContinuationPreviewResult | undefined
        : undefined);
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
  }, [activeMassG, capacityBundleQuery.data, capacityQueries, cycleRange, preferCanonicalCapacityPreview, quickExcelCapacityPreview, usesCapacityBundlePreview]);
  const capacityTraces = useMemo(
    () => cellPreviewCapacityTraces(capacitySeries, capacityView, normalizeByMass),
    [capacitySeries, capacityView, normalizeByMass],
  );
  const efficiencyRange = useMemo(
    () => paddedEfficiencyRange(capacitySeries.flatMap((series) => series.efficiencyPct ?? [])),
    [capacitySeries],
  );
  const quickExcelCycleIdBounds = useMemo(
    () => previewCycleIdBounds(quickExcelCapacityPreview),
    [quickExcelCapacityPreview],
  );
  const cycleCount = Math.max(
    inspectionCycleCount,
    freshQuickPreview?.cycle_count ?? 0,
    quickExcelCycleIdBounds?.end ?? quickExcelCapacityPreview?.cycle_count ?? 0,
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
    const fullRange = quickNewareExcelPath && quickExcelCycleIdBounds
      ? quickExcelCycleIdBounds
      : fullPreviewCycleWindow(cycleCount);
    if (!fullRange) return;
    setCycleRange((current) => current === null || (!cycleRangeUserEdited && current.start <= 1)
      ? fullRange
      : current);
  }, [source.staged_name, source.hash, cycleCount, cycleRangeUserEdited, quickNewareExcelPath, quickExcelCycleIdBounds]);
  useEffect(() => {
    if (!inspectionCycleCount || quickNewareExcelPath) return;
    setVoltageCycleRange((current) => current ?? {
      start: Math.max(1, inspectionCycleCount - 19),
      end: inspectionCycleCount,
    });
  }, [source.staged_name, source.hash, inspectionCycleCount, quickNewareExcelPath]);
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
  const useQuickExcelCapacity = quickNewareExcelPath
    && !quickExcelCapacityTerminal
    && (!quickExcelCapacityFallbackReady || (Boolean(quickExcelCapacityPreview) && !preferCanonicalCapacityPreview));
  const capacityError = quickNewareExcelPath && quickExcelCapacityTerminal
    ? capacityBundleQuery.error ?? quickExcelCapacityQuery.error
    : usesCapacityBundlePreview
      ? capacityBundleQuery.error
      : capacityQueries.find((query) => query.isError)?.error;
  const quickExcelFallbackValidationError = quickNewareExcelPath && canonicalFallbackForActiveView
    ? view === "voltage" && quickVoltageHasPoints && voltageQuery.isError
      ? voltageError
      : view === "cycles" && quickExcelCapacityPreview && capacityBundleQuery.isError
        ? capacityBundleQuery.error instanceof Error
          ? capacityBundleQuery.error.message
          : "The validated cycle preview could not be prepared."
        : null
    : null;
  const isCapacityLoading = useQuickExcelCapacity
    ? quickExcelCapacityQuery.isPending || quickExcelCapacityQuery.isFetching || !quickExcelCapacityPreview
    : usesCapacityBundlePreview
      ? sourceInspectionLoading
        || (capacityBundleQueryEnabled && capacityBundleQuery.isPending)
        || capacityBundleQuery.isFetching
        || (capacityBundleQueryEnabled && !capacityBundleQuery.data && !continuationReady && !inspectionFailure)
      : sourceInspectionLoading
        || (inspectionEnabled && (inspectionQuery.isPending || inspectionQuery.isFetching))
        || capacityQueries.some((query) => query.isFetching || (continuationReady && query.isPending));
  const activeCycleRange = view === "cycles"
    ? cycleRange
    : voltageCycleRange ?? (cycleCount > 0
      ? { start: Math.max(1, cycleCount - 19), end: cycleCount }
      : null);
  const activeCycleBounds = view === "cycles" && quickNewareExcelPath && quickExcelCycleIdBounds
    ? quickExcelCycleIdBounds
    : { start: 1, end: cycleCount };
  const updateActiveCycleRange = (next: { start: number; end: number }) => {
    if (view === "cycles") {
      setCycleRangeUserEdited(true);
      setCycleRange(next);
    }
    else setVoltageCycleRange(next);
  };
  const shiftCycleRange = (direction: -1 | 1) => {
    if (!activeCycleRange || cycleCount <= 0) return;
    updateActiveCycleRange(shiftCycleWindowWithinBounds(activeCycleRange, activeCycleBounds, direction));
  };
  const voltageHasPoints = Boolean(voltagePreview?.segments.some((segment) => segment.x.length > 0));
  const voltageReady = view === "voltage"
    && (quickVoltageAvailable || quickVoltageFallbackReady || (!voltageQuery.isPending && !voltageQuery.isFetching && !voltageQuery.isPlaceholderData))
    && voltageHasPoints;
  const isVoltageLoading = (supportsQuickVoltagePreview && !quickVoltageFallbackReady && (quickVoltageQuery.isPending
    || quickVoltageQuery.isFetching))
    || sourceInspectionLoading
    || (inspectionEnabled && (inspectionQuery.isPending || inspectionQuery.isFetching || !continuationReady))
    || (voltageQueryEnabled && (voltageQuery.isPending || voltageQuery.isFetching || voltageQuery.isPlaceholderData));
  const isCyclesLoading = isCapacityLoading
    || (!usesCapacityBundlePreview && inspectionEnabled && (inspectionQuery.isPending || inspectionQuery.isFetching || !continuationReady))
    || capacityBundleQuery.isPlaceholderData
    || capacityQueries.some((query) => query.isPlaceholderData);
  const capacityReady = view === "cycles"
    && !isCapacityLoading
    && (useQuickExcelCapacity
      ? Boolean(quickExcelCapacityPreview)
      : usesCapacityBundlePreview
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
      <Stack ref={previewContentRef} gap="xs">
      {(parserWarnings.length > 0 || quickExcelDiagnosticMessage || quickExcelFallbackValidationError) && (
        <Group justify="flex-end">
          {(quickExcelDiagnosticMessage || quickExcelFallbackValidationError) && (
            <Button
              size="compact-sm"
              variant="light"
              color="orange"
              leftSection={<IconAlertTriangle size={15} />}
              onClick={() => setWarningsOpen(true)}
            >
              {quickExcelFallbackValidationError && !quickExcelDiagnosticMessage ? "Preview fallback" : "Source check failed"}
            </Button>
          )}
          {parserWarnings.length > 0 && (
            <Button
              size="compact-sm"
              variant="light"
              color="orange"
              leftSection={<IconAlertTriangle size={15} />}
              onClick={() => setWarningsOpen(true)}
            >
              Data warnings · {parserWarningCount}
            </Button>
          )}
        </Group>
      )}
      <Tabs value={view} onChange={(value) => value && setView(value as ImportPreviewView)} keepMounted>
        <Tabs.List grow>
          <Tabs.Tab value="voltage">Voltage</Tabs.Tab>
          <Tabs.Tab value="cycles" disabled={!hasNavigableCycles && !canTryQuickExcelCycles}>Cycles</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {view === "cycles" && quickNewareExcelPath && quickExcelCapacityPreview && quickExcelDiagnosticMessage && (
        <Alert color="orange" title="Cycle-sheet preview only" p="xs">
          This plot uses the workbook’s separate cycle summary and has not been checked against the raw records.
        </Alert>
      )}
      {quickExcelFallbackValidationError && (
        <Alert color="orange" title="Showing a display-only quick preview" p="xs">
          The validated {view === "voltage" ? "voltage" : "cycle"} preview failed, so this quick preview remains visible. It may not include all source data. {quickExcelFallbackValidationError}
        </Alert>
      )}
      <Box ref={plotSurfaceRef} className="preview-plot-surface" style={{ position: "relative" }}>
        <CellPreviewToolbar
          surfaceMode={surfaceMode}
          onSurfaceModeChange={setSurfaceMode}
          compactChildren={compactToolbarChildren}
          compactSecondaryContent={compactToolbarSecondaryContent}
        >
          {toolbarContent}
        </CellPreviewToolbar>
        <Box ref={plotStackRef} h={plotStackHeight} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {view === "voltage" ? (
            voltageReady && voltagePlot ? (
              <Box w="100%" className="import-preview-plot-ready">{voltagePlot}</Box>
            ) : inspectionError ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionError}</Alert>
            ) : inspectionQuery.isError ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Source inspection failed."}</Alert>
            ) : inspectionFailure ? (
              <Alert color="orange" title="Voltage preview unavailable">{inspectionFailureMessage}</Alert>
            ) : voltageQuery.isError ? (
              <Alert color="orange" title="Voltage preview unavailable">{voltageError}</Alert>
            ) : quickPreviewTakingLong && !quickVoltageFallbackReady ? (
              <Alert color="gray" title="Preview is taking longer than expected">
                The request is still running. You can keep browsing; the preview will update if it finishes.
              </Alert>
            ) : isVoltageLoading ? (
              <ImportPlotSkeleton view="voltage" height={responsivePlotHeight} colors={plotColors} />
            ) : (
              <Alert color="gray">No voltage points were found for this source.</Alert>
            )
          ) : source.metadata_only ? (
            <Alert color="gray">Cycle preview is unavailable for this metadata-only source.</Alert>
          ) : capacityReady && capacityPlot ? (
            <Box w="100%" className="import-preview-plot-ready">{capacityPlot}</Box>
          ) : inspectionError ? (
            <Alert color="orange" title="Cycle preview unavailable">{inspectionError}</Alert>
          ) : inspectionQuery.isError ? (
            <Alert color="orange" title="Cycle preview unavailable">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Source inspection failed."}</Alert>
          ) : inspectionFailure ? (
            <Alert color="orange" title="Cycle preview unavailable">{inspectionFailureMessage}</Alert>
          ) : quickExcelCapacityFallbackReady && capacityError ? (
            <Alert color="orange" title="Cycle preview unavailable">
              {capacityError instanceof Error ? capacityError.message : "The cycle preview could not be prepared."}
            </Alert>
          ) : quickPreviewTakingLong && !quickExcelCapacityFallbackReady ? (
            <Alert color="gray" title="Preview is taking longer than expected">
              The request is still running. You can keep browsing; the preview will update if it finishes.
            </Alert>
          ) : isCyclesLoading ? (
            <ImportPlotSkeleton view="cycles" height={responsivePlotHeight} colors={plotColors} />
          ) : (
            <Alert color={capacityError ? "orange" : "gray"} title="Cycle preview unavailable">
              {capacityError instanceof Error ? capacityError.message : "No charge or discharge capacity points were found."}
            </Alert>
          )}
        </Box>
      </Box>
      <Group gap="xs" justify="center" wrap="nowrap" h={40}>
        <Tooltip label="Previous cycle window"><ActionIcon variant="default" aria-label="Previous cycle window" disabled={!hasNavigableCycles || !activeCycleRange || activeCycleRange.start <= activeCycleBounds.start} onClick={() => shiftCycleRange(-1)}><IconChevronLeft size={15} /></ActionIcon></Tooltip>
        <NumberInput aria-label="First preview cycle" min={activeCycleBounds.start} max={activeCycleBounds.end || undefined} value={activeCycleRange?.start ?? ""} disabled={!hasNavigableCycles} onChange={(value) => {
          const start = Math.max(activeCycleBounds.start, Math.min(Math.trunc(Number(value) || activeCycleBounds.start), activeCycleRange?.end ?? activeCycleBounds.end));
          updateActiveCycleRange({ start, end: activeCycleRange?.end ?? activeCycleBounds.end });
        }} w={86} />
        <Text size="sm" c="dimmed">–</Text>
        <NumberInput aria-label="Last preview cycle" min={activeCycleRange?.start ?? activeCycleBounds.start} max={activeCycleBounds.end || undefined} value={activeCycleRange?.end ?? ""} disabled={!hasNavigableCycles} onChange={(value) => {
          const end = Math.max(activeCycleRange?.start ?? activeCycleBounds.start, Math.min(Math.trunc(Number(value) || activeCycleBounds.end), activeCycleBounds.end));
          updateActiveCycleRange({ start: activeCycleRange?.start ?? activeCycleBounds.start, end });
        }} w={86} />
        <Tooltip label="Next cycle window"><ActionIcon variant="default" aria-label="Next cycle window" disabled={!hasNavigableCycles || !activeCycleRange || activeCycleRange.end >= activeCycleBounds.end} onClick={() => shiftCycleRange(1)}><IconChevronRight size={15} /></ActionIcon></Tooltip>
      </Group>
      </Stack>
      <Modal
        opened={warningsOpen}
        onClose={() => setWarningsOpen(false)}
        title="Neware source diagnostics"
        centered
        size="md"
      >
        <Stack gap="sm">
          {quickExcelDiagnosticMessage && (
            <Alert color="orange" title="Source diagnostic">
              This diagnostic describes the source check. A quick voltage plot, if shown, is display-only; a separate cycle-summary preview is not cross-checked against raw records.
              <Text size="sm" mt="xs">{quickExcelDiagnosticMessage}</Text>
            </Alert>
          )}
          {quickExcelFallbackValidationError && (
            <Alert color="orange" title="Quick preview fallback">
              The validated {view === "voltage" ? "voltage" : "cycle"} preview failed, so the quick preview is being retained for display. Treat it as display-only; it may not include all source data.
              <Text size="sm" mt="xs">{quickExcelFallbackValidationError}</Text>
            </Alert>
          )}
          {parserWarnings.length > 0 && (
            <Text size="sm" c="dimmed">
              These warnings describe inconsistencies found in the workbook. CellXplorer explains how it handled them below; preview and import remain available when the data can be recovered safely.
            </Text>
          )}
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
