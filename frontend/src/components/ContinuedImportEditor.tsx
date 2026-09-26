import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconChevronLeft, IconChevronRight, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  ActiveMaterialPresetSettings,
  ApiError,
  ContinuationFinding,
  ContinuationInspectResult,
  ContinuationPreviewResult,
  ElectrodeAreaPresetSettings,
  ImportPreview,
  ImportFolderWatchDraft,
  inspectContinuationSources,
  previewContinuationSources,
} from "../api";
import {
  applySuggestedOrder,
  continuationSourceCanOpenRawData,
  continuationInspectionHasErrors,
  continuationInspectionShouldPoll,
  moveSource,
  shouldAutoApplySuggestedOrder,
} from "../continuationPolicy";
import {
  assignContinuationSourceColors,
  buildContinuedImportSubmissionState,
  nextSelectedSourceKey,
  reorderContinuationSourceKeys,
  type ContinuedImportSubmissionState,
  type SourceColorAssignments,
} from "../continuedImportWorkspacePolicy";
import {
  shouldRequestImportPreview,
  type ImportPreviewDraftState,
} from "../importPreviewPolicy";
import {
  buildContinuationPreviewProvenanceLayout,
  continuationPreviewHasPoints,
  continuationPreviewFailureSources,
  continuationPreviewQueryKey,
  continuationPreviewRequest,
  scaleContinuationPreviewTimeAxis,
  type ContinuationPreviewInterpretation,
  type ContinuationPreviewQuantity,
} from "../continuedImportPreviewPolicy";
import { PALETTE } from "../features/analyses/editor/plotting/plotStyle";
import { ContinuationSourceList } from "./ContinuationSourceList";
import { CellPreviewPlot, type CellPreviewSurfaceMode } from "./CellPreviewPlot";
import {
  cellPreviewCapacityLayout,
  cellPreviewCapacityTraces,
  cellPreviewVoltageLayout,
  cellPreviewVoltageTraces,
  paddedEfficiencyRange,
  type CellPreviewCycleSeries,
} from "./cellPreviewPlotModel";
import { ImportSourcePreview } from "./ImportSourcePreview";
import { shiftPreviewCycleWindow } from "../analysisCellPreviewPolicy";

export type ContinuedCellDraft = {
  cell_name: string;
  description: string;
  metadata: Record<string, string>;
  active_mass_mg_override: number | null;
  nominal_capacity_mah_override: number | null;
  electrode_area_cm2_override: number | null;
  active_material_selection: string;
  active_material_preset_id: string | null;
  active_material_name: string | null;
  active_material_specific_capacity_mah_g: number | null;
  electrode_area_selection: string;
  electrode_area_preset_id: string | null;
  electrode_area_preset_name: string | null;
  source_metadata: ImportPreview | null;
};

type DraftSource = ImportPreviewDraftState;

function draftSource(draft: DraftSource) {
  return {
    staged_name: draft.staged_name,
    source_path: draft.source_path,
    inspection: draft.inspection,
    allow_metadata_only: draft.metadata_only,
  };
}

function fallbackSource(draft: DraftSource) {
  return {
    key: draft.staged_name,
    kind: "staged" as const,
    source_file_id: null,
    filename: draft.filename,
    source_path: draft.source_path,
    hash: draft.hash || null,
    start_time: draft.start_time,
    end_time: null,
    local_cycle_start: null,
    local_cycle_end: null,
    local_cycle_count: null,
    protocol_signature: null,
    device_info: draft.device_info,
    channel: draft.channel,
    nominal_capacity_mah: draft.nominal_capacity_mah,
    active_mass_mg: draft.active_mass_mg,
    inspection_status: "pending" as const,
    canonical_cycling: !draft.metadata_only,
    metadata_only: draft.metadata_only,
    capability_warning: draft.capability_warning,
  };
}

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** One compact fact line in the selected-source summary. Unavailable facts render as "—" rather than being guessed. */
function SummaryRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Group gap="xs" wrap="nowrap" align="start">
      <Text size="xs" c="dimmed" style={{ flex: "none", width: 84 }}>{label}</Text>
      <Text size="xs" truncate title={value ?? undefined} style={{ flex: 1, minWidth: 0 }}>
        {value || "—"}
      </Text>
    </Group>
  );
}

function inlineFindingLabel(
  finding: ContinuationFinding,
  sources: ContinuationInspectResult["sources"],
): string {
  const filenames = new Map(sources.map((source) => [source.key, source.filename]));
  const sourceLabel = finding.source_keys
    .map((key) => filenames.get(key) ?? key)
    .join(" → ");
  return `${finding.title}: ${finding.message}${sourceLabel ? ` (${sourceLabel})` : ""}`;
}

