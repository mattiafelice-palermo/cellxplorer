import Plotly from "plotly.js-dist-min";
import {
  panPlotRange,
  plotWheelMode,
  PLOT_WHEEL_GESTURE_GAP_MS,
  zoomPlotRange,
  type NumericPlotRange,
  type PlotWheelMode,
} from "./plotNavigationPolicy";

type PlotlyRuntimeAxis = {
  _length?: number;
  _offset?: number;
  fixedrange?: boolean;
  matches?: string | false;
  overlaying?: string | false;
  range?: unknown[];
};

type PlotlyRuntimeLayout = Record<string, unknown> & {
  height?: number;
  width?: number;
};

type PlotlyNavigationGraphDiv = HTMLElement & {
  _fullLayout?: PlotlyRuntimeLayout;
};

type AxisDirection = "x" | "y";

type ResolvedAxis = {
  key: string;
  range: NumericPlotRange;
  screenLength: number;
  screenStart: number;
};

type NavigationState = {
  graphDiv: HTMLElement;
  onViewportIntent?: () => void;
  wheelMode: PlotWheelMode | null;
  wheelModeAt: number;
  virtualRanges: Map<string, NumericPlotRange>;
  virtualRangeTimer: number | null;
  frame: number | null;
  pendingPatch: Record<string, NumericPlotRange>;
  drag: {
    pointerId: number;
    startX: number;
    startY: number;
    xAxis: ResolvedAxis | null;
    yAxis: ResolvedAxis | null;
    previousCursor: string;
  } | null;
  onWheel: (event: WheelEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
};

const navigationStates = new WeakMap<HTMLElement, NavigationState>();
const DOM_DELTA_PIXEL = 0;

function numericRange(value: unknown): NumericPlotRange | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const first = Number(value[0]);
  const second = Number(value[1]);
  return Number.isFinite(first) && Number.isFinite(second) && first !== second
    ? [first, second]
    : null;
}

function axisLayoutKey(axisId: string): string | null {
  const match = /^([xy])(\d*)$/.exec(axisId);
  if (!match) return null;
  return `${match[1]}axis${match[2]}`;
}

function canonicalAxisKey(
  layout: PlotlyRuntimeLayout,
  key: string,
  axis: PlotlyRuntimeAxis,
): string {
  if (typeof axis.matches !== "string") return key;
  const matchedKey = axisLayoutKey(axis.matches);
  const matchedAxis = matchedKey ? layout[matchedKey] as PlotlyRuntimeAxis | undefined : undefined;
  return matchedKey && numericRange(matchedAxis?.range) ? matchedKey : key;
}

function axisAtPointer(
  graphDiv: HTMLElement,
  direction: AxisDirection,
  clientCoordinate: number,
  virtualRanges: Map<string, NumericPlotRange>,
): ResolvedAxis | null {
  const layout = (graphDiv as PlotlyNavigationGraphDiv)._fullLayout;
  if (!layout) return null;
  const rect = graphDiv.getBoundingClientRect();
  const layoutLength = direction === "x" ? layout.width : layout.height;
  const screenLength = direction === "x" ? rect.width : rect.height;
  if (!layoutLength || !screenLength) return null;
  const screenOrigin = direction === "x" ? rect.left : rect.top;
  const scale = screenLength / layoutLength;
  const pattern = direction === "x" ? /^xaxis\d*$/ : /^yaxis\d*$/;
  const candidates: Array<ResolvedAxis & { overlay: boolean }> = [];

  for (const key of Object.keys(layout)) {
    if (!pattern.test(key)) continue;
    const axis = layout[key] as PlotlyRuntimeAxis | undefined;
    if (!axis || axis.fixedrange || !Number.isFinite(axis._offset) || !Number.isFinite(axis._length)) {
      continue;
    }
    const start = screenOrigin + Number(axis._offset) * scale;
    const length = Number(axis._length) * scale;
    if (clientCoordinate < start || clientCoordinate > start + length) continue;
    const canonicalKey = canonicalAxisKey(layout, key, axis);
    const canonicalAxis = layout[canonicalKey] as PlotlyRuntimeAxis | undefined;
    const range = virtualRanges.get(canonicalKey) ?? numericRange(canonicalAxis?.range);
    if (!range) continue;
    candidates.push({
      key: canonicalKey,
      range,
      screenLength: length,
      screenStart: start,
      overlay: Boolean(axis.overlaying),
    });
  }

  candidates.sort((left, right) => Number(left.overlay) - Number(right.overlay));
  return candidates[0] ?? null;
}

