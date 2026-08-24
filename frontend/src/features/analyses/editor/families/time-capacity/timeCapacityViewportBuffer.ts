/**
 * Spec 052.7 — buffered viewport panning for the Time/Capacity cycle slider.
 *
 * The per-window model fetches exactly the cycles the slider selects, and the
 * backend re-zeroes every response at its own first point. Consecutive windows
 * are therefore separate coordinate systems, so dragging replaces one curve
 * with another instead of moving along a timeline — it reads as a slideshow.
 *
 * Panning needs two things the per-window model cannot give:
 *
 *   1. absolute coordinates, so cycle 150 sits further right than cycle 50
 *      (the backend provides these when asked, via `absolute_time_origin_cycle`);
 *   2. more data loaded than is visible, so there is something off-screen to
 *      drag into view.
 *
 * So the request covers a *buffer* several windows wide while the plot shows
 * only the window. Dragging then moves the x-range within data already held —
 * no request per pointer move — and a request is issued only when the viewport
 * approaches the buffer's edge.
 *
 * Everything here is pure so the policy can be tested without a browser.
 */
import type { TimeCapacityCycleRange } from "./timeCapacityCycleNavigationPolicy";

/** Windows of context held on each side of the visible range. */
export const TIME_CAPACITY_BUFFER_FACTOR = 2;

/**
 * A buffer sized only as a multiple of the window is useless for a narrow
 * window: three cycles out of three hundred gives fifteen cycles of context,
 * which a moving pointer leaves almost immediately, so every step refetches
 * and nothing is ever panned through. The buffer therefore also spans at
 * least this fraction of the whole range.
 */
export const TIME_CAPACITY_BUFFER_MIN_EXTENT_FRACTION = 0.1;

/**
 * Requests for a buffer must raise `viewport_width` as well as the point
 * budget: `time_capacity_display_budget` caps a response at
 * `(2 * viewport_width * 6) / visible_cells`, so asking for more points at the
 * default width silently returns the same number spread over a wider range —
 * which would make the visible window coarser, not equal.
 */
export const TIME_CAPACITY_BUFFER_VIEWPORT_WIDTH = 6000;

/**
 * Refill once the viewport comes within this fraction of a buffer half-width
 * of the buffer edge. Below 1 the refill starts before data runs out, which is
 * what keeps a sustained drag from stalling at the boundary.
 */
export const TIME_CAPACITY_BUFFER_REFILL_FRACTION = 0.5;

/** Smoothed track-speed tiers used only for transient buffered requests. */
export type TimeCapacityPanSpeedTier = "slow" | "medium" | "fast";

export interface TimeCapacityPanMotion {
  centerCycle: number;
  sampledAtMs: number;
  /** Exponential moving average, expressed as fractions of the full extent per second. */
  extentVelocityPerSecond: number;
  direction: -1 | 0 | 1;
  tier: TimeCapacityPanSpeedTier;
}

export interface TimeCapacityBufferPlan {
  window: TimeCapacityCycleRange;
  buffer: TimeCapacityCycleRange;
  maxPoints: number;
  tier: TimeCapacityPanSpeedTier;
  direction: -1 | 0 | 1;
}

export interface TimeCapacityBufferRequest extends TimeCapacityBufferPlan {
  id: number;
}

export interface TimeCapacityBufferSchedulerState {
  active: boolean;
  nextRequestId: number;
  phase: "idle" | "fetching" | "rendering";
  resident: TimeCapacityBufferRequest | null;
  published: TimeCapacityBufferRequest | null;
  pending: TimeCapacityBufferPlan | null;
}

export interface TimeCapacityBufferSchedulerDecision {
  state: TimeCapacityBufferSchedulerState;
  request: TimeCapacityBufferRequest | null;
}

const MEDIUM_PAN_EXTENTS_PER_SECOND = 0.08;
const FAST_PAN_EXTENTS_PER_SECOND = 0.25;
const MEDIUM_PAN_EXIT_EXTENTS_PER_SECOND = 0.05;
const FAST_PAN_EXIT_EXTENTS_PER_SECOND = 0.18;
const PAN_VELOCITY_EMA_ALPHA = 0.35;

