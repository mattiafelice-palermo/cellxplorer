import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentListItem,
  adjacentProjectSelectionItem,
  projectSelectionAfterClick,
} from "../src/projectSelection.ts";

const visible = [
  { key: "folder:1", kind: "folder" as const, folderId: 1 },
  { key: "cell:1:10", kind: "cell" as const, folderId: 1 },
  { key: "cell:1:11", kind: "cell" as const, folderId: 1 },
  { key: "replicate:1:20", kind: "replicate_group" as const, folderId: 1 },
  { key: "analysis:1:30", kind: "analysis" as const, folderId: 1 },
  { key: "folder:2", kind: "folder" as const, folderId: 2 },
  { key: "cell:2:12", kind: "cell" as const, folderId: 2 },
];

test("project shift ranges remain inside one folder-local sample scope", () => {
  const selected = projectSelectionAfterClick(
    new Set(["cell:1:10"]),
    visible,
    "cell:1:10",
    visible[3],
    { range: true, toggle: false },
  );
  assert.deepEqual([...selected], [
    "cell:1:10",
    "cell:1:11",
    "replicate:1:20",
  ]);

  const crossed = projectSelectionAfterClick(
    selected,
    visible,
    "cell:1:10",
    visible[6],
    { range: true, toggle: false },
  );
  assert.deepEqual([...crossed], ["cell:2:12"]);
});

test("folders cannot coexist with a sample selection", () => {
  const selected = projectSelectionAfterClick(
    new Set(["cell:1:10", "cell:1:11"]),
    visible,
    "cell:1:11",
    visible[0],
    { range: false, toggle: true },
  );
  assert.deepEqual([...selected], ["folder:1"]);
});

test("project keyboard adjacency skips incompatible rows and other folders", () => {
  assert.equal(
    adjacentProjectSelectionItem(visible, "cell:1:10", 1)?.key,
    "cell:1:11",
  );
  assert.equal(
    adjacentProjectSelectionItem(visible, "replicate:1:20", 1),
    null,
  );
  assert.equal(
    adjacentProjectSelectionItem(visible, "folder:1", 1)?.key,
    "folder:2",
  );
});

test("list keyboard adjacency stays within the supplied visible page", () => {
  assert.equal(adjacentListItem([10, 11, 12], 11, 1), 12);
  assert.equal(adjacentListItem([10, 11, 12], 10, -1), null);
  assert.equal(adjacentListItem([10, 11, 12], 99, 1), null);
});