function pointerIsOnPlot(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest(".nsewdrag"));
}

function queueRelayout(state: NavigationState, patch: Record<string, NumericPlotRange>): void {
  Object.assign(state.pendingPatch, patch);
  for (const [property, range] of Object.entries(patch)) {
    state.virtualRanges.set(property.replace(/\.range$/, ""), range);
  }
  if (state.virtualRangeTimer !== null) window.clearTimeout(state.virtualRangeTimer);
  state.virtualRangeTimer = window.setTimeout(() => {
    state.virtualRangeTimer = null;
    state.virtualRanges.clear();
  }, PLOT_WHEEL_GESTURE_GAP_MS);
  if (state.frame !== null) return;
  state.frame = window.requestAnimationFrame(() => {
    state.frame = null;
    const next = state.pendingPatch;
    state.pendingPatch = {};
    if (Object.keys(next).length === 0) return;
    state.onViewportIntent?.();
    void Plotly.relayout(state.graphDiv as never, next as never).catch(() => undefined);
  });
}

function wheelZoomFactor(event: WheelEvent): number {
  const pixels = event.deltaMode === DOM_DELTA_PIXEL
    ? event.deltaY
    : event.deltaY * 40;
  return Math.exp(Math.max(-120, Math.min(120, pixels)) * 0.0025);
}

function createNavigationState(
  graphDiv: HTMLElement,
  onViewportIntent?: () => void,
): NavigationState {
  const state = {
    graphDiv,
    onViewportIntent,
    wheelMode: null,
    wheelModeAt: 0,
    virtualRanges: new Map<string, NumericPlotRange>(),
    virtualRangeTimer: null,
    frame: null,
    pendingPatch: {},
    drag: null,
  } as NavigationState;

  state.onWheel = (event) => {
    if (!pointerIsOnPlot(event)) return;
    const previous = state.wheelMode === null
      ? null
      : { mode: state.wheelMode, at: state.wheelModeAt };
    const mode = plotWheelMode(event, previous);
    state.wheelMode = mode;
    state.wheelModeAt = event.timeStamp;
    const xAxis = axisAtPointer(graphDiv, "x", event.clientX, state.virtualRanges);
    const yAxis = axisAtPointer(graphDiv, "y", event.clientY, state.virtualRanges);
    const patch: Record<string, NumericPlotRange> = {};

    if (mode === "zoom") {
      const factor = wheelZoomFactor(event);
      if (xAxis) {
        patch[`${xAxis.key}.range`] = zoomPlotRange(
          xAxis.range,
          (event.clientX - xAxis.screenStart) / xAxis.screenLength,
          factor,
        );
      }
      if (yAxis) {
        patch[`${yAxis.key}.range`] = zoomPlotRange(
          yAxis.range,
          1 - (event.clientY - yAxis.screenStart) / yAxis.screenLength,
          factor,
        );
      }
    } else {
      if (xAxis && event.deltaX !== 0) {
        patch[`${xAxis.key}.range`] = panPlotRange(
          xAxis.range,
          event.deltaX,
          xAxis.screenLength,
        );
      }
      if (yAxis && event.deltaY !== 0) {
        patch[`${yAxis.key}.range`] = panPlotRange(
          yAxis.range,
          -event.deltaY,
          yAxis.screenLength,
        );
      }
    }
    if (Object.keys(patch).length === 0) return;
    event.preventDefault();
    queueRelayout(state, patch);
  };

  state.onPointerDown = (event) => {
    if (event.button !== 0 || !event.ctrlKey || !pointerIsOnPlot(event)) return;
    const xAxis = axisAtPointer(graphDiv, "x", event.clientX, state.virtualRanges);
    const yAxis = axisAtPointer(graphDiv, "y", event.clientY, state.virtualRanges);
    if (!xAxis && !yAxis) return;
    event.preventDefault();
    event.stopPropagation();
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      xAxis,
      yAxis,
      previousCursor: graphDiv.style.cursor,
    };
    graphDiv.style.cursor = "grabbing";
    graphDiv.setPointerCapture?.(event.pointerId);
  };

  state.onPointerMove = (event) => {
    const drag = state.drag;
    if (!drag) return;
    event.preventDefault();
    const patch: Record<string, NumericPlotRange> = {};
    if (drag.xAxis) {
      patch[`${drag.xAxis.key}.range`] = panPlotRange(
        drag.xAxis.range,
        drag.startX - event.clientX,
        drag.xAxis.screenLength,
      );
    }
    if (drag.yAxis) {
      patch[`${drag.yAxis.key}.range`] = panPlotRange(
        drag.yAxis.range,
        event.clientY - drag.startY,
        drag.yAxis.screenLength,
      );
    }
    queueRelayout(state, patch);
  };

  state.onPointerUp = (event) => {
    const drag = state.drag;
    if (!drag) return;
    state.drag = null;
    graphDiv.style.cursor = drag.previousCursor;
    if (graphDiv.hasPointerCapture?.(event.pointerId)) {
      graphDiv.releasePointerCapture(event.pointerId);
    }
  };
  return state;
}