const PAN_DENSITY: Record<TimeCapacityPanSpeedTier, number> = {
  slow: 1,
  medium: 0.45,
  fast: 0.15,
};

const PAN_POINT_CAP: Record<TimeCapacityPanSpeedTier, number> = {
  slow: 24_000,
  medium: 8_000,
  fast: 3_000,
};

function rangeCenter(range: TimeCapacityCycleRange): number {
  return (range.start + range.end) / 2;
}

function panSpeedTier(
  extentVelocityPerSecond: number,
  previousTier: TimeCapacityPanSpeedTier,
): TimeCapacityPanSpeedTier {
  if (previousTier === "fast" && extentVelocityPerSecond >= FAST_PAN_EXIT_EXTENTS_PER_SECOND) {
    return "fast";
  }
  if (previousTier !== "slow" && extentVelocityPerSecond >= MEDIUM_PAN_EXIT_EXTENTS_PER_SECOND) {
    return extentVelocityPerSecond >= FAST_PAN_EXTENTS_PER_SECOND ? "fast" : "medium";
  }
  if (extentVelocityPerSecond >= FAST_PAN_EXTENTS_PER_SECOND) return "fast";
  if (extentVelocityPerSecond >= MEDIUM_PAN_EXTENTS_PER_SECOND) return "medium";
  return "slow";
}

/** Update normalized velocity without making noisy pointer acceleration part of request identity. */
export function nextTimeCapacityPanMotion(
  previous: TimeCapacityPanMotion | null,
  window: TimeCapacityCycleRange,
  sampledAtMs: number,
  maxCycle: number,
): TimeCapacityPanMotion {
  const centerCycle = rangeCenter(window);
  if (!previous || !Number.isFinite(sampledAtMs) || sampledAtMs <= previous.sampledAtMs) {
    return {
      centerCycle,
      sampledAtMs,
      extentVelocityPerSecond: 0,
      direction: 0,
      tier: "slow",
    };
  }

  const deltaCycles = centerCycle - previous.centerCycle;
  const elapsedSeconds = Math.max(0.001, (sampledAtMs - previous.sampledAtMs) / 1000);
  const instantaneous = Math.abs(deltaCycles) / Math.max(1, maxCycle) / elapsedSeconds;
  const smoothed =
    previous.extentVelocityPerSecond * (1 - PAN_VELOCITY_EMA_ALPHA) +
    instantaneous * PAN_VELOCITY_EMA_ALPHA;
  return {
    centerCycle,
    sampledAtMs,
    extentVelocityPerSecond: smoothed,
    direction: deltaCycles === 0 ? previous.direction : deltaCycles > 0 ? 1 : -1,
    tier: panSpeedTier(smoothed, previous.tier),
  };
}

function directionalBufferRange(
  window: TimeCapacityCycleRange,
  maxCycle: number,
  tier: TimeCapacityPanSpeedTier,
  direction: -1 | 0 | 1,
): TimeCapacityCycleRange {
  if (tier === "slow" || direction === 0) return bufferRangeForWindow(window, maxCycle);

  const width = Math.max(1, window.end - window.start + 1);
  const basePad = Math.max(
    1,
    Math.round(width * TIME_CAPACITY_BUFFER_FACTOR),
    Math.ceil(Math.max(1, maxCycle) * TIME_CAPACITY_BUFFER_MIN_EXTENT_FRACTION),
  );
  const leadFraction = tier === "fast" ? 0.4 : 0.2;
  const trailFraction = tier === "fast" ? 0.03 : 0.05;
  const lead = Math.max(basePad, Math.ceil(maxCycle * leadFraction));
  const trail = Math.max(width, Math.ceil(maxCycle * trailFraction));
  return direction > 0
    ? {
        start: clampCycle(window.start - trail, maxCycle),
        end: clampCycle(window.end + lead, maxCycle),
      }
    : {
        start: clampCycle(window.start - lead, maxCycle),
        end: clampCycle(window.end + trail, maxCycle),
      };
}

