import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLegendPreview,
  expandLegendPreview,
  expandedLegendPreviewHeight,
  LEGEND_PREVIEW_CONFIG,
  LEGEND_PREVIEW_EXPANDED_WIDTH,
  LEGEND_PREVIEW_MAX_HEIGHT,
  LEGEND_PREVIEW_MIN_HEIGHT,
  legendPreviewHeight,
} from "../src/features/analyses/editor/plotting/legendPreview.ts";

test("legend preview keeps user-facing traces and filters helper traces", () => {
  const preview = buildLegendPreview({
    data: [
      { name: "shadow", showlegend: false, x: [1, 2], y: [3, 4] },
      { name: "Visible", showlegend: true, type: "scatter", x: [1, 2], y: [3, 4] },
      { name: "also helper", showlegend: false, x: [5], y: [6] },
    ],
    layout: {},
  });

  assert.deepEqual(
    preview.data.map((trace) => (trace as Record<string, unknown>).name),
    ["Visible"],
  );
  assert.equal((preview.data[0] as Record<string, unknown>).showlegend, true);
});

test("legend preview preserves effective Plotly styling without retaining curve data", () => {
  const line = { color: "#12b886", width: 3, dash: "dash" };
  const marker = { color: "#12b886", size: 9, symbol: "square-open" };
  const customdata = Array.from({ length: 10_000 }, (_, index) => index);
  const source = {
    name: "Styled series",
    showlegend: true,
    legendgroup: "cell-1",
    legendrank: 2,
    type: "scattergl",
    mode: "lines+markers",
    line,
    marker,
    opacity: 0.7,
    x: Array.from({ length: 10_000 }, (_, index) => index),
    y: Array.from({ length: 10_000 }, (_, index) => index * 2),
    customdata,
    hovertemplate: "large hover payload",
  };

  const preview = buildLegendPreview({ data: [source], layout: {} });
  const trace = preview.data[0] as Record<string, unknown>;

  assert.equal(trace.name, "Styled series");
  assert.equal(trace.legendgroup, "cell-1");
  assert.equal(trace.legendrank, 2);
  assert.equal(trace.type, "scatter", "legend preview keeps SVG-compatible scatter styling");
  assert.equal(trace.mode, "lines+markers");
  assert.deepEqual(trace.line, line);
  assert.deepEqual(trace.marker, marker);
  assert.equal(trace.opacity, 0.7);
  assert.equal("visible" in trace, false);
  assert.deepEqual(trace.x, [0]);
  assert.deepEqual(trace.y, [null]);
  assert.equal("customdata" in trace, false);
  assert.equal("hovertemplate" in trace, false);
  assert.equal(source.x.length, 10_000);
});

test("legend preview uses rank order, keeps legend styling, and owns local placement", () => {
  const preview = buildLegendPreview({
    data: [
      { name: "stored second", showlegend: true, legendrank: 4, x: [1], y: [1] },
      { name: "stored first", showlegend: true, legendrank: 1, x: [1], y: [1] },
      { name: "default rank", showlegend: true, x: [1], y: [1] },
    ],
    layout: {
      paper_bgcolor: "#101820",
      legend: {
        orientation: "v",
        font: { size: 13, color: "#f8f9fa" },
        traceorder: "grouped",
        x: 1.2,
        y: -0.4,
      },
      margin: { l: 300, r: 300, t: 300, b: 300 },
    },
  });

  assert.deepEqual(
    preview.data.map((trace) => (trace as Record<string, unknown>).name),
    ["stored first", "stored second", "default rank"],
  );
  const layout = preview.layout as Record<string, unknown>;
  const legend = layout.legend as Record<string, unknown>;
  assert.equal(legend.orientation, "v");
  assert.deepEqual(legend.font, { size: 13, color: "#f8f9fa" });
  assert.equal(legend.traceorder, "grouped");
  assert.equal(legend.x, 0);
  assert.equal(legend.y, 1);
  assert.deepEqual(layout.margin, { l: 12, r: 12, t: 8, b: 8 });
  assert.equal(layout.paper_bgcolor, "#101820");
  assert.equal(legend.itemclick, false);
  assert.equal(legend.itemdoubleclick, false);
  assert.equal("maxheight" in legend, false);
});

test("legend preview height stays compact for ordinary and bounded for large legends", () => {
  assert.equal(legendPreviewHeight(0, "h"), LEGEND_PREVIEW_MIN_HEIGHT);
  assert.ok(legendPreviewHeight(5, "h") < LEGEND_PREVIEW_MAX_HEIGHT);
  assert.equal(legendPreviewHeight(100, "v"), LEGEND_PREVIEW_MAX_HEIGHT);
});

test("legend preview keeps Plotly scrolling enabled while disabling legend mutations", () => {
  assert.equal(LEGEND_PREVIEW_CONFIG.displayModeBar, false);
  assert.equal(LEGEND_PREVIEW_CONFIG.responsive, true);
  assert.equal("staticPlot" in LEGEND_PREVIEW_CONFIG, false);
});

test("expanded legend preview reuses the same data and enlarges the passive layout", () => {
  const preview = buildLegendPreview({
    data: Array.from({ length: 4 }, (_, index) => ({
      name: `series-${index + 1}`,
      showlegend: true,
      type: "scatter",
      x: [1],
      y: [index + 1],
    })),
    layout: { legend: { orientation: "v" } },
  });
  const expanded = expandLegendPreview(preview);
  const expandedHeight = (expanded.layout as Record<string, unknown>).height as number;

  assert.equal(expanded.data, preview.data, "expanded view must consume the embedded data source");
  assert.equal((expanded.layout as Record<string, unknown>).width, LEGEND_PREVIEW_EXPANDED_WIDTH);
  assert.equal(expandedHeight, expandedLegendPreviewHeight(4, "v"));
  assert.ok(expandedHeight < 520, "short legends must not retain the old fixed canvas height");
  assert.equal(
    (expanded.layout as Record<string, unknown>).legend,
    (preview.layout as Record<string, unknown>).legend,
    "expanded view must preserve the same legend ordering and styling object",
  );
});

test("expanded legend height grows with long content for outer-modal scrolling", () => {
  assert.ok(expandedLegendPreviewHeight(30, "v") > expandedLegendPreviewHeight(4, "v"));
});
