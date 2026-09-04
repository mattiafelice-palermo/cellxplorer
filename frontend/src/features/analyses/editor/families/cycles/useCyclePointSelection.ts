import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  cyclePointCandidatesForTraces,
  cyclePointCullRecords,
  cyclePointGestureIsRectangle,
  cyclePointRecordsForShape,
  type CyclePoint,
  type CyclePointScreenCandidate,
  type CyclePointSelectionRecord,
  type CyclePointSelectionShape,
  type CycleSelectableTraceLike,
} from "./cyclePointSelectionPolicy";

type PlotlyAxis = {
  range?: unknown[];
  type?: string;
};

type PlotlySelectionLayout = {
  xaxis?: PlotlyAxis;
  yaxis?: PlotlyAxis;
  yaxis2?: PlotlyAxis;
};

type PlotlySelectionGraphDiv = HTMLElement & {
  _fullLayout?: PlotlySelectionLayout;
};

type ActivePointer = {
  pointerId: number;
  captureTarget: HTMLElement;
  start: CyclePoint;
  current: CyclePoint;
  dragging: boolean;
};

export type CyclePointOverlayBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type CyclePointSelectionController = {
  records: CyclePointSelectionRecord[];
  completedShape: CyclePointSelectionShape | null;
  constructionVertices: CyclePoint[];
  dragPreview: { start: CyclePoint; end: CyclePoint } | null;
  halos: CyclePointScreenCandidate[];
  anchorBounds: CyclePointOverlayBounds | null;
  clear: () => void;
  refresh: () => void;
  invalidateGeometry: () => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancelCapture: (event: ReactPointerEvent<HTMLElement>) => void;
};

