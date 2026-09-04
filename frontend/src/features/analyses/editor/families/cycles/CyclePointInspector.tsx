import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  post,
  type AnalysisSpec,
  type ComputeResult,
  type TimeCapacityRefinementResult,
  type TimeCapacityResult,
} from "../../../../../api";
import Plot from "../../../../../components/Plot";
import { simpleCartesianLayout } from "../../plotting/plotLayout";
import { currentPlotStyle } from "../../plotting/plotStyle";
import { useDelayedFlag } from "../../plotting/plotRuntime";
import { timeCapacityPlaceholderData } from "../../policies/timeCapacityQueryPolicy";
import {
  timeCapacityTracesForResult,
} from "../time-capacity/TimeCapacityPlotCard";
import {
  timeCapacityOverviewExtent,
  timeCapacityRefinementWorthwhile,
} from "../time-capacity/timeCapacityRefinementPolicy";
import { TimeCapacityRefinementLifecycle } from "../time-capacity/timeCapacityRefinementLifecycle";
import {
  cyclePointAdjacentCycle,
  cyclePointDetailRequest,
  cyclePointMeasurePresentation,
  cyclePointSelectedCycles,
  type CyclePoint,
  type CyclePointDetailRequest,
  type CyclePointDetailXQuantity,
  type CyclePointDetailYQuantity,
  type CyclePointSelectionRecord,
  type CyclePointSelectionShape,
} from "./cyclePointSelectionPolicy";
import type { CyclePointOverlayBounds } from "./useCyclePointSelection";

const INSPECTOR_WIDTH = 460;
const INSPECTOR_GAP = 12;
const DETAIL_REFINEMENT_DELAY_MS = 150;

const X_OPTIONS: { value: CyclePointDetailXQuantity; label: string }[] = [
  { value: "time", label: "Time" },
  { value: "capacity_mah", label: "Capacity (mAh)" },
  { value: "capacity_mah_g", label: "Specific capacity (mAh/g)" },
  { value: "capacity_mah_cm2", label: "Areal capacity (mAh/cm²)" },
];

const Y_OPTIONS: { value: CyclePointDetailYQuantity; label: string }[] = [
  { value: "voltage", label: "Cell voltage (V)" },
  { value: "working_potential", label: "Working potential (V)" },
  { value: "counter_potential", label: "Counter potential (V)" },
  { value: "current_ma", label: "Current (mA)" },
  { value: "current_density", label: "Current density (mA/cm²)" },
  { value: "c_rate", label: "C-rate (C)" },
];

function formatSelectionNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 100_000) {
    return value.toExponential(4);
  }
  return Number(value.toPrecision(6)).toString();
}

function detailXLabel(quantity: CyclePointDetailXQuantity, spec: AnalysisSpec): string {
  if (quantity === "capacity_mah_g") return "Specific capacity (mAh/g)";
  if (quantity === "capacity_mah_cm2") return "Areal capacity (mAh/cm²)";
  if (quantity === "capacity_mah") return "Capacity (mAh)";
  return `Time (${spec.computation.time_capacity?.time_unit ?? "min"})`;
}

function detailYLabel(
  quantity: CyclePointDetailYQuantity,
  result: TimeCapacityResult | undefined,
): string {
  if (quantity === "current_density") return "Current density (mA/cm²)";
  if (quantity === "c_rate") return "C-rate (C)";
  if (quantity === "current_ma") return "Current (mA)";
  const fallback = Y_OPTIONS.find((option) => option.value === quantity)?.label ?? "Voltage (V)";
  return result?.voltage_channels?.[quantity]?.label ?? fallback;
}

function availableXOptions(result: TimeCapacityResult | undefined, spec: AnalysisSpec) {
  if (!result) return X_OPTIONS.slice(0, 2);
  // Compact responses materialize only the selected X coordinate, so use
  // stable sample capabilities rather than asking whether an unselected
  // coordinate array happens to be populated in the current payload.
  const hasMass = result.cell_traces.some(
    (trace) => trace.active_mass_mg !== null && trace.active_mass_mg > 0,
  );
  const areaOverride = spec.computation.time_capacity?.electrode_area_cm2;
  const hasArea = Boolean(
    (areaOverride && areaOverride > 0) ||
      result.cell_traces.some(
        (trace) => trace.electrode_area_cm2 !== null && trace.electrode_area_cm2 > 0,
      ),
  );
  return X_OPTIONS.filter(
    (option) =>
      option.value !== "capacity_mah_g" || hasMass,
  ).filter((option) => option.value !== "capacity_mah_cm2" || hasArea);
}

