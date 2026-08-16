/**
 * Pure geometry for the palette editor preview.
 *
 * Keeping the sample curves and chart annotations outside the React component
 * makes the SVG contract testable without mounting the modal. The preview is
 * deliberately a fixed viewBox: the component supplies matching intrinsic
 * width and height so WebView renderers cannot collapse an auto-sized SVG.
 */

export const PALETTE_PREVIEW_WIDTH = 812;
export const PALETTE_PREVIEW_HEIGHT = 356;
export const PALETTE_PREVIEW_VIEWBOX = `0 0 ${PALETTE_PREVIEW_WIDTH} ${PALETTE_PREVIEW_HEIGHT}`;

/** Plot-area geometry for the palette preview, in viewBox units. */
export const PALETTE_PREVIEW_PLOT = { left: 78, right: 646, top: 26, bottom: 272 } as const;
const PREVIEW_DATA_MIN = -1.5;
const PREVIEW_DATA_MAX = 1.5;

/**
 * A deterministic sample curve for preview line `index` of `count`.
 *
 * Amplitude, vertical offset and period are all spread deterministically so
 * ten lines read as ten different measurements rather than one braided rope.
 * `cos(phase)` is symmetric about zero, which keeps the band of curves centred
 * instead of bunched in the top half.
 */
function palettePreviewValue(x: number, index: number, count: number): number {
  const n = Math.max(1, count);
  const spread = ((index * 7) % n) / Math.max(1, n - 1);
  const tempo = ((index * 3) % n) / Math.max(1, n - 1);
  const phase = (index / n) * Math.PI * 2;
  const amp = 0.30 + 0.46 * spread;
  const drift = 0.62 * Math.cos(phase);
  const freq = 0.48 + 0.38 * tempo;
  return (
    drift +
    amp * Math.sin(2 * Math.PI * freq * x + phase) +
    0.14 * amp * Math.sin(2 * Math.PI * (2.1 * freq) * x + phase * 1.7)
  );
}

/**
 * A smooth path for one preview line.
 *
 * Catmull-Rom converted to cubic Bezier. The control points must stay inside
 * the segment being drawn; an earlier version placed the second control point
 * past the endpoint, so every one of the 80 segments overshot and doubled
 * back, which is what made the lines look dotted.
 */
