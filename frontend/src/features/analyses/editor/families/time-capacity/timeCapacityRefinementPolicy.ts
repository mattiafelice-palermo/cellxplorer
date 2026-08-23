import type {
  AnalysisSpec,
  TimeCapacityRefinementResult,
  TimeCapacityResult,
} from "../../../../../api";

export type TimeCapacityViewport = { min: number; max: number };
export type TimeCapacityCycleRange = { start: number; end: number };

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function timeCapacityOverviewExtent(
  result: TimeCapacityResult | undefined,
): TimeCapacityViewport | null {
  if (!result) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    for (const value of trace.display_x ?? []) {
      if (!finite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function timeCapacityCycleRangeForViewport(
  result: TimeCapacityResult | undefined,
  viewport: TimeCapacityViewport,
): TimeCapacityCycleRange | null {
  if (!result) return null;
  let selectedMin = Number.POSITIVE_INFINITY;
  let selectedMax = Number.NEGATIVE_INFINITY;
  let globalMin = Number.POSITIVE_INFINITY;
  let globalMax = Number.NEGATIVE_INFINITY;
  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    const x = trace.display_x ?? [];
    for (let index = 0; index < trace.cycle.length; index += 1) {
      const cycle = trace.cycle[index];
      const xValue = x[index];
      if (typeof cycle !== "number" || !Number.isInteger(cycle) || !finite(xValue)) continue;
      globalMin = Math.min(globalMin, cycle);
      globalMax = Math.max(globalMax, cycle);
      if (xValue >= viewport.min && xValue <= viewport.max) {
        selectedMin = Math.min(selectedMin, cycle);
        selectedMax = Math.max(selectedMax, cycle);
      }
    }
  }
  if (!Number.isFinite(selectedMin) || !Number.isFinite(selectedMax)) return null;
  return {
    start: Math.max(globalMin, selectedMin - 1),
    end: Math.min(globalMax, selectedMax + 1),
  };
}

export function timeCapacityRefinementWorthwhile(
  overview: TimeCapacityViewport | null,
  viewport: TimeCapacityViewport,
): boolean {
  if (!overview) return false;
  const fullSpan = overview.max - overview.min;
  const visibleSpan = viewport.max - viewport.min;
  return fullSpan > 0 && visibleSpan > 0 && visibleSpan <= fullSpan * 0.5;
}

export function timeCapacityRefinementRequestIsCurrent(
  response: TimeCapacityRefinementResult,
  currentResult: TimeCapacityResult | undefined,
  generation: string,
): boolean {
  return Boolean(
    currentResult &&
      response.request_generation === generation &&
      response.overview_data_signature === currentResult.data_signature &&
      response.data_signature === currentResult.data_signature,
  );
}

export function timeCapacityRefinementEligible(spec: AnalysisSpec): boolean {
  const cfg = spec.computation.time_capacity;
  return (
    (cfg?.view ?? "voltage_current") === "voltage_current" &&
    (cfg?.x_axis ?? "time") === "time" &&
    (cfg?.display_mode ?? "consecutive") === "consecutive"
  );
}
