import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationPreviewResult } from "../src/api.ts";
import {
  buildContinuationPreviewTraces,
  continuationPreviewHasPoints,
  continuationPreviewQueryKey,
  continuationPreviewRequest,
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
  const request = continuationPreviewRequest(drafts, ["part-b.xlsx", "part-a.ndax"]);

  assert.deepEqual(request.proposed_order, ["part-b.xlsx", "part-a.ndax"]);
  assert.deepEqual(request.sources.map((source) => source.staged_name), ["part-b.xlsx", "part-a.ndax"]);
  assert.deepEqual(request.sources.map((source) => source.inspection?.hash), ["hash-b", "hash-a"]);
});

test("combined preview query identity changes for order or an inspected source identity", () => {
  const original = continuationPreviewQueryKey(["part-a.ndax", "part-b.xlsx"], drafts);
  const reordered = continuationPreviewQueryKey(["part-b.xlsx", "part-a.ndax"], drafts);
  const changed = continuationPreviewQueryKey(
    ["part-a.ndax", "part-b.xlsx"],
    [{ ...drafts[0], inspection: { ...drafts[0].inspection, mtime_ns: 99 } }, drafts[1]],
  );
  const reinspection = continuationPreviewQueryKey(["part-a.ndax", "part-b.xlsx"], drafts, 1);

  assert.notDeepEqual(reordered, original);
  assert.notDeepEqual(changed, original);
  assert.notDeepEqual(reinspection, original);
});

test("combined preview traces preserve backend global points and source colors without a legend", () => {
  const traces = buildContinuationPreviewTraces(preview(), {
    "part-b.xlsx": "#228be6",
    "part-a.ndax": "#12b886",
  });
  const first = traces[0] as {
    x?: number[];
    y?: number[];
    line?: { color?: string };
    marker?: { color?: string };
    showlegend?: boolean;
  };

  assert.deepEqual(first.x, [1, 2]);
  assert.deepEqual(first.y, [2.1, 2.0]);
  assert.equal(first.line?.color, "#228be6");
  assert.equal(first.marker?.color, "#228be6");
  assert.equal(first.showlegend, false);
  assert.equal(continuationPreviewHasPoints(preview()), true);
  assert.equal(continuationPreviewHasPoints({ ...preview(), segments: [] }), false);
});
