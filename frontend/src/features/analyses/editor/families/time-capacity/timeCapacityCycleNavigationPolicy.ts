import type { CellSummary, ReplicateGroupSummary, SelectionEntry } from "../../../../../api";

export interface TimeCapacityCycleRange {
  start: number;
  end: number;
}

export const TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS = 40;
export const TIME_CAPACITY_PREVIEW_IDLE_MS = 50;
// The fallback preview is now the production drag path. Keep enough points for
// the curves to remain recognisable while still leaving headroom for the
// latest-wins request cadence on ordinary laptops.
export const TIME_CAPACITY_PREVIEW_MAX_POINTS = 3000;

export type TimeCapacityPreviewResolution = "moving" | "full";

export interface TimeCapacityPreviewRequest {
  range: TimeCapacityCycleRange;
  resolution: TimeCapacityPreviewResolution;
  generation: number;
}

export interface TimeCapacityPreviewSchedulerState {
  active: boolean;
  generation: number;
  phase: TimeCapacityPreviewResolution;
  range: TimeCapacityCycleRange | null;
  lastMovementAt: number | null;
  lastPublishedAt: number | null;
  pendingRange: TimeCapacityCycleRange | null;
  inFlight: boolean;
  publishedRequest: TimeCapacityPreviewRequest | null;
}

export interface TimeCapacityPreviewSchedulerDecision {
  state: TimeCapacityPreviewSchedulerState;
  request: TimeCapacityPreviewRequest | null;
  waitMs: number | null;
}

export interface TimeCapacityCommittedNavigationRequest {
  range: TimeCapacityCycleRange;
  generation: number;
  contextSignature: string;
}

export interface TimeCapacityCommittedNavigationSchedulerState {
  active: boolean;
  generation: number;
  contextSignature: string | null;
  inFlight: boolean;
  pendingRange: TimeCapacityCycleRange | null;
  publishedRequest: TimeCapacityCommittedNavigationRequest | null;
}

export interface TimeCapacityCommittedNavigationSchedulerDecision {
  state: TimeCapacityCommittedNavigationSchedulerState;
  request: TimeCapacityCommittedNavigationRequest | null;
}

export type TimeCapacityCycleRangePatch = {
  start?: number | string | null;
  end?: number | string | null;
};

export const TIME_CAPACITY_WINDOW_PRESETS = [1, 5, 10, 20, 50, 100] as const;

export const TIME_CAPACITY_HISTORY_LIMIT = 8;

function positiveInteger(value: number | string | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : fallback;
}

