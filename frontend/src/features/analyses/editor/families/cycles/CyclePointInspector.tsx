import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Paper,
  Portal,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { DEFAULT_PLOT_STYLE } from "../../plotting/plotStyle";
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
  cyclePointInspectorPosition,
  cyclePointDetailRequest,
  cyclePointMeasurePresentation,
  cyclePointSelectedCycles,
  cyclePointSelectedMarkerSize,
  type CyclePoint,
  type CyclePointDetailRequest,
  type CyclePointDetailXQuantity,
  type CyclePointDetailYQuantity,
  type CyclePointSelectionRecord,
  type CyclePointSelectionShape,
} from "./cyclePointSelectionPolicy";
import type { CyclePointOverlayBounds } from "./useCyclePointSelection";

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
      line: { ...(trace as Partial<Plotly.PlotData>).line, width: 1.8, dash: "solid" },
      opacity: 1,
    })) as Plotly.Data[];
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
  cursorPoint,
}: {
  completedShape: CyclePointSelectionShape | null;
  constructionVertices: CyclePoint[];
  dragPreview: { start: CyclePoint; end: CyclePoint } | null;
  halos: (CyclePointSelectionRecord & { screenX: number; screenY: number })[];
  cursorPoint: CyclePoint | null;
}) {
  const overlayRef = useRef<SVGSVGElement>(null);
  const [surface, setSurface] = useState({ width: 1, height: 1, scale: 1 });
  // Plotly's onUpdate need not fire for CSS zoom. Measure our actual surface,
  // not its last Plotly layout, before painting screen-space geometry.
  useLayoutEffect(() => {
    const svg = overlayRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const next = { width: rect.width, height: rect.height,
      scale: rect.height / (svg.clientHeight || rect.height) };
    setSurface((old) => old.width === next.width && old.height === next.height && old.scale === next.scale ? old : next);
  });
  const { width, height, scale } = surface;
  const completedPoints = completedShape ? shapePoints(completedShape) : [];
  const completedPolygon = completedPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const constructionPolyline = constructionVertices
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  return (
    <svg
      ref={overlayRef}
      aria-hidden="true"
      data-cycle-point-selection-overlay
      viewBox={`0 0 ${width || 1} ${height || 1}`}
      preserveAspectRatio="none"
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
      {cursorPoint && constructionVertices.length > 0 && (
        <polyline
          data-cycle-polygon-preview
          points={[constructionVertices[constructionVertices.length - 1], cursorPoint,
            ...(constructionVertices.length > 1 ? [constructionVertices[0]] : [])]
            .map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none" stroke="var(--mantine-primary-color-6)" strokeWidth={1.5}
          strokeDasharray="5 4" pointerEvents="none"
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
      {halos.map((point) => {
        const radius = cyclePointSelectedMarkerSize(point.markerSize ?? 0) * scale / 2;
        const symbol = point.markerSymbol ?? "circle";
        const base = symbol.replace("-open", "");
        const r = radius;
        const paths: Record<string, string> = {
          square: `M ${-r},${-r} H ${r} V ${r} H ${-r} Z`,
          diamond: `M 0,${-r * 1.3} L ${r * 1.3},0 0,${r * 1.3} ${-r * 1.3},0 Z`,
          "triangle-up": `M 0,${-r * 1.3} L ${r * 1.15},${r} ${-r * 1.15},${r} Z`,
          cross: `M ${-r},${-r / 3} H ${-r / 3} V ${-r} H ${r / 3} V ${-r / 3} H ${r} V ${r / 3} H ${r / 3} V ${r} H ${-r / 3} V ${r / 3} H ${-r} Z`,
        };
        return <g key={point.key} data-cycle-selected-marker
          transform={`translate(${point.screenX} ${point.screenY})`}
          fill={symbol.endsWith("-open") ? "none" : point.color ?? "#495057"}
          stroke="#495057" strokeWidth={1.2 * scale} strokeLinejoin="round">
          {base === "circle" ? <circle r={r} /> :
            <path d={paths[base === "x" ? "cross" : base] ?? paths.square}
              transform={base === "x" ? "rotate(45)" : undefined} />}
        </g>;
      })}
    </svg>
  );
}

function CycleDetail({
  analysisId,
  records,
  samplePrefix,
  activeCycle,
  setActiveCycle,
  spec,
  cyclesResult,
}: {
  analysisId: number;
  records: CyclePointSelectionRecord[];
  samplePrefix: string;
  activeCycle: number;
  setActiveCycle: (cycle: number) => void;
  spec: AnalysisSpec;
  cyclesResult: ComputeResult | undefined;
}) {
  const [xQuantity, setXQuantity] = useState<CyclePointDetailXQuantity>("time");
  const [yQuantity, setYQuantity] = useState<CyclePointDetailYQuantity>("voltage");
  const [shownCell, setShownCell] = useState("all");
  const capabilitiesRef = useRef<{ context: string; result: TimeCapacityResult } | null>(null);
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
  // Capability metadata survives coordinate changes, even when the old curve cannot
  // safely be reused under the new axis. A missing in-flight payload is not a denial.
  const capabilityContext = JSON.stringify(request.spec.selection.entries);
  if (overview && !detailQuery.isPlaceholderData) {
    capabilitiesRef.current = { context: capabilityContext, result: overview };
  }
  const capabilityResult = capabilitiesRef.current?.context === capabilityContext
    ? capabilitiesRef.current.result : undefined;

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
  const cellColors = useMemo(() => {
    const colors = new Map<number, string>();
    // Direct Cell identities take precedence over a group's shared color.
    for (const row of [...activeRecords].sort((a, b) =>
      Number(a.sampleKind === "cell") - Number(b.sampleKind === "cell"))) {
      for (const id of row.detailCellIds) colors.set(id, row.color ?? "#495057");
    }
    return colors;
  }, [activeRecords]);
  const detailStyle = useMemo(() => ({
    ...DEFAULT_PLOT_STYLE,
    custom_colors: Object.fromEntries([...cellColors].map(([id, color]) => [`c${id}`, color])),
    line_width: 1.8,
    individual_opacity: 1,
    show_grid: false,
    show_frame: true,
    frame_color: "#555555",
    tick_font_size: 11,
    axis_title_size: 13,
  }), [cellColors]);
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
        legend: false,
        plot_style: detailStyle,
        plot_styles: { time_capacity: detailStyle },
      },
    }),
    [request.spec, spec.selection.exclusions, spec.selection.hidden_replicate_group_ids, detailStyle],
  );
  const traces = useMemo(
    () => detailTraces(shownResult, request, renderSpec, yQuantity).filter((trace) => {
      const sample = (trace as unknown as { cellxplorer_analysis_sample?: { cell_id: number } }).cellxplorer_analysis_sample;
      return shownCell === "all" || sample?.cell_id === Number(shownCell);
    }),
    [renderSpec, request, shownResult, yQuantity, shownCell],
  );
  const members = useMemo(() => [...new Map((capabilityResult?.cell_traces ?? [])
    .map((trace) => [trace.cell_id, { id: trace.cell_id, label: trace.label }])).values()], [capabilityResult]);
  useEffect(() => {
    if (shownCell !== "all" && capabilityResult && !members.some((member) => String(member.id) === shownCell)) {
      setShownCell("all");
    }
  }, [capabilityResult, members, shownCell]);
  const xOptions = useMemo(() => availableXOptions(capabilityResult, spec), [capabilityResult, spec]);
  const yOptions = useMemo(() => availableYOptions(capabilityResult, spec), [capabilityResult, spec]);
  useEffect(() => {
    if (!overview || detailQuery.isFetching || detailQuery.isPlaceholderData) return;
    if (!xOptions.some((option) => option.value === xQuantity)) setXQuantity("time");
  }, [xOptions, xQuantity, overview, detailQuery.isFetching, detailQuery.isPlaceholderData]);
  useEffect(() => {
    if (!overview || detailQuery.isFetching || detailQuery.isPlaceholderData) return;
    if (!yOptions.some((option) => option.value === yQuantity)) setYQuantity("voltage");
  }, [yOptions, yQuantity, overview, detailQuery.isFetching, detailQuery.isPlaceholderData]);
  const layoutSpec = useMemo(
    () => ({
      ...request.spec,
      presentation: { ...request.spec.presentation, legend: false },
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
          classNames={{ dropdown: "cycle-point-inspector-dropdown" }}
          label="X quantity"
          data={xOptions}
          value={xQuantity}
          allowDeselect={false}
          onChange={(value) => value && setXQuantity(value as CyclePointDetailXQuantity)}
        />
        <Select
          size="xs"
          classNames={{ dropdown: "cycle-point-inspector-dropdown" }}
          label="Y quantity"
          data={yOptions}
          value={yQuantity}
          allowDeselect={false}
          onChange={(value) => value && setYQuantity(value as CyclePointDetailYQuantity)}
        />
      </Group>
      {members.length > 1 && <Select size="xs" label="Show"
        classNames={{ dropdown: "cycle-point-inspector-dropdown" }}
        data={[{ value: "all", label: "All selected samples" },
          ...members.map((member) => ({ value: String(member.id),
            label: member.label.startsWith(samplePrefix) ? member.label.slice(samplePrefix.length) : member.label }))]}
        value={shownCell} allowDeselect={false} onChange={(value) => value && setShownCell(value)} />}
      {activeRecords.some((record) => record.sampleKind === "replicate") && (
        <Group gap="xs" aria-label="Selected replicate members">
          {members.filter((member) => shownCell === "all" || String(member.id) === shownCell).map((member) =>
            <Group key={member.id} gap={5} wrap="nowrap" miw={0} maw="100%">
              <Box w={18} style={{ flexShrink: 0, borderTop: `2px solid ${cellColors.get(member.id) ?? "#495057"}` }} />
              <Text size="xs" truncate title={member.label}>{member.label}</Text>
            </Group>)}
        </Group>
      )}
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
      ) : detailQuery.isFetching ? (
        <Group justify="center" py="xl" gap="xs">
          {delayedLoading && <Loader size="sm" />}
          <Text size="xs" c="dimmed">Loading cycle {activeCycle}…</Text>
        </Group>
      ) : !detailQuery.isError ? (
        <Text size="xs" c="dimmed" ta="center" py="md">
          No detail data are available for this cycle and quantity.
        </Text>
      ) : null}
    </Stack>
  );
}