function availableYOptions(result: TimeCapacityResult | undefined, spec: AnalysisSpec) {
  const areaOverride = spec.computation.time_capacity?.electrode_area_cm2;
  const hasArea = Boolean(
    (areaOverride && areaOverride > 0) ||
      result?.cell_traces.some((trace) => trace.electrode_area_cm2 && trace.electrode_area_cm2 > 0),
  );
  const hasNominal = Boolean(
    result?.cell_traces.some((trace) => trace.nominal_capacity_mah && trace.nominal_capacity_mah > 0),
  );
  return Y_OPTIONS.filter((option) => {
    if (option.value === "working_potential" || option.value === "counter_potential") {
      return result?.voltage_channels?.[option.value]?.available === true;
    }
    if (option.value === "current_density") return hasArea;
    if (option.value === "c_rate") return hasNominal;
    return true;
  }).map((option) => ({
    ...option,
    label:
      option.value === "working_potential" || option.value === "counter_potential"
        ? result?.voltage_channels?.[option.value]?.label ?? option.label
        : option.label,
  }));
}

function currentQuantity(quantity: CyclePointDetailYQuantity): boolean {
  return quantity === "current_ma" || quantity === "current_density" || quantity === "c_rate";
}

function detailTraces(
  result: TimeCapacityResult | undefined,
  request: CyclePointDetailRequest | null,
  renderSpec: AnalysisSpec,
  yQuantity: CyclePointDetailYQuantity,
): Plotly.Data[] {
  if (!result || !request) return [];
  return timeCapacityTracesForResult(result, renderSpec, true)
    .filter((trace) => {
      if (String((trace as { name?: unknown }).name ?? "") === "Source boundary") return false;
      const axis = (trace as { yaxis?: unknown }).yaxis;
      return currentQuantity(yQuantity) ? axis === "y2" : axis !== "y2" && axis !== "y3";
    })
    .map((trace) => ({
      ...trace,
      xaxis: undefined,
      yaxis: undefined,
      mode: "lines",
    })) as Plotly.Data[];
}

function inspectorPosition(
  anchor: CyclePointOverlayBounds,
  containerWidth: number,
  containerHeight: number,
): { left: number; top: number; width: number } {
  const width = Math.min(INSPECTOR_WIDTH, Math.max(320, containerWidth - 16));
  const rightSide = anchor.right + INSPECTOR_GAP;
  const leftSide = anchor.left - width - INSPECTOR_GAP;
  const left =
    rightSide + width <= containerWidth - 8
      ? rightSide
      : leftSide >= 8
        ? leftSide
        : Math.max(8, Math.min(containerWidth - width - 8, rightSide));
  const expectedHeight = Math.min(520, Math.max(180, containerHeight - 16));
  return {
    left,
    top: Math.max(8, Math.min(containerHeight - expectedHeight - 8, anchor.top - 12)),
    width,
  };
}

function shapePoints(shape: CyclePointSelectionShape): CyclePoint[] {
  return shape.kind === "rectangle"
    ? [
        shape.start,
        { x: shape.end.x, y: shape.start.y },
        shape.end,
        { x: shape.start.x, y: shape.end.y },
      ]
    : shape.vertices;
}