function positiveMaximum(value: number | string | null | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function cycleRangeWidth(range: TimeCapacityCycleRange): number {
  return Math.max(1, range.end - range.start + 1);
}

export function cycleRangesEqual(
  left: TimeCapacityCycleRange,
  right: TimeCapacityCycleRange,
): boolean {
  return left.start === right.start && left.end === right.end;
}

function previewInterval(intervalMs: number, fallback: number): number {
  return Number.isFinite(intervalMs) ? Math.max(1, intervalMs) : fallback;
}

function previewNow(nowMs: number): number {
  return Number.isFinite(nowMs) ? nowMs : 0;
}

export function timeCapacityPreviewSchedulerInitialState(): TimeCapacityPreviewSchedulerState {
  return {
    active: false,
    generation: 0,
    phase: "moving",
    range: null,
    lastMovementAt: null,
    lastPublishedAt: null,
    pendingRange: null,
    inFlight: false,
    publishedRequest: null,
  };
}

function previewRequest(
  range: TimeCapacityCycleRange,
  resolution: TimeCapacityPreviewResolution,
  generation: number,
): TimeCapacityPreviewRequest {
  return { range: { ...range }, resolution, generation };
}

function admitPreviewRequest(
  state: TimeCapacityPreviewSchedulerState,
  range: TimeCapacityCycleRange,
  resolution: TimeCapacityPreviewResolution,
  generation: number,
  now: number,
): TimeCapacityPreviewSchedulerDecision {
  const request = previewRequest(range, resolution, generation);
  return {
    state: {
      ...state,
      range: { ...range },
      lastPublishedAt: now,
      pendingRange: null,
      inFlight: true,
      publishedRequest: request,
    },
    request,
    waitMs: null,
  };
}

/** Start or continue a latest-wins moving preview and reset the idle promotion clock. */
export function timeCapacityPreviewOnMove(
  state: TimeCapacityPreviewSchedulerState,
  range: TimeCapacityCycleRange,
  nowMs: number,
  intervalMs = TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
): TimeCapacityPreviewSchedulerDecision {
  const now = previewNow(nowMs);
  const interval = previewInterval(intervalMs, TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS);
  const generation = state.generation + 1;
  const movingAfterFull = state.active && state.phase === "full";
  const next: TimeCapacityPreviewSchedulerState = {
    active: true,
    generation,
    phase: "moving",
    range: { ...range },
    lastMovementAt: now,
    lastPublishedAt: movingAfterFull ? null : state.lastPublishedAt,
    pendingRange: movingAfterFull ? null : state.pendingRange,
    inFlight: movingAfterFull ? false : state.inFlight,
    publishedRequest: movingAfterFull ? null : state.publishedRequest,
  };
  if (next.inFlight) {
    next.pendingRange = { ...range };
    return { state: next, request: null, waitMs: null };
  }

  const elapsed = next.lastPublishedAt === null ? interval : now - next.lastPublishedAt;
  if (movingAfterFull || next.lastPublishedAt === null || elapsed >= interval) {
    return admitPreviewRequest(next, range, "moving", generation, now);
  }

  next.pendingRange = { ...range };
  return {
    state: next,
    request: null,
    waitMs: Math.max(0, interval - elapsed),
  };
}

/** Publish the newest moving range once its bounded cadence elapses. */
export function timeCapacityPreviewFlushMoving(
  state: TimeCapacityPreviewSchedulerState,
  nowMs: number,
  intervalMs = TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
): TimeCapacityPreviewSchedulerDecision {
  if (!state.active || state.phase !== "moving" || !state.pendingRange) {
    return { state, request: null, waitMs: null };
  }
  if (state.inFlight) return { state, request: null, waitMs: null };

  const now = previewNow(nowMs);
  const interval = previewInterval(intervalMs, TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS);
  const elapsed = state.lastPublishedAt === null ? interval : now - state.lastPublishedAt;
  if (state.lastPublishedAt === null || elapsed >= interval) {
    const range = state.pendingRange;
    return admitPreviewRequest(state, range, "moving", state.generation, now);
  }

  return {
    state,
    request: null,
    waitMs: Math.max(0, interval - elapsed),
  };
}

/** Promote the still-held range to the user's full resolution after pointer idle. */
export function timeCapacityPreviewPromoteOnIdle(
  state: TimeCapacityPreviewSchedulerState,
  generation: number,
  nowMs: number,
  idleMs = TIME_CAPACITY_PREVIEW_IDLE_MS,
): TimeCapacityPreviewSchedulerDecision {
  if (
    !state.active ||
    state.phase !== "moving" ||
    state.generation !== generation ||
    state.range === null ||
    state.lastMovementAt === null
  ) {
    return { state, request: null, waitMs: null };
  }

  const now = previewNow(nowMs);
  const idle = previewInterval(idleMs, TIME_CAPACITY_PREVIEW_IDLE_MS);
  const elapsed = now - state.lastMovementAt;
  if (elapsed < idle) {
    return { state, request: null, waitMs: Math.max(0, idle - elapsed) };
  }

  const next = {
    ...state,
    phase: "full" as const,
    lastPublishedAt: now,
    pendingRange: null,
    inFlight: false,
    publishedRequest: null,
  };
  return admitPreviewRequest(next, state.range, "full", state.generation, now);
}

/** Complete one admitted moving request and immediately admit only the newest pending range. */
export function timeCapacityPreviewOnMovingRequestComplete(
  state: TimeCapacityPreviewSchedulerState,
  request: TimeCapacityPreviewRequest,
  nowMs: number,
  intervalMs = TIME_CAPACITY_PREVIEW_MOVING_INTERVAL_MS,
): TimeCapacityPreviewSchedulerDecision {
  if (
    !state.active ||
    state.phase !== "moving" ||
    !state.inFlight ||
    state.publishedRequest === null ||
    state.publishedRequest.generation !== request.generation ||
    state.publishedRequest.resolution !== request.resolution ||
    !cycleRangesEqual(state.publishedRequest.range, request.range)
  ) {
    return { state, request: null, waitMs: null };
  }

  const next = { ...state, inFlight: false };
  return timeCapacityPreviewFlushMoving(next, nowMs, intervalMs);
}

/** Invalidate all preview work when a drag is released, cancelled, or reset. */
export function timeCapacityPreviewCancel(
  state: TimeCapacityPreviewSchedulerState,
): TimeCapacityPreviewSchedulerState {
  return {
    ...timeCapacityPreviewSchedulerInitialState(),
    generation: state.generation + 1,
  };
}

/** A late query result is ineligible once its range, phase, or generation is superseded. */
export function timeCapacityPreviewRequestIsCurrent(
  state: TimeCapacityPreviewSchedulerState,
  request: TimeCapacityPreviewRequest,
): boolean {
  return (
    state.active &&
    state.phase === request.resolution &&
    state.publishedRequest !== null &&
    state.publishedRequest.generation === request.generation &&
    state.publishedRequest.resolution === request.resolution &&
    cycleRangesEqual(state.publishedRequest.range, request.range)
  );
}

export function timeCapacityCommittedNavigationSchedulerInitialState():
  TimeCapacityCommittedNavigationSchedulerState {
  return {
    active: false,
    generation: 0,
    contextSignature: null,
    inFlight: false,
    pendingRange: null,
    publishedRequest: null,
  };
}

function committedNavigationRequest(
  range: TimeCapacityCycleRange,
  generation: number,
  contextSignature: string,
): TimeCapacityCommittedNavigationRequest {
  return { range: { ...range }, generation, contextSignature };
}

function admitCommittedNavigationRequest(
  state: TimeCapacityCommittedNavigationSchedulerState,
  range: TimeCapacityCycleRange,
  generation: number,
  contextSignature: string,
): TimeCapacityCommittedNavigationSchedulerDecision {
  const request = committedNavigationRequest(range, generation, contextSignature);
  return {
    state: {
      ...state,
      active: true,
      generation,
      contextSignature,
      inFlight: true,
      pendingRange: null,
      publishedRequest: request,
    },
    request,
  };
}

/** Admit one committed range and keep only the newest range while it runs. */
export function timeCapacityCommittedNavigationOnRange(
  state: TimeCapacityCommittedNavigationSchedulerState,
  range: TimeCapacityCycleRange,
  contextSignature: string,
): TimeCapacityCommittedNavigationSchedulerDecision {
  const nextGeneration = state.generation + 1;
  if (state.inFlight && state.contextSignature === contextSignature) {
    const current = state.publishedRequest?.range;
    return {
      state: {
        ...state,
        generation: nextGeneration,
        pendingRange:
          current && cycleRangesEqual(current, range) ? null : { ...range },
      },
      request: null,
    };
  }
  return admitCommittedNavigationRequest(state, range, nextGeneration, contextSignature);
}

/** Complete one committed request, immediately admitting the latest pending range. */
export function timeCapacityCommittedNavigationOnRequestSettled(
  state: TimeCapacityCommittedNavigationSchedulerState,
  request: TimeCapacityCommittedNavigationRequest,
): TimeCapacityCommittedNavigationSchedulerDecision {
  if (
    !state.active ||
    !state.inFlight ||
    state.publishedRequest === null ||
    state.publishedRequest.generation !== request.generation ||
    state.publishedRequest.contextSignature !== request.contextSignature ||
    !cycleRangesEqual(state.publishedRequest.range, request.range)
  ) {
    return { state, request: null };
  }

  if (state.pendingRange && !cycleRangesEqual(state.pendingRange, request.range)) {
    return admitCommittedNavigationRequest(
      state,
      state.pendingRange,
      state.generation + 1,
      request.contextSignature,
    );
  }

  return {
    state: {
      ...timeCapacityCommittedNavigationSchedulerInitialState(),
      generation: state.generation,
    },
    request: null,
  };
}

/** Cancel committed navigation work when the plot context changes or a preview starts. */
export function timeCapacityCommittedNavigationCancel(
  state: TimeCapacityCommittedNavigationSchedulerState,
): TimeCapacityCommittedNavigationSchedulerState {
  return {
    ...timeCapacityCommittedNavigationSchedulerInitialState(),
    generation: state.generation + 1,
  };
}

export function timeCapacityCommittedNavigationRequestIsCurrent(
  state: TimeCapacityCommittedNavigationSchedulerState,
  request: TimeCapacityCommittedNavigationRequest,
): boolean {
  return (
    state.active &&
    state.inFlight &&
    state.publishedRequest !== null &&
    state.publishedRequest.generation === request.generation &&
    state.publishedRequest.contextSignature === request.contextSignature &&
    cycleRangesEqual(state.publishedRequest.range, request.range)
  );
}

/** Resolve the request-only point budget without changing the canonical config. */
export function timeCapacityPreviewMaxPoints(
  configuredMaxPoints: number,
  resolution: TimeCapacityPreviewResolution,
): number {
  const configured = Number.isFinite(configuredMaxPoints) ? configuredMaxPoints : 4000;
  return resolution === "moving"
    ? Math.min(configured, TIME_CAPACITY_PREVIEW_MAX_POINTS)
    : configured;
}

/**
 * Normalize stored/manual endpoints without silently preserving an old width.
 * Navigation actions use normalizeCycleRangeForNavigation when width
 * preservation is required.
 */
export function normalizeTimeCapacityRange(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined = null,
): TimeCapacityCycleRange {
  let normalizedStart = positiveInteger(start, 1);
  let normalizedEnd = positiveInteger(end, Math.max(normalizedStart, 3));
  if (normalizedEnd < normalizedStart) normalizedEnd = normalizedStart;

  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum !== null) {
    normalizedStart = Math.min(normalizedStart, maximum);
    normalizedEnd = Math.min(normalizedEnd, maximum);
    if (normalizedEnd < normalizedStart) normalizedEnd = normalizedStart;
  }

  return { start: normalizedStart, end: normalizedEnd };
}