export function palettePreviewPath(index: number, count: number): string {
  const steps = 64;
  const pts: Array<[number, number]> = [];
  for (let step = 0; step <= steps; step += 1) {
    const x = step / steps;
    const v = palettePreviewValue(x, index, count);
    const y =
      PALETTE_PREVIEW_PLOT.bottom -
      ((v - PREVIEW_DATA_MIN) / (PREVIEW_DATA_MAX - PREVIEW_DATA_MIN)) *
        (PALETTE_PREVIEW_PLOT.bottom - PALETTE_PREVIEW_PLOT.top);
    pts.push([
      PALETTE_PREVIEW_PLOT.left + x * (PALETTE_PREVIEW_PLOT.right - PALETTE_PREVIEW_PLOT.left),
      Math.max(PALETTE_PREVIEW_PLOT.top, Math.min(PALETTE_PREVIEW_PLOT.bottom, y)),
    ]);
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = i > 0 ? pts[i - 1] : pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)},${c2x.toFixed(2)},${c2y.toFixed(2)},${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/**
 * Generate grid, axis, and legend elements for the palette preview chart.
 * Uses PALETTE_PREVIEW_PLOT geometry so the grid can never drift from the
 * curves.
 */
export function generatePalettePreviewChartElements(colors: readonly string[]) {
  const gridLines: Array<{
    type: "vertical" | "horizontal";
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }> = [];

  // Vertical gridlines at x ticks 0,2,4,6,8,10
  const xTicks = [0, 2, 4, 6, 8, 10];
  for (const tick of xTicks) {
    const x = PALETTE_PREVIEW_PLOT.left + (tick / 10) * (PALETTE_PREVIEW_PLOT.right - PALETTE_PREVIEW_PLOT.left);
    gridLines.push({ type: "vertical", x1: x, y1: PALETTE_PREVIEW_PLOT.top, x2: x, y2: PALETTE_PREVIEW_PLOT.bottom });
  }

  // Horizontal gridlines at y ticks -1.5,-1.0,-0.5,0,0.5,1.0,1.5
  const yTicks = [-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5];
  for (const tick of yTicks) {
    const yNorm = (tick - PREVIEW_DATA_MIN) / (PREVIEW_DATA_MAX - PREVIEW_DATA_MIN);
    const y = PALETTE_PREVIEW_PLOT.bottom - yNorm * (PALETTE_PREVIEW_PLOT.bottom - PALETTE_PREVIEW_PLOT.top);
    gridLines.push({ type: "horizontal", x1: PALETTE_PREVIEW_PLOT.left, y1: y, x2: PALETTE_PREVIEW_PLOT.right, y2: y });
  }

  // Axes: left (y), bottom (x), and baseline (y=0)
  const axes = [
    { type: "left", x1: PALETTE_PREVIEW_PLOT.left, y1: PALETTE_PREVIEW_PLOT.top, x2: PALETTE_PREVIEW_PLOT.left, y2: PALETTE_PREVIEW_PLOT.bottom }, // Y axis
    { type: "bottom", x1: PALETTE_PREVIEW_PLOT.left, y1: PALETTE_PREVIEW_PLOT.bottom, x2: PALETTE_PREVIEW_PLOT.right, y2: PALETTE_PREVIEW_PLOT.bottom }, // X axis
    // Zero line at y = 0
    {
      type: "baseline",
      x1: PALETTE_PREVIEW_PLOT.left,
      y1: PALETTE_PREVIEW_PLOT.bottom - ((0 - PREVIEW_DATA_MIN) / (PREVIEW_DATA_MAX - PREVIEW_DATA_MIN)) * (PALETTE_PREVIEW_PLOT.bottom - PALETTE_PREVIEW_PLOT.top),
      x2: PALETTE_PREVIEW_PLOT.right,
      y2: PALETTE_PREVIEW_PLOT.bottom - ((0 - PREVIEW_DATA_MIN) / (PREVIEW_DATA_MAX - PREVIEW_DATA_MIN)) * (PALETTE_PREVIEW_PLOT.bottom - PALETTE_PREVIEW_PLOT.top),
    },
  ];

  // Y axis tick labels: right-aligned at x=(left - 12), vertically centered
  const yTickLabels: Array<{ x: number; y: number; text: string }> = [];
  for (const tick of yTicks) {
    const yNorm = (tick - PREVIEW_DATA_MIN) / (PREVIEW_DATA_MAX - PREVIEW_DATA_MIN);
    const y = PALETTE_PREVIEW_PLOT.bottom - yNorm * (PALETTE_PREVIEW_PLOT.bottom - PALETTE_PREVIEW_PLOT.top);
    yTickLabels.push({ x: PALETTE_PREVIEW_PLOT.left - 12, y, text: tick.toFixed(1) });
  }

  // X axis tick labels at y=(bottom + 28), centered at each x tick position
  const xTickLabels: Array<{ x: number; y: number; text: string }> = [];
  for (const tick of xTicks) {
    const x = PALETTE_PREVIEW_PLOT.left + (tick / 10) * (PALETTE_PREVIEW_PLOT.right - PALETTE_PREVIEW_PLOT.left);
    xTickLabels.push({ x, y: PALETTE_PREVIEW_PLOT.bottom + 28, text: tick.toFixed(0) });
  }

  // Legend: line sample from x=676 to x=702, label at x=710, first entry at y=40, step 24
  const legendEntries: Array<{ color: string; label: string }> = [];
  const maxLegendItems = 12;
  for (let i = 0; i < Math.min(colors.length, maxLegendItems); i++) {
    legendEntries.push({ color: colors[i], label: `Series ${i + 1}` });
  }
  if (colors.length > maxLegendItems) {
    legendEntries.push({ color: "transparent", label: `+${colors.length - maxLegendItems} more` });
  }

  return { gridLines, axes, yTickLabels, xTickLabels, legendEntries };
}