/** Resolve a directional buffer and a deliberately coarse fast-pan point budget. */
export function timeCapacityBufferPlanForWindow(
  window: TimeCapacityCycleRange,
  maxCycle: number,
  windowPoints: number,
  motion: TimeCapacityPanMotion | null,
): TimeCapacityBufferPlan {
  const tier = motion?.tier ?? "slow";
  const direction = motion?.direction ?? 0;
  const buffer = directionalBufferRange(window, maxCycle, tier, direction);
  const densityAdjusted = Math.round(
    bufferMaxPoints(windowPoints, window, buffer) * PAN_DENSITY[tier],
  );
  return {
    window: { ...window },
    buffer,
    maxPoints: Math.max(1, Math.min(PAN_POINT_CAP[tier], densityAdjusted)),
    tier,
    direction,
  };
}

function planSatisfiedBy(
  request: TimeCapacityBufferRequest | null,
  plan: TimeCapacityBufferPlan,
  maxCycle: number,
): boolean {
  return Boolean(
    request &&
      !bufferNeedsRefill(request.buffer, plan.window, maxCycle) &&
      request.maxPoints >= plan.maxPoints,
  );
}

function admitBufferPlan(
  state: TimeCapacityBufferSchedulerState,
  plan: TimeCapacityBufferPlan,
): TimeCapacityBufferSchedulerDecision {
  const request: TimeCapacityBufferRequest = {
    ...plan,
    window: { ...plan.window },
    buffer: { ...plan.buffer },
    id: state.nextRequestId,
  };
  return {
    state: {
      ...state,
      active: true,
      nextRequestId: state.nextRequestId + 1,
      phase: "fetching",
      published: request,
      pending: null,
    },
    request,
  };
}

export function timeCapacityBufferSchedulerInitialState(): TimeCapacityBufferSchedulerState {
  return {
    active: false,
    nextRequestId: 1,
    phase: "idle",
    resident: null,
    published: null,
    pending: null,
  };
}

/** Admit one refill and retain only the newest desired plan while it fetches or renders. */
export function timeCapacityBufferOnMove(
  state: TimeCapacityBufferSchedulerState,
  plan: TimeCapacityBufferPlan,
  maxCycle: number,
): TimeCapacityBufferSchedulerDecision {
  const active = { ...state, active: true };
  if (planSatisfiedBy(active.resident, plan, maxCycle)) {
    return { state: { ...active, pending: null }, request: null };
  }
  if (active.phase !== "idle") {
    if (planSatisfiedBy(active.published, plan, maxCycle)) {
      return { state: { ...active, pending: null }, request: null };
    }
    return {
      state: {
        ...active,
        pending: { ...plan, window: { ...plan.window }, buffer: { ...plan.buffer } },
      },
      request: null,
    };
  }
  return admitBufferPlan(active, plan);
}

export function timeCapacityBufferOnResponseReady(
  state: TimeCapacityBufferSchedulerState,
  request: TimeCapacityBufferRequest,
): TimeCapacityBufferSchedulerState {
  if (state.phase !== "fetching" || state.published?.id !== request.id) return state;
  return { ...state, phase: "rendering" };
}

/** Render acknowledgement is the backpressure boundary, not HTTP completion. */
export function timeCapacityBufferOnRendered(
  state: TimeCapacityBufferSchedulerState,
  request: TimeCapacityBufferRequest,
  maxCycle: number,
): TimeCapacityBufferSchedulerDecision {
  if (
    (state.phase !== "fetching" && state.phase !== "rendering") ||
    state.published?.id !== request.id
  ) {
    return { state, request: null };
  }
  const settled: TimeCapacityBufferSchedulerState = {
    ...state,
    phase: "idle",
    resident: request,
    published: null,
  };
  const pending = settled.pending;
  if (!pending || planSatisfiedBy(request, pending, maxCycle)) {
    return { state: { ...settled, pending: null }, request: null };
  }
  return admitBufferPlan(settled, pending);
}

