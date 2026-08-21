import type { PlotStyle } from "../../../../../api";
import {
  axisLayout,
  numericTraceExtent,
  type AxisOverrides,
} from "../../plotting/plotAxisLayout.ts";

export type TimeCapacityNumericRange = [number, number];

/**
 * The data-derived frame captured at the first current progressive result.
 * Later partial results may replace data, but they must not replace this
 * frame until the terminal complete result is promoted.
 */
export interface TimeCapacityProgressiveFrame {
  xRange?: TimeCapacityNumericRange;
  yRange?: TimeCapacityNumericRange;
  y2Range?: TimeCapacityNumericRange;
  hasRightCurrent: boolean;
}

export function timeCapacityProgressiveFrameForTraces(
  traces: Plotly.Data[],
  hasRightCurrent: boolean,
): TimeCapacityProgressiveFrame {
  return {
    xRange: numericTraceExtent(traces, "x", ["x", "x2"]),
    yRange: numericTraceExtent(traces, "y", ["y"]),
    y2Range: numericTraceExtent(traces, "y", ["y2", "y3"]),
    hasRightCurrent,
  };
}

/**
 * Keep an automatic axis at the captured progressive frame. Persisted manual
 * bounds still win, including one-sided bounds handled by axisLayout().
 */
export function progressiveAxisLayout(
  axis: PlotStyle["x_axis"],
  observedRange: TimeCapacityNumericRange | undefined,
  stableRange: TimeCapacityNumericRange | undefined,
): AxisOverrides {
  const overrides = axisLayout(axis, observedRange);
  if (axis.mode === "manual" || !stableRange) return overrides;
  return {
    ...overrides,
    autorange: false,
    range: [...stableRange],
  };
}
