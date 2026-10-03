import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REFERENCE_LINES, REFERENCE_NAME_PREFIX, applyReferenceLabelMoves, axisBinding, createReferenceLine, normalizeReferenceLines, referenceAxis, referenceDragConfig, referenceLabelDraggingSupported, referenceLabelMoves, referenceLabelText, referenceLineIssue, withReferenceLines } from "../src/features/analyses/editor/plotting/plotReferenceLines.ts";
import { currentPlotStyle, normalizePlotStyle, writeScopedStyle } from "../src/features/analyses/editor/plotting/plotStyle.ts";
import { exportFigure, resolveExportPlan, tracesToColumns } from "../src/features/analyses/editor/plotting/plotExport.ts";
import { plotViewSignature, specForSavedPlotView } from "../src/features/analyses/editor/policies/analysisPlotPolicy.ts";
import type { AnalysisSpec, SavedAnalysisPlot } from "../src/api.ts";

const axes = [referenceAxis("x", "cycle", "", "Cycle"), referenceAxis("y", "capacity", "mAh", "Capacity (mAh)"), referenceAxis("y2", "ce", "%", "CE (%)")];
const horizontal = () => createReferenceLine(axes[1], axes[0], "threshold");

test("old and malformed style JSON gets bounded independent defaults and stable unique IDs", () => {
  assert.deepEqual(normalizePlotStyle(undefined).reference_lines, []);
  assert.deepEqual(normalizeReferenceLines(null), []);
  const bad = horizontal();
  const lines = normalizeReferenceLines([null, [], { ...bad, id: "same", position: Infinity }, { ...bad, id: "same", width: 100, opacity: -2, dash: "bad", label: { angle: 500, along: -1, x: Infinity, text: "x".repeat(600) } }, { ...bad, id: "" }]);
  assert.equal(lines.length, 3); assert.equal(lines[0].enabled, false);
  assert.deepEqual(lines.map((line) => line.id), ["same", "same-2", "reference-5"]);
  assert.equal(lines[1].width, 20); assert.equal(lines[1].opacity, 0); assert.equal(lines[1].dash, "dash");
  assert.equal(lines[1].label.angle, 180); assert.equal(lines[1].label.along, 0); assert.equal(lines[1].label.x, 0.5); assert.equal(lines[1].label.text.length, 500);
  assert.deepEqual(normalizeReferenceLines(lines), lines);
  assert.equal(normalizeReferenceLines(Array.from({ length: 100 }, horizontal)).length, MAX_REFERENCE_LINES);
  const source = normalizePlotStyle({ reference_lines: [horizontal()] });
  const clone = normalizePlotStyle(source); clone.reference_lines![0].label.text = "changed";
  assert.equal(source.reference_lines![0].label.text, "");
});

test("every numeric axis, full and bounded spans, and ordered same-layer geometry compose", () => {
  const lines = axes.map((axis, i) => ({ ...createReferenceLine(axis, axis.axis === "x" ? axes[1] : axes[0], `line-${i}`), position: i + 5, layer: i === 1 ? "below" as const : "above" as const }));
  lines[1].span = { mode: "bounded", binding: axisBinding(axes[0]), min: 2, max: 8 };
  const existingShape = { type: "rect" as const, x0: 0, x1: 1, y0: 0, y1: 1 };
  const existingAnnotation = { text: "Existing" };
  const base = { shapes: [existingShape], annotations: [existingAnnotation], uirevision: "same", xaxis: { matches: "x2" } } as Partial<Plotly.Layout>;
  const layout = withReferenceLines(base, normalizePlotStyle({ reference_lines: lines }), axes);
  assert.equal(layout.shapes![0], existingShape); assert.equal(layout.annotations![0], existingAnnotation);
  assert.equal(base.shapes!.length, 1); assert.equal(base.annotations!.length, 1);
  assert.deepEqual(layout.shapes!.slice(1).map((shape) => shape.name), lines.map((line) => REFERENCE_NAME_PREFIX + line.id));
  assert.equal(layout.shapes![1].xref, "x"); assert.equal(layout.shapes![1].yref, "paper");
  assert.equal(layout.shapes![2].xref, "x"); assert.equal(layout.shapes![2].x0, 2); assert.equal(layout.shapes![2].x1, 8);
  assert.equal(layout.shapes![3].yref, "y2"); assert.equal(layout.shapes![3].xref, "x domain");
  assert.equal(layout.uirevision, "same"); assert.equal(layout.xaxis!.matches, "x2");
});