/** Clamp a window while preserving its inclusive width whenever possible. */
export function clampCycleWindow(
  preferredStart: number | string | null | undefined,
  requestedWidth: number | string | null | undefined,
  maxAvailableCycle: number | string,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum === null) return normalizeTimeCapacityRange(preferredStart, preferredStart);

  const width = Math.min(positiveInteger(requestedWidth, 1), maximum);
  if (width >= maximum) return { start: 1, end: maximum };

  const latestStart = maximum - width + 1;
  const start = clamp(positiveInteger(preferredStart, 1), 1, latestStart);
  return { start, end: start + width - 1 };
}

/** Normalize a current/stored range for an action that must preserve its width. */
export function normalizeCycleRangeForNavigation(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const current = normalizeTimeCapacityRange(start, end);
  const maximum = positiveMaximum(maxAvailableCycle);
  return maximum === null
    ? current
    : clampCycleWindow(current.start, cycleRangeWidth(current), maximum);
}

export function shiftTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  direction: -1 | 1,
  mode: "cycle" | "window",
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) {
    if (direction !== -1 || mode !== "cycle") return current;
    const start = Math.max(1, current.start - 1);
    return { start, end: start + cycleRangeWidth(current) - 1 };
  }

  const amount = mode === "window" ? cycleRangeWidth(current) : 1;
  return clampCycleWindow(current.start + direction * amount, cycleRangeWidth(current), maximum);
}

