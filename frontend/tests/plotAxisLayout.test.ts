import assert from "node:assert/strict";
import test from "node:test";

import type { PlotAxisStyle } from "../src/api.ts";
import { axisLayout, axisManualRangeShowsData } from "../src/features/analyses/editor/plotting/plotAxisLayout.ts";

const manualAxis: PlotAxisStyle = {
  mode: "manual",
  min: 0,
  max: 100,
  tick_mode: "step",
  dtick: 10,
  tick_count: null,
  title_standoff: 14,
  tick_label_standoff: 4,
};

test("axisManualRangeShowsData detects overlap with trace bounds", () => {
  assert.equal(axisManualRangeShowsData(manualAxis, [20, 80]), true);
  assert.equal(axisManualRangeShowsData(manualAxis, [150, 200]), false);
  assert.equal(axisManualRangeShowsData(manualAxis, [50, 50]), true);
  assert.equal(axisManualRangeShowsData({ ...manualAxis, mode: "auto" }, [150, 200]), true);
});

test("axisLayout falls back to auto ranges when manual window hides all data", () => {
  const pinned = axisLayout(manualAxis, [0, 50]);
  assert.deepEqual(pinned.range, [0, 100]);
  assert.equal(pinned.autorange, false);

  const hidden = axisLayout(manualAxis, [200, 300]);
  assert.equal(hidden.range, undefined);
  assert.equal(hidden.autorange, undefined);
  assert.equal(hidden.dtick, undefined);
});

test("axisLayout keeps one-sided manual clamps when data is visible", () => {
  const axis: PlotAxisStyle = { ...manualAxis, max: null };
  const layout = axisLayout(axis, [50, 120]);
  assert.equal(layout.autorange, true);
  assert.deepEqual(layout.autorangeoptions, { minallowed: 0 });
});
