import type { PlotAxisStyle } from "../../../../api";

export type AxisOverrides = {
  autorange?: boolean;
  range?: [number, number];
  tickmode?: "linear" | "array";
  tick0?: number;
  dtick?: number;
  tickvals?: number[];
  autorangeoptions?: { minallowed?: number; maxallowed?: number };
};

/** True when at least one finite trace value would appear inside a manual axis window. */
export function axisManualRangeShowsData(
  axis: PlotAxisStyle,
  observedRange?: [number, number],
): boolean {
  if (axis.mode !== "manual") return true;
  if (!observedRange) return false;
  const [d0, d1] =
    observedRange[0] <= observedRange[1]
      ? observedRange
      : [observedRange[1], observedRange[0]];
  const hasMin = axis.min !== null && axis.min !== undefined;
  const hasMax = axis.max !== null && axis.max !== undefined;
  if (hasMin && hasMax && axis.min! < axis.max!) {
    return d1 >= axis.min! && d0 <= axis.max!;
  }
  if (hasMin && !hasMax) return d1 >= axis.min!;
  if (!hasMin && hasMax) return d0 <= axis.max!;
  return true;
}

export function numericTraceExtent(
  traces: Plotly.Data[],
  coordinate: "x" | "y",
  axisNames: string[],
): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const raw of traces) {
    const trace = raw as Record<string, unknown>;
    const axisName = String(trace[coordinate === "x" ? "xaxis" : "yaxis"] ?? coordinate);
    if (!axisNames.includes(axisName)) continue;
    const values = trace[coordinate];
    if (!values || typeof (values as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
      continue;
    }
    for (const rawValue of values as Iterable<unknown>) {
      const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : undefined;
}

// Returns ONLY the keys that should override Plotly's defaults. In auto mode
// this is empty on purpose: passing `range: undefined, autorange: true` on a
// layout-only re-render (grid/zero-line/border toggles) made Plotly.react
// fall back to its empty-plot ranges (x [-1, 6], y [-1, 4]) without
// recomputing from data. One-sided manual bounds clamp the autorange.
export function axisLayout(
  axis: PlotAxisStyle,
  observedRange?: [number, number],
): AxisOverrides {
  const axisForLayout =
    axis.mode === "manual" && !axisManualRangeShowsData(axis, observedRange)
      ? {
          ...axis,
          mode: "auto" as const,
          min: null,
          max: null,
          tick_mode: "auto" as const,
          dtick: null,
          tick_count: null,
        }
      : axis;
  const out: AxisOverrides = {};
  const hasMin = axisForLayout.min !== null && axisForLayout.min !== undefined;
  const hasMax = axisForLayout.max !== null && axisForLayout.max !== undefined;
  const validManualRange = hasMin && hasMax && axisForLayout.min! < axisForLayout.max!;
  if (axisForLayout.mode === "manual" && validManualRange) {
    out.autorange = false;
    out.range = [axisForLayout.min!, axisForLayout.max!];
  } else if (axisForLayout.mode === "manual" && hasMin !== hasMax) {
    out.autorange = true;
    out.autorangeoptions = {
      ...(hasMin ? { minallowed: axisForLayout.min! } : {}),
      ...(hasMax ? { maxallowed: axisForLayout.max! } : {}),
    };
  }
  if (axisForLayout.tick_mode === "step" && axisForLayout.dtick !== null && axisForLayout.dtick > 0) {
    out.tickmode = "linear";
    out.dtick = axisForLayout.dtick;
    const start = validManualRange ? axisForLayout.min! : observedRange?.[0];
    if (start !== undefined) out.tick0 = start;
  } else if (axisForLayout.tick_mode === "count" && axisForLayout.tick_count !== null && axisForLayout.tick_count >= 2) {
    const start = validManualRange ? axisForLayout.min! : hasMin ? axisForLayout.min! : observedRange?.[0];
    const end = validManualRange ? axisForLayout.max! : hasMax ? axisForLayout.max! : observedRange?.[1];
    if (start !== undefined && end !== undefined && start < end) {
      const steps = axisForLayout.tick_count - 1;
      out.tickmode = "array";
      out.tickvals = Array.from(
        { length: axisForLayout.tick_count },
        (_, index) => start + ((end - start) * index) / steps,
      );
    }
  }
  return out;
}