export function resizeTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  requestedWidth: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;
  return clampCycleWindow(current.start, requestedWidth, maximum);
}

export function centerTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  targetCycle: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;

  const target = positiveInteger(targetCycle, current.start);
  return clampCycleWindow(target - Math.floor(cycleRangeWidth(current) / 2), cycleRangeWidth(current), maximum);
}

export const TIME_CAPACITY_SLIDER_MIN_VISUAL_CYCLES = 24;

export interface TimeCapacityCycleSliderGeometry {
  leftPercent: number;
  widthPercent: number;
  visualWidthCycles: number;
}

/**
 * Keep narrow cycle windows graspable without changing their scientific width.
 * Start positions still map linearly across the visual handle's legal travel.
 */
export function timeCapacityCycleSliderGeometry(
  range: TimeCapacityCycleRange,
  maxAvailableCycle: number | null | undefined,
  minimumVisualCycles = TIME_CAPACITY_SLIDER_MIN_VISUAL_CYCLES,
): TimeCapacityCycleSliderGeometry {
  const maximum = positiveMaximum(maxAvailableCycle) ?? 1;
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  const width = cycleRangeWidth(current);
  const maximumGraspableWidth =
    width >= maximum ? maximum : Math.max(width, Math.floor(maximum / 2));
  const visualWidthCycles = Math.min(
    maximumGraspableWidth,
    Math.max(width, positiveInteger(minimumVisualCycles, TIME_CAPACITY_SLIDER_MIN_VISUAL_CYCLES)),
  );
  const widthPercent = (visualWidthCycles / maximum) * 100;
  const availableStarts = Math.max(0, maximum - width);
  const visualTravelPercent = Math.max(0, 100 - widthPercent);
  const leftPercent =
    availableStarts === 0 ? 0 : ((current.start - 1) / availableStarts) * visualTravelPercent;
  return { leftPercent, widthPercent, visualWidthCycles };
}

