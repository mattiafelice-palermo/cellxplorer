import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDelimitedText,
  exportFigure,
  resolveExportPlan,
  slugFilename,
  tracesToColumns,
} from "../src/features/analyses/editor/plotting/plotExport.ts";
import { DEFAULT_PLOT_STYLE } from "../src/features/analyses/editor/plotting/plotStyle.ts";
import { plotViewSignature } from "../src/features/analyses/editor/policies/analysisPlotPolicy.ts";
import type { AnalysisSpec } from "../src/api.ts";

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

test("export settings do not dirty a saved-view signature", () => {
  const spec = {
    selection: { entries: [], exclusions: [], hidden_replicate_group_ids: [] },
    dcir_segments: [],
    computation: { formation_cycles: 3 },
    aggregation: { min_n_for_band: 2 },
    presentation: {
      plot_styles: { cycles: structuredClone(DEFAULT_PLOT_STYLE) },
    },
  } as AnalysisSpec;
  const baseline = plotViewSignature(spec);
  const before = structuredClone(spec);
  const traces = [
    {
      x: [1, 2],
      y: [3, 4],
      name: "Cell A",
      type: "scatter",
      line: { color: "#12b886", width: 2.5 },
    },
  ] as Plotly.Data[];
  const layout: Partial<Plotly.Layout> = {
    xaxis: { title: { text: "Cycle" } },
    yaxis: { title: { text: "Capacity" } },
  };
  const plan = resolveExportPlan(DEFAULT_PLOT_STYLE, { width: 640, height: 480 }, layout);

  // The former shallow export boundary could mutate this derived graph, but
  // those fields are not part of the saved-view signature and are not linked
  // back to the persisted spec. Keep that diagnosis explicit and verifiable.
  const legacyFigure = {
    data: traces,
    layout: {
      ...layout,
      width: plan.layoutWidth,
      height: plan.layoutHeight,
      margin: plan.margin,
    },
  };
  (legacyFigure.layout.xaxis as Record<string, unknown>).type = "linear";
  (legacyFigure.data[0] as Record<string, unknown>).line = {
    ...(legacyFigure.data[0] as Record<string, unknown>).line as Record<string, unknown>,
    shape: "linear",
  };
  assert.equal(plotViewSignature(spec), baseline);
  assert.deepEqual(spec, before);

  // The repaired boundary isolates the same renderer writes even when the
  // figure is built from the live derived inputs.
  const figure = exportFigure(traces, layout, DEFAULT_PLOT_STYLE, "Saved view", plan);
  (figure.layout.xaxis as Record<string, unknown>).type = "linear";
  (figure.data[0] as Record<string, unknown>).line = {
    ...(figure.data[0] as Record<string, unknown>).line as Record<string, unknown>,
    shape: "linear",
  };
  assert.equal(plotViewSignature(spec), baseline);
  assert.deepEqual(spec, before);

  // Advanced export settings are transient. PlotHeader passes the local style
  // to the export callbacks instead of writing it into the saved plot draft.
  const headerSource = readFileSync(
    new URL("../src/features/analyses/editor/plotting/PlotHeader.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(headerSource, /updateStyle/);
  assert.match(headerSource, /onExport\?\.\(selectedFormat, renderedFilename, exportStyle\)/);
  assert.match(headerSource, /onDataExport\?\.\(renderedFilename, exportStyle\)/);
});

test("saved plot names remain the sanitized export filename base", () => {
  assert.equal(slugFilename("Gen2H 6 bar retention"), "gen2h-6-bar-retention");
  assert.equal(slugFilename("Unsaved plot"), "unsaved-plot");
});
