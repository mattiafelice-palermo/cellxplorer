import assert from "node:assert/strict";
import test from "node:test";

import type { PlotStyle } from "../src/api.ts";
import {
  applyAllSeriesStylePatch,
  cePlotMode,
  plotMode,
} from "../src/features/analyses/editor/plotting/plotStyle.ts";
import { applyPlotStylePreset } from "../src/features/analyses/editor/plotting/plotStylePresets.ts";

const axis = {
  mode: "manual" as const,
  min: 1,
  max: 2,
  tick_mode: "step" as const,
  dtick: 0.2,
  tick_count: null,
  title_standoff: 14,
  tick_label_standoff: 4,
};

const style = {
  custom_colors: {},
  ce_custom_colors: {},
  x_axis: axis,
  y_axis: axis,
  y2_axis: axis,
} as PlotStyle;

test("preset can preserve current ranges and ticks independently", () => {
  const preset = {
    ...style,
    line_width: 5,
    x_axis: { ...axis, min: 10, max: 20, dtick: 2 },
  } as PlotStyle;
  const applied = applyPlotStylePreset(style, preset, false, false);
  assert.equal(applied.line_width, 5);
  assert.equal(applied.x_axis.min, 1);
  assert.equal(applied.x_axis.dtick, 0.2);
});

test("applying a style preset preserves the current series order", () => {
  const current = { ...style, series_order: ["c2", "c1"] } as PlotStyle;
  const applied = applyPlotStylePreset(current, style, false, false);
  assert.deepEqual(applied.series_order, ["c2", "c1"]);
});

test("preset applies ranges and ticks when requested", () => {
  const preset = {
    ...style,
    x_axis: { ...axis, min: 10, max: 20, dtick: 2 },
  } as PlotStyle;
  const applied = applyPlotStylePreset(style, preset, true, true);
  assert.equal(applied.x_axis.min, 10);
  assert.equal(applied.x_axis.dtick, 2);
});

test("All series styling mirrors shared line and marker fields to CE", () => {
  const current = {
    ...style,
    line_width: 2.5,
    line_dash: "solid" as const,
    marker_mode: "none" as const,
    marker_size: 5,
    marker_symbol: "circle" as const,
    marker_open: false,
    ce_line_width: 1.5,
    ce_line_dash: "dot" as const,
    ce_marker_mode: "none" as const,
    ce_marker_size: 5,
    ce_marker_symbol: "circle" as const,
    ce_marker_open: false,
  } as PlotStyle;
  const applied = applyAllSeriesStylePatch(current, {
    line_width: 4,
    line_dash: "dash",
    marker_mode: "points",
    marker_size: 8,
    marker_symbol: "square",
    marker_open: true,
  });

  assert.equal(applied.line_width, 4);
  assert.equal(applied.ce_line_width, 4);
  assert.equal(applied.line_dash, "dash");
  assert.equal(applied.ce_line_dash, "dash");
  assert.equal(applied.marker_mode, "points");
  assert.equal(applied.ce_marker_mode, "points");
  assert.equal(applied.marker_size, 8);
  assert.equal(applied.ce_marker_size, 8);
  assert.equal(applied.marker_symbol, "square");
  assert.equal(applied.ce_marker_symbol, "square");
  assert.equal(applied.marker_open, true);
  assert.equal(applied.ce_marker_open, true);
  assert.equal(plotMode(applied), "markers");
  assert.equal(cePlotMode(applied), "markers");
});