export function CyclePointSelectionOverlay({
  completedShape,
  constructionVertices,
  dragPreview,
  halos,
}: {
  completedShape: CyclePointSelectionShape | null;
  constructionVertices: CyclePoint[];
  dragPreview: { start: CyclePoint; end: CyclePoint } | null;
  halos: { key: string; screenX: number; screenY: number }[];
}) {
  const completedPoints = completedShape ? shapePoints(completedShape) : [];
  const completedPolygon = completedPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const constructionPolyline = constructionVertices
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      data-cycle-point-selection-overlay
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }}
    >
      {completedPoints.length > 0 && (
        <polygon
          points={completedPolygon}
          fill="var(--mantine-primary-color-light)"
          fillOpacity={0.12}
          stroke="var(--mantine-primary-color-6)"
          strokeWidth={1.5}
          strokeOpacity={0.65}
          strokeLinejoin="round"
        />
      )}
      {constructionVertices.length > 1 && (
        <polyline
          points={constructionPolyline}
          fill="none"
          stroke="var(--mantine-primary-color-6)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {constructionVertices.map((point, index) => (
        <circle
          key={`${point.x}-${point.y}-${index}`}
          cx={point.x}
          cy={point.y}
          r={3.5}
          fill="var(--mantine-primary-color-6)"
          stroke="var(--mantine-color-body)"
          strokeWidth={1}
        />
      ))}
      {dragPreview && (
        <rect
          x={Math.min(dragPreview.start.x, dragPreview.end.x)}
          y={Math.min(dragPreview.start.y, dragPreview.end.y)}
          width={Math.abs(dragPreview.end.x - dragPreview.start.x)}
          height={Math.abs(dragPreview.end.y - dragPreview.start.y)}
          fill="var(--mantine-primary-color-light)"
          fillOpacity={0.18}
          stroke="var(--mantine-primary-color-6)"
          strokeWidth={1.5}
        />
      )}
      {halos.map((point) => (
        <circle
          key={point.key}
          cx={point.screenX}
          cy={point.screenY}
          r={7}
          fill="none"
          stroke="var(--mantine-primary-color-6)"
          strokeWidth={2.5}
        />
      ))}
    </svg>
  );
}