export function timeCapacityBufferOnFailed(
  state: TimeCapacityBufferSchedulerState,
  request: TimeCapacityBufferRequest,
): TimeCapacityBufferSchedulerDecision {
  if (state.published?.id !== request.id) return { state, request: null };
  const idle = { ...state, phase: "idle" as const, published: null };
  return idle.pending ? admitBufferPlan(idle, idle.pending) : { state: idle, request: null };
}

export function timeCapacityBufferCancel(
  state: TimeCapacityBufferSchedulerState,
): TimeCapacityBufferSchedulerState {
  return {
    ...timeCapacityBufferSchedulerInitialState(),
    nextRequestId: state.nextRequestId,
  };
}

export interface TimeCapacityBufferTrace {
  cycle: (number | null)[];
  display_x?: (number | null)[];
}

export interface TimeCapacityCycleXSpan {
  min: number;
  max: number;
}

export type TimeCapacityCycleXIndex = Map<number, TimeCapacityCycleXSpan>;

/** Build once per resident buffer; live pointer frames then inspect only visible cycles. */
export function buildTimeCapacityCycleXIndex(
  traces: readonly TimeCapacityBufferTrace[] | undefined,
): TimeCapacityCycleXIndex {
  const index: TimeCapacityCycleXIndex = new Map();
  if (!traces) return index;
  for (const trace of traces) {
    const cycles = trace.cycle;
    const xs = trace.display_x;
    if (!cycles || !xs) continue;
    const length = Math.min(cycles.length, xs.length);
    for (let point = 0; point < length; point += 1) {
      const cycle = cycles[point];
      const x = xs[point];
      if (cycle === null || x === null || !Number.isFinite(cycle) || !Number.isFinite(x)) continue;
      const key = Math.round(cycle);
      const current = index.get(key);
      if (!current) index.set(key, { min: x, max: x });
      else {
        if (x < current.min) current.min = x;
        if (x > current.max) current.max = x;
      }
    }
  }
  return index;
}

export function absoluteXRangeForCycleIndex(
  index: TimeCapacityCycleXIndex,
  start: number,
  end: number,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let cycle = Math.round(start); cycle <= Math.round(end); cycle += 1) {
    const span = index.get(cycle);
    if (!span) continue;
    if (span.min < min) min = span.min;
    if (span.max > max) max = span.max;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= min) {
    const pad = Math.max(Math.abs(min) * 1e-6, 1e-6);
    return [min - pad, max + pad];
  }
  return [min, max];
}

function clampCycle(value: number, maxCycle: number): number {
  return Math.max(1, Math.min(maxCycle, Math.round(value)));
}

/** Expand a visible window into the range that should actually be requested. */
export function bufferRangeForWindow(
  window: TimeCapacityCycleRange,
  maxCycle: number,
  factor: number = TIME_CAPACITY_BUFFER_FACTOR,
): TimeCapacityCycleRange {
  const width = Math.max(1, window.end - window.start + 1);
  const pad = Math.max(
    1,
    Math.round(width * Math.max(0, factor)),
    Math.ceil(Math.max(1, maxCycle) * TIME_CAPACITY_BUFFER_MIN_EXTENT_FRACTION),
  );
  return {
    start: clampCycle(window.start - pad, maxCycle),
    end: clampCycle(window.end + pad, maxCycle),
  };
}

export function bufferCoversWindow(
  buffer: TimeCapacityCycleRange | null,
  window: TimeCapacityCycleRange,
): boolean {
  if (!buffer) return false;
  return buffer.start <= window.start && buffer.end >= window.end;
}

/**
 * True when the viewport is close enough to a buffer edge that the next
 * buffer should be fetched, or has left the buffer entirely.
 *
 * A buffer already clamped to the extent of the data is not "near an edge" on
 * that side — there is nothing further to fetch, and treating the end of the
 * data as a refill trigger would request the same range forever.
 */