test("disabled, nonfinite, incompatible quantities/units and categorical axes never emit a threshold", () => {
  const line = horizontal();
  const style = normalizePlotStyle({ reference_lines: [line] });
  for (const changed of [axes.filter((axis) => axis.axis !== "y"), axes.map((axis) => ({ ...axis, quantity: axis.quantity + "changed" })), axes.map((axis) => ({ ...axis, units: axis.units + "/g" })), axes.map((axis) => ({ ...axis, numeric: false }))]) {
    assert.ok(referenceLineIssue(line, changed)); assert.equal(withReferenceLines({}, style, changed).shapes!.length, 0);
  }
  assert.equal(withReferenceLines({}, normalizePlotStyle({ reference_lines: [{ ...line, enabled: false }] }), axes).shapes!.length, 0);
  assert.equal(withReferenceLines({}, normalizePlotStyle({ reference_lines: [{ ...line, position: NaN }] }), axes).shapes!.length, 0);
  const categories = axes.map((axis) => axis.axis === "x" ? { ...axis, numeric: false } : axis);
  assert.equal(withReferenceLines({}, style, categories).shapes!.length, 1, "horizontal domain spans are valid on category plots");
  line.span.mode = "bounded"; assert.ok(referenceLineIssue(line, categories));
  line.span.binding = axisBinding(axes[1]); assert.ok(referenceLineIssue(line, axes), "numeric spans must be perpendicular");
  line.span.binding = axisBinding(axes[0]); line.span.min = 4; line.span.max = 2;
  assert.ok(referenceLineIssue(line, axes)); assert.equal(withReferenceLines({}, normalizePlotStyle({ reference_lines: [line] }), axes).shapes!.length, 0);
});

test("plain text, value/units switches and all label geometry/style settings reach Plotly", () => {
  const line = horizontal(); line.position = 4.25;
  line.label = { ...line.label, text: '<b>Threshold & "x"</b>', placement: "free", x: 0.17, y: 0.91, angle: -45, side: "left", align: "right", xshift: 12, yshift: -9, font_size: 20, color: "#ff0000", background: "rgba(255,255,255,0.7)", border_color: "#000000", border_width: 3, border_pad: 4 };
  assert.equal(referenceLabelText(line), "&lt;b&gt;Threshold &amp; &quot;x&quot;&lt;/b&gt; 4.25 mAh");
  const annotation = withReferenceLines({}, normalizePlotStyle({ reference_lines: [line] }), axes).annotations![0];
  assert.equal(annotation.x, 0.17); assert.equal(annotation.y, 0.91); assert.equal(annotation.xref, "x domain"); assert.equal(annotation.yref, "y domain");
  assert.equal(annotation.textangle, -45); assert.equal(annotation.xanchor, "right"); assert.equal(annotation.align, "right");
  assert.equal(annotation.xshift, 12); assert.equal(annotation.yshift, -9); assert.equal(annotation.font!.size, 20); assert.equal(annotation.font!.color, "#ff0000");
  assert.equal(annotation.borderwidth, 3); assert.equal(annotation.borderpad, 4); assert.equal(annotation.bgcolor, line.label.background);
  line.label.include_value = false; line.label.include_units = false;
  assert.equal(referenceLabelText(line), "&lt;b&gt;Threshold &amp; &quot;x&quot;&lt;/b&gt;");
  line.label.visible = false; assert.equal(withReferenceLines({}, normalizePlotStyle({ reference_lines: [line] }), axes).annotations!.length, 0);
});

test("extreme but finite spans never produce an infinite label coordinate", () => {
  const line = horizontal(); line.span = { mode: "bounded", binding: axisBinding(axes[0]), min: -1e308, max: 1e308 };
  for (const along of [0, 0.25, 0.5, 0.75, 1]) {
    line.label.along = along;
    const layout = withReferenceLines({}, normalizePlotStyle({ reference_lines: [line] }), axes);
    assert.equal(layout.shapes![0].x0, -1e308); assert.equal(layout.shapes![0].x1, 1e308);
    assert.ok(Number.isFinite(layout.annotations![0].x)); assert.ok(Number.isFinite(layout.annotations![0].y));
  }
});

