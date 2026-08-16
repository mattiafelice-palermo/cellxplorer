import assert from "node:assert/strict";
import test from "node:test";

import type { PlotStyle } from "../src/api.ts";
import {
  DEFAULT_PLOT_STYLE,
  applyAllSeriesStylePatch,
  applyPaletteToStyle,
  normalizePlotStyle,
  plotPalette,
  withoutSeriesColors,
} from "../src/features/analyses/editor/plotting/plotStyle.ts";

const OKABE_ITO = ["#E69F00", "#56B4E9", "#009E73", "#F0E442"];

const styleWith = (over: Partial<PlotStyle> = {}): PlotStyle => ({
  ...DEFAULT_PLOT_STYLE,
  custom_colors: {},
  ce_custom_colors: {},
  ...over,
});

test("applying a palette records its colours", () => {
  const style = styleWith();
  applyPaletteToStyle(style, OKABE_ITO, null);
  assert.deepEqual(style.palette_colors, OKABE_ITO);
  assert.deepEqual(plotPalette(style), OKABE_ITO);
});

test("applying a palette preserves the persisted series order", () => {
  const style = styleWith({ series_order: ["c2", "c1"] });
  applyPaletteToStyle(style, OKABE_ITO, null);
  assert.deepEqual(style.series_order, ["c2", "c1"]);
});

test("an order patch composed after palette application keeps both states", () => {
  const style = styleWith({
    palette: "app",
    palette_id: "old-palette",
    palette_colors: ["#111111"],
    series_order: ["c1", "c2"],
  });

  applyPaletteToStyle(style, OKABE_ITO, "new-palette");
  const reordered = applyAllSeriesStylePatch(style, { series_order: ["c2", "c1"] });

  assert.deepEqual(reordered.series_order, ["c2", "c1"]);
  assert.equal(reordered.palette, "custom");
  assert.equal(reordered.palette_id, "new-palette");
  assert.deepEqual(reordered.palette_colors, OKABE_ITO);
  assert.deepEqual(reordered.custom_colors, {});
});

test("plot-style normalization round-trips series order without sharing its array", () => {
  const input = { series_order: ["c2", "c1"] };
  const normalized = normalizePlotStyle(input);
  assert.deepEqual(normalized.series_order, ["c2", "c1"]);
  assert.notEqual(normalized.series_order, input.series_order);
});

test("a saved palette id marks the palette custom; a built-in leaves the key alone", () => {
  const saved = styleWith({ palette: "app" });
  applyPaletteToStyle(saved, OKABE_ITO, "pal-7");
  assert.equal(saved.palette, "custom");
  assert.equal(saved.palette_id, "pal-7");

  const builtIn = styleWith({ palette: "app" });
  applyPaletteToStyle(builtIn, OKABE_ITO, null);
  assert.equal(builtIn.palette, "app");
  assert.equal(builtIn.palette_id, null);
});

// The bug: "Apply palette" cleared only `custom_colors`, so a series the user
// had recoloured by hand — which lands in `series_overrides[key].color` — kept
// its old colour while every untouched series moved to the new palette.
test("applying a palette clears per-series colour pins so every series follows it", () => {
  const style = styleWith({
    custom_colors: { c1: "#111111" },
    ce_custom_colors: { c1: "#222222" },
    series_overrides: {
      c1: { color: "#333333" },
      "c1|y2|coulombic_efficiency": { color: "#444444" },
    },
  });

  applyPaletteToStyle(style, OKABE_ITO, null);

  assert.deepEqual(style.custom_colors, {});
  assert.deepEqual(style.ce_custom_colors, {});
  assert.deepEqual(style.series_overrides, {});
});

test("applying a palette keeps non-colour per-series settings", () => {
  const style = styleWith({
    series_overrides: {
      c1: {
        color: "#333333",
        line_width: 4,
        line_dash: "dash",
        name: "Renamed",
        hidden: true,
        link_color: false,
        show_in_legend: false,
      },
    },
  });

  applyPaletteToStyle(style, OKABE_ITO, null);

  assert.deepEqual(style.series_overrides, {
    c1: {
      line_width: 4,
      line_dash: "dash",
      name: "Renamed",
      hidden: true,
      link_color: false,
      show_in_legend: false,
    },
  });
});

// Rules are authored separately and stay visible in the Rules tab, so a palette
// must not silently delete them.
test("applying a palette leaves bulk rules untouched", () => {
  const rules = [
    {
      id: "r1",
      enabled: true,
      field: "label" as const,
      operator: "contains" as const,
      value: "LFP",
      case_sensitive: false,
      style: { color: "#ff0000" },
    },
  ];
  const style = styleWith({ series_rules: rules });

  applyPaletteToStyle(style, OKABE_ITO, null);

  assert.deepEqual(style.series_rules, rules);
});

test("applying a palette is safe when a style has no overrides at all", () => {
  const style = styleWith();
  delete style.series_overrides;
  applyPaletteToStyle(style, OKABE_ITO, null);
  assert.equal(style.series_overrides, undefined);
});

// The series editor keeps its own draft of the overrides and only re-syncs it
// from the spec when the dialog opens. Applying a palette therefore has to
// strip colours from that draft as well, or the next edit in the dialog would
// commit the stale draft and undo the palette.
test("withoutSeriesColors drops colours, keeps the rest, and prunes empties", () => {
  const stripped = withoutSeriesColors({
    onlyColour: { color: "#123456" },
    mixed: { color: "#123456", line_width: 3 },
    untouched: { line_dash: "dot" },
  });

  assert.deepEqual(stripped, {
    mixed: { line_width: 3 },
    untouched: { line_dash: "dot" },
  });
});

test("withoutSeriesColors does not mutate the map it is given", () => {
  const original = { c1: { color: "#123456", line_width: 3 } };
  withoutSeriesColors(original);
  assert.deepEqual(original, { c1: { color: "#123456", line_width: 3 } });
});
