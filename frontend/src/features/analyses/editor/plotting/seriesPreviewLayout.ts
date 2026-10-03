/** Fit a scientific figure in Series Appearance without clipping its annotation key. */
export function seriesAppearancePreviewLayout(layout: Record<string, unknown>, width: number, height: number) {
  const margin = layout.margin as Partial<Plotly.Margin> | undefined;
  return {
    ...layout,
    autosize: false, width, height, showlegend: false, legend: undefined,
    margin: { l: 64, r: 64, t: Math.max(16, margin?.t ?? 0), b: 56 },
  };
}
