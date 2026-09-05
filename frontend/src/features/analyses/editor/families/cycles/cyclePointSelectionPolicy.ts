import type { AnalysisSpec, ComputeResult, SelectionEntry } from "../../../../../api";
import {
  timeCapacityCompatibilitySignature,
  timeCapacityDataSignature,
  timeCapacityScientificRequestSpec,
} from "../../policies/timeCapacityQueryPolicy.ts";

export const CYCLE_POINT_DRAG_THRESHOLD_PX = 6;
export const CYCLE_POINT_CLICK_RADIUS_PX = 10;
export const CYCLE_POINT_DETAIL_VIEWPORT_WIDTH = 1200;

export type CyclePoint = { x: number; y: number };

/** Remove redundant family context without reducing padded numeric IDs to their last digit. */
export function cyclePointSharedSamplePrefix(labels: readonly string[]): string {
  const distinct = [...new Set(labels)];
  if (distinct.length < 2) return "";
  let prefix = distinct[0];
  for (const label of distinct.slice(1)) {
    let length = 0;
    while (length < prefix.length && prefix[length] === label[length]) length += 1;
    prefix = prefix.slice(0, length);
  }
  const numericTail = prefix.match(/\d+$/)?.[0];
  if (numericTail) {
    const padding = numericTail.match(/^0*/)?.[0] ?? "";
    prefix = prefix.slice(0, -numericTail.length) + padding;
  }
  // Short generic prefixes save little, and an empty suffix would hide the sample's identity.
  if (prefix.length < 8 || distinct.some((label) => label.slice(prefix.length).trim().length === 0)) return "";
  return prefix;
}

export function cyclePointVisibleSampleLabels(traces: readonly CycleSelectableTraceLike[]): string[] {
  return [...new Set(traces.flatMap((trace) => {
    if (trace.visible === false || trace.visible === "legendonly") return [];
    const metadata = selectableMetadata(trace.meta);
    return metadata ? [metadata.sampleLabel] : [];
  }))];
}

/** Screen-pixel placement: use an unobstructed side before requiring scrolling. */
export function cyclePointInspectorPosition(
  anchor: { left: number; right: number; top: number; bottom: number },
  viewportWidth: number,
  viewportHeight: number,
  contentHeight: number,
  scale: number,
) {
  const padding = 8;
  const gap = 12;
  const width = Math.min(520 * scale, viewportWidth - padding * 2);
  const maxHeight = Math.min(viewportHeight * 0.7, viewportHeight - padding * 2);
  const height = Math.min(contentHeight, maxHeight);
  const slots = [
    { side: "right", left: anchor.right + gap, top: padding,
      width: viewportWidth - padding - anchor.right - gap, height: viewportHeight - padding * 2 },
    { side: "left", left: padding, top: padding,
      width: anchor.left - gap - padding, height: viewportHeight - padding * 2 },
    { side: "below", left: padding, top: anchor.bottom + gap,
      width: viewportWidth - padding * 2, height: viewportHeight - padding - anchor.bottom - gap },
    { side: "above", left: padding, top: padding,
      width: viewportWidth - padding * 2, height: anchor.top - gap - padding },
  ];
  const full = slots.find((slot) => slot.width >= width && slot.height >= height);
  // Prefer a readable width. Only narrow further when none of the four sides can hold it.
  const readable = slots.filter((slot) => slot.width >= Math.min(width, 320 * scale) && slot.height >= 100 * scale);
  const usable = readable.length ? readable : slots.filter((slot) => slot.width >= 100 * scale && slot.height >= 80 * scale);
  const slot = full ?? usable.sort((a, b) =>
    Math.min(b.width, width) * Math.min(b.height, height) -
    Math.min(a.width, width) * Math.min(a.height, height))[0];
  if (!slot) {
    // A selection occupying the whole viewport cannot coexist with the inspector there.
    // Place it after the selection in document space, so it remains reachable by scrolling.
    return { left: padding, top: Math.max(padding, anchor.bottom + gap), width,
      maxHeight, outsideViewport: true };
  }
  const actualWidth = Math.min(width, slot.width);
  const actualHeight = Math.min(height, slot.height);
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  return {
    left: slot.side === "right" ? slot.left : slot.side === "left"
      ? anchor.left - gap - actualWidth
      : clamp(anchor.left, padding, viewportWidth - padding - actualWidth),
    top: slot.side === "below" ? slot.top : slot.side === "above"
      ? anchor.top - gap - actualHeight
      : clamp(anchor.top - gap, padding, viewportHeight - padding - actualHeight),
    width: actualWidth,
    maxHeight: Math.min(maxHeight, slot.height),
    outsideViewport: false,
  };
}