export function CyclePointInspector({
  analysisId,
  records,
  samplePrefix = "",
  anchorBounds,
  container,
  spec,
  cyclesResult,
  onClose,
}: {
  analysisId: number;
  records: CyclePointSelectionRecord[];
  samplePrefix?: string;
  anchorBounds: CyclePointOverlayBounds;
  container: HTMLElement;
  spec: AnalysisSpec;
  cyclesResult: ComputeResult | undefined;
  onClose: () => void;
}) {
  const cycles = useMemo(() => cyclePointSelectedCycles(records), [records]);
  const [activeCycle, setActiveCycle] = useState(cycles[0]);
  const [paperElement, setPaperElement] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState({ left: 0, top: 0, width: window.innerWidth,
    height: window.innerHeight, scale: 1, paperHeight: 550 });
  useLayoutEffect(() => {
    const sync = () => {
      const rect = container.getBoundingClientRect();
      const scale = rect.width / container.clientWidth || 1;
      const next = { left: rect.left, top: rect.top, width: window.innerWidth,
        height: window.innerHeight, scale, paperHeight: (paperElement?.scrollHeight ?? 550) * scale };
      setGeometry((old) => Object.keys(next).every((key) =>
        old[key as keyof typeof old] === next[key as keyof typeof next]) ? old : next);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    if (paperElement) observer.observe(paperElement);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true); };
  }, [container, paperElement]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (paperElement?.contains(target) || target.closest(".cycle-point-inspector-dropdown")) return;
      // The plot controller owns replacement gestures and Escape cancellation.
      if (event.ctrlKey && container.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [container, onClose, paperElement]);
  useEffect(() => {
    if (!cycles.includes(activeCycle)) setActiveCycle(cycles[0]);
  }, [activeCycle, cycles]);
  const markerPadding = records.reduce((largest, record) => Math.max(largest,
    cyclePointSelectedMarkerSize(record.markerSize ?? 0) * 0.65 + 0.6), 0) * geometry.scale;
  const position = cyclePointInspectorPosition({ left: anchorBounds.left + geometry.left - markerPadding,
    right: anchorBounds.right + geometry.left + markerPadding, top: anchorBounds.top + geometry.top - markerPadding,
    bottom: anchorBounds.bottom + geometry.top + markerPadding }, geometry.width, geometry.height,
    geometry.paperHeight, geometry.scale);
  const measurePresentation = cyclePointMeasurePresentation(records);

  return (
    <Portal>
    <Paper
      ref={setPaperElement}
      data-cycle-point-inspector
      withBorder
      shadow="md"
      p="sm"
      style={{
        position: position.outsideViewport ? "absolute" : "fixed",
        left: position.left,
        top: position.top + (position.outsideViewport ? window.scrollY : 0),
        width: position.width / geometry.scale,
        transform: `scale(${geometry.scale})`,
        transformOrigin: "top left",
        maxHeight: position.maxHeight / geometry.scale,
        overflowX: "hidden",
        overflowY: "auto",
        zIndex: 210,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" style={{ position: "sticky", top: -12,
          background: "var(--mantine-color-body)", zIndex: 5, paddingBlock: 4 }}>
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
        <Box>
          <Table striped={false} highlightOnHover verticalSpacing={5} horizontalSpacing={6}
            style={{ tableLayout: "fixed" }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="40%">
                  Sample
                  {samplePrefix && <Tooltip label={`Shared prefix: ${samplePrefix}`} multiline maw={360}>
                    <Text size="xs" c="dimmed" fw={400} truncate title={samplePrefix}>
                      ({samplePrefix}…)
                    </Text>
                  </Tooltip>}
                </Table.Th>
                <Table.Th ta="right" w="16%">Original cycle</Table.Th>
                <Table.Th ta="right" w="16%">Plotted cycle</Table.Th>
                <Table.Th ta="right" w="28%">{measurePresentation.yHeader}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {records.map((record) => {
                const active = record.scientificCycle === activeCycle;
                const sourceContext = [
                  record.sourceFilename,
                  record.localCycle !== null ? `local cycle ${record.localCycle}` : null,
                  record.sourcePosition !== null ? `source ${record.sourcePosition}` : null,
                ].filter(Boolean).join(" · ");
                return (
                  <Table.Tr
                    key={record.key}
                    tabIndex={0}
                    onClick={() => setActiveCycle(record.scientificCycle)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveCycle(record.scientificCycle);
                      }
                    }}
                    style={{
                      cursor: "pointer",
                      background: active ? "var(--mantine-primary-color-light)" : undefined,
                      fontWeight: active ? 650 : undefined,
                    }}
                  >
                    <Table.Td maw={170}>
                      <Tooltip label={sourceContext || record.sampleLabel} multiline maw={360}>
                        <Group gap={5} wrap="nowrap">
                          <Box w={18} style={{ flexShrink: 0, borderTop: `2px solid ${record.color ?? "#495057"}` }} />
                          <Box miw={0}>
                          <Text size="xs" fw={active ? 650 : 500} truncate="end" title={record.sampleLabel}>
                            {record.sampleLabel.startsWith(samplePrefix)
                              ? record.sampleLabel.slice(samplePrefix.length) : record.sampleLabel}
                          </Text>
                          {measurePresentation.showMeasurePerRow && (
                            <Text size="xs" c="dimmed" lh={1.25} mt={2}>
                              {record.quantityLabel}
                            </Text>
                          )}
                          </Box>
                        </Group>
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
        </Box>
        <Text size="sm" fw={600} style={{ borderTop: "1px solid var(--mantine-color-default-border)", paddingTop: 8 }}>
          Cycle detail
        </Text>
          <Box id="cycle-point-detail">
            {activeCycle !== undefined && (
              <CycleDetail
                analysisId={analysisId}
                records={records}
                samplePrefix={samplePrefix}
                activeCycle={activeCycle}
                setActiveCycle={setActiveCycle}
                spec={spec}
                cyclesResult={cyclesResult}
              />
            )}
          </Box>
      </Stack>
    </Paper>
    </Portal>
  );
}
