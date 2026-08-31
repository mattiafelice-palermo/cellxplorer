import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AnalysisSpec } from "../src/api.ts";
import {
  DEFAULT_PLOT_STYLE,
  normalizePlotStyle,
  plotStylePresetFamilyForTab,
} from "../src/features/analyses/editor/plotting/plotStyle.ts";
import { simpleCartesianLayout } from "../src/features/analyses/editor/plotting/plotLayout.ts";

const spec = { presentation: { legend: true } } as AnalysisSpec;
const traces = [
  { type: "scatter", x: [1, 2, 3], y: [10, 20, 30] },
] as Plotly.Data[];

test("simple plot families apply manual ranges, ticks, title gaps, and legend margins", () => {
  const style = normalizePlotStyle({
    ...DEFAULT_PLOT_STYLE,
    x_axis: {
      ...DEFAULT_PLOT_STYLE.x_axis,
      mode: "manual",
      min: 1,
      max: 3,
      tick_mode: "step",
      dtick: 1,
      title_standoff: 24,
    },
    y_axis: {
      ...DEFAULT_PLOT_STYLE.y_axis,
      mode: "manual",
      min: 10,
      max: 30,
      tick_mode: "count",
      tick_count: 3,
      title_standoff: 28,
    },
    legend_mode: "outside",
    legend_side: "right",
  });
  const layout = simpleCartesianLayout(style, spec, {
    traces,
    xTitle: "X",
    yTitle: "Y",
    baseMargin: { l: 72, r: 20, t: 12, b: 56 },
  });

  assert.deepEqual(layout.xaxis?.range, [1, 3]);
  assert.equal(layout.xaxis?.autorange, false);
  assert.equal(layout.xaxis?.dtick, 1);
  assert.deepEqual(layout.yaxis?.range, [10, 30]);
  assert.deepEqual(layout.yaxis?.tickvals, [10, 20, 30]);
  assert.equal(layout.xaxis?.title && "standoff" in layout.xaxis.title
    ? layout.xaxis.title.standoff
    : undefined, 24);
  assert.equal(layout.yaxis?.title && "standoff" in layout.yaxis.title
    ? layout.yaxis.title.standoff
    : undefined, 28);
  assert.equal(layout.legend?.orientation, "v");
  assert.equal(layout.legend?.x, 1.02);
  assert.equal(layout.margin?.r, 140);
});

test("categorical X layouts keep category ordering without applying numeric X controls", () => {
  const style = normalizePlotStyle({
    ...DEFAULT_PLOT_STYLE,
    x_axis: {
      ...DEFAULT_PLOT_STYLE.x_axis,
      mode: "manual",
      min: 1,
      max: 3,
      tick_mode: "step",
      dtick: 1,
    },
  });
  const layout = simpleCartesianLayout(style, spec, {
    traces: [{ type: "scatter", x: ["C/10", "C/2"], y: [1, 2] } as Plotly.Data],
    xTitle: "C-rate",
    yTitle: "Capacity",
    xAxis: { type: "category", categoryorder: "array", categoryarray: ["C/10", "C/2"] },
    xAxisNumeric: false,
  });

  assert.equal(layout.xaxis?.type, "category");
  assert.deepEqual(layout.xaxis?.categoryarray, ["C/10", "C/2"]);
  assert.equal(layout.xaxis?.range, undefined);
  assert.equal(layout.xaxis?.dtick, undefined);
});

test("specialized plot families have their own preset scopes", () => {
  assert.equal(plotStylePresetFamilyForTab("dcir"), "dcir");
  assert.equal(plotStylePresetFamilyForTab("crate"), "crate");
  assert.equal(plotStylePresetFamilyForTab("chargeability"), "chargeability");
  assert.equal(plotStylePresetFamilyForTab("steps"), "steps");
  assert.equal(plotStylePresetFamilyForTab("recap"), "all");
});

test("all audited simple plot families use the shared layout and opacity paths", () => {
  const families = [
    "../src/features/analyses/editor/families/dcir/DcirPlotCard.tsx",
    "../src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx",
    "../src/features/analyses/editor/families/chargeability/ChargeabilityPlotCard.tsx",
    "../src/features/analyses/editor/families/steps/StepsPlotCard.tsx",
  ];
  for (const family of families) {
    const source = readFileSync(new URL(family, import.meta.url), "utf8");
    assert.match(source, /simpleCartesianLayout/);
    assert.match(source, /return simpleCartesianLayout\(style, spec/);
    assert.match(source, /opacity: style\.individual_opacity/);
  }
});

test("representative plot families expose the shared persistent visibility menu", () => {
  const families = [
    "../src/features/analyses/editor/families/cycles/CyclePlotCard.tsx",
    "../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx",
    "../src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx",
  ];
  for (const family of families) {
    const source = readFileSync(new URL(family, import.meta.url), "utf8");
    assert.match(source, /hiddenSeriesIdsAfterShowOnly/);
    assert.match(source, /hiddenSeriesIdsAfterShowAll/);
    assert.match(source, /seriesVisibility=/);
  }
});