export type CyclePointSelectionRecord = {
  key: string;
  seriesKey: string;
  sampleKind: "cell" | "replicate";
  cellId: number | null;
  groupId: number | null;
  sampleLabel: string;
  scientificCycle: number;
  localCycle: number | null;
  sourcePosition: number | null;
  sourceFilename: string | null;
  detailCellIds: number[];
  quantityKey: string;
  quantityLabel: string;
  axis: "y" | "y2";
  displayedX: number;
  displayedY: number;
  renderedSeriesOrder: number;
  color?: string;
  markerSize?: number;
  markerSymbol?: string;
};

export type CyclePointScreenCandidate = CyclePointSelectionRecord & {
  screenX: number;
  screenY: number;
};

export type CycleSelectableTraceMetadata = {
  version: 1;
  seriesKey: string;
  sampleKind: CyclePointSelectionRecord["sampleKind"];
  cellId: number | null;
  groupId: number | null;
  sampleLabel: string;
  scientificCycles: (number | null)[];
  localCycles?: (number | null)[];
  sourcePositions?: (number | null)[];
  sourceFilenames?: (string | null)[];
  detailCellIds?: number[][];
  quantityKey: string;
  quantityLabel: string;
  axis: CyclePointSelectionRecord["axis"];
};

export type CycleSelectableTraceMeta = {
  cellxplorerCycleSelection: CycleSelectableTraceMetadata;
};

export type CycleSelectableTraceLike = {
  x?: unknown;
  y?: unknown;
  meta?: unknown;
  visible?: unknown;
  mode?: unknown;
  line?: unknown;
  marker?: unknown;
};

export type CyclePointSelectionShape =
  | { kind: "rectangle"; start: CyclePoint; end: CyclePoint }
  | { kind: "polygon"; vertices: CyclePoint[] };

export type CyclePointDetailXQuantity =
  | "time"
  | "capacity_mah"
  | "capacity_mah_g"
  | "capacity_mah_cm2";

export type CyclePointDetailYQuantity =
  | "voltage"
  | "working_potential"
  | "counter_potential"
  | "current_ma"
  | "current_density"
  | "c_rate";

export type CyclePointDetailRequest = {
  spec: AnalysisSpec;
  compatibilitySignature: string;
  dataSignature: string;
  viewportWidth: number;
};

export type CyclePointMeasurePresentation = {
  yHeader: string;
  showMeasurePerRow: boolean;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function selectableMetadata(value: unknown): CycleSelectableTraceMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = (value as Partial<CycleSelectableTraceMeta>).cellxplorerCycleSelection;
  if (!metadata || metadata.version !== 1) return null;
  return metadata;
}

/** Keep live hit-test metadata out of exports and persisted plot artifacts. */
export function withoutCyclePointSelectionMetadata<T extends object>(
  traces: readonly T[],
): T[] {
  return traces.map((trace) => {
    const meta = (trace as { meta?: unknown }).meta;
    if (
      !meta ||
      typeof meta !== "object" ||
      Array.isArray(meta) ||
      !("cellxplorerCycleSelection" in meta)
    ) {
      return trace;
    }
    const {
      cellxplorerCycleSelection: _selectionMetadata,
      ...remainingMeta
    } = meta as Record<string, unknown>;
    const clean = { ...trace } as T & { meta?: unknown };
    if (Object.keys(remainingMeta).length > 0) clean.meta = remainingMeta;
    else delete clean.meta;
    return clean;
  });
}

export function cyclePointGestureIsRectangle(
  start: CyclePoint,
  end: CyclePoint,
  threshold = CYCLE_POINT_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= threshold;
}

