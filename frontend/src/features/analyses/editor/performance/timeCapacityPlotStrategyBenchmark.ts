import type { TimeCapacityProgressiveFrame } from "../families/time-capacity/timeCapacityRenderingPolicy";

export type TimeCapacityPlotStrategy = "react_plotly_react" | "plotly_add_traces";

export interface TimeCapacityBenchmarkRender {
  data: Plotly.Data[];
  layout: Partial<Plotly.Layout>;
}

/**
 * A live, complete Time/Capacity result plus the canonical production
 * builders for that result. The benchmark is deliberately fed by the
 * mounted plot card rather than fabricating traces or a synthetic request.
 */
export interface TimeCapacityPlotStrategyBenchmarkInput {
  analysis_id: number;
  data_signature?: string;
  source_data_signature?: string;
  total_series: number;
  build_progressive_frame: () => TimeCapacityProgressiveFrame | undefined;
  build_partial: (
    completedSeries: number,
    frame: TimeCapacityProgressiveFrame | undefined,
  ) => TimeCapacityBenchmarkRender;
  build_complete: () => TimeCapacityBenchmarkRender;
}

export interface TimeCapacityPlotStrategyRun {
  request_start_ms: number;
  series_received_ms: number[];
  partial_visible_completion_ms: number[];
  event_to_visible_ms: number[];
  first_useful_ms?: number;
  per_arrival_update_ms: number[];
  median_update_ms: number;
  max_update_ms: number;
  final_series_received_ms?: number;
  final_metadata_received_ms?: number;
  final_plotly_completion_ms?: number;
  total_interaction_ms?: number;
  scientific_series_event_count: number;
  partial_visible_update_count: number;
  newplot_count: number;
  remount_count: number;
  zoom_preserved: boolean;
  final_trace_metadata_equal: boolean;
  final_trace_count: number;
}

export interface TimeCapacityPlotStrategyBenchmarkResult {
  benchmark_version: 2;
  representative_request: {
    analysis_id: number;
    data_signature?: string;
    source_data_signature?: string;
    total_series: number;
    installed_plotly_runtime: string;
  };
  passes: number;
  strategy_a_react_plotly_react: TimeCapacityPlotStrategyRun[];
  strategy_b_plotly_add_traces: TimeCapacityPlotStrategyRun[];
  ordinary_control_ms: number[];
  median_a_final_ms: number;
  median_b_final_ms: number;
  median_control_ms: number;
  final_figures_equal: boolean;
  final_trace_metadata_equal: boolean;
  selected_strategy: "react_plotly_react";
}

export const SELECTED_TIME_CAPACITY_PLOT_STRATEGY = "react_plotly_react" as const;

type PlotlyRuntime = {
  version?: string;
  newPlot: (
    target: HTMLElement,
    data: Plotly.Data[],
    layout: Partial<Plotly.Layout>,
    config?: object,
  ) => Promise<unknown>;
  react: (
    target: HTMLElement,
    data: Plotly.Data[],
    layout: Partial<Plotly.Layout>,
    config?: object,
  ) => Promise<unknown>;
  addTraces: (target: HTMLElement, data: Plotly.Data[]) => Promise<unknown>;
  relayout: (target: HTMLElement, update: Record<string, unknown>) => Promise<unknown>;
  purge: (target: HTMLElement) => void;
};

type PlotlyGraph = HTMLElement & {
  data?: Plotly.Data[];
  _fullLayout?: Record<string, unknown>;
};

let benchmarkInput: TimeCapacityPlotStrategyBenchmarkInput | null = null;
let benchmarkInputToken = 0;