/** Install shared touchpad/wheel navigation on one live Plotly graph. */
export function installPlotNavigation(
  graphDiv: HTMLElement,
  onViewportIntent?: () => void,
): void {
  if (typeof window === "undefined") return;
  const existing = navigationStates.get(graphDiv);
  if (existing) {
    existing.onViewportIntent = onViewportIntent;
    return;
  }
  const state = createNavigationState(graphDiv, onViewportIntent);
  navigationStates.set(graphDiv, state);
  graphDiv.addEventListener("wheel", state.onWheel, { passive: false, capture: true });
  graphDiv.addEventListener("pointerdown", state.onPointerDown, { capture: true });
  graphDiv.addEventListener("pointermove", state.onPointerMove, { capture: true });
  graphDiv.addEventListener("pointerup", state.onPointerUp, { capture: true });
  graphDiv.addEventListener("pointercancel", state.onPointerUp, { capture: true });
}

export function disposePlotNavigation(graphDiv: HTMLElement): void {
  const state = navigationStates.get(graphDiv);
  if (!state) return;
  graphDiv.removeEventListener("wheel", state.onWheel, { capture: true });
  graphDiv.removeEventListener("pointerdown", state.onPointerDown, { capture: true });
  graphDiv.removeEventListener("pointermove", state.onPointerMove, { capture: true });
  graphDiv.removeEventListener("pointerup", state.onPointerUp, { capture: true });
  graphDiv.removeEventListener("pointercancel", state.onPointerUp, { capture: true });
  if (state.frame !== null) window.cancelAnimationFrame(state.frame);
  if (state.virtualRangeTimer !== null) window.clearTimeout(state.virtualRangeTimer);
  if (state.drag && graphDiv.hasPointerCapture?.(state.drag.pointerId)) {
    graphDiv.releasePointerCapture(state.drag.pointerId);
  }
  graphDiv.style.cursor = state.drag?.previousCursor ?? graphDiv.style.cursor;
  navigationStates.delete(graphDiv);
}