export function cyclePointInRectangle(
  point: CyclePoint,
  start: CyclePoint,
  end: CyclePoint,
): boolean {
  const epsilon = 1e-7;
  return (
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon
  );
}

function cyclePointOnSegment(
  point: CyclePoint,
  start: CyclePoint,
  end: CyclePoint,
): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squaredLength = dx * dx + dy * dy;
  // Plotly rounds SVG coordinates to hundredths of a pixel. Match that visual
  // boundary without turning repeated (zero-length) edges into universal hits.
  const fraction = squaredLength === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / squaredLength));
  return Math.hypot(point.x - start.x - fraction * dx, point.y - start.y - fraction * dy) <= 0.01;
}

/** Modest emphasis, including markers for line-only traces. Never enlarge large markers. */
export function cyclePointSelectedMarkerSize(size: number): number {
  return size >= 8 ? size : Math.min(8, Math.max(5, size + 2));
}

/** Even/odd containment with an explicit inclusive boundary check. */
export function cyclePointInPolygon(point: CyclePoint, vertices: CyclePoint[]): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[previous];
    const b = vertices[index];
    if (cyclePointOnSegment(point, a, b)) return true;
    const crosses =
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function cyclePointSelectionKey(
  record: Omit<CyclePointSelectionRecord, "key" | "renderedSeriesOrder" | "displayedX" | "displayedY">,
): string {
  return [
    record.seriesKey,
    record.axis,
    record.quantityKey,
    record.scientificCycle,
    record.cellId ?? "group",
    record.groupId ?? "none",
    record.sourcePosition ?? "none",
    record.localCycle ?? "none",
  ].join("|");
}

/**
 * Project explicit selectable trace metadata to screen-space candidates.
 * Helper traces have no metadata and are therefore ineligible by construction.
 */
export function cyclePointCandidatesForTraces(
  traces: readonly CycleSelectableTraceLike[],
  project: (
    x: number,
    y: number,
    axis: CyclePointSelectionRecord["axis"],
  ) => CyclePoint | null,
): CyclePointScreenCandidate[] {
  const candidates: CyclePointScreenCandidate[] = [];
  traces.forEach((trace, renderedSeriesOrder) => {
    const line = trace.line as { color?: unknown } | undefined;
    const marker = trace.marker as { color?: unknown; size?: unknown; symbol?: unknown } | undefined;
    if (trace.visible === false || trace.visible === "legendonly") return;
    const metadata = selectableMetadata(trace.meta);
    if (!metadata || !Array.isArray(trace.x) || !Array.isArray(trace.y)) return;
    const count = Math.min(trace.x.length, trace.y.length, metadata.scientificCycles.length);
    for (let index = 0; index < count; index += 1) {
      const displayedX = finiteNumber(trace.x[index]);
      const displayedY = finiteNumber(trace.y[index]);
      const scientificCycle = finiteNumber(metadata.scientificCycles[index]);
      if (displayedX === null || displayedY === null || scientificCycle === null) continue;
      const screen = project(displayedX, displayedY, metadata.axis);
      if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) continue;
      const partial = {
        seriesKey: metadata.seriesKey,
        sampleKind: metadata.sampleKind,
        cellId: metadata.cellId,
        groupId: metadata.groupId,
        sampleLabel: metadata.sampleLabel,
        scientificCycle,
        localCycle: nullableFiniteNumber(metadata.localCycles?.[index]),
        sourcePosition: nullableFiniteNumber(metadata.sourcePositions?.[index]),
        sourceFilename:
          typeof metadata.sourceFilenames?.[index] === "string"
            ? metadata.sourceFilenames[index]
            : null,
        detailCellIds: [
          ...new Set(
            (metadata.detailCellIds?.[index] ??
              (metadata.cellId === null ? [] : [metadata.cellId]))
              .filter((cellId) => Number.isInteger(cellId) && cellId > 0),
          ),
        ],
        quantityKey: metadata.quantityKey,
        quantityLabel: metadata.quantityLabel,
        axis: metadata.axis,
      } satisfies Omit<
        CyclePointSelectionRecord,
        "key" | "renderedSeriesOrder" | "displayedX" | "displayedY"
      >;
      candidates.push({
        ...partial,
        key: cyclePointSelectionKey(partial),
        displayedX,
        displayedY,
        renderedSeriesOrder,
        color: String(marker?.color ?? line?.color ?? "#495057"),
        markerSize: String(trace.mode ?? "").includes("markers")
          ? Number(marker?.size ?? 5) : 0,
        markerSymbol: String(marker?.symbol ?? "circle"),
        screenX: screen.x,
        screenY: screen.y,
      });
    }
  });
  return cyclePointDeduplicate(candidates);
}