/** Place the current-width window's left edge at a click position along the slider track. */
export function timeCapacityCycleRangeAtTrackPosition(
  range: TimeCapacityCycleRange,
  pointerOffsetPx: number,
  trackWidthPx: number,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (
    maximum === null ||
    !Number.isFinite(pointerOffsetPx) ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return current;
  }
  const fraction = clamp(pointerOffsetPx / trackWidthPx, 0, 1);
  const width = cycleRangeWidth(current);
  const availableStarts = Math.max(0, maximum - width);
  const targetStart = 1 + Math.round(fraction * availableStarts);
  return clampCycleWindow(targetStart, width, maximum);
}

/**
 * Continuous left-edge position for a track click.
 *
 * The public cycle range remains integral, but the plot viewport must retain
 * the pointer's fractional position or a drag can only jump one whole cycle
 * at a time.  This is deliberately independent of the minimum visual handle
 * width: that width is only a graspability affordance.
 */
export function timeCapacityCycleStartAtTrackPosition(
  range: TimeCapacityCycleRange,
  pointerOffsetPx: number,
  trackWidthPx: number,
  maxAvailableCycle: number | null | undefined,
): number {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (
    maximum === null ||
    !Number.isFinite(pointerOffsetPx) ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return current.start;
  }
  const width = cycleRangeWidth(current);
  const availableStarts = Math.max(0, maximum - width);
  const fraction = clamp(pointerOffsetPx / trackWidthPx, 0, 1);
  return clamp(1 + fraction * availableStarts, 1, availableStarts + 1);
}

export function timeCapacityCycleRangeAtBoundary(
  range: TimeCapacityCycleRange,
  boundary: "first" | "last",
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;
  return boundary === "first"
    ? clampCycleWindow(1, cycleRangeWidth(current), maximum)
    : clampCycleWindow(maximum, cycleRangeWidth(current), maximum);
}

/** Map pointer movement to the highlighted segment's legal left-edge travel. */
export function timeCapacityCycleRangeAtPointerDelta(
  range: TimeCapacityCycleRange,
  pointerDeltaPx: number,
  trackWidthPx: number,
  maxAvailableCycle: number | null | undefined,
  visualWidthCycles?: number,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;

  const width = cycleRangeWidth(current);
  const availableStarts = Math.max(0, maximum - width);
  if (
    availableStarts === 0 ||
    !Number.isFinite(pointerDeltaPx) ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return current;
  }

  const visualWidth = Math.min(
    maximum,
    Math.max(width, positiveInteger(visualWidthCycles, width)),
  );
  const segmentTravelPx = (trackWidthPx * Math.max(0, maximum - visualWidth)) / maximum;
  if (segmentTravelPx <= 0) return current;
  const deltaCycles = Math.round((pointerDeltaPx / segmentTravelPx) * availableStarts);
  return clampCycleWindow(current.start + deltaCycles, width, maximum);
}

