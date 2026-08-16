import assert from "node:assert/strict";
import test from "node:test";

import {
  PALETTE_PREVIEW_HEIGHT,
  PALETTE_PREVIEW_PLOT,
  PALETTE_PREVIEW_VIEWBOX,
  PALETTE_PREVIEW_WIDTH,
  generatePalettePreviewChartElements,
  palettePreviewPath,
} from "../src/features/analyses/editor/plotting/palettePreview.ts";

test("palette preview geometry supplies a non-empty curve and complete chart chrome", () => {
  const colors = ["#e03131", "#1971c2", "#2f9e44"];
  const elements = generatePalettePreviewChartElements(colors);

  assert.equal(PALETTE_PREVIEW_VIEWBOX, "0 0 812 356");
  assert.equal(PALETTE_PREVIEW_WIDTH, 812);
  assert.equal(PALETTE_PREVIEW_HEIGHT, 356);
  assert.equal(PALETTE_PREVIEW_PLOT.left, 78);
  assert.equal(PALETTE_PREVIEW_PLOT.right, 646);
  assert.equal(elements.gridLines.length, 13);
  assert.equal(elements.axes.length, 3);
  assert.equal(elements.yTickLabels.length, 7);
  assert.equal(elements.xTickLabels.length, 6);
  assert.deepEqual(elements.legendEntries, [
    { color: "#e03131", label: "Series 1" },
    { color: "#1971c2", label: "Series 2" },
    { color: "#2f9e44", label: "Series 3" },
  ]);

  const paths = colors.map((_, index) => palettePreviewPath(index, colors.length));
  assert.equal(paths.length, colors.length);
  paths.forEach((path) => {
    assert.match(path, /^M\d+\.\d{2},\d+\.\d{2} C/);
    assert.ok(path.length > 500, "each colour must produce a visible multi-segment curve");
  });
});

test("palette preview chart model updates legend entries for palette edits", () => {
  const before = generatePalettePreviewChartElements(["#e03131", "#1971c2"]);
  const after = generatePalettePreviewChartElements(["#2f9e44", "#f08c00", "#7950f2"]);

  assert.deepEqual(before.legendEntries.map((entry) => entry.color), ["#e03131", "#1971c2"]);
  assert.deepEqual(after.legendEntries.map((entry) => entry.color), ["#2f9e44", "#f08c00", "#7950f2"]);
  assert.notEqual(palettePreviewPath(1, 2), palettePreviewPath(1, 3));
});