export function cyclePointDeduplicate<T extends CyclePointSelectionRecord>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.key)) return false;
    seen.add(record.key);
    return true;
  });
}

function nearestCyclePoint(
  candidates: readonly CyclePointScreenCandidate[],
  vertex: CyclePoint,
  hitRadius: number,
): CyclePointScreenCandidate | null {
  let best: CyclePointScreenCandidate | null = null;
  let bestDistance = hitRadius;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.screenX - vertex.x, candidate.screenY - vertex.y);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best === null) ||
      (distance === bestDistance &&
        best !== null &&
        candidate.renderedSeriesOrder < best.renderedSeriesOrder)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function cyclePointRecordsForShape(
  candidates: readonly CyclePointScreenCandidate[],
  shape: CyclePointSelectionShape,
  hitRadius = CYCLE_POINT_CLICK_RADIUS_PX,
): CyclePointSelectionRecord[] {
  let selected: CyclePointScreenCandidate[];
  if (shape.kind === "rectangle") {
    selected = candidates.filter((candidate) =>
      cyclePointInRectangle(
        { x: candidate.screenX, y: candidate.screenY },
        shape.start,
        shape.end,
      ),
    );
  } else if (shape.vertices.length >= 3) {
    selected = candidates.filter((candidate) =>
      cyclePointInPolygon(
        { x: candidate.screenX, y: candidate.screenY },
        shape.vertices,
      ),
    );
  } else {
    selected = shape.vertices
      .map((vertex) => nearestCyclePoint(candidates, vertex, hitRadius))
      .filter((candidate): candidate is CyclePointScreenCandidate => candidate !== null);
  }
  return cyclePointSortRecords(cyclePointDeduplicate(selected)).map(
    ({ screenX: _screenX, screenY: _screenY, ...record }) => record,
  );
}

export function cyclePointSortRecords<T extends CyclePointSelectionRecord>(records: T[]): T[] {
  return [...records].sort(
    (a, b) =>
      a.scientificCycle - b.scientificCycle ||
      a.renderedSeriesOrder - b.renderedSeriesOrder ||
      a.seriesKey.localeCompare(b.seriesKey) ||
      a.axis.localeCompare(b.axis),
  );
}

export function cyclePointMeasurePresentation(
  records: readonly CyclePointSelectionRecord[],
): CyclePointMeasurePresentation {
  const labels = [...new Set(records.map((record) => record.quantityLabel))];
  return {
    yHeader: labels.length === 1 ? labels[0] : "Y value",
    showMeasurePerRow: labels.length > 1,
  };
}

export function cyclePointSelectedCycles(
  records: readonly CyclePointSelectionRecord[],
): number[] {
  return [...new Set(records.map((record) => record.scientificCycle))].sort((a, b) => a - b);
}

export function cyclePointAdjacentCycle(
  records: readonly CyclePointSelectionRecord[],
  activeCycle: number,
  direction: -1 | 1,
): number | null {
  const cycles = cyclePointSelectedCycles(records);
  const index = cycles.indexOf(activeCycle);
  const target = index + direction;
  return index >= 0 && target >= 0 && target < cycles.length ? cycles[target] : null;
}

export function cyclePointCullRecords(
  records: readonly CyclePointSelectionRecord[],
  eligibleKeys: ReadonlySet<string>,
): CyclePointSelectionRecord[] {
  return records.filter((record) => eligibleKeys.has(record.key));
}

function groupMemberIds(result: ComputeResult | undefined, groupId: number): Set<number> {
  return new Set(
    result?.cell_series
      .filter((series) => series.group_id === groupId)
      .map((series) => series.cell_id) ?? [],
  );
}

