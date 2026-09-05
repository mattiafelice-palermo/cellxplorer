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
  cyclePointPreviewShape,
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
  cursorPoint: CyclePoint | null;
  suppressHover: boolean;
  dragPreview: { start: CyclePoint; end: CyclePoint } | null;
  halos: CyclePointScreenCandidate[];
  anchorBounds: CyclePointOverlayBounds | null;
  clear: () => void;
  refresh: () => void;
  invalidateGeometry: () => void;
  onOutsidePointerDown: (event: PointerEvent) => void;
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
  const [cursorPoint, setCursorPoint] = useState<CyclePoint | null>(null);
  const [suppressHover, setSuppressHover] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ start: CyclePoint; end: CyclePoint } | null>(null);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const activePointerRef = useRef<ActivePointer | null>(null);
  const plainPointerRef = useRef<{ pointerId: number; start: CyclePoint; dragged: boolean } | null>(null);
  const constructionVerticesRef = useRef<CyclePoint[]>([]);
  const lastAnchorBoundsRef = useRef<CyclePointOverlayBounds | null>(null);

  const writeConstructionVertices = useCallback((vertices: CyclePoint[]) => {
    constructionVerticesRef.current = vertices;
    setConstructionVertices(vertices);
  }, []);

  const cancelConstruction = useCallback(() => {
    plainPointerRef.current = null;
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
    setCursorPoint(null);
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

  const onOutsidePointerDown = useCallback((event: PointerEvent) => {
    const container = containerRef.current;
    const plotArea = graphDivRef.current ? plotAreaElement(graphDivRef.current) : null;
    if (event.ctrlKey && event.button === 0 && container && plotArea &&
      pointInClientRect(event.clientX, event.clientY, plotArea.getBoundingClientRect())) {
      const hit = cyclePointRecordsForShape(candidates(), {
        kind: "polygon", vertices: [localPoint(event, container)],
      })[0];
      if (hit && records.some((record) => record.key === hit.key)) return;
      // Dismiss the old result without discarding vertices already collected for
      // its replacement. This runs before the new pointer-down capture handler.
      lastAnchorBoundsRef.current = null;
      setRecords([]);
      setCompletedShape(null);
      return;
    }
    clear();
  }, [candidates, clear, containerRef, graphDivRef, records]);

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

  const pointGestureTarget = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (event.button !== 0) return false;
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
      plainPointerRef.current = null;
      if (!pointGestureTarget(event)) return;
      const container = containerRef.current;
      if (!container) return;
      if (!event.ctrlKey) {
        if (!event.shiftKey && !event.altKey && !event.metaKey) {
          plainPointerRef.current = { pointerId: event.pointerId, start: localPoint(event, container), dragged: false };
        }
        // Let Plotly own ordinary drags, double-click reset, and pointer capture.
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSuppressHover(true);
      const point = localPoint(event, container);
      setCursorPoint(point);
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
    [containerRef, pointGestureTarget],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = activePointerRef.current;
      const container = containerRef.current;
      if (!active && container && event.ctrlKey && constructionVerticesRef.current.length > 0) {
        setCursorPoint(localPoint(event, container));
        return;
      }
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
      if (dragging && !active.dragging) {
        setRecords([]);
        setCompletedShape(null);
      }
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
        cancelConstruction();
        return;
      }
      if (active.dragging || cyclePointGestureIsRectangle(active.start, end)) {
        commit({ kind: "rectangle", start: active.start, end });
        return;
      }
      writeConstructionVertices([...constructionVerticesRef.current, end]);
      setCursorPoint(end);
    },
    [cancelConstruction, commit, containerRef, writeConstructionVertices],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (plainPointerRef.current?.pointerId === event.pointerId) plainPointerRef.current = null;
      if (activePointerRef.current?.pointerId !== event.pointerId) return;
      cancelConstruction();
    },
    [cancelConstruction],
  );

  useEffect(() => {
    // Plotly places its drag cover outside this React subtree after mouse-down.
    // Observe the release at window capture without taking ownership of the drag.
    const onMove = (event: PointerEvent) => {
      const plain = plainPointerRef.current;
      const container = containerRef.current;
      if (plain && plain.pointerId === event.pointerId && container) {
        plain.dragged ||= cyclePointGestureIsRectangle(plain.start, localPoint(event, container));
      }
    };
    const onUp = (event: PointerEvent) => {
      const plain = plainPointerRef.current;
      if (!plain || plain.pointerId !== event.pointerId) return;
      plainPointerRef.current = null;
      const container = containerRef.current;
      if (!container || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || plain.dragged) return;
      const end = localPoint(event, container);
      if (cyclePointGestureIsRectangle(plain.start, end)) return;
      const shape: CyclePointSelectionShape = { kind: "polygon", vertices: [end] };
      if (cyclePointRecordsForShape(candidates(), shape).length > 0) commit(shape);
    };
    const onCancel = () => { plainPointerRef.current = null; };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
  }, [candidates, commit, containerRef]);

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") return;
      setSuppressHover(false);
      if (activePointerRef.current) {
        cancelConstruction();
        return;
      }
      const vertices = constructionVerticesRef.current;
      if (vertices.length > 0) commit({ kind: "polygon", vertices });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") setSuppressHover(true);
      if (event.key !== "Escape") return;
      if (activePointerRef.current || constructionVerticesRef.current.length > 0) {
        cancelConstruction();
      } else {
        clear();
      }
    };
    const onBlur = () => { cancelConstruction(); setSuppressHover(false); };
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

  const screenCandidates = useMemo(() => {
    void overlayRevision;
    return candidates();
  }, [candidates, overlayRevision]);
  const committedHalos = useMemo(() => {
    const selectedKeys = new Set(records.map((record) => record.key));
    return screenCandidates.filter((candidate) => selectedKeys.has(candidate.key));
  }, [screenCandidates, records]);
  const halos = useMemo(() => {
    const previewShape = cyclePointPreviewShape(dragPreview, constructionVertices, cursorPoint);
    if (!previewShape) return committedHalos;
    const previewKeys = new Set(
      cyclePointRecordsForShape(screenCandidates, previewShape).map((record) => record.key),
    );
    return screenCandidates.filter((candidate) => previewKeys.has(candidate.key));
  }, [committedHalos, constructionVertices, cursorPoint, dragPreview, screenCandidates]);
  // A provisional highlight must not move an existing inspector or load detail.
  const liveAnchorBounds = candidateBounds(committedHalos) ?? shapeBounds(completedShape);
  if (liveAnchorBounds) lastAnchorBoundsRef.current = liveAnchorBounds;
  const anchorBounds =
    liveAnchorBounds ?? (records.length > 0 ? lastAnchorBoundsRef.current : null);

  return {
    records,
    completedShape,
    constructionVertices,
    cursorPoint,
    suppressHover,
    dragPreview,
    halos,
    anchorBounds,
    clear,
    refresh,
    invalidateGeometry,
    onOutsidePointerDown,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}
