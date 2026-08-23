import type {
  AnalysisSpec,
  TimeCapacityRefinementResult,
  TimeCapacityResult,
} from "../../../../../api";

export type TimeCapacityViewport = { min: number; max: number };
export type TimeCapacityCycleRange = { start: number; end: number };

export const TIME_CAPACITY_REFINEMENT_TRANSITION_MS = 140;

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
      timeCapacityRefinementResultMatchesOverview(response, currentResult),
  );
}

/**
 * A displayed refinement is not tied to the generation of the next request.
 * It is valid only while it still describes the current overview identity.
 * Request-generation matching remains the stricter rule used when accepting
 * a newly arriving response.
 */
export function timeCapacityRefinementResultMatchesOverview(
  response: TimeCapacityRefinementResult,
  currentResult: TimeCapacityResult | undefined,
): boolean {
  return Boolean(
    currentResult &&
      response.overview_data_signature === currentResult.data_signature &&
      response.data_signature === currentResult.data_signature,
  );
}

/**
 * Return whether a displayed refinement covers the next visible viewport.
 * Viewport bounds are client-only metadata; they never affect scientific or
 * persisted result identity.
 */
export function timeCapacityViewportContains(
  displayedViewport: TimeCapacityViewport | null,
  nextViewport: TimeCapacityViewport | null,
): boolean {
  if (!displayedViewport || !nextViewport) return false;
  const displayedMin = Math.min(displayedViewport.min, displayedViewport.max);
  const displayedMax = Math.max(displayedViewport.min, displayedViewport.max);
  const nextMin = Math.min(nextViewport.min, nextViewport.max);
  const nextMax = Math.max(nextViewport.min, nextViewport.max);
  if (![displayedMin, displayedMax, nextMin, nextMax].every(Number.isFinite)) {
    return false;
  }
  const tolerance = Math.max(1e-9, Math.abs(displayedMax - displayedMin) * 1e-9);
  return nextMin >= displayedMin - tolerance && nextMax <= displayedMax + tolerance;
}

/**
 * Decide whether the old refinement may remain visible while a replacement
 * request is pending. This intentionally excludes request generation: a
 * newer request invalidates old responses, but not a still-compatible view.
 */
export function timeCapacityRefinementDisplayIsCompatible(
  response: TimeCapacityRefinementResult | null,
  currentResult: TimeCapacityResult | undefined,
  displayedViewport: TimeCapacityViewport | null,
  nextViewport: TimeCapacityViewport | null,
): boolean {
  return Boolean(
    response &&
      timeCapacityRefinementResultMatchesOverview(response, currentResult) &&
      timeCapacityViewportContains(displayedViewport, nextViewport),
  );
}

export function timeCapacityRefinementTransitionDuration(
  prefersReducedMotion: boolean,
): number {
  return prefersReducedMotion ? 0 : TIME_CAPACITY_REFINEMENT_TRANSITION_MS;
}

export function timeCapacityRefinementTransitionProgress(
  elapsedMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0) return 1;
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

export function timeCapacityRefinementEligible(spec: AnalysisSpec): boolean {
  const cfg = spec.computation.time_capacity;
  return (
    (cfg?.view ?? "voltage_current") === "voltage_current" &&
    (cfg?.x_axis ?? "time") === "time" &&
    (cfg?.display_mode ?? "consecutive") === "consecutive" &&
    cfg?.stacked !== true &&
    !(cfg?.cycles?.length)
  );
}

/**
 * A refinement can be displayed only while the current client-side mode is
 * still eligible for adaptive refinement. This keeps a stacked transition
 * from reusing a previously accepted flat-view refinement.
 */
export function timeCapacityRefinementDisplayIsCurrent(
  spec: AnalysisSpec,
  response: TimeCapacityRefinementResult | null,
  currentResult: TimeCapacityResult | undefined,
  displayedCompatibilitySignature: string | null,
  compatibilitySignature: string,
): boolean {
  return Boolean(
    timeCapacityRefinementEligible(spec) &&
      response &&
      displayedCompatibilitySignature === compatibilitySignature &&
      timeCapacityRefinementResultMatchesOverview(response, currentResult),
  );
}

export function timeCapacityRefinementCanSchedule(
  active: boolean,
  spec: AnalysisSpec,
): boolean {
  return active && timeCapacityRefinementEligible(spec);
}
