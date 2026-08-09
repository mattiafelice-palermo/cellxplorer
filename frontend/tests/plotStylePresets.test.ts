import assert from "node:assert/strict";
import test from "node:test";

import type { PlotStyle } from "../src/api.ts";
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

test("preset applies ranges and ticks when requested", () => {
  const preset = {
    ...style,
    x_axis: { ...axis, min: 10, max: 20, dtick: 2 },
  } as PlotStyle;
  const applied = applyPlotStylePreset(style, preset, true, true);
  assert.equal(applied.x_axis.min, 10);
  assert.equal(applied.x_axis.dtick, 2);
});
