import assert from "node:assert/strict";
import test from "node:test";
import { cellPreviewVoltageTraces } from "../src/components/cellPreviewPlotModel.ts";

test("voltage and current previews break both coordinates between executions", () => {
  const traces = cellPreviewVoltageTraces([{
    x: [0, 1, 10, 11], voltage: [3, 4, 3.1, 4.1], current: [1, 1, 2, 2],
    breakBefore: [2],
  }]);
  assert.deepEqual(traces[0].x, [0, 1, null, 10, 11]);
  assert.deepEqual(traces[0].y, [3, 4, null, 3.1, 4.1]);
  assert.deepEqual(traces[1].x, traces[0].x);
  assert.deepEqual(traces[1].y, [1, 1, null, 2, 2]);
  assert.ok(traces.every((trace) => trace.connectgaps === false));
});