/** Continuous counterpart of `timeCapacityCycleRangeAtPointerDelta`. */
export function timeCapacityCycleStartAtPointerDelta(
  range: TimeCapacityCycleRange,
  pointerDeltaPx: number,
  trackWidthPx: number,
  maxAvailableCycle: number | null | undefined,
  visualWidthCycles?: number,
  startPosition: number = range.start,
): number {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current.start;

  const width = cycleRangeWidth(current);
  const availableStarts = Math.max(0, maximum - width);
  if (
    availableStarts === 0 ||
    !Number.isFinite(pointerDeltaPx) ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return current.start;
  }

  const visualWidth = Math.min(
    maximum,
    Math.max(width, positiveInteger(visualWidthCycles, width)),
  );
  const segmentTravelPx = (trackWidthPx * Math.max(0, maximum - visualWidth)) / maximum;
  if (segmentTravelPx <= 0) return current.start;
  const deltaCycles = (pointerDeltaPx / segmentTravelPx) * availableStarts;
  const continuousStart = Number.isFinite(startPosition) ? startPosition : current.start;
  return clamp(continuousStart + deltaCycles, 1, availableStarts + 1);
}

/** Resolve a normal or Ctrl+extreme navigation action without inventing a null-bound extreme. */
export function navigateTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  direction: -1 | 1,
  mode: "cycle" | "window",
  maxAvailableCycle: number | null | undefined,
  boundary?: "first" | "last",
): TimeCapacityCycleRange | null {
  const hasBound = positiveMaximum(maxAvailableCycle) !== null;
  if (boundary && !hasBound) return null;
  if (!hasBound && (direction === 1 || mode === "window")) return null;
  return boundary
    ? timeCapacityCycleRangeAtBoundary(range, boundary, maxAvailableCycle)
    : shiftTimeCapacityCycleRange(range, direction, mode, maxAvailableCycle);
}

export function timeCapacityVirginCycleRange(
  maxAvailableCycle: number | null | undefined,
  preferredWidth = 20,
): TimeCapacityCycleRange | null {
  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum === null) return null;
  const width = Math.min(positiveInteger(preferredWidth, 20), maximum);
  return clampCycleWindow(maximum - width + 1, width, maximum);
}

export function timeCapacityVirginDefaultCanApply(
  isVirgin: boolean,
  pending: boolean,
  applied: boolean,
  specificCyclesActive: boolean,
  maxAvailableCycle: number | null | undefined,
): boolean {
  return (
    isVirgin &&
    pending &&
    !applied &&
    !specificCyclesActive &&
    positiveMaximum(maxAvailableCycle) !== null
  );
}

/** Apply one exact From/To edit, including the locked crossing behaviour. */
export function normalizeManualTimeCapacityRange(
  current: TimeCapacityCycleRange,
  patch: TimeCapacityCycleRangePatch,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const baseline = normalizeTimeCapacityRange(current.start, current.end, maximum);
  const hasStart = patch.start !== undefined;
  const hasEnd = patch.end !== undefined;
  let start = hasStart ? positiveInteger(patch.start, baseline.start) : baseline.start;
  let end = hasEnd ? positiveInteger(patch.end, baseline.end) : baseline.end;

  if (maximum !== null) {
    start = Math.min(start, maximum);
    end = Math.min(end, maximum);
  }

  if (hasStart && !hasEnd && start > end) end = start;
  else if (hasEnd && !hasStart && end < start) start = end;
  else if (end < start) end = start;

  return { start, end };
}

export function cycleWindowOptions(
  currentWidth: number,
  maxAvailableCycle: number | null | undefined,
): number[] {
  const maximum = positiveMaximum(maxAvailableCycle);
  const width = positiveInteger(currentWidth, 1);
  const options: number[] = TIME_CAPACITY_WINDOW_PRESETS.filter(
    (preset) => maximum === null || preset <= maximum,
  );
  if (!options.includes(width as (typeof TIME_CAPACITY_WINDOW_PRESETS)[number])) {
    options.push(width);
  }
  return [...new Set(options)].sort((left, right) => left - right);
}

