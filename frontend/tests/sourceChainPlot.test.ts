import assert from "node:assert/strict";
import test from "node:test";

import {
  sourceBoundaryPointIndices,
  sourceExportColumns,
} from "../src/features/analyses/editor/plotting/sourceChainPlot.ts";

test("source boundaries select the first finite plotted point of later sources", () => {
  assert.deepEqual(
    sourceBoundaryPointIndices([1, 1, 2, 2, 3], [0, 1, 2, 3, 4], [10, 11, 12, null, 14]),
    [2, 4],
  );
});

test("source boundaries scan past invalid transition rows", () => {
  assert.deepEqual(
    sourceBoundaryPointIndices(
      [1, 1, 2, 2, 2, 3, 3],
      [0, 1, 2, 3, 4, null, 6],
      [10, 11, null, Number.NaN, 14, 15, 16],
    ),
    [4, 6],
  );
});

test("source boundaries omit wholly unplottable source segments", () => {
  assert.deepEqual(
    sourceBoundaryPointIndices([1, 1, 2, 2, 3], [0, 1, null, 3, null], [10, 11, 12, null, null]),
    [],
  );
});

test("source export columns carry global and local provenance without paths", () => {
  const columns = sourceExportColumns(
    "Cell A",
    [1, 2],
    [7, 8],
    [1, 1],
    ["first.ndax", "first.ndax"],
    ["a".repeat(64), "a".repeat(64)],
  );

  assert.deepEqual(columns.map((column) => column.header), [
    "Cell",
    "Global cycle",
    "Local cycle",
    "Source position",
    "Source file",
    "Source hash",
  ]);
  assert.equal(columns.some((column) => column.values.some((value) => String(value).includes("\\"))), false);
});
