import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDelimitedText,
  exportFigure,
  resolveExportPlan,
  tracesToColumns,
} from "../src/features/analyses/editor/plotting/plotExport.ts";
import { DEFAULT_PLOT_STYLE } from "../src/features/analyses/editor/plotting/plotStyle.ts";

test("CSV text starts with a UTF-8 BOM, not visible mojibake", () => {
  const text = buildDelimitedText(
    [{ header: "Voltage (V)", values: [3.1415926] }],
    "standard",
    "point",
    "comma",
  );

  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(
    [...new TextEncoder().encode(text).slice(0, 3)],
    [0xef, 0xbb, 0xbf],
  );
  assert.equal(text.startsWith("ï»¿"), false);
  assert.equal(text.slice(1), "Voltage (V)\r\n3.14159");
});

test("scientific export keeps raw semantic axis labels after Plotly escaping", () => {
  const columns = tracesToColumns(
    [
      {
        x: [1],
        y: [3.5],
        name: "Cell A",
        cellxplorer_export_axis_labels: { y: "Working potential vs R&D %{y}<br> (V)" },
      } as any,
    ],
    {
      xaxis: { title: { text: "Time (min)" } },
      yaxis: { title: { text: "Working potential vs R&amp;D &#37;{y}&lt;br&gt; (V)" } },
    },
  );

  assert.equal(columns[0].header, "Cell A | Time (min)");
  assert.equal(columns[1].header, "Cell A | Working potential vs R&D %{y}<br> (V)");
});

test("export figures isolate nested live inputs from Plotly normalization", () => {
  const traces = [
    {
      x: [1, 2],
      y: [3, 4],
      name: "Cell A",
      type: "scatter",
      line: { color: "#12b886", width: 2.5 },
      marker: { color: "#12b886", size: 5 },
      customdata: [[1, "source-a"], [2, "source-a"]],
    },
  ] as Plotly.Data[];
  const layout: Partial<Plotly.Layout> = {
    width: 640,
    height: 480,
    margin: { l: 66, r: 24, t: 20, b: 58 },
    xaxis: { range: [0, 3], title: { text: "Cycle", font: { size: 14 } } },
    yaxis: { range: [0, 5], title: { text: "Capacity", font: { size: 14 } } },
    legend: { x: 0.5, y: -0.22, font: { size: 12 } },
  };
  const style = structuredClone(DEFAULT_PLOT_STYLE);
  const before = structuredClone({ traces, layout, style });
  const plan = resolveExportPlan(style, { width: 640, height: 480 }, layout);
  const figure = exportFigure(traces, layout, style, "Saved view", plan);

  assert.notStrictEqual(figure.data, traces);
  assert.notStrictEqual(figure.data[0], traces[0]);
  assert.notStrictEqual(figure.layout.xaxis, layout.xaxis);
  assert.notStrictEqual(figure.layout.yaxis, layout.yaxis);

  // Plotly's renderer adds inferred axis fields to the nested export layout.
  // This is the mutation observed during the 055.1 reproduction.
  (figure.layout.xaxis as Record<string, unknown>).type = "linear";
  (figure.layout.yaxis as Record<string, unknown>).type = "linear";
  (figure.data[0] as Record<string, unknown>).line = {
    ...(figure.data[0] as Record<string, unknown>).line as Record<string, unknown>,
    shape: "linear",
  };

  assert.deepEqual({ traces, layout, style }, before);
});