export function registerTimeCapacityPlotStrategyBenchmarkInput(
  input: TimeCapacityPlotStrategyBenchmarkInput,
): () => void {
  const token = ++benchmarkInputToken;
  benchmarkInput = input;
  return () => {
    if (benchmarkInputToken === token) benchmarkInput = null;
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function finiteRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const first = Number(value[0]);
  const second = Number(value[1]);
  return Number.isFinite(first) && Number.isFinite(second) ? [first, second] : undefined;
}

function graphAxisRange(graph: PlotlyGraph, axis: string): [number, number] | undefined {
  const value = graph._fullLayout?.[axis] as { range?: unknown } | undefined;
  return finiteRange(value?.range);
}

type BenchmarkZoom = {
  x?: [number, number];
  x2?: [number, number];
  y?: [number, number];
  y2?: [number, number];
  y3?: [number, number];
};

async function applyDiagnosticZoom(
  graph: PlotlyGraph,
  PlotlyLib: PlotlyRuntime,
): Promise<BenchmarkZoom> {
  const x = graphAxisRange(graph, "xaxis");
  const x2 = graphAxisRange(graph, "xaxis2");
  const y = graphAxisRange(graph, "yaxis");
  const y2 = graphAxisRange(graph, "yaxis2");
  const y3 = graphAxisRange(graph, "yaxis3");
  const update: Record<string, unknown> = {};
  const zoom = (range: [number, number] | undefined) =>
    range
      ? [
          range[0] + (range[1] - range[0]) * 0.2,
          range[0] + (range[1] - range[0]) * 0.8,
        ] as [number, number]
      : undefined;
  const zoomedX = zoom(x);
  const zoomedX2 = zoom(x2 ?? x);
  const zoomedY = zoom(y);
  const zoomedY2 = zoom(y2);
  const zoomedY3 = zoom(y3);
  if (zoomedX) update["xaxis.range"] = zoomedX;
  if (zoomedX2 && x2) update["xaxis2.range"] = zoomedX2;
  if (zoomedY) update["yaxis.range"] = zoomedY;
  if (zoomedY2) update["yaxis2.range"] = zoomedY2;
  if (zoomedY3) update["yaxis3.range"] = zoomedY3;
  if (Object.keys(update).length === 0) return {};
  await PlotlyLib.relayout(graph, update);
  return { x: zoomedX, x2: zoomedX2, y: zoomedY, y2: zoomedY2, y3: zoomedY3 };
}

function applyZoomToLayout(
  layout: Partial<Plotly.Layout>,
  zoom: BenchmarkZoom,
): Partial<Plotly.Layout> {
  if (!zoom.x && !zoom.x2 && !zoom.y && !zoom.y2 && !zoom.y3) return layout;
  const x = zoom.x2 ?? zoom.x;
  const x2 = zoom.x2 ?? zoom.x;
  return {
    ...layout,
    ...(x
      ? { xaxis: { ...(layout.xaxis ?? {}), range: [...x], autorange: false } }
      : {}),
    ...(x2 && layout.xaxis2
      ? { xaxis2: { ...(layout.xaxis2 ?? {}), range: [...x2], autorange: false } }
      : {}),
    ...(zoom.y
      ? { yaxis: { ...(layout.yaxis ?? {}), range: [...zoom.y], autorange: false } }
      : {}),
    ...(zoom.y2 && layout.yaxis2
      ? { yaxis2: { ...(layout.yaxis2 ?? {}), range: [...zoom.y2], autorange: false } }
      : {}),
    ...(zoom.y3 && layout.yaxis3
      ? { yaxis3: { ...(layout.yaxis3 ?? {}), range: [...zoom.y3], autorange: false } }
      : {}),
  };
}

function traceMetadata(data: Plotly.Data[] | undefined): unknown[] {
  return (data ?? []).map((raw) => {
    const trace = raw as Record<string, unknown>;
    const line = trace.line as Record<string, unknown> | undefined;
    const marker = trace.marker as Record<string, unknown> | undefined;
    return {
      type: trace.type,
      name: trace.name,
      legendgroup: trace.legendgroup,
      showlegend: trace.showlegend,
      legendrank: trace.legendrank,
      xaxis: trace.xaxis,
      yaxis: trace.yaxis,
      opacity: trace.opacity,
      line: line
        ? { color: line.color, width: line.width, dash: line.dash, shape: line.shape }
        : undefined,
      marker: marker
        ? { color: marker.color, size: marker.size, symbol: marker.symbol }
        : undefined,
      x: trace.x,
      y: trace.y,
    };
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plotlyRuntimeVersion(PlotlyLib: PlotlyRuntime): string {
  return typeof PlotlyLib.version === "string" && PlotlyLib.version.length > 0
    ? PlotlyLib.version
    : "plotly.js-dist-min";
}

async function runStrategy(
  input: TimeCapacityPlotStrategyBenchmarkInput,
  PlotlyLib: PlotlyRuntime,
  strategy: TimeCapacityPlotStrategy,
): Promise<TimeCapacityPlotStrategyRun> {
  const frame = input.build_progressive_frame();
  const graph = document.createElement("div") as PlotlyGraph;
  graph.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1200px;height:620px";
  document.body.append(graph);
  const config = {
    displaylogo: false,
    edits: { legendPosition: true },
    displayModeBar: false,
  };
  const requestStart = performance.now();
  const seriesReceived: number[] = [];
  const visibleCompletion: number[] = [];
  const eventToVisible: number[] = [];
  const updateDurations: number[] = [];
  let zoom: BenchmarkZoom = {};
  let previousData: Plotly.Data[] = [];
  let newplotCount = 0;
  try {
    for (let index = 1; index <= input.total_series; index += 1) {
      const receivedAt = performance.now();
      seriesReceived.push(receivedAt - requestStart);
      const render = input.build_partial(index, frame);
      const layout = applyZoomToLayout(render.layout, zoom);
      const updateStarted = performance.now();
      if (index === 1) {
        newplotCount += 1;
        await PlotlyLib.newPlot(graph, render.data, layout, config);
      } else if (strategy === "react_plotly_react") {
        await PlotlyLib.react(graph, render.data, layout, config);
      } else {
        const newData = render.data.slice(previousData.length);
        if (newData.length > 0) await PlotlyLib.addTraces(graph, newData);
      }
      const visibleAt = performance.now();
      visibleCompletion.push(visibleAt - requestStart);
      eventToVisible.push(visibleAt - receivedAt);
      updateDurations.push(visibleAt - updateStarted);
      previousData = render.data;
      if (index === 1) zoom = await applyDiagnosticZoom(graph, PlotlyLib);
    }

    const finalSeriesReceived = seriesReceived[seriesReceived.length - 1];
    const completeStarted = performance.now();
    const complete = input.build_complete();
    const finalMetadataReceived = completeStarted - requestStart;
    const finalLayout = applyZoomToLayout(complete.layout, zoom);
    await PlotlyLib.react(graph, complete.data, finalLayout, config);
    const finalPlotlyCompletion = performance.now() - requestStart;
    const finalGraphX = graphAxisRange(graph, "xaxis");
    const finalGraphX2 = graphAxisRange(graph, "xaxis2");
    const finalGraphY = graphAxisRange(graph, "yaxis");
    const finalGraphY2 = graphAxisRange(graph, "yaxis2");
    const finalGraphY3 = graphAxisRange(graph, "yaxis3");
    const zoomPreserved =
      (!zoom.x || sameJson(finalGraphX, zoom.x)) &&
      (!zoom.x2 || sameJson(finalGraphX2, zoom.x2)) &&
      (!zoom.y || sameJson(finalGraphY, zoom.y)) &&
      (!zoom.y2 || sameJson(finalGraphY2, zoom.y2)) &&
      (!zoom.y3 || sameJson(finalGraphY3, zoom.y3));
    const finalTraceMetadataEqual = sameJson(traceMetadata(graph.data), traceMetadata(complete.data));
    return {
      request_start_ms: requestStart,
      series_received_ms: seriesReceived,
      partial_visible_completion_ms: visibleCompletion,
      event_to_visible_ms: eventToVisible,
      first_useful_ms: visibleCompletion[0],
      per_arrival_update_ms: updateDurations,
      median_update_ms: median(updateDurations),
      max_update_ms: Math.max(...updateDurations, 0),
      final_series_received_ms: finalSeriesReceived,
      final_metadata_received_ms: finalMetadataReceived,
      final_plotly_completion_ms: finalPlotlyCompletion,
      total_interaction_ms: finalPlotlyCompletion,
      scientific_series_event_count: input.total_series,
      partial_visible_update_count: visibleCompletion.length,
      newplot_count: newplotCount,
      remount_count: 0,
      zoom_preserved: zoomPreserved,
      final_trace_metadata_equal: finalTraceMetadataEqual,
      final_trace_count: graph.data?.length ?? 0,
    };
  } finally {
    PlotlyLib.purge(graph);
    graph.remove();
  }
}

async function runOrdinaryControl(
  input: TimeCapacityPlotStrategyBenchmarkInput,
  PlotlyLib: PlotlyRuntime,
): Promise<number> {
  const graph = document.createElement("div") as PlotlyGraph;
  graph.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1200px;height:620px";
  document.body.append(graph);
  try {
    const started = performance.now();
    const complete = input.build_complete();
    await PlotlyLib.newPlot(graph, complete.data, complete.layout, {
      displaylogo: false,
      edits: { legendPosition: true },
      displayModeBar: false,
    });
    return performance.now() - started;
  } finally {
    PlotlyLib.purge(graph);
    graph.remove();
  }
}

export async function benchmarkTimeCapacityPlotStrategies(
  input: TimeCapacityPlotStrategyBenchmarkInput | null = benchmarkInput,
  options: { passes?: number } = {},
): Promise<TimeCapacityPlotStrategyBenchmarkResult> {
  if (typeof document === "undefined") {
    throw new Error("The Plotly strategy benchmark requires a browser document.");
  }
  if (!input) {
    throw new Error("Open a complete Time/Capacity plot before running its representative benchmark.");
  }
  if (input.total_series < 1) {
    throw new Error("The representative Time/Capacity request has no scientific series.");
  }
  const passes = Math.max(1, Math.min(5, Math.floor(options.passes ?? 3)));
  const PlotlyLib = (await import("plotly.js-dist-min")).default as unknown as PlotlyRuntime;
  const strategyA: TimeCapacityPlotStrategyRun[] = [];
  const strategyB: TimeCapacityPlotStrategyRun[] = [];
  const controls: number[] = [];
  let finalFiguresEqual = true;
  let finalTraceMetadataEqual = true;

  for (let pass = 0; pass < passes; pass += 1) {
    const a = await runStrategy(input, PlotlyLib, "react_plotly_react");
    const b = await runStrategy(input, PlotlyLib, "plotly_add_traces");
    strategyA.push(a);
    strategyB.push(b);
    controls.push(await runOrdinaryControl(input, PlotlyLib));
    finalFiguresEqual &&= a.final_trace_count === b.final_trace_count &&
      a.final_trace_metadata_equal && b.final_trace_metadata_equal;
    finalTraceMetadataEqual &&= a.final_trace_metadata_equal && b.final_trace_metadata_equal;
  }

  return {
    benchmark_version: 2,
    representative_request: {
      analysis_id: input.analysis_id,
      data_signature: input.data_signature,
      source_data_signature: input.source_data_signature,
      total_series: input.total_series,
      installed_plotly_runtime: plotlyRuntimeVersion(PlotlyLib),
    },
    passes,
    strategy_a_react_plotly_react: strategyA,
    strategy_b_plotly_add_traces: strategyB,
    ordinary_control_ms: controls,
    median_a_final_ms: median(strategyA.map((run) => run.total_interaction_ms ?? 0)),
    median_b_final_ms: median(strategyB.map((run) => run.total_interaction_ms ?? 0)),
    median_control_ms: median(controls),
    final_figures_equal: finalFiguresEqual,
    final_trace_metadata_equal: finalTraceMetadataEqual,
    selected_strategy: SELECTED_TIME_CAPACITY_PLOT_STRATEGY,
  };
}
