import assert from "node:assert/strict";
import test from "node:test";
import type { TimeCapacityResult } from "../src/api.ts";
import { secondsResultInDays } from "../src/plotTimeUnits.ts";

test("legacy seconds convert to days for both the plot and zoom extents", () => {
  const trace = { display_x: [-108000, null, 216000], display_cycle_spans: { "1": [0, 86400] }, time_s: [86400] };
  const input = { settings: { time_unit: "s" }, cell_traces: [trace] } as unknown as TimeCapacityResult;
  const result = secondsResultInDays(input);
  assert.equal(result.settings.time_unit, "d");
  assert.deepEqual(result.cell_traces[0].display_x, [-1.25, null, 2.5]);
  assert.deepEqual(result.cell_traces[0].display_cycle_spans, { "1": [0, 1] });
  assert.deepEqual(result.cell_traces[0].time_s, [86400]);
  assert.equal(input.settings.time_unit, "s");
});
