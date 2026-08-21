export interface TimeCapacityPlotStrategyBenchmarkResult {
  benchmark_version: 1;
  series_count: number;
  points_per_series: number;
  passes: number;
  strategy_a_react_plotly_react_ms: number[];
  strategy_b_plotly_add_traces_ms: number[];
  median_a_ms: number;
  median_b_ms: number;
  final_figures_equal: boolean;
  selected_strategy: "react_plotly_react";
}

export const SELECTED_TIME_CAPACITY_PLOT_STRATEGY = "react_plotly_react" as const;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function benchmarkData(seriesCount: number, pointsPerSeries: number): Plotly.Data[] {
  return Array.from({ length: seriesCount }, (_, seriesIndex) => ({
    type: "scatter",
    mode: "lines",
    name: `series-${seriesIndex + 1}`,
    x: Array.from({ length: pointsPerSeries }, (_, point) => point),
    y: Array.from(
      { length: pointsPerSeries },
      (_, point) => Math.sin(point / 20) + seriesIndex / 10,
    ),
  } as Plotly.Data));
}

/**
 * Diagnostic browser benchmark for the two safe progressive update shapes.
 * It is intentionally opt-in and uses synthetic, non-scientific traces.
 */
export async function benchmarkTimeCapacityPlotStrategies(options: {
  seriesCount?: number;
  pointsPerSeries?: number;
  passes?: number;
} = {}): Promise<TimeCapacityPlotStrategyBenchmarkResult> {
  if (typeof document === "undefined") {
    throw new Error("The Plotly strategy benchmark requires a browser document.");
  }
  const seriesCount = Math.max(1, Math.min(50, Math.floor(options.seriesCount ?? 12)));
  const pointsPerSeries = Math.max(20, Math.min(5000, Math.floor(options.pointsPerSeries ?? 400)));
  const passes = Math.max(1, Math.min(7, Math.floor(options.passes ?? 3)));
  const PlotlyLib = (await import("plotly.js-dist-min")).default as unknown as {
    newPlot: (target: HTMLElement, data: Plotly.Data[], layout: Plotly.Layout, config?: object) => Promise<unknown>;
    react: (target: HTMLElement, data: Plotly.Data[], layout: Plotly.Layout, config?: object) => Promise<unknown>;
    addTraces: (target: HTMLElement, data: Plotly.Data[]) => Promise<unknown>;
    purge: (target: HTMLElement) => void;
  };
  const data = benchmarkData(seriesCount, pointsPerSeries);
  const layout = {
    width: 800,
    height: 420,
    showlegend: false,
    margin: { l: 40, r: 20, t: 10, b: 30 },
  } as Plotly.Layout;
  const config = { staticPlot: true, displayModeBar: false };
  const aTimes: number[] = [];
  const bTimes: number[] = [];
  let finalFiguresEqual = false;

  for (let pass = 0; pass < passes; pass += 1) {
    const a = document.createElement("div");
    const b = document.createElement("div");
    a.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:800px;height:420px";
    b.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:800px;height:420px";
    document.body.append(a, b);
    try {
      await PlotlyLib.newPlot(a, [], layout, config);
      const aStart = performance.now();
      const aData: Plotly.Data[] = [];
      for (const trace of data) {
        aData.push(trace);
        await PlotlyLib.react(a, aData, layout, config);
      }
      aTimes.push(performance.now() - aStart);

      await PlotlyLib.newPlot(b, [], layout, config);
      const bStart = performance.now();
      for (const trace of data) await PlotlyLib.addTraces(b, [trace]);
      bTimes.push(performance.now() - bStart);
      finalFiguresEqual = JSON.stringify((a as unknown as { data: unknown }).data) ===
        JSON.stringify((b as unknown as { data: unknown }).data);
    } finally {
      PlotlyLib.purge(a);
      PlotlyLib.purge(b);
      a.remove();
      b.remove();
    }
  }

  return {
    benchmark_version: 1,
    series_count: seriesCount,
    points_per_series: pointsPerSeries,
    passes,
    strategy_a_react_plotly_react_ms: aTimes,
    strategy_b_plotly_add_traces_ms: bTimes,
    median_a_ms: median(aTimes),
    median_b_ms: median(bTimes),
    final_figures_equal: finalFiguresEqual,
    selected_strategy: SELECTED_TIME_CAPACITY_PLOT_STRATEGY,
  };
}