export function bufferNeedsRefill(
  buffer: TimeCapacityBufferRange | null,
  window: TimeCapacityCycleRange,
  maxCycle: number,
  fraction: number = TIME_CAPACITY_BUFFER_REFILL_FRACTION,
): boolean {
  if (!buffer) return true;
  if (!bufferCoversWindow(buffer, window)) return true;

  const width = Math.max(1, window.end - window.start + 1);
  const margin = Math.max(1, Math.round(width * Math.max(0, fraction)));
  const atLowerExtent = buffer.start <= 1;
  const atUpperExtent = buffer.end >= maxCycle;

  if (!atLowerExtent && window.start - buffer.start <= margin) return true;
  if (!atUpperExtent && buffer.end - window.end <= margin) return true;
  return false;
}

export type TimeCapacityBufferRange = TimeCapacityCycleRange;

/**
 * Points to request for a buffer so the *visible* window keeps the density it
 * would have had on its own. A buffer five windows wide needs five times the
 * points to look the same once only one fifth of it is on screen.
 */
export function bufferMaxPoints(
  windowPoints: number,
  window: TimeCapacityCycleRange,
  buffer: TimeCapacityCycleRange,
): number {
  const windowWidth = Math.max(1, window.end - window.start + 1);
  const bufferWidth = Math.max(1, buffer.end - buffer.start + 1);
  const scale = Math.max(1, bufferWidth / windowWidth);
  return Math.max(1, Math.round(Math.max(1, windowPoints) * scale));
}

/**
 * Absolute x span covering `start..end` across every loaded trace.
 *
 * Cells reach different cycle counts, so a window near the end of the longest
 * cell may be absent from the others; traces that do not reach it simply do
 * not contribute. Returns null when no trace covers the range at all, which
 * tells the caller to leave the axis alone rather than pin it to nothing.
 */
export function absoluteXRangeForCycles(
  traces: readonly TimeCapacityBufferTrace[] | undefined,
  start: number,
  end: number,
): [number, number] | null {
  return absoluteXRangeForCycleIndex(buildTimeCapacityCycleXIndex(traces), start, end);
}

/** Is buffered panning switched on? Falls back to the per-window model. */
export function timeCapacityPanningEnabled(): boolean {
  try {
    const override = globalThis.localStorage?.getItem("cellxplorer.timeCapacityPanning");
    if (override === "on") return true;
    if (override === "off") return false;
  } catch {
    // Storage can be unavailable (private mode, embedded webview); fall
    // through to the compiled default rather than breaking the plot.
  }
  return TIME_CAPACITY_PANNING_DEFAULT;
}

export const TIME_CAPACITY_PANNING_DEFAULT = true;

export interface TimeCapacityPlottedTrace {
  x?: unknown;
  y?: unknown;
  yaxis?: string;
}

/**
 * Spec 052.8: does anything visible in `xRange` fall outside `yRange`?
 *
 * Panning freezes y so the plot does not rescale and blink on every buffer,
 * but that means the position the user settles on may hold data above or below
 * the frozen window. This is what decides whether to offer the "fit" control.
 *
 * Only the primary y axis is considered: secondary-axis traces (the current
 * overlay) have their own scale and are not what the control would refit.
 */
export function yDataOutsideRange(
  traces: readonly TimeCapacityPlottedTrace[] | undefined,
  xRange: readonly [number, number] | null,
  yRange: readonly [number, number] | null,
): boolean {
  if (!traces || !xRange || !yRange) return false;
  const [xLo, xHi] = xRange;
  const [yLo, yHi] = yRange;
  if (!Number.isFinite(yLo) || !Number.isFinite(yHi)) return false;

  for (const trace of traces) {
    if (trace.yaxis && trace.yaxis !== "y") continue;
    const xs = trace.x;
    const ys = trace.y;
    if (!Array.isArray(xs) || !Array.isArray(ys)) continue;
    const length = Math.min(xs.length, ys.length);
    for (let index = 0; index < length; index += 1) {
      const x = xs[index];
      const y = ys[index];
      if (typeof x !== "number" || !Number.isFinite(x)) continue;
      if (x < xLo || x > xHi) continue;
      if (typeof y !== "number" || !Number.isFinite(y)) continue;
      if (y < yLo || y > yHi) return true;
    }
  }
  return false;
}
