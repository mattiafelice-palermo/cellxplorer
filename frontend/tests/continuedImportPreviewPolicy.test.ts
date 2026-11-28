import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationPreviewResult } from "../src/api.ts";
import {
  buildContinuationPreviewProvenanceLayout,
  buildContinuationPreviewTraces,
  continuationPreviewHasPoints,
  continuationPreviewFailureSources,
  continuationPreviewQueryKey,
  continuationPreviewRequest,
  continuationPreviewTimeAxis,
  defaultContinuationVoltageRange,
  previewSourceSpans,
  scaleContinuationPreviewTimeAxis,
} from "../src/continuedImportPreviewPolicy.ts";

const drafts = [
  {
    staged_name: "part-a.ndax",
    source_path: "C:/data/part-a.ndax",
    hash: "hash-a",
    size: 10,
    metadata_only: false,
    inspection: { hash: "hash-a", size: 10, mtime_ns: 11 },
  },
  {
    staged_name: "part-b.xlsx",
    source_path: "C:/data/part-b.xlsx",
    hash: "hash-b",
    size: 20,
    metadata_only: false,
    inspection: { hash: "hash-b", size: 20, mtime_ns: 22 },
  },
];

function preview(): ContinuationPreviewResult {
  return {
    quantity: "discharge_capacity_mah",
    label: "Discharge capacity (mAh)",
    segments: [
      {
        source_key: "part-b.xlsx",
        filename: "part-b.xlsx",
        x: [1, 2],
        y: [2.1, 2.0],
        global_cycle_start: 1,
        global_cycle_end: 2,
        source_cycle_start: 1,
        source_cycle_end: 2,
        source_cycle_count: 2,
      },
      {
        source_key: "part-a.ndax",
        filename: "part-a.ndax",
        x: [3, 4],
        y: [1.9, 1.8],
        global_cycle_start: 3,
        global_cycle_end: 4,
        source_cycle_start: 7,
        source_cycle_end: 8,
        source_cycle_count: 2,
      },
    ],
  };
}

test("combined preview requests follow the visible source order and receipts", () => {
  const request = continuationPreviewRequest(
    drafts,
    ["part-b.xlsx", "part-a.ndax"],
    "voltage",
    "source_chain",
  );

  assert.deepEqual(request.proposed_order, ["part-b.xlsx", "part-a.ndax"]);
  assert.deepEqual(request.sources.map((source) => source.staged_name), ["part-b.xlsx", "part-a.ndax"]);
  assert.deepEqual(request.sources.map((source) => source.inspection?.hash), ["hash-b", "hash-a"]);
  assert.equal(request.quantity, "voltage");
  assert.equal(request.interpretation, "source_chain");
});

test("combined preview query identity changes for order or an inspected source identity", () => {
  const original = continuationPreviewQueryKey(["part-a.ndax", "part-b.xlsx"], drafts);
  const reordered = continuationPreviewQueryKey(["part-b.xlsx", "part-a.ndax"], drafts);
  const changed = continuationPreviewQueryKey(
    ["part-a.ndax", "part-b.xlsx"],
    [{ ...drafts[0], inspection: { ...drafts[0].inspection, mtime_ns: 99 } }, drafts[1]],
  );
  const reinspection = continuationPreviewQueryKey(["part-a.ndax", "part-b.xlsx"], drafts, 1);
  const differentMetric = continuationPreviewQueryKey(
    ["part-a.ndax", "part-b.xlsx"],
    drafts,
    0,
    "voltage",
    "stitched",
  );

  assert.notDeepEqual(reordered, original);
  assert.notDeepEqual(changed, original);
  assert.notDeepEqual(reinspection, original);
  assert.notDeepEqual(differentMetric, original);
});

test("voltage preview uses Analysis-picker minutes and rebases to the selected range", () => {
  const voltage = {
    ...preview(),
    quantity: "voltage",
    label: "Voltage (V)",
    x: undefined,
    segments: [
      { ...preview().segments[0]!, x: [1000, 2000], display_x_start: 1000, display_x_end: 2000 },
      { ...preview().segments[1]!, x: [3000, 4000], display_x_start: 3000, display_x_end: 4000 },
    ],
  } as ContinuationPreviewResult;
  assert.deepEqual(continuationPreviewTimeAxis(voltage), {
    unit: "minutes",
    divisor: 60,
    label: "Time (min)",
  });
  const scaled = scaleContinuationPreviewTimeAxis(voltage);
  assert.equal(scaled.x_label, "Time (min)");
  assert.deepEqual(scaled.segments[0]?.x, [0, 1000 / 60]);
  assert.deepEqual(scaled.segments[1]?.x, [2000 / 60, 3000 / 60]);
  assert.deepEqual(voltage.segments[0]?.x, [1000, 2000]);
});

