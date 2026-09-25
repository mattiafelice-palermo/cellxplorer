export type PreviewCycleWindow = { start: number; end: number };

/** Shift the visible cycle window by its span, clamping both ends at the data bounds. */
export function shiftPreviewCycleWindow(
  window: PreviewCycleWindow,
  cycleCount: number,
  direction: -1 | 1,
): PreviewCycleWindow {
  if (cycleCount < 1) return { start: 0, end: 0 };
  const start = Math.max(1, Math.min(Math.trunc(window.start), cycleCount));
  const end = Math.max(start, Math.min(Math.trunc(window.end), cycleCount));
  const step = Math.max(1, end - start);
  return direction < 0
    ? { start: Math.max(1, start - step), end: Math.max(1, end - step) }
    : { start: Math.min(cycleCount, start + step), end: Math.min(cycleCount, end + step) };
}