function CycleDetail({
  analysisId,
  records,
  activeCycle,
  setActiveCycle,
  spec,
  cyclesResult,
}: {
  analysisId: number;
  records: CyclePointSelectionRecord[];
  activeCycle: number;
  setActiveCycle: (cycle: number) => void;
  spec: AnalysisSpec;
  cyclesResult: ComputeResult | undefined;
}) {
  const [xQuantity, setXQuantity] = useState<CyclePointDetailXQuantity>("time");
  const [yQuantity, setYQuantity] = useState<CyclePointDetailYQuantity>("voltage");
  const [refinedResult, setRefinedResult] = useState<TimeCapacityRefinementResult | null>(null);
  const refinementTimerRef = useRef<number | null>(null);
  const refinementAbortRef = useRef<AbortController | null>(null);
  const refinementLifecycleRef = useRef<TimeCapacityRefinementLifecycle | null>(null);
  if (refinementLifecycleRef.current === null) {
    refinementLifecycleRef.current = new TimeCapacityRefinementLifecycle();
  }
  const refinementLifecycle = refinementLifecycleRef.current;
  const refinementGestureArmedRef = useRef(false);
  const activeRecords = useMemo(
    () => records.filter((record) => record.scientificCycle === activeCycle),
    [activeCycle, records],
  );
  const request = useMemo(
    () =>
      cyclePointDetailRequest(
        spec,
        activeRecords,
        activeCycle,
        xQuantity,
        yQuantity,
        cyclesResult,
      ),
    [activeCycle, activeRecords, cyclesResult, spec, xQuantity, yQuantity],
  );
  const requestIdentity = `${request.compatibilitySignature}|${request.dataSignature}`;
  const requestIdentityRef = useRef(requestIdentity);
  requestIdentityRef.current = requestIdentity;
  const detailQuery = useQuery({
    queryKey: [
      "time-capacity",
      analysisId,
      request.compatibilitySignature,
      request.dataSignature,
    ],
    queryFn: ({ signal }) =>
      post<TimeCapacityResult>(
        `/api/analyses/${analysisId}/time-capacity`,
        {
          spec: request.spec,
          viewport_width: request.viewportWidth,
          precision: "standard",
          compact: true,
        },
        { signal },
      ),
    placeholderData: (previous, previousQuery) =>
      timeCapacityPlaceholderData(
        previous,
        previousQuery?.queryKey,
        analysisId,
        request.compatibilitySignature,
      ),
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
  });
  const delayedLoading = useDelayedFlag(detailQuery.isFetching);
  const overview = detailQuery.data;

  const cancelRefinement = useCallback(() => {
    refinementLifecycle.cancelPending();
    if (refinementTimerRef.current !== null) {
      window.clearTimeout(refinementTimerRef.current);
      refinementTimerRef.current = null;
    }
    refinementAbortRef.current?.abort();
    refinementAbortRef.current = null;
  }, [refinementLifecycle]);

  useEffect(() => {
    cancelRefinement();
    setRefinedResult(null);
  }, [cancelRefinement, requestIdentity]);

  useEffect(() => cancelRefinement, [cancelRefinement]);

  const handleRelayout = useCallback(
    (event: Readonly<Plotly.PlotRelayoutEvent>) => {
      const relayout = event as unknown as Record<string, unknown>;
      if (relayout["xaxis.autorange"] === true) {
        refinementGestureArmedRef.current = false;
        cancelRefinement();
        setRefinedResult(null);
        return;
      }
      if (!refinementGestureArmedRef.current) return;
      refinementGestureArmedRef.current = false;
      const range = Array.isArray(relayout["xaxis.range"])
        ? (relayout["xaxis.range"] as unknown[])
        : [];
      const first = relayout["xaxis.range[0]"] ?? range[0];
      const second = relayout["xaxis.range[1]"] ?? range[1];
      if (
        typeof first !== "number" ||
        !Number.isFinite(first) ||
        typeof second !== "number" ||
        !Number.isFinite(second) ||
        !overview?.data_signature
      ) {
        return;
      }
      const viewport = { min: Math.min(first, second), max: Math.max(first, second) };
      if (!timeCapacityRefinementWorthwhile(timeCapacityOverviewExtent(overview), viewport)) {
        cancelRefinement();
        setRefinedResult(null);
        return;
      }
      cancelRefinement();
      const requestAtSchedule = request;
      const requestIdentityAtSchedule = requestIdentity;
      const overviewAtSchedule = overview;
      const generation = refinementLifecycle.beginRequest(viewport);
      refinementTimerRef.current = window.setTimeout(() => {
        refinementTimerRef.current = null;
        const controller = new AbortController();
        refinementAbortRef.current = controller;
        void post<TimeCapacityRefinementResult>(
          `/api/analyses/${analysisId}/time-capacity/refine`,
          {
            spec: requestAtSchedule.spec,
            viewport_x_min: viewport.min,
            viewport_x_max: viewport.max,
            viewport_width: requestAtSchedule.viewportWidth,
            cycle_start: activeCycle,
            cycle_end: activeCycle,
            request_generation: generation,
          },
          { signal: controller.signal },
        )
          .then((response) => {
            if (
              requestIdentityRef.current === requestIdentityAtSchedule &&
              refinementLifecycle.acceptResponse(
                response,
                overviewAtSchedule,
                generation,
                viewport,
                requestAtSchedule.compatibilitySignature,
              )
            ) {
              setRefinedResult(response);
            }
          })
          .catch(() => {
            // Refinement is opportunistic; retain the valid overview on failure.
          });
      }, DETAIL_REFINEMENT_DELAY_MS);
    },
    [
      activeCycle,
      analysisId,
      cancelRefinement,
      overview,
      refinementLifecycle,
      request,
      requestIdentity,
    ],
  );

  const shownResult = refinedResult ?? overview;
  const renderSpec = useMemo(
    () => ({
      ...request.spec,
      selection: {
        ...request.spec.selection,
        exclusions: [...(spec.selection.exclusions ?? [])],
        hidden_replicate_group_ids: [
          ...(spec.selection.hidden_replicate_group_ids ?? []),
        ],
      },
      presentation: {
        ...request.spec.presentation,
        // The request is already narrowed to the points the user selected.
        // A saved Time/Capacity series toggle must not silently suppress those
        // member curves inside this independent Cycles inspector.
        hidden_series_ids: [],
      },
    }),
    [request.spec, spec.selection.exclusions, spec.selection.hidden_replicate_group_ids],
  );
  const traces = useMemo(
    () => detailTraces(shownResult, request, renderSpec, yQuantity),
    [renderSpec, request, shownResult, yQuantity],
  );
  const xOptions = useMemo(() => availableXOptions(overview, spec), [overview, spec]);
  const yOptions = useMemo(() => availableYOptions(overview, spec), [overview, spec]);
  useEffect(() => {
    if (!xOptions.some((option) => option.value === xQuantity)) setXQuantity("time");
  }, [xOptions, xQuantity]);
  useEffect(() => {
    if (!yOptions.some((option) => option.value === yQuantity)) setYQuantity("voltage");
  }, [yOptions, yQuantity]);

  const detailStyle = useMemo(() => {
    const base = currentPlotStyle(spec, "time_capacity");
    return {
      ...base,
      x_title: null,
      y_title: null,
      x_axis: { ...base.x_axis, mode: "auto" as const },
      y_axis: { ...base.y_axis, mode: "auto" as const },
      legend_mode: "inside" as const,
      legend_inside_position: "top_right" as const,
    };
  }, [spec]);
  const layoutSpec = useMemo(
    () => ({
      ...request.spec,
      presentation: { ...request.spec.presentation, legend: traces.length > 1 },
    }),
    [request.spec, traces.length],
  );
  const layout = useMemo(
    () =>
      simpleCartesianLayout(detailStyle, layoutSpec, {
        traces,
        xTitle: detailXLabel(xQuantity, request.spec),
        yTitle: detailYLabel(yQuantity, shownResult),
        baseMargin: { l: 64, r: 18, t: 12, b: 48 },
        extra: {
          height: 250,
          autosize: true,
          uirevision: requestIdentity,
          hovermode: "closest",
        },
      }),
    [detailStyle, layoutSpec, request.spec, requestIdentity, shownResult, traces, xQuantity, yQuantity],
  );
  const plotConfig = useMemo(
    () => ({ displaylogo: false, responsive: true, displayModeBar: false }),
    [],
  );
  const previousCycle = cyclePointAdjacentCycle(records, activeCycle, -1);
  const nextCycle = cyclePointAdjacentCycle(records, activeCycle, 1);

  return (
    <Stack gap="xs" mt="xs">
      <Group gap="xs" grow align="end">
        <Select
          size="xs"
          label="X quantity"
          data={xOptions}
          value={xQuantity}
          allowDeselect={false}
          onChange={(value) => value && setXQuantity(value as CyclePointDetailXQuantity)}
        />
        <Select
          size="xs"
          label="Y quantity"
          data={yOptions}
          value={yQuantity}
          allowDeselect={false}
          onChange={(value) => value && setYQuantity(value as CyclePointDetailYQuantity)}
        />
      </Group>
      <Group justify="center" gap={6}>
        <Tooltip label="Previous selected cycle">
          <ActionIcon
            variant="default"
            size="sm"
            aria-label="Previous selected cycle"
            disabled={previousCycle === null}
            onClick={() => previousCycle !== null && setActiveCycle(previousCycle)}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
        </Tooltip>
        <Text size="xs" fw={600} miw={70} ta="center">
          Cycle {activeCycle}
        </Text>
        <Tooltip label="Next selected cycle">
          <ActionIcon
            variant="default"
            size="sm"
            aria-label="Next selected cycle"
            disabled={nextCycle === null}
            onClick={() => nextCycle !== null && setActiveCycle(nextCycle)}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {detailQuery.isError && (
        <Alert color="red" py="xs">
          <Group justify="space-between" gap="xs">
            <Text size="xs">
              Cycle {activeCycle} detail could not be loaded
              {overview ? "; the previous curve is retained." : "."}
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconRefresh size={13} />}
              onClick={() => void detailQuery.refetch()}
            >
              Retry
            </Button>
          </Group>
        </Alert>
      )}
      {traces.length > 0 ? (
        <Box
          pos="relative"
          onPointerDownCapture={() => {
            refinementGestureArmedRef.current = true;
          }}
          style={{ opacity: detailQuery.isPlaceholderData ? 0.38 : 1 }}
        >
          <Plot
            data={traces}
            layout={layout}
            config={plotConfig}
            style={{ width: "100%", height: 250 }}
            onRelayout={handleRelayout}
          />
          {delayedLoading && (
            <Group
              gap={6}
              px="xs"
              py={4}
              style={{ position: "absolute", top: 6, left: 6, borderRadius: 6, background: "var(--mantine-color-body)" }}
            >
              <Loader size={12} />
              <Text size="xs">Loading cycle {activeCycle}…</Text>
            </Group>
          )}
        </Box>
      ) : delayedLoading ? (
        <Group justify="center" py="xl" gap="xs">
          <Loader size="sm" />
          <Text size="xs" c="dimmed">Loading cycle {activeCycle}…</Text>
        </Group>
      ) : (
        <Text size="xs" c="dimmed" ta="center" py="md">
          No detail data are available for this cycle and quantity.
        </Text>
      )}
    </Stack>
  );
}

