export type PlotWheelMode = "pan" | "zoom";
export type NumericPlotRange = readonly [number, number];

type WheelGesture = {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  timeStamp: number;
};

const DOM_DELTA_PIXEL = 0;
export const PLOT_WHEEL_GESTURE_GAP_MS = 180;
const PIXEL_TOUCHPAD_THRESHOLD = 50;

/**
 * Chromium exposes both wheel mice and precision touchpads as WheelEvents.
 * A gesture is classified from its first event and retained for the burst so
 * a fast touchpad swipe cannot change from pan to zoom halfway through.
 */
export function plotWheelMode(
  event: WheelGesture,
  previous: { mode: PlotWheelMode; at: number } | null = null,
): PlotWheelMode {
  if (event.ctrlKey) return "zoom"; // touchpad pinch is Ctrl+wheel in Chromium
  if (previous && event.timeStamp - previous.at < PLOT_WHEEL_GESTURE_GAP_MS) {
    return previous.mode;
  }
  if (event.deltaMode !== DOM_DELTA_PIXEL) return "zoom";
  if (Math.abs(event.deltaX) > 0) return "pan";
  return Math.abs(event.deltaY) < PIXEL_TOUCHPAD_THRESHOLD ? "pan" : "zoom";
}

export function panPlotRange(
  range: NumericPlotRange,
  pixelDelta: number,
  pixelLength: number,
): NumericPlotRange {
  if (!Number.isFinite(pixelDelta) || !Number.isFinite(pixelLength) || pixelLength <= 0) {
    return range;
  }
  const shift = (pixelDelta / pixelLength) * (range[1] - range[0]);
  return [range[0] + shift, range[1] + shift];
}

export function zoomPlotRange(
  range: NumericPlotRange,
  anchorFraction: number,
  factor: number,
): NumericPlotRange {
  if (!Number.isFinite(factor) || factor <= 0) return range;
  const fraction = Math.min(1, Math.max(0, anchorFraction));
  const anchor = range[0] + (range[1] - range[0]) * fraction;
  return [
    anchor - (anchor - range[0]) * factor,
    anchor + (range[1] - anchor) * factor,
  ];
}
