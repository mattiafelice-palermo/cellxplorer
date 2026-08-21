import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  progressiveAxisLayout,
  timeCapacityProgressiveFrameForTraces,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityRenderingPolicy.ts";
import type { PlotStyle } from "../src/api.ts";

const autoAxis = { mode: "auto" } as PlotStyle["x_axis"];

test("progressive frame keeps flat and stacked extents fixed after a broader arrival", () => {
  const firstTraces = [
    { x: [0, 1], y: [3.4, 3.8], type: "scatter" },
    { x: [0, 1], y: [0.5, 1.5], yaxis: "y2", type: "scatter" },
    { x: [0, 1], y: [0.25, 1.25], yaxis: "y3", type: "scatter" },
  ] as Plotly.Data[];
  const laterTraces = [
    ...firstTraces,
    { x: [-4, 12], y: [2.0, 8.0], type: "scatter" },
    { x: [-4, 12], y: [-5, 9], yaxis: "y3", type: "scatter" },
  ] as Plotly.Data[];
  const frame = timeCapacityProgressiveFrameForTraces(firstTraces, true);

  assert.deepEqual(frame.xRange, [0, 1]);
  assert.deepEqual(frame.yRange, [3.4, 3.8]);
  assert.deepEqual(frame.y2Range, [0.25, 1.5]);
  assert.equal(frame.hasRightCurrent, true);
  assert.deepEqual(
    progressiveAxisLayout(autoAxis, [2, 8], frame.yRange).range,
    [3.4, 3.8],
  );
  assert.deepEqual(
    progressiveAxisLayout(autoAxis, [2, 9], frame.y2Range).range,
    [0.25, 1.5],
  );
  assert.deepEqual(
    progressiveAxisLayout(autoAxis, [2, 12], frame.xRange).range,
    [0, 1],
  );
  // The later traces are intentionally broader; the captured ranges, not
  // their extents, are the values passed to the partial layout.
  assert.notDeepEqual(frame.yRange, [2, 8]);
  assert.notDeepEqual(frame.y2Range, [ -5, 9]);
  assert.ok(laterTraces.length > firstTraces.length);
});

test("manual axis bounds continue to take precedence over the progressive frame", () => {
  const manualAxis = {
    mode: "manual",
    min: 0,
    max: 10,
  } as PlotStyle["x_axis"];
  assert.deepEqual(
    progressiveAxisLayout(manualAxis, [2, 8], [3, 4]).range,
    [0, 10],
  );
});

test("Time/Capacity replacement never dims the whole retained plot", () => {
  const source = readFileSync(
    new URL(
      "../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /opacity:\s*timeResult\.isFetching/);
  assert.doesNotMatch(source, /transition:\s*["']opacity/);
  assert.match(source, /compatible result remains fully readable/);
});

test("strategy benchmark uses mounted production input and visible-update measurements", () => {
  const source = readFileSync(
    new URL(
      "../src/features/analyses/editor/performance/timeCapacityPlotStrategyBenchmark.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /registerTimeCapacityPlotStrategyBenchmarkInput/);
  assert.match(source, /build_progressive_frame/);
  assert.match(source, /build_partial/);
  assert.match(source, /partial_visible_completion_ms/);
  assert.match(source, /event_to_visible_ms/);
  assert.match(source, /ordinary_control_ms/);
  assert.match(source, /addTraces/);
  assert.doesNotMatch(source, /staticPlot/);
  assert.doesNotMatch(source, /function benchmarkData/);
});