export function CyclePointInspector({
  analysisId,
  records,
  anchorBounds,
  containerWidth,
  containerHeight,
  spec,
  cyclesResult,
  onClose,
}: {
  analysisId: number;
  records: CyclePointSelectionRecord[];
  anchorBounds: CyclePointOverlayBounds;
  containerWidth: number;
  containerHeight: number;
  spec: AnalysisSpec;
  cyclesResult: ComputeResult | undefined;
  onClose: () => void;
}) {
  const cycles = useMemo(() => cyclePointSelectedCycles(records), [records]);
  const [expanded, setExpanded] = useState(false);
  const [activeCycle, setActiveCycle] = useState(cycles[0]);
  useEffect(() => {
    if (!cycles.includes(activeCycle)) setActiveCycle(cycles[0]);
  }, [activeCycle, cycles]);
  const position = inspectorPosition(anchorBounds, containerWidth, containerHeight);
  const xLabel = "Cycle";
  const measurePresentation = cyclePointMeasurePresentation(records);

  return (
    <Paper
      data-cycle-point-inspector
      withBorder
      shadow="md"
      p="sm"
      style={{
        position: "absolute",
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: Math.max(180, containerHeight - position.top - 8),
        overflowX: "hidden",
        overflowY: "auto",
        zIndex: 5,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={650} size="sm">
              {records.length === 1 ? "Selected point" : "Selected points"}
            </Text>
            {records.length > 1 && <Badge size="sm" variant="light">{records.length}</Badge>}
          </Group>
          <Tooltip label="Close point inspector">
            <ActionIcon variant="subtle" size="sm" aria-label="Close point inspector" onClick={onClose}>
              <IconX size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <ScrollArea.Autosize mah={expanded ? 120 : 210} type="auto" offsetScrollbars>
          <Table striped={false} highlightOnHover stickyHeader verticalSpacing={5} horizontalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Sample</Table.Th>
                <Table.Th ta="right">Cycle</Table.Th>
                <Table.Th ta="right">{xLabel}</Table.Th>
                <Table.Th ta="right">{measurePresentation.yHeader}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {records.map((record) => {
                const active = expanded && record.scientificCycle === activeCycle;
                const sourceContext = [
                  record.sourceFilename,
                  record.localCycle !== null ? `local cycle ${record.localCycle}` : null,
                  record.sourcePosition !== null ? `source ${record.sourcePosition}` : null,
                ].filter(Boolean).join(" · ");
                return (
                  <Table.Tr
                    key={record.key}
                    tabIndex={expanded ? 0 : undefined}
                    onClick={() => expanded && setActiveCycle(record.scientificCycle)}
                    onKeyDown={(event) => {
                      if (expanded && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setActiveCycle(record.scientificCycle);
                      }
                    }}
                    style={{
                      cursor: expanded ? "pointer" : "default",
                      background: active ? "var(--mantine-primary-color-light)" : undefined,
                      fontWeight: active ? 650 : undefined,
                    }}
                  >
                    <Table.Td maw={170}>
                      <Tooltip label={sourceContext || record.sampleLabel} multiline maw={360}>
                        <Box>
                          <Text size="xs" fw={active ? 650 : 500} truncate="end" title={record.sampleLabel}>
                            {record.sampleLabel}
                          </Text>
                          {measurePresentation.showMeasurePerRow && (
                            <Text size="10px" c="dimmed" lh={1.25} mt={2}>
                              {record.quantityLabel}
                            </Text>
                          )}
                        </Box>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td ta="right"><Text size="xs" fw={active ? 650 : undefined}>{record.scientificCycle}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="xs" ff="monospace" fw={active ? 650 : undefined}>{formatSelectionNumber(record.displayedX)}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="xs" ff="monospace" fw={active ? 650 : undefined}>{formatSelectionNumber(record.displayedY)}</Text></Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
        <UnstyledButton
          aria-expanded={expanded}
          aria-controls="cycle-point-detail"
          onClick={() => setExpanded((open) => !open)}
          style={{ borderTop: "1px solid var(--mantine-color-default-border)", paddingTop: 8 }}
        >
          <Group justify="space-between">
            <Text size="sm" fw={600}>Cycle detail</Text>
            {expanded ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
          </Group>
        </UnstyledButton>
        <Collapse in={expanded}>
          <Box id="cycle-point-detail">
            {expanded && activeCycle !== undefined && (
              <CycleDetail
                analysisId={analysisId}
                records={records}
                activeCycle={activeCycle}
                setActiveCycle={setActiveCycle}
                spec={spec}
                cyclesResult={cyclesResult}
              />
            )}
          </Box>
        </Collapse>
      </Stack>
    </Paper>
  );
}