test("dragging uses actual axis ranges/domains and persists precise subplot coordinates", () => {
  const line = createReferenceLine(axes[2], axes[0], "ce"); line.position = 80;
  const style = normalizePlotStyle({ reference_lines: [line] });
  const layout = withReferenceLines({}, style, axes);
  const full = { xaxis: { range: [10, 20], domain: [0.2, 0.8] }, yaxis2: { range: [0, 100], domain: [0, 0.39] } };
  const moves = referenceLabelMoves({ "annotations[0].x": 0.3, "annotations[0].y": 25 } as any, layout, full);
  assert.equal(moves[0].id, "ce"); assert.ok(Math.abs(moves[0].x - 0.3) < 1e-10); assert.equal(moves[0].y, 0.25);
  applyReferenceLabelMoves(style, moves); assert.equal(style.reference_lines![0].label.placement, "free");
  assert.equal(style.reference_lines![0].position, 80); assert.equal(style.reference_lines![0].label.y, 0.25);
  const free = withReferenceLines({}, style, axes).annotations![0]; assert.equal(free.yref, "y2 domain");
  assert.deepEqual(referenceLabelMoves({ "annotations[0].y": Infinity } as any, layout, full), []);
  assert.deepEqual(referenceLabelMoves({ "xaxis.range": [1, 2] } as any, layout, full), []);
});

test("only owned annotation positions are editable; shape/data/text/foreign annotations are protected", () => {
  const layout = withReferenceLines({}, normalizePlotStyle({ reference_lines: [horizontal()] }), axes);
  assert.equal(referenceLabelDraggingSupported(layout), true);
  const config = referenceDragConfig({ edits: { legendPosition: true } }, layout);
  assert.equal(config.edits!.annotationPosition, true); assert.equal(config.edits!.legendPosition, true);
  assert.equal(config.editable, false); assert.equal(config.edits!.annotationText, false); assert.equal(config.edits!.shapePosition, false);
  const foreign = { ...layout, annotations: [{ text: "Scientific annotation" }, ...layout.annotations!] };
  assert.equal(referenceLabelDraggingSupported(foreign), false); assert.equal(referenceDragConfig({}, foreign).edits!.annotationPosition, false);
  assert.deepEqual(referenceLabelMoves({ "annotations[1].x": 0.2, "annotations[1].y": 0.3 } as any, foreign, {}), []);
});

test("a full-domain vertical label dragged in the lower stacked panel retains its paper position", () => {
  const line = createReferenceLine(axes[0], axes[1], "vertical"); line.position = 5; line.label.along = 0.2;
  const style = normalizePlotStyle({ reference_lines: [line] });
  const layout = withReferenceLines({}, style, axes);
  const full = { xaxis: { range: [0, 10], domain: [0, 1] }, yaxis: { range: [0, 100], domain: [0.39, 1] } };
  const moves = referenceLabelMoves({ "annotations[0].x": 6 } as any, layout, full);
  assert.deepEqual(moves, [{ id: "vertical", x: 0.6, y: 0.2 }]);
  applyReferenceLabelMoves(style, moves);
  const annotation = withReferenceLines({}, style, axes).annotations![0];
  assert.equal(annotation.yref, "paper"); assert.equal(annotation.y, 0.2);
});

test("saved/scoped style roundtrip and figure exports retain references without adding measured data", () => {
  const spec = { selection: { entries: [], exclusions: [] }, computation: {}, aggregation: {}, presentation: { legend: false } } as unknown as AnalysisSpec;
  const before = plotViewSignature(spec);
  writeScopedStyle(spec, "cycles", (style) => { style.reference_lines = [horizontal(), { ...horizontal(), id: "second", enabled: false }]; });
  assert.notEqual(plotViewSignature(spec), before);
  const saved = { id: "saved", tab: "cycles", selection: spec.selection, computation: spec.computation, aggregation: spec.aggregation, presentation: spec.presentation } as SavedAnalysisPlot;
  const restored = specForSavedPlotView(spec, JSON.parse(JSON.stringify(saved)));
  const style = currentPlotStyle(restored, "cycles"); assert.deepEqual(style.reference_lines!.map((line) => line.id), ["threshold", "second"]);
  assert.deepEqual(currentPlotStyle(restored, "dcir").reference_lines, []);
  const traces = [{ type: "scatter", name: "Measured", x: [1, 2], y: [4, 5] }] as Plotly.Data[];
  const layout = withReferenceLines({ height: 500 }, style, axes);
  const figure = exportFigure(traces, layout, style, "Figure", resolveExportPlan(style, null, layout));
  assert.deepEqual(figure.layout.shapes, layout.shapes); assert.deepEqual(figure.layout.annotations, layout.annotations);
  assert.equal(figure.data.length, 1); assert.deepEqual(figure.data[0].y, [4, 5]);
  assert.deepEqual(tracesToColumns(traces, layout), tracesToColumns(figure.data, layout));
  const portable = JSON.parse(JSON.stringify({ figure, presentation: restored.presentation }));
  assert.equal(portable.figure.layout.shapes.length, 1); assert.equal(portable.presentation.plot_styles.cycles.reference_lines[0].id, "threshold");
});
