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

export interface TimeCapacityBufferTrace {
  cycle: (number | null)[];
  display_x?: (number | null)[];
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
  if (!traces || traces.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const trace of traces) {
    const cycles = trace.cycle;
    const xs = trace.display_x;
    if (!cycles || !xs) continue;
    const length = Math.min(cycles.length, xs.length);
    for (let index = 0; index < length; index += 1) {
      const cycle = cycles[index];
      if (cycle === null || cycle < start || cycle > end) continue;
      const x = xs[index];
      if (x === null || !Number.isFinite(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= min) {
    // A degenerate span (one point, or all points at one coordinate) would
    // make Plotly pick its own range. Give it a small symmetric window.
    const pad = Math.max(Math.abs(min) * 1e-6, 1e-6);
    return [min - pad, max + pad];
  }
  return [min, max];
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