function localPoint(event: { clientX: number; clientY: number }, container: HTMLElement): CyclePoint {
  const rect = container.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function plotAreaElement(graphDiv: HTMLElement): HTMLElement | null {
  return graphDiv.querySelector<HTMLElement>(".nsewdrag");
}

function finiteRange(axis: PlotlyAxis | undefined): [number, number] | null {
  const first = axis?.range?.[0];
  const second = axis?.range?.[1];
  return typeof first === "number" &&
    Number.isFinite(first) &&
    typeof second === "number" &&
    Number.isFinite(second) &&
    first !== second
    ? [first, second]
    : null;
}

function axisValue(value: number, axis: PlotlyAxis | undefined): number | null {
  if (axis?.type !== "log") return value;
  return value > 0 ? Math.log10(value) : null;
}

function pointInClientRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function shapeBounds(shape: CyclePointSelectionShape | null): CyclePointOverlayBounds | null {
  if (!shape) return null;
  const points = shape.kind === "rectangle" ? [shape.start, shape.end] : shape.vertices;
  if (points.length === 0) return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function candidateBounds(candidates: CyclePointScreenCandidate[]): CyclePointOverlayBounds | null {
  if (candidates.length === 0) return null;
  return {
    left: Math.min(...candidates.map((candidate) => candidate.screenX)),
    right: Math.max(...candidates.map((candidate) => candidate.screenX)),
    top: Math.min(...candidates.map((candidate) => candidate.screenY)),
    bottom: Math.max(...candidates.map((candidate) => candidate.screenY)),
  };
}

export function useCyclePointSelection({
  traces,
  graphDivRef,
  containerRef,
  selectionIdentity,
}: {
  traces: readonly CycleSelectableTraceLike[];
  graphDivRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  selectionIdentity: string;
}): CyclePointSelectionController {
  const [records, setRecords] = useState<CyclePointSelectionRecord[]>([]);
  const [completedShape, setCompletedShape] = useState<CyclePointSelectionShape | null>(null);
  const [constructionVertices, setConstructionVertices] = useState<CyclePoint[]>([]);
  const [dragPreview, setDragPreview] = useState<{ start: CyclePoint; end: CyclePoint } | null>(null);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const activePointerRef = useRef<ActivePointer | null>(null);
  const constructionVerticesRef = useRef<CyclePoint[]>([]);
  const lastAnchorBoundsRef = useRef<CyclePointOverlayBounds | null>(null);

  const writeConstructionVertices = useCallback((vertices: CyclePoint[]) => {
    constructionVerticesRef.current = vertices;
    setConstructionVertices(vertices);
  }, []);

  const cancelConstruction = useCallback(() => {
    const active = activePointerRef.current;
    if (active) {
      try {
        active.captureTarget.releasePointerCapture(active.pointerId);
      } catch {
        // Capture may already have ended because the pointer left the window.
      }
    }
    activePointerRef.current = null;
    setDragPreview(null);
    writeConstructionVertices([]);
  }, [writeConstructionVertices]);

  const clear = useCallback(() => {
    cancelConstruction();
    lastAnchorBoundsRef.current = null;
    setRecords([]);
    setCompletedShape(null);
  }, [cancelConstruction]);

  const refresh = useCallback(() => {
    setOverlayRevision((revision) => revision + 1);
  }, []);

  const invalidateGeometry = useCallback(() => {
    // Screen-space outlines cannot be truthfully transformed after Plotly
    // relayout. Clear the outline, records, halos, and inspector together
    // rather than leaving a partially represented active selection.
    clear();
  }, [clear]);

  const candidates = useCallback((): CyclePointScreenCandidate[] => {
    const graphDiv = graphDivRef.current as PlotlySelectionGraphDiv | null;
    const container = containerRef.current;
    const plotArea = graphDiv ? plotAreaElement(graphDiv) : null;
    const layout = graphDiv?._fullLayout;
    if (!graphDiv || !container || !plotArea || !layout) return [];
    const plotRect = plotArea.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const xRange = finiteRange(layout.xaxis);
    if (!xRange || plotRect.width <= 0 || plotRect.height <= 0) return [];
    return cyclePointCandidatesForTraces(traces, (x, y, axisName) => {
      const yAxis = axisName === "y2" ? layout.yaxis2 : layout.yaxis;
      const yRange = finiteRange(yAxis);
      const normalizedX = axisValue(x, layout.xaxis);
      const normalizedY = axisValue(y, yAxis);
      if (!yRange || normalizedX === null || normalizedY === null) return null;
      const xFraction = (normalizedX - xRange[0]) / (xRange[1] - xRange[0]);
      const yFraction = (normalizedY - yRange[0]) / (yRange[1] - yRange[0]);
      if (xFraction < 0 || xFraction > 1 || yFraction < 0 || yFraction > 1) return null;
      return {
        x: plotRect.left - containerRect.left + xFraction * plotRect.width,
        y: plotRect.bottom - containerRect.top - yFraction * plotRect.height,
      };
    });
  }, [containerRef, graphDivRef, traces]);

  const commit = useCallback(
    (shape: CyclePointSelectionShape) => {
      const screenCandidates = candidates();
      const selected = cyclePointRecordsForShape(screenCandidates, shape);
      const selectedKeys = new Set(selected.map((record) => record.key));
      lastAnchorBoundsRef.current = candidateBounds(
        screenCandidates.filter((candidate) => selectedKeys.has(candidate.key)),
      );
      setRecords(selected);
      setCompletedShape(selected.length > 0 ? shape : null);
      cancelConstruction();
      refresh();
    },
    [cancelConstruction, candidates, refresh],
  );

  const modifiedGestureTarget = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (!event.ctrlKey || event.button !== 0) return false;
      if ((event.target as HTMLElement).closest("[data-cycle-point-inspector]")) return false;
      const graphDiv = graphDivRef.current;
      const plotArea = graphDiv ? plotAreaElement(graphDiv) : null;
      return Boolean(
        plotArea && pointInClientRect(event.clientX, event.clientY, plotArea.getBoundingClientRect()),
      );
    },
    [graphDivRef],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!modifiedGestureTarget(event)) return;
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();
      event.stopPropagation();
      const point = localPoint(event, container);
      activePointerRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        start: point,
        current: point,
        dragging: false,
      };
      setDragPreview(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The window-level cancellation handlers still keep state coherent.
      }
    },
    [containerRef, modifiedGestureTarget],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = activePointerRef.current;
      const container = containerRef.current;
      if (!active || active.pointerId !== event.pointerId || !container) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.ctrlKey) {
        cancelConstruction();
        return;
      }
      const current = localPoint(event, container);
      const dragging = active.dragging || cyclePointGestureIsRectangle(active.start, current);
      activePointerRef.current = { ...active, current, dragging };
      if (dragging && !active.dragging && constructionVerticesRef.current.length > 0) {
        writeConstructionVertices([]);
      }
      setDragPreview(
        dragging ? { start: active.start, end: current } : null,
      );
    },
    [cancelConstruction, containerRef, writeConstructionVertices],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = activePointerRef.current;
      const container = containerRef.current;
      if (!active || active.pointerId !== event.pointerId || !container) return;
      event.preventDefault();
      event.stopPropagation();
      const end = localPoint(event, container);
      activePointerRef.current = null;
      setDragPreview(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // A browser may already have released capture after leaving the window.
      }
      if (!event.ctrlKey) {
        writeConstructionVertices([]);
        return;
      }
      if (active.dragging || cyclePointGestureIsRectangle(active.start, end)) {
        commit({ kind: "rectangle", start: active.start, end });
        return;
      }
      writeConstructionVertices([...constructionVerticesRef.current, end]);
    },
    [commit, containerRef, writeConstructionVertices],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (activePointerRef.current?.pointerId !== event.pointerId) return;
      cancelConstruction();
    },
    [cancelConstruction],
  );

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") return;
      if (activePointerRef.current) {
        cancelConstruction();
        return;
      }
      const vertices = constructionVerticesRef.current;
      if (vertices.length > 0) commit({ kind: "polygon", vertices });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activePointerRef.current || constructionVerticesRef.current.length > 0) {
        cancelConstruction();
      } else {
        clear();
      }
    };
    const onBlur = () => cancelConstruction();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelConstruction();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cancelConstruction, clear, commit]);

  useEffect(() => {
    clear();
  }, [clear, selectionIdentity]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const eligibleKeys = new Set(candidates().map((candidate) => candidate.key));
      setRecords((current) => {
        const next = cyclePointCullRecords(current, eligibleKeys);
        return next.length === current.length && next.every((record, index) => record === current[index])
          ? current
          : next;
      });
      refresh();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [candidates, refresh, traces]);

  useEffect(() => {
    if (records.length === 0) setCompletedShape(null);
  }, [records.length]);

  const halos = useMemo(() => {
    void overlayRevision;
    const selectedKeys = new Set(records.map((record) => record.key));
    return candidates().filter((candidate) => selectedKeys.has(candidate.key));
  }, [candidates, overlayRevision, records]);
  const liveAnchorBounds = candidateBounds(halos) ?? shapeBounds(completedShape);
  if (liveAnchorBounds) lastAnchorBoundsRef.current = liveAnchorBounds;
  const anchorBounds =
    liveAnchorBounds ?? (records.length > 0 ? lastAnchorBoundsRef.current : null);

  return {
    records,
    completedShape,
    constructionVertices,
    dragPreview,
    halos,
    anchorBounds,
    clear,
    refresh,
    invalidateGeometry,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}
