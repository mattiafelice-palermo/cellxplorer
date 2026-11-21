import assert from "node:assert/strict";
import test from "node:test";
import { importRevealTarget, queueImportedCells } from "../src/importedCellHighlight.ts";

test("overlapping imports keep unseen rows and reveal the latest batch", () => {
  const initial = queueImportedCells(null, [3, 4], 0);
  const next = queueImportedCells(initial, [4, 7], 1);
  assert.deepEqual(next.pending, [3, 4, 7]);
  assert.deepEqual(next.reveal, [4, 7]);
  assert.deepEqual(queueImportedCells(next, [8], next.expiresAt).pending, [8]);
});

test("reveal keeps the current page when possible and respects filtered order", () => {
  const rows = [6, 3, 1, 2, 4].map(id => ({ cell: { id } }));
  assert.deepEqual(importRevealTarget(rows, [6, 2], 2, 2), { id: 2, page: 2 });
  assert.deepEqual(importRevealTarget(rows, [4], 1, 2), { id: 4, page: 3 });
  assert.equal(importRevealTarget(rows, [7], 1, 2), null);
});