export function ContinuedImportEditor({
  opened,
  drafts,
  cellDraft,
  onCellDraftChange,
  onAddMoreSources,
  onRemoveSource,
  onSwitchToSeparate,
  addingMore,
  destinationFolders,
  onDestinationFoldersChange,
  folderSelectData,
  materialPresets,
  areaPresets,
  onSubmissionStateChange,
  onRawData,
  onPreviewRequested,
  importing,
  folderWatch,
  onFolderWatchChange,
  folderTrackingReason,
  onOpenFolderTrackingSettings,
}: {
  opened: boolean;
  drafts: DraftSource[];
  cellDraft: ContinuedCellDraft;
  onCellDraftChange: (draft: ContinuedCellDraft) => void;
  onAddMoreSources: () => void;
  onRemoveSource: (stagedName: string) => void;
  onSwitchToSeparate: () => void;
  addingMore: boolean;
  destinationFolders: string[];
  onDestinationFoldersChange: (folders: string[]) => void;
  folderSelectData: { value: string; label: string }[];
  materialPresets: ActiveMaterialPresetSettings["presets"];
  areaPresets: ElectrodeAreaPresetSettings["presets"];
  /** Immutable submission projection for the shared footer's Import action. */
  onSubmissionStateChange: (state: ContinuedImportSubmissionState) => void;
  onRawData?: (stagedName: string) => void;
  onPreviewRequested?: (draft: DraftSource, retry?: boolean) => void;
  importing: boolean;
  folderWatch: ImportFolderWatchDraft | null;
  onFolderWatchChange?: (watch: ImportFolderWatchDraft) => void;
  folderTrackingReason?: string | null;
  onOpenFolderTrackingSettings?: () => void;
}) {
  const [order, setOrder] = useState<string[]>(() => drafts.map((item) => item.staged_name));
  const [colors, setColors] = useState<SourceColorAssignments>({});
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>(() => drafts[0]?.staged_name ?? "");
  const [previewMode, setPreviewMode] = useState<"combined" | "source">("combined");
  const [previewSurfaceMode, setPreviewSurfaceMode] = useState<CellPreviewSurfaceMode>("theme");
  const scheme = useComputedColorScheme("light");
  const theme = useMantineTheme();
  const previewColors = useMemo(() => previewSurfaceMode === "theme"
    ? scheme === "dark"
      ? { background: theme.colors.dark[7], text: theme.colors.gray[0], border: theme.colors.dark[3], grid: theme.colors.dark[5] }
      : { background: theme.white, text: theme.black, border: theme.colors.gray[5], grid: theme.colors.gray[3] }
    : previewSurfaceMode === "sun"
      ? { background: theme.white, text: theme.black, border: theme.colors.gray[5], grid: theme.colors.gray[3] }
      : previewSurfaceMode === "moon"
        ? { background: scheme === "dark" ? theme.colors.dark[7] : "#000000", text: theme.colors.gray[0], border: scheme === "dark" ? theme.colors.dark[3] : theme.colors.dark[1], grid: scheme === "dark" ? theme.colors.dark[5] : theme.colors.dark[3] }
        : { background: theme.colors.dark[4], text: theme.colors.gray[0], border: theme.colors.dark[1], grid: theme.colors.dark[3] },
  [previewSurfaceMode, scheme, theme]);
  const [previewQuantity, setPreviewQuantity] = useState<ContinuationPreviewQuantity>(() =>
    drafts.length > 0 && drafts.every((draft) => draft.technique?.trim().toLocaleUpperCase() === "OCV")
      ? "voltage"
      : "discharge_capacity_mah",
  );
  const [previewCapacityView, setPreviewCapacityView] = useState<"discharge" | "both" | "charge">("both");
  const [previewVoltageXAxis, setPreviewVoltageXAxis] = useState<"time" | "capacity">("time");
  const [previewNormalizeByMass, setPreviewNormalizeByMass] = useState(true);
  const [previewVoltageCycleRange, setPreviewVoltageCycleRange] = useState<{ start: number; end: number } | null>(null);
  const [previewCapacityCycleRange, setPreviewCapacityCycleRange] = useState<{ start: number; end: number } | null>(null);
  const previewCycleRange = previewQuantity === "voltage" ? previewVoltageCycleRange : previewCapacityCycleRange;
  const setPreviewCycleRange = (next: { start: number; end: number } | null) => {
    if (previewQuantity === "voltage") setPreviewVoltageCycleRange(next);
    else setPreviewCapacityCycleRange(next);
  };
  const [previewInterpretation, setPreviewInterpretation] = useState<ContinuationPreviewInterpretation>("stitched");
  const previousOrderRef = useRef<string[]>(order);
  const userReorderedRef = useRef(false);

  const byKey = useMemo(() => new Map(drafts.map((item) => [item.staged_name, item])), [drafts]);
  const orderedDrafts = useMemo(
    () => order.map((key) => byKey.get(key)).filter((item): item is DraftSource => Boolean(item)),
    [byKey, order],
  );
  const inspectionQuery = useQuery<ContinuationInspectResult>({
    queryKey: [
      "continued-import-inspection",
      order,
      drafts.map((item) => `${item.staged_name}:${item.hash}:${item.source_path ?? ""}`).join("|"),
    ],
    queryFn: () => inspectContinuationSources({
      sources: orderedDrafts.map(draftSource),
      proposed_order: order,
    }),
    enabled: opened && orderedDrafts.length >= 1,
    refetchInterval: (query) =>
      opened
      && orderedDrafts.length >= 1
      && !query.state.error
      && continuationInspectionShouldPoll(query.state.data)
        ? 1000
        : false,
  });
  const result = inspectionQuery.data;
  const sourceInspectionFailed = continuationInspectionHasErrors(result);
  const orderNeedsAutomaticCorrection = shouldAutoApplySuggestedOrder(
    result,
    order,
    userReorderedRef.current,
  );
  const allOcvSources = orderedDrafts.length >= 1
    && orderedDrafts.every((draft) => draft.technique?.trim().toLocaleUpperCase() === "OCV");
  useEffect(() => {
    if (allOcvSources) setPreviewQuantity("voltage");
  }, [allOcvSources]);
  const combinedPreviewQuery = useQuery<ContinuationPreviewResult>({
    queryKey: [
      ...continuationPreviewQueryKey(
        order,
        orderedDrafts,
        inspectionQuery.dataUpdatedAt,
        previewQuantity,
        previewInterpretation,
      ),
      previewVoltageXAxis,
      previewQuantity === "voltage" ? previewVoltageCycleRange?.start ?? null : null,
      previewQuantity === "voltage" ? previewVoltageCycleRange?.end ?? null : null,
      previewQuantity === "voltage" ? null : previewCapacityCycleRange?.start ?? null,
      previewQuantity === "voltage" ? null : previewCapacityCycleRange?.end ?? null,
    ],
    queryFn: ({ signal }) => previewContinuationSources({
      ...continuationPreviewRequest(orderedDrafts, order, previewQuantity, previewInterpretation),
      voltage_x_axis: previewVoltageXAxis,
      ...(previewQuantity === "voltage" && previewVoltageCycleRange
        ? { cycle_start: previewVoltageCycleRange.start, cycle_end: previewVoltageCycleRange.end }
        : previewQuantity !== "voltage" && previewCapacityCycleRange
          ? { cycle_start: previewCapacityCycleRange.start, cycle_end: previewCapacityCycleRange.end }
        : {}),
    }, { signal }),
    enabled: opened
      && previewMode === "combined"
      && Boolean(result?.inspection_complete)
      && !sourceInspectionFailed
      && !orderNeedsAutomaticCorrection
      && orderedDrafts.length >= 1,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
  const chargePreviewQuery = useQuery<ContinuationPreviewResult>({
    queryKey: [
      ...continuationPreviewQueryKey(
        order,
        orderedDrafts,
        inspectionQuery.dataUpdatedAt,
        "charge_capacity_mah",
        previewInterpretation,
      ),
      previewCapacityCycleRange?.start ?? null,
      previewCapacityCycleRange?.end ?? null,
    ],
    queryFn: ({ signal }) => previewContinuationSources(
      {
        ...continuationPreviewRequest(orderedDrafts, order, "charge_capacity_mah", previewInterpretation),
        ...(previewCapacityCycleRange
          ? { cycle_start: previewCapacityCycleRange.start, cycle_end: previewCapacityCycleRange.end }
          : {}),
      },
      { signal },
    ),
    enabled: opened
      && previewMode === "combined"
      && previewQuantity !== "voltage"
      && previewCapacityView !== "discharge"
      && Boolean(result?.inspection_complete)
      && !sourceInspectionFailed
      && !orderNeedsAutomaticCorrection
      && orderedDrafts.length >= 1,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
  const activeCombinedQuery = previewQuantity === "voltage"
    ? combinedPreviewQuery
    : previewCapacityView === "charge" ? chargePreviewQuery : combinedPreviewQuery;
  const displayCombinedPreview = useMemo(
    () => activeCombinedQuery.data
      ? previewQuantity === "voltage" && previewVoltageXAxis === "time"
        ? scaleContinuationPreviewTimeAxis(activeCombinedQuery.data)
        : activeCombinedQuery.data
      : undefined,
    [activeCombinedQuery.data, previewQuantity, previewVoltageXAxis],
  );
  const displayChargePreview = chargePreviewQuery.data;
  const normalizableByMass = orderedDrafts.length > 0 && orderedDrafts.every((draft) => {
    const massMg = cellDraft.active_mass_mg_override ?? draft.active_mass_mg;
    return massMg !== null && massMg !== undefined && massMg > 0;
  });
  const inspectedCycleExtent = previewInterpretation === "stitched"
    ? (result?.sources.reduce((sum, source) => sum + (source.local_cycle_count ?? 0), 0) ?? 0)
    : Math.max(0, ...(result?.sources.map((source) => source.local_cycle_count ?? 0) ?? []));
  const previewCycleExtent = Math.max(
    0,
    displayCombinedPreview?.cycle_count ?? 0,
    displayChargePreview?.cycle_count ?? 0,
    ...(displayCombinedPreview?.segments.map((segment) => segment.global_cycle_end ?? 0) ?? []),
    ...(displayChargePreview?.segments.map((segment) => segment.global_cycle_end ?? 0) ?? []),
  );
  const combinedCycleCount = previewCycleExtent || inspectedCycleExtent;
  const combinedPreviewLoading = activeCombinedQuery.isPending
    || (activeCombinedQuery.isFetching && !activeCombinedQuery.data)
    || activeCombinedQuery.isPlaceholderData
    || (previewQuantity !== "voltage" && previewCapacityView !== "discharge"
      && (chargePreviewQuery.isPending || (chargePreviewQuery.isFetching && !chargePreviewQuery.data) || chargePreviewQuery.isPlaceholderData));
  const combinedPreviewError = activeCombinedQuery.isError
    || (previewQuantity !== "voltage" && previewCapacityView !== "discharge" && chargePreviewQuery.isError);
  useEffect(() => {
    setPreviewVoltageCycleRange(combinedCycleCount > 0
      ? { start: Math.max(1, combinedCycleCount - 19), end: combinedCycleCount }
      : null);
    setPreviewCapacityCycleRange(combinedCycleCount > 0
      ? { start: 1, end: combinedCycleCount }
      : null);
  }, [order.join("\u0000"), previewInterpretation, combinedCycleCount]);
  useEffect(() => {
    if (!normalizableByMass) setPreviewNormalizeByMass(false);
  }, [normalizableByMass]);
  useEffect(() => {
    if (allOcvSources) {
      setPreviewQuantity("voltage");
      setPreviewVoltageXAxis("time");
      setPreviewVoltageCycleRange(null);
      setPreviewCapacityCycleRange(null);
    }
  }, [allOcvSources]);
  const combinedCapacitySeries = useMemo<CellPreviewCycleSeries[]>(() => {
    if (previewQuantity === "voltage") return [];
    const dischargePreview = previewCapacityView === "charge"
      ? undefined
      : displayCombinedPreview?.quantity === "discharge_capacity_mah" ? displayCombinedPreview : undefined;
    const chargePreview = displayChargePreview?.quantity === "charge_capacity_mah"
      ? displayChargePreview
      : previewCapacityView === "charge" && displayCombinedPreview?.quantity === "charge_capacity_mah"
        ? displayCombinedPreview
        : undefined;
    const keys = new Set([
      ...(dischargePreview?.segments.map((segment) => segment.source_key) ?? []),
      ...(chargePreview?.segments.map((segment) => segment.source_key) ?? []),
    ]);
    const inRange = (cycle: number | null) => cycle !== null
      && (!previewCycleRange || (cycle >= previewCycleRange.start && cycle <= previewCycleRange.end));
    return [...keys].map((key) => {
      const discharge = dischargePreview?.segments.find((segment) => segment.source_key === key);
      const charge = chargePreview?.segments.find((segment) => segment.source_key === key);
      const efficiency = [discharge, charge].find((segment) =>
        segment?.coulombic_efficiency_x?.length && segment.coulombic_efficiency_pct?.length,
      );
      const dischargeX = discharge?.x ?? [];
      const chargeX = charge?.x ?? [];
      const efficiencyX = efficiency?.coulombic_efficiency_x ?? [];
      const efficiencyPct = efficiency?.coulombic_efficiency_pct ?? [];
      const draft = orderedDrafts.find((item) => item.staged_name === key);
      const massMg = cellDraft.active_mass_mg_override ?? draft?.active_mass_mg;
      const massG = massMg && massMg > 0 ? massMg / 1000 : null;
      const sourceColor = colors[key] ?? "#12b886";
      return {
        x: [],
        sourceKey: key,
        name: discharge?.filename ?? charge?.filename ?? key,
        dischargeX: dischargeX.filter(inRange),
        dischargeCapacityMah: discharge?.y.filter((_, index) => inRange(dischargeX[index])) ?? [],
        chargeX: chargeX.filter(inRange),
        chargeCapacityMah: charge?.y.filter((_, index) => inRange(chargeX[index])) ?? [],
        efficiencyX: efficiencyX.filter(inRange),
        efficiencyPct: efficiencyPct.filter((_, index) => inRange(efficiencyX[index] ?? null)),
        massG,
        chargeColor: sourceColor,
        dischargeColor: sourceColor,
        capacityOpacity: key === selectedSourceKey ? 1 : 0.62,
      };
    });
  }, [
    previewQuantity,
    previewCapacityView,
    displayCombinedPreview,
    displayChargePreview,
    previewCycleRange?.start,
    previewCycleRange?.end,
    orderedDrafts,
    cellDraft.active_mass_mg_override,
    colors,
    selectedSourceKey,
  ]);
  const combinedCapacityTraces = useMemo(
    () => cellPreviewCapacityTraces(combinedCapacitySeries, previewCapacityView, previewNormalizeByMass),
    [combinedCapacitySeries, previewCapacityView, previewNormalizeByMass],
  );
  const combinedEfficiencyRange = useMemo(
    () => paddedEfficiencyRange(combinedCapacitySeries.flatMap((series) => series.efficiencyPct ?? [])),
    [combinedCapacitySeries],
  );
  const combinedPlotPreview = displayCombinedPreview ?? displayChargePreview;
  const combinedVoltageTraces = useMemo(() => displayCombinedPreview?.quantity === "voltage"
    ? cellPreviewVoltageTraces(displayCombinedPreview.segments.map((segment) => ({
        x: segment.x,
        voltage: segment.y,
        current: segment.current_ma,
        name: segment.filename,
        voltageColor: colors[segment.source_key] ?? "#12b886",
        opacity: segment.source_key === selectedSourceKey ? 1 : 0.62,
      })))
    : [], [displayCombinedPreview, colors, selectedSourceKey]);
  const combinedPlotData = previewQuantity === "voltage"
    ? displayCombinedPreview && continuationPreviewHasPoints(displayCombinedPreview) ? combinedVoltageTraces : []
    : combinedCapacityTraces;
  const combinedPlotLayout = useMemo(() => {
    if (!combinedPlotPreview) return {};
    const base = previewQuantity === "voltage"
      ? cellPreviewVoltageLayout(
          previewColors,
          combinedPlotPreview.x_label
            ?? (previewVoltageXAxis === "time" ? "Time (minutes)" : "Capacity (mAh)"),
          `continued-preview-voltage-${previewVoltageXAxis}`,
        )
      : cellPreviewCapacityLayout(
          previewColors,
          `Capacity (${previewNormalizeByMass && normalizableByMass ? "mAh/g" : "mAh"})`,
          combinedEfficiencyRange,
          `continued-preview-cycles-${previewNormalizeByMass && normalizableByMass ? "mAh-per-g" : "mAh"}`,
        );
    if (previewQuantity !== "voltage") return base;
    const provenance = buildContinuationPreviewProvenanceLayout(combinedPlotPreview, colors);
    return {
      ...base,
      ...provenance,
      shapes: [...base.shapes, ...(provenance.shapes ?? [])],
    };
  }, [
    combinedPlotPreview,
    previewQuantity,
    previewVoltageXAxis,
    previewColors,
    previewNormalizeByMass,
    normalizableByMass,
    combinedEfficiencyRange,
    colors,
  ]);
  const combinedPlotReady = Boolean(
    result?.inspection_complete
    && !sourceInspectionFailed
    && !inspectionQuery.isFetching
    && !orderNeedsAutomaticCorrection
    && !combinedPreviewLoading
    && !combinedPreviewError
    && !activeCombinedQuery.isPlaceholderData
    && !(previewQuantity !== "voltage" && previewCapacityView !== "discharge" && chargePreviewQuery.isPlaceholderData)
    && combinedPlotData.length > 0
    && combinedPlotPreview,
  );
  const combinedPlotElement: ReactNode = combinedPlotPreview && combinedPlotData.length > 0 ? (
    <CellPreviewPlot
      data={combinedPlotData}
      layout={combinedPlotLayout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: 352, fontWeight: 400 }}
      surfaceMode={previewSurfaceMode}
      onSurfaceModeChange={setPreviewSurfaceMode}
      legend={previewQuantity === "voltage" && combinedVoltageTraces.some((trace) => trace.name.startsWith("Current"))
        ? [{ name: "Voltage", color: "#12b886" }, { name: "Current", color: "#2E86AB" }]
        : []}
      updating={activeCombinedQuery.isFetching && Boolean(activeCombinedQuery.data)
        || (previewQuantity !== "voltage" && previewCapacityView !== "discharge" && chargePreviewQuery.isFetching && Boolean(chargePreviewQuery.data))}
    />
  ) : null;
  const combinedCycleNavigator = (
    <Group gap="xs" justify="center" wrap="nowrap" mt="xs" h={40}>
      <Tooltip label="Previous cycle window"><Button variant="default" size="compact-sm" aria-label="Previous cycle window" disabled={!previewCycleRange || previewCycleRange.start <= 1} onClick={() => previewCycleRange && setPreviewCycleRange(shiftPreviewCycleWindow(previewCycleRange, combinedCycleCount, -1))}><IconChevronLeft size={15} /></Button></Tooltip>
      <NumberInput aria-label="First preview cycle" min={1} max={combinedCycleCount || undefined} value={previewCycleRange?.start ?? ""} disabled={combinedCycleCount === 0} onChange={(value) => {
        const start = Math.max(1, Math.min(Math.trunc(Number(value) || 1), previewCycleRange?.end ?? combinedCycleCount));
        setPreviewCycleRange({ start, end: previewCycleRange?.end ?? combinedCycleCount });
      }} w={86} />
      <Text size="sm" c="dimmed">–</Text>
      <NumberInput aria-label="Last preview cycle" min={previewCycleRange?.start ?? 1} max={combinedCycleCount || undefined} value={previewCycleRange?.end ?? ""} disabled={combinedCycleCount === 0} onChange={(value) => {
        const end = Math.max(previewCycleRange?.start ?? 1, Math.min(Math.trunc(Number(value) || 1), combinedCycleCount));
        setPreviewCycleRange({ start: previewCycleRange?.start ?? 1, end });
      }} w={86} />
      <Tooltip label="Next cycle window"><Button variant="default" size="compact-sm" aria-label="Next cycle window" disabled={!previewCycleRange || previewCycleRange.end >= combinedCycleCount} onClick={() => previewCycleRange && setPreviewCycleRange(shiftPreviewCycleWindow(previewCycleRange, combinedCycleCount, 1))}><IconChevronRight size={15} /></Button></Tooltip>
    </Group>
  );
  const [retainedCombinedPlot, setRetainedCombinedPlot] = useState<ReactNode>(null);
  useEffect(() => {
    if (combinedPlotReady && combinedPlotElement) setRetainedCombinedPlot(combinedPlotElement);
  }, [
    previewMode,
    previewQuantity,
    previewCapacityView,
    previewVoltageXAxis,
    previewInterpretation,
    previewNormalizeByMass,
    previewCycleRange?.start,
    previewCycleRange?.end,
    previewSurfaceMode,
    combinedPlotReady,
    activeCombinedQuery.data,
    activeCombinedQuery.isPlaceholderData,
    chargePreviewQuery.data,
    chargePreviewQuery.isPlaceholderData,
    combinedCapacityTraces,
    cellDraft.active_mass_mg_override,
    colors,
    selectedSourceKey,
    previewColors.background,
    previewColors.text,
    previewColors.grid,
    previewColors.border,
  ]);
  const combinedPreviewUpdatingPanel = (
    <Paper withBorder p="xs">
      <Box h={404} style={{ position: "relative" }}>
        {retainedCombinedPlot ? (
          <Box style={{ opacity: 0.46, transition: "opacity 100ms linear" }}>{retainedCombinedPlot}</Box>
        ) : (
          <Center h={404}><Loader size="sm" /></Center>
        )}
        {retainedCombinedPlot && <Badge color="gray" variant="filled" role="status" style={{ position: "absolute", top: 8, right: 8, pointerEvents: "none" }}>Updating preview…</Badge>}
      </Box>
      {combinedCycleNavigator}
    </Paper>
  );
  const orderedSources = useMemo(
    () => result?.sources.length
      ? order
        .map((key) => result.sources.find((source) => source.key === key))
        .filter((source): source is NonNullable<typeof source> => Boolean(source))
      : orderedDrafts.map(fallbackSource),
    [order, orderedDrafts, result],
  );

  // Keep the visible order in sync with staged drafts: append newly staged
  // sources, drop removed ones, preserve everyone else's position.
  useEffect(() => {
    const available = new Set(drafts.map((item) => item.staged_name));
    setOrder((current) => [
      ...current.filter((key) => available.has(key)),
      ...drafts.map((item) => item.staged_name).filter((key) => !current.includes(key)),
    ]);
  }, [drafts]);

  // Color belongs to source identity, not list position: reordering never
  // recolors a source, and a newly added source takes the next free slot.
  useEffect(() => {
    setColors((current) => assignContinuationSourceColors(current, order, PALETTE));
  }, [order]);

  // Selection is stable by source key: reordering keeps the same source
  // selected, and removing the selected source falls back to its nearest
  // surviving neighbour rather than jumping to the first row.
  useEffect(() => {
    setSelectedSourceKey((current) => nextSelectedSourceKey(current || null, previousOrderRef.current, order) ?? "");
    previousOrderRef.current = order;
  }, [order]);

  // Individual previews remain lazy. The automatic merged preview uses the
  // continuation endpoint and must not start an extra per-source request just
  // because a row is selected for its summary/raw-data target.
  useEffect(() => {
    const selected = byKey.get(selectedSourceKey);
    if (previewMode === "source" && shouldRequestImportPreview(selected, true)) {
      onPreviewRequested?.(selected);
    }
  }, [byKey, onPreviewRequested, previewMode, selectedSourceKey]);

  useEffect(() => {
    if (!orderNeedsAutomaticCorrection || !result) return;
    setOrder((current) => applySuggestedOrder(current, result.suggested_order));
  }, [orderNeedsAutomaticCorrection, result]);

  useEffect(() => {
    if (!opened) {
      userReorderedRef.current = false;
      setPreviewMode("combined");
      setPreviewQuantity(drafts.length > 0 && drafts.every((draft) => draft.technique?.trim().toLocaleUpperCase() === "OCV")
        ? "voltage"
        : "discharge_capacity_mah");
      setPreviewInterpretation("stitched");
    }
  }, [drafts, opened]);

  const submissionState = useMemo(
    () => buildContinuedImportSubmissionState(
      order,
      cellDraft,
      cellDraft.cell_name,
      result,
      [],
      inspectionQuery.isError,
      folderWatch?.enabled === true,
    ),
    [cellDraft, folderWatch?.enabled, inspectionQuery.isError, order, result],
  );
  useEffect(() => {
    onSubmissionStateChange(submissionState);
  }, [submissionState, onSubmissionStateChange]);

  // Reordering/removal must reflect work actually in flight (submission), not
  // the query's resting "pending" status for an inspection that was never
  // requested or that a reorder just invalidated. canSubmit already re-gates
  // import through continuedImportCanSubmit(...) whenever the order changes
  // without a matching complete inspection, so this lock does not need to
  // track inspection fetch state for safety.
  const disabled = importing;
  const move = (index: number, direction: -1 | 1) => {
    if (disabled) return;
    setOrder((current) => {
      const next = moveSource(current, index, direction);
      if (next.some((key, itemIndex) => key !== current[itemIndex])) {
        userReorderedRef.current = true;
      }
      return next;
    });
  };
  const visibleFindings = orderNeedsAutomaticCorrection ? [] : result?.findings;
  const warningFindings = visibleFindings?.filter(
    (finding) => finding.severity === "warning" || finding.severity === "confirmation",
  ) ?? [];
  const orderCouldNotBeVerified = Boolean(
    result?.inspection_complete
    && orderedDrafts.length > 1
    && result.suggested_order_basis === "selection_order",
  );
  const selectedDraft = byKey.get(selectedSourceKey) ?? orderedDrafts[0];
  const selectedSource = orderedSources.find((source) => source.key === selectedSourceKey) ?? orderedSources[0];
  const selectedRawDataAvailable = Boolean(
    selectedDraft?.source_path
    && selectedSource?.inspection_status !== "error",
  );
  const canOpenSelectedRawData = Boolean(
    selectedDraft
    && selectedSource
    && continuationSourceCanOpenRawData(selectedSource, {
      rawDataAvailable: selectedRawDataAvailable,
    }),
  );
  const combinedPreviewFailureSources = activeCombinedQuery.isError
    ? continuationPreviewFailureSources(
      activeCombinedQuery.error instanceof ApiError ? activeCombinedQuery.error.detail : null,
    )
    : [];
  const updateDraft = (patch: Partial<ContinuedCellDraft>) =>
    onCellDraftChange({ ...cellDraft, ...patch });

  const selectSource = (key: string) => {
    setSelectedSourceKey(key);
  };
  const materialOptions = [
    { value: "custom", label: "Custom nominal capacity" },
    ...materialPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.specific_capacity_mah_g} mAh/g)`,
    })),
  ];
  const areaOptions = [
    { value: "custom", label: "Custom" },
    ...areaPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.area_cm2} cm²)`,
    })),
  ];

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" align="center" gap="sm" wrap="wrap" style={{ flex: "none" }}>
        <Group gap="xs" align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {folderWatch ? (
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Group gap="xs" align="center" wrap="nowrap">
                <Switch
                  size="sm"
                  label="Track this folder for new files"
                  checked={folderWatch.enabled}
                  onChange={(event) => onFolderWatchChange?.({
                    ...folderWatch,
                    enabled: event.currentTarget.checked,
                  })}
                />
                <Button
                  variant="default"
                  size="compact-sm"
                  onClick={onOpenFolderTrackingSettings}
                >
                  Settings
                </Button>
              </Group>
              <Text size="xs" c="dimmed" truncate title={folderWatch.folder_path}>
                {folderWatch.folder_path}
              </Text>
            </Stack>
          ) : (
            <Text size="xs" c="dimmed" truncate title={folderTrackingReason ?? undefined}>
              {folderTrackingReason || "Folder tracking is available when the selected sources share a folder."}
            </Text>
          )}
        </Group>
        <Group gap="xs" justify="flex-end" align="center">
          {inspectionQuery.isFetching && (
            <Text size="xs" c="dimmed">Preparing merged preview…</Text>
          )}
          {inspectionQuery.isError && (
            <Text size="xs" c="red">
              {inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Continuation inspection failed."}
            </Text>
          )}
          {(sourceInspectionFailed || inspectionQuery.isError) && (
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRefresh size={15} />}
              disabled={importing}
              onClick={() => {
                void inspectionQuery.refetch();
              }}
            >
              Retry inspection
            </Button>
          )}
          <Button variant="default" leftSection={<IconPlus size={16} />} loading={addingMore} disabled={importing} onClick={onAddMoreSources}>
            Add more sources
          </Button>
          <MultiSelect
            w={280}
            size="xs"
            placeholder="No folder"
            data={folderSelectData}
            value={destinationFolders}
            onChange={onDestinationFoldersChange}
            clearable
            searchable
          />
        </Group>
      </Group>

      {orderedDrafts.length < 2 && !folderWatch?.enabled && (
        <Alert color="orange" style={{ flex: "none" }}>
          {orderedDrafts.length === 1
            ? "A single-source continued Cell requires folder tracking. Enable “Track this folder for new files” in the command row, or add another source."
            : "Add a source to continue, or switch back to the separate-cell import workflow."}
          <Button mt="xs" size="compact-sm" variant="default" onClick={onSwitchToSeparate}>
            Use separate cells
          </Button>
        </Alert>
      )}

      <Group align="stretch" gap="md" wrap="nowrap" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Paper withBorder p="xs" w={328} style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between" wrap="nowrap" style={{ flex: "none" }}>
              <Text size="sm" fw={700}>Source chain</Text>
              <Badge size="xs" variant="light">{orderedSources.length}</Badge>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
              <ContinuationSourceList
                variant="compact-import"
                sources={orderedSources}
                findings={result?.findings ?? []}
                colorsBySourceKey={colors}
                selectedSourceKey={selectedSourceKey}
                onSelect={selectSource}
                onMove={move}
                onReorder={disabled ? undefined : (from, to) => {
                  setOrder((current) => {
                    const next = reorderContinuationSourceKeys(current, from, to);
                    if (next.some((key, itemIndex) => key !== current[itemIndex])) {
                      userReorderedRef.current = true;
                    }
                    return next;
                  });
                }}
                onRemove={disabled ? undefined : (sourceKey) => {
                  onRemoveSource(sourceKey);
                }}
                disabled={disabled}
              />
            </ScrollArea>
          </Stack>
        </Paper>

        <Paper withBorder p="xs" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between" align="end" gap="xs" wrap="nowrap" style={{ flex: "none" }}>
              <Select
                size="xs"
                label="Preview"
                value={previewMode === "combined" ? "combined" : selectedSourceKey || selectedDraft?.staged_name || null}
                data={[
                  { value: "combined", label: "All sources (combined)" },
                  ...orderedDrafts.map((source, index) => ({
                    value: source.staged_name,
                    label: `Source ${index + 1} — ${source.filename}`,
                  })),
                ]}
                onChange={(value) => {
                  if (value === "combined") setPreviewMode("combined");
                  else if (value) {
                    setSelectedSourceKey(value);
                    setPreviewMode("source");
                  }
                }}
                searchable
                styles={{ root: { minWidth: 240 } }}
              />
              <Tooltip
                label={
                  !selectedDraft
                    ? "Select a source to view raw data"
                    : !canOpenSelectedRawData
                      ? "Raw data is unavailable for this source"
                      : "Open raw cycling data"
                }
              >
                <Button
                  size="compact-sm"
                  variant="default"
                  disabled={!canOpenSelectedRawData}
                  onClick={() => selectedDraft && onRawData?.(selectedDraft.staged_name)}
                >
                  Raw data
                </Button>
              </Tooltip>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="md" pr="xs">
                {previewMode === "combined" && (
                  <Stack gap="xs">
                    <Tabs
                      value={previewQuantity === "voltage" ? "voltage" : "cycles"}
                      onChange={(value) => {
                        if (value === "voltage") setPreviewQuantity("voltage");
                        else if (value === "cycles") setPreviewQuantity("discharge_capacity_mah");
                      }}
                      variant="default"
                      keepMounted={false}
                    >
                      <Tabs.List grow>
                        <Tabs.Tab value="voltage">Voltage</Tabs.Tab>
                        <Tabs.Tab value="cycles" disabled={allOcvSources}>Cycles</Tabs.Tab>
                      </Tabs.List>
                    </Tabs>
                    {previewQuantity === "voltage" ? (
                      <Group justify="center" gap="xs" h={58}>
                        <Text size="sm" c={previewVoltageXAxis === "time" ? undefined : "dimmed"}>Time</Text>
                        <Switch
                          aria-label="Voltage x-axis: time or capacity"
                          checked={previewVoltageXAxis === "capacity"}
                          disabled={allOcvSources}
                          onChange={(event) => setPreviewVoltageXAxis(event.currentTarget.checked ? "capacity" : "time")}
                        />
                        <Text size="sm" c={previewVoltageXAxis === "capacity" ? undefined : "dimmed"}>Capacity</Text>
                      </Group>
                    ) : (
                      <Group justify="center" gap="md" wrap="nowrap" h={58}>
                        <SegmentedControl
                          aria-label="Capacity series to show"
                          value={previewCapacityView}
                          onChange={(value) => setPreviewCapacityView(value as "discharge" | "both" | "charge")}
                          data={[
                            { value: "discharge", label: "Dchg" },
                            { value: "both", label: "Both" },
                            { value: "charge", label: "Chg" },
                          ]}
                        />
                        <Switch
                          size="sm"
                          label="Normalize by mass"
                          checked={normalizableByMass && previewNormalizeByMass}
                          disabled={!normalizableByMass}
                          onChange={(event) => setPreviewNormalizeByMass(event.currentTarget.checked)}
                        />
                      </Group>
                    )}
                  </Stack>
                )}
                {previewMode === "combined" ? (
                  sourceInspectionFailed ? (
                    <Text size="sm" c="red">Continuity inspection failed. Review the source error before retrying.</Text>
                  ) : inspectionQuery.isError ? (
                    <Text size="sm" c="red">The merged preview is waiting for a successful continuity inspection.</Text>
                  ) : !result?.inspection_complete || inspectionQuery.isFetching || orderNeedsAutomaticCorrection ? (
                    combinedPreviewUpdatingPanel
                  ) : combinedPreviewLoading ? (
                    combinedPreviewUpdatingPanel
                  ) : combinedPreviewError ? (
                    <Alert
                      color={activeCombinedQuery.error instanceof ApiError && activeCombinedQuery.error.status === 422 ? "gray" : "orange"}
                      title={activeCombinedQuery.error instanceof ApiError && activeCombinedQuery.error.status === 409 ? "Re-inspect continuity" : "Combined preview could not be generated"}
                    >
                      <Group justify="space-between" align="start" gap="xs" wrap="nowrap">
                        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm">
                            {activeCombinedQuery.error instanceof Error
                              ? activeCombinedQuery.error.message
                              : "The combined preview is unavailable."}
                          </Text>
                          {combinedPreviewFailureSources.length > 0 && (
                            <Stack gap={2} mt={2} style={{ maxHeight: 96, overflowY: "auto" }}>
                              {combinedPreviewFailureSources.map((source, index) => (
                                <Text key={`${source.filename}-${index}`} size="xs" c="dimmed">
                                  {source.filename}: {source.reason}
                                </Text>
                              ))}
                            </Stack>
                          )}
                        </Stack>
                        {!(activeCombinedQuery.error instanceof ApiError && (activeCombinedQuery.error.status === 409 || activeCombinedQuery.error.status === 422)) && (
                          <Button
                            size="compact-sm"
                            variant="default"
                            onClick={() => {
                              void activeCombinedQuery.refetch();
                              if (previewQuantity !== "voltage" && previewCapacityView !== "discharge") void chargePreviewQuery.refetch();
                            }}
                          >
                            Retry
                          </Button>
                        )}
                      </Group>
                    </Alert>
                  ) : combinedPlotReady && combinedPlotElement ? (
                    <Paper withBorder p="xs">
                      <Box h={300}>{combinedPlotElement}</Box>
                      {combinedCycleNavigator}
                    </Paper>
                  ) : (
                    <Alert color="gray">
                      No {previewQuantity === "voltage" ? "voltage" : "capacity"} preview points were found for this chain.
                    </Alert>
                  )
                ) : selectedDraft ? (
                  <ImportSourcePreview source={selectedDraft} />
                ) : (
                  <Text size="sm" c="dimmed">Select a source to preview it.</Text>
                )}

                {previewMode === "combined" && (
                  <Switch
                    size="sm"
                    label="Continuous cycles"
                    description={
                      previewInterpretation === "stitched"
                        ? "Interpret ordered files as one continuous cycle sequence"
                        : "Keep each file's cycle numbering in the source chain"
                    }
                    checked={previewInterpretation === "stitched"}
                    onChange={(event) => setPreviewInterpretation(
                      event.currentTarget.checked ? "stitched" : "source_chain",
                    )}
                  />
                )}

                <Divider label="Selected source" labelPosition="left" />
                <Stack gap={4}>
                  <SummaryRow label="Filename" value={selectedDraft?.filename} />
                  <SummaryRow label="Full path" value={selectedDraft?.source_path} />
                  <SummaryRow label="Size" value={selectedDraft ? formatBytes(selectedDraft.size) : null} />
                  <SummaryRow label="Format" value={selectedDraft?.source_format} />
                  <SummaryRow label="Technique" value={selectedDraft?.technique} />
                  <SummaryRow
                    label="Cycles in file"
                    value={
                      selectedSource?.local_cycle_count !== null && selectedSource?.local_cycle_count !== undefined
                        ? `${selectedSource.local_cycle_count}`
                        : null
                    }
                  />
                  <SummaryRow label="Started" value={selectedSource?.start_time ?? selectedDraft?.start_time} />
                  <SummaryRow label="Ended" value={selectedSource?.end_time} />
                  <SummaryRow label="Protocol" value={selectedSource?.protocol_signature} />
                </Stack>
              </Stack>
            </ScrollArea>
          </Stack>
        </Paper>

        <Paper withBorder p="xs" w={380} style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
            <Stack gap="sm" pr="xs">
              <Text size="sm" fw={700}>Cell draft</Text>
              <TextInput label="Cell name" value={cellDraft.cell_name} onChange={(event) => updateDraft({ cell_name: event.currentTarget.value })} />
              <Textarea label="Cell notes" autosize minRows={3} value={cellDraft.description} onChange={(event) => updateDraft({ description: event.currentTarget.value })} />
              <Divider label="Scientific overrides and presets" labelPosition="left" />
              <NumberInput label="Active material mass (mg)" min={0.000001} decimalScale={6} value={cellDraft.active_mass_mg_override ?? ""} placeholder={cellDraft.source_metadata?.active_mass_mg?.toString() ?? "Source value"} onChange={(value) => updateDraft({ active_mass_mg_override: value === "" ? null : Number(value) })} />
              <Select label="Active material preset" data={materialOptions} value={cellDraft.active_material_selection} searchable onChange={(value) => { const preset = materialPresets.find((item) => item.id === value); updateDraft({ active_material_selection: value ?? "custom", active_material_preset_id: preset?.id ?? null, active_material_name: preset?.name ?? null, active_material_specific_capacity_mah_g: preset?.specific_capacity_mah_g ?? null, nominal_capacity_mah_override: preset ? (cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg) ? ((cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg)! * preset.specific_capacity_mah_g) / 1000 : null : cellDraft.nominal_capacity_mah_override }); }} />
              <NumberInput label="Nominal capacity (mAh)" min={0.000001} decimalScale={6} value={cellDraft.nominal_capacity_mah_override ?? ""} placeholder={cellDraft.source_metadata?.nominal_capacity_mah?.toString() ?? "Source value"} disabled={cellDraft.active_material_selection !== "custom"} onChange={(value) => updateDraft({ nominal_capacity_mah_override: value === "" ? null : Number(value) })} />
              <Group grow align="end">
                <Select label="Electrode-area preset" data={areaOptions} value={cellDraft.electrode_area_selection} searchable onChange={(value) => { const preset = areaPresets.find((item) => item.id === value); updateDraft({ electrode_area_selection: value ?? "custom", electrode_area_preset_id: preset?.id ?? null, electrode_area_preset_name: preset?.name ?? null, electrode_area_cm2_override: preset?.area_cm2 ?? cellDraft.electrode_area_cm2_override }); }} />
                <NumberInput label="Electrode area (cm²)" min={0.000001} decimalScale={6} value={cellDraft.electrode_area_cm2_override ?? ""} disabled={cellDraft.electrode_area_selection !== "custom"} onChange={(value) => updateDraft({ electrode_area_cm2_override: value === "" ? null : Number(value) })} />
              </Group>
            </Stack>
          </ScrollArea>
        </Paper>
      </Group>

      {(orderCouldNotBeVerified || warningFindings.length > 0) && result && (
        <Stack gap={2} style={{ flex: "none" }}>
          {orderCouldNotBeVerified && (
            <Text size="xs" c="orange">
              Recorded times do not establish a unique source order. Review the sequence before importing.
            </Text>
          )}
          {warningFindings.map((finding) => (
            <Text key={finding.id} size="xs" c="orange">
              {inlineFindingLabel(finding, result.sources)}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