export function appendTimeCapacityCycleHistory(
  history: readonly TimeCapacityCycleRange[],
  range: TimeCapacityCycleRange,
  limit = TIME_CAPACITY_HISTORY_LIMIT,
): TimeCapacityCycleRange[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const withoutDuplicate = history.filter((entry) => !cycleRangesEqual(entry, range));
  return [...withoutDuplicate, range].slice(-boundedLimit);
}

export function selectTimeCapacityCycleHistory(
  history: readonly TimeCapacityCycleRange[],
  index: number,
): { range: TimeCapacityCycleRange; history: TimeCapacityCycleRange[] } | null {
  if (!Number.isInteger(index) || index < 0 || index >= history.length) return null;
  return {
    range: history[index],
    history: history.slice(0, index),
  };
}

export function timeCapacityRangeNavigationDisabled(
  cycles: readonly number[] | null | undefined,
): boolean {
  return (cycles ?? []).length > 0;
}

export function timeCapacityCycleNavigationDisabledAtBoundary(
  range: TimeCapacityCycleRange,
  direction: -1 | 1,
  mode: "cycle" | "window",
  maxAvailableCycle: number | null | undefined,
): boolean {
  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum === null) {
    // A previous single-cycle move remains safe without an extent; forward and
    // window moves need the known upper bound to avoid an unbounded request.
    return direction === 1 || mode === "window";
  }
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  return direction === -1 ? current.start <= 1 : current.end >= maximum;
}

export function parseTimeCapacitySpecificCycles(
  input: string,
  maxAvailableCycle: number | null | undefined,
): number[] | null {
  const trimmed = input.trim();
  if (trimmed === "") return [];

  const maximum = positiveMaximum(maxAvailableCycle);
  const values = new Set<number>();
  // Normalize optional whitespace around a range dash before accepting the
  // same comma/whitespace-separated syntax as the previous single-cycle
  // parser. A range is expanded here because the backend contract stores
  // explicit cycles as a concrete list.
  const tokens = trimmed.replace(/\s*-\s*/g, "-").split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    const startText = range?.[1] ?? token;
    const endText = range?.[2] ?? token;
    if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) return null;

    const start = Number(startText);
    const end = Number(endText);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= 0 ||
      end <= 0 ||
      end < start ||
      (maximum !== null && end > maximum)
    ) {
      return null;
    }

    for (let value = start; value < end; value += 1) values.add(value);
    values.add(end);
  }

  return [...values].sort((left, right) => left - right);
}

export function timeCapacityPreviousViewDisabled(
  _cycles: readonly number[] | null | undefined,
  historyLength: number,
): boolean {
  return historyLength <= 0;
}

export function selectedTimeCapacityCycleMax(
  selectionEntries: readonly Pick<SelectionEntry, "kind" | "ref_id">[] | null | undefined,
  cells: readonly Pick<CellSummary, "id" | "total_cycles">[] | null | undefined,
  replicateGroups:
    | readonly Pick<ReplicateGroupSummary, "id" | "cell_ids">[]
    | null
    | undefined,
): number | null {
  if (!selectionEntries || !cells) return null;

  const groupById = new Map((replicateGroups ?? []).map((group) => [group.id, group]));
  const selectedCellIds = new Set<number>();
  for (const entry of selectionEntries) {
    if (entry.kind === "cell") selectedCellIds.add(entry.ref_id);
    else groupById.get(entry.ref_id)?.cell_ids.forEach((cellId) => selectedCellIds.add(cellId));
  }

  const totalsByCellId = new Map(cells.map((cell) => [cell.id, cell.total_cycles]));
  const validTotals = [...selectedCellIds]
    .map((cellId) => totalsByCellId.get(cellId))
    .filter((total): total is number => total !== undefined && Number.isFinite(total) && total > 0)
    .map((total) => Math.floor(total))
    .filter((total) => total > 0);

  return validTotals.length > 0 ? Math.max(...validTotals) : null;
}
