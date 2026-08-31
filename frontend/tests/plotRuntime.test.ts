import assert from "node:assert/strict";
import test from "node:test";

import {
  blockPlotlyLegendVisibility,
  disablePlotlyLegendVisibility,
} from "../src/features/analyses/editor/policies/analysisVisibility.ts";

test("the shared Plotly legend policy blocks click and double-click mutations", () => {
  assert.equal(blockPlotlyLegendVisibility(), false);
  assert.deepEqual(
    disablePlotlyLegendVisibility({
      legend: { orientation: "h", itemclick: "toggleothers", itemdoubleclick: "toggle" },
      height: 400,
    }),
    {
      legend: { orientation: "h", itemclick: false, itemdoubleclick: false },
      height: 400,
    },
  );
});

test("legend policy supplies a passive legend even when a plot has no layout", () => {
  assert.deepEqual(disablePlotlyLegendVisibility(undefined), {
    legend: { itemclick: false, itemdoubleclick: false },
  });
});