test("voltage time-axis helper keeps minutes for short traces and ignores capacity previews", () => {
  assert.deepEqual(continuationPreviewTimeAxis({ ...preview(), quantity: "voltage", segments: [{ ...preview().segments[0]!, x: [0, 45] }] }), {
    unit: "minutes",
    divisor: 60,
    label: "Time (min)",
  });
  assert.deepEqual(scaleContinuationPreviewTimeAxis({ ...preview(), quantity: "voltage", segments: [{ ...preview().segments[0]!, x: [10, 55] }] }).segments[0]?.x, [0, 0.75]);
  assert.equal(continuationPreviewTimeAxis(preview()), null);
});

test("empty voltage segments cannot shift the selected time origin with cycle metadata", () => {
  const voltage = {
    ...preview(),
    quantity: "voltage",
    segments: [
      { ...preview().segments[0]!, x: [], y: [], display_x_start: 1, display_x_end: 1 },
      { ...preview().segments[1]!, x: [1200, 1800], display_x_start: 2, display_x_end: 2 },
    ],
  } as ContinuationPreviewResult;

  const scaled = scaleContinuationPreviewTimeAxis(voltage);

  assert.deepEqual(scaled.segments[0]?.x, []);
  assert.equal(scaled.segments[0]?.display_x_start, null);
  assert.equal(scaled.segments[0]?.display_x_end, null);
  assert.deepEqual(scaled.segments[1]?.x, [0, 10]);
});

test("combined preview failure details retain usable affected-source reasons", () => {
  assert.deepEqual(
    continuationPreviewFailureSources({
      sources: [
        { filename: "part-a.ndax", reason: "The prepared cycle cache is not ready." },
        { filename: "", reason: "ignore malformed source" },
        "ignore malformed entry",
      ],
    }),
    [{ filename: "part-a.ndax", reason: "The prepared cycle cache is not ready." }],
  );
  assert.deepEqual(continuationPreviewFailureSources({ message: "top-level only" }), []);
  assert.deepEqual(continuationPreviewFailureSources(null), []);
});

test("combined preview traces preserve backend global points and source colors without a legend", () => {
  const colorsBySourceKey = {
    "part-a.ndax": "#12b886",
    "part-b.xlsx": "#228be6",
  };
  const sourcePreview = {
    ...preview(),
    segments: [
      ...preview().segments,
      {
        source_key: "part-missing.ndax",
        filename: "part-missing.ndax",
        x: [5],
        y: [1.7],
        global_cycle_start: 5,
        global_cycle_end: 5,
        source_cycle_start: 1,
        source_cycle_end: 1,
        source_cycle_count: 1,
      },
    ],
  };
  const traces = buildContinuationPreviewTraces(sourcePreview, colorsBySourceKey);

  assert.equal(traces.length, sourcePreview.segments.length);
  traces.forEach((trace, index) => {
    const rendered = trace as {
      x?: number[];
      y?: number[];
      line?: { color?: string };
      marker?: { color?: string };
      showlegend?: boolean;
    };
    const segment = sourcePreview.segments[index];
    const expectedColor = colorsBySourceKey[segment.source_key as keyof typeof colorsBySourceKey] ?? "#12b886";
    assert.deepEqual(rendered.x, segment.x);
    assert.deepEqual(rendered.y, segment.y);
    assert.equal(rendered.line?.color, expectedColor);
    assert.equal(rendered.marker?.color, expectedColor);
    assert.equal(rendered.showlegend, false);
  });
  assert.equal(continuationPreviewHasPoints(sourcePreview), true);
  assert.equal(continuationPreviewHasPoints({ ...preview(), segments: [] }), false);
});

test("source selection highlights capacity markers and voltage lines", () => {
  const colorsBySourceKey = {
    "part-a.ndax": "#12b886",
    "part-b.xlsx": "#228be6",
  };
  const capacityTraces = buildContinuationPreviewTraces(preview(), colorsBySourceKey, "part-b.xlsx");
  const selectedCapacity = capacityTraces[0] as {
    line?: { width?: number };
    marker?: { size?: number };
    opacity?: number;
  };
  const dimmedCapacity = capacityTraces[1] as { opacity?: number };
  assert.equal(selectedCapacity.line?.width, 3);
  assert.equal(selectedCapacity.marker?.size, 8);
  assert.equal(dimmedCapacity.opacity, 0.62);

  const voltageTraces = buildContinuationPreviewTraces(
    { ...preview(), quantity: "voltage", label: "Voltage (V)" },
    colorsBySourceKey,
    "part-a.ndax",
  );
  const selectedVoltage = voltageTraces[1] as {
    line?: { width?: number };
    marker?: { size?: number };
  };
  assert.equal(selectedVoltage.line?.width, 4);
  assert.equal(selectedVoltage.marker?.size, 5);
});

