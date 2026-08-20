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

test("voltage preview chooses a readable time unit and scales only display values", () => {
  const voltage = {
    ...preview(),
    quantity: "voltage",
    label: "Voltage (V)",
    x: undefined,
    segments: preview().segments.map((segment) => ({
      ...segment,
      x: segment.x.map((value) => value * 1000),
      display_x_start: segment.display_x_start ?? 0,
      display_x_end: segment.display_x_end ?? 120_000,
    })),
  } as ContinuationPreviewResult;
  assert.deepEqual(continuationPreviewTimeAxis(voltage), {
    unit: "days",
    divisor: 86_400,
    label: "Time (days)",
  });
  const scaled = scaleContinuationPreviewTimeAxis(voltage);
  assert.equal(scaled.x_label, "Time (days)");
  assert.deepEqual(scaled.segments[0]?.x, [1000 / 86_400, 2000 / 86_400]);
  assert.deepEqual(voltage.segments[0]?.x, [1000, 2000]);
});

test("voltage time-axis helper uses seconds for short traces and ignores capacity previews", () => {
  assert.deepEqual(continuationPreviewTimeAxis({ ...preview(), quantity: "voltage", segments: [{ ...preview().segments[0]!, x: [0, 45] }] }), {
    unit: "seconds",
    divisor: 1,
    label: "Time (seconds)",
  });
  assert.equal(continuationPreviewTimeAxis(preview()), null);
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

test("provenance guides keep one colored marker and file number for every segment", () => {
  const guides = buildContinuationPreviewProvenanceLayout(preview(), {
    "part-a.ndax": "#12b886",
    "part-b.xlsx": "#228be6",
  });

  assert.equal(guides.shapes?.length, 2);
  assert.equal(guides.annotations?.length, 2);
  assert.deepEqual(guides.annotations?.map((annotation) => annotation.text), ["1", "2"]);
  assert.deepEqual(guides.shapes?.map((shape) => shape.line?.color), ["#228be6", "#12b886"]);
  assert.deepEqual(guides.annotations?.map((annotation) => annotation.bordercolor), ["#228be6", "#12b886"]);
  assert.deepEqual(guides.annotations?.map((annotation) => annotation.y), [1.04, 1.04]);
  assert.deepEqual(guides.annotations?.map((annotation) => annotation.font?.color), ["#1f2937", "#1f2937"]);
});