/** Narrow selected rows to unique analysis entries, avoiding direct Cell/group duplicates. */
export function cyclePointDetailSelectionEntries(
  records: readonly CyclePointSelectionRecord[],
  result?: ComputeResult,
): SelectionEntry[] {
  const unresolvedGroups = new Set<number>();
  const exactCellIds = new Set<number>();
  for (const record of records) {
    if (record.detailCellIds.length > 0) {
      for (const cellId of record.detailCellIds) exactCellIds.add(cellId);
    } else if (record.sampleKind === "replicate" && record.groupId !== null) {
      // Retain a safe fallback for older/injected trace metadata. Traces built
      // by Spec 056 publish exact per-point contributors and take the Cell path.
      unresolvedGroups.add(record.groupId);
    } else if (record.cellId !== null) {
      exactCellIds.add(record.cellId);
    }
  }
  const cellsCoveredByGroups = new Set<number>();
  for (const groupId of unresolvedGroups) {
    for (const cellId of groupMemberIds(result, groupId)) cellsCoveredByGroups.add(cellId);
  }
  const entries: SelectionEntry[] = [...unresolvedGroups]
    .sort((a, b) => a - b)
    .map((ref_id) => ({ kind: "replicate_group", ref_id }));
  entries.push(
    ...[...exactCellIds]
      .filter((cellId) => !cellsCoveredByGroups.has(cellId))
      .sort((a, b) => a - b)
      .map((ref_id) => ({ kind: "cell" as const, ref_id })),
  );
  return entries;
}

export function cyclePointDetailRequest(
  liveSpec: AnalysisSpec,
  records: readonly CyclePointSelectionRecord[],
  activeCycle: number,
  xQuantity: CyclePointDetailXQuantity,
  yQuantity: CyclePointDetailYQuantity,
  result?: ComputeResult,
): CyclePointDetailRequest {
  const liveConfig = liveSpec.computation.time_capacity;
  const voltageChannel =
    yQuantity === "working_potential" || yQuantity === "counter_potential"
      ? yQuantity
      : "voltage";
  const currentQuantity =
    yQuantity === "current_density" || yQuantity === "c_rate" ? yQuantity : "current_ma";
  const narrowed: AnalysisSpec = {
    ...liveSpec,
    selection: {
      ...liveSpec.selection,
      entries: cyclePointDetailSelectionEntries(records, result),
      exclusions: [...(liveSpec.selection.exclusions ?? [])],
      hidden_replicate_group_ids: [
        ...(liveSpec.selection.hidden_replicate_group_ids ?? []),
      ],
    },
    computation: {
      ...liveSpec.computation,
      time_capacity: {
        x_axis: xQuantity,
        time_unit: liveConfig?.time_unit ?? "min",
        display_mode: "consecutive",
        stacked:
          yQuantity === "current_ma" ||
          yQuantity === "current_density" ||
          yQuantity === "c_rate",
        current_left: currentQuantity,
        current_right: "none",
        electrode_area_cm2: liveConfig?.electrode_area_cm2 ?? null,
        view: "voltage_current",
        derivative_phase: liveConfig?.derivative_phase ?? "both",
        derivative_specific: liveConfig?.derivative_specific ?? false,
        derivative_absolute_discharge: liveConfig?.derivative_absolute_discharge ?? true,
        smoothing_window: liveConfig?.smoothing_window ?? 7,
        cycle_start: activeCycle,
        cycle_end: activeCycle,
        // A one-cycle contiguous range preserves the exact selected global
        // cycle while remaining compatible with the existing refinement API,
        // which deliberately rejects sparse `cycles` lists.
        cycles: [],
        max_points_per_cell: liveConfig?.max_points_per_cell ?? 4000,
        voltage_channel: voltageChannel,
        voltage_channels: [voltageChannel],
      },
    },
  };
  const spec = timeCapacityScientificRequestSpec(narrowed);
  const config = spec.computation.time_capacity!;
  const viewportWidth = CYCLE_POINT_DETAIL_VIEWPORT_WIDTH;
  return {
    spec,
    compatibilitySignature: timeCapacityCompatibilitySignature(spec, config, viewportWidth),
    dataSignature: timeCapacityDataSignature(spec, config, viewportWidth),
    viewportWidth,
  };
}