function source(number: number, start: number, end: number) {
  return { number, start, end, filename: `part-${number}.mpr`, color: number % 2 ? "#228be6" : "#12b886" };
}

test("combined voltage opens unfiltered even when the final twenty cycles belong to one file", () => {
  assert.equal(defaultContinuationVoltageRange(6, 51), null);
  assert.equal(defaultContinuationVoltageRange(2, 0), null);
  assert.equal(defaultContinuationVoltageRange(1, 15), null);
  assert.deepEqual(defaultContinuationVoltageRange(1, 51), { start: 32, end: 51 });
});

test("short recordings keep separate badges and their exact joins on the full time axis", () => {
  const edges = [0, 60, 60.2, 203, 203.01, 270, 7500];
  const spans = edges.slice(1).map((end, i) => source(i + 1, edges[i], end));
  const width = 420;
  const guides = buildContinuationPreviewProvenanceLayout(spans, { start: 0, end: 7500, width }, true);
  const labels = guides.annotations!;
  assert.deepEqual(labels.map((a) => a.text), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(labels.map((a) => a.bordercolor), spans.map((span) => span.color));
  assert.deepEqual(guides.shapes!.map((s) => s.x0), edges.slice(1, -1).map(x => x / 7500));
  assert.ok(guides.shapes!.every(s => s.xref === "paper"));
  const centers = labels.map((a) => Number(a.x) * width + Number(a.ax));
  assert.ok(centers.every((x, i) => i === 0 || x - centers[i - 1] >= 21));
  assert.equal(labels[1].x, (60 + 60.2) / 2 / 7500);
  assert.ok(labels.every((a) => a.ay! < 0 && a.showarrow));
  assert.match(labels[5].hovertext!, /Source 6 · part-6.mpr/);

  const zoom = buildContinuationPreviewProvenanceLayout(spans, { start: 300, end: 330, width }, true);
  assert.deepEqual(zoom.annotations!.map((a) => [a.text, a.x]), [["6", 0.5]]);
  assert.deepEqual(zoom.shapes, []);
});

test("a filtered window labels only sources with finite plotted measurements and keeps their chain numbers", () => {
  const spans = previewSourceSpans([
    { ...source(1, 0, 1), traces: [{ x: [], y: [] }] },
    { ...source(3, 1, 1), traces: [{ x: [1, 2], y: [null, NaN] }] },
    { ...source(6, 0, 5), traces: [{ x: [0, null, 2], y: [1.6, null, 2] }, { x: [5], y: [16] }] },
  ]);
  assert.deepEqual(spans, [source(6, 0, 5)]);
  const guides = buildContinuationPreviewProvenanceLayout(spans, { start: 0, end: 5, width: 400 }, true);
  assert.deepEqual(guides.annotations!.map((a) => a.text), ["6"]);
  assert.deepEqual(guides.shapes, []);
});

test("cycle points mark visible joins, while file-local capacity coordinates have no time separators", () => {
  const viewport = { start: 0, end: 51, width: 400 };
  const cycles = [source(3, 1, 1), source(6, 2, 51)];
  const guides = buildContinuationPreviewProvenanceLayout(cycles, viewport, true);
  assert.deepEqual(guides.annotations!.map((a) => a.text), ["3", "6"]);
  assert.deepEqual(guides.shapes!.map((shape) => shape.x0), [1.5 / 51]);
  const overlaid = buildContinuationPreviewProvenanceLayout([source(1, 0, 12), source(2, 0, 30)], viewport, false);
  assert.deepEqual(overlaid.annotations!.map((a) => a.text), ["1", "2"]);
  assert.deepEqual(overlaid.shapes, []);
});

test("a dense chain retains individual names in grouped badges and resolves them on zoom", () => {
  const spans = Array.from({ length: 80 }, (_, i) => source(i + 1, i, i + 1));
  const overview = buildContinuationPreviewProvenanceLayout(spans, { start: 0, end: 80, width: 400 }, true);
  assert.ok(overview.annotations!.length < spans.length);
  assert.equal(overview.annotations!.flatMap((a) => a.hovertext!.split("<br>")).length, 80);
  const zoom = buildContinuationPreviewProvenanceLayout(spans, { start: 12.1, end: 17.9, width: 400 }, true);
  assert.deepEqual(zoom.annotations!.map((a) => a.text), ["13", "14", "15", "16", "17", "18"]);
});

test("combined previews preserve each source's reader and separate cache keys by mode", () => {
  const sources = drafts.map((d, i) => ({...d, read_mode: i ? "safe" as const : "permissive" as const}));
  const order = sources.map(s => s.staged_name).reverse();
  assert.deepEqual(continuationPreviewRequest(sources, order).sources.map(s => s.read_mode), ["safe", "permissive"]);
  assert.notDeepEqual(continuationPreviewQueryKey(order, sources), continuationPreviewQueryKey(order, drafts));
});
