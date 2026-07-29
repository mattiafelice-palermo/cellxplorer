import assert from "node:assert/strict";
import test from "node:test";

import { groupTransfersBySource, isNoOpDrop, type DropItem } from "../src/folderDrop.ts";

const cell = (id: number, folderId: number): DropItem => ({ kind: "cell", id, folderId });
const group = (id: number, folderId: number): DropItem => ({
  kind: "replicate_group",
  id,
  folderId,
});
const analysis = (id: number, folderId: number): DropItem => ({ kind: "analysis", id, folderId });
const folder = (id: number): DropItem => ({ kind: "folder", id, folderId: id });

test("items already in the target folder are never transferred", () => {
  const buckets = groupTransfersBySource([cell(1, 5), cell(2, 5)], 5);
  assert.equal(buckets.size, 0);
});

test("a mixed selection still moves the items that come from elsewhere", () => {
  // The reason the guard is per item and not per drag: dropping an A+B selection
  // onto A must leave A's items alone and still move B's.
  const buckets = groupTransfersBySource([cell(1, 5), cell(2, 7), cell(3, 7)], 5);
  assert.deepEqual([...buckets.entries()], [[7, [2, 3]]]);
});

test("buckets preserve input order within a source folder", () => {
  const buckets = groupTransfersBySource([cell(9, 1), cell(4, 1), cell(6, 1)], 2);
  assert.deepEqual(buckets.get(1), [9, 4, 6]);
});

test("items from several other folders each get their own bucket", () => {
  const buckets = groupTransfersBySource([cell(1, 2), cell(2, 3), cell(3, 2)], 9);
  assert.deepEqual([...buckets.keys()].sort(), [2, 3]);
  assert.deepEqual(buckets.get(2), [1, 3]);
  assert.deepEqual(buckets.get(3), [2]);
});

test("a drop is a no-op when every item already lives in the target", () => {
  assert.equal(isNoOpDrop([cell(1, 5), group(2, 5), analysis(3, 5)], 5), true);
});

test("a drop is not a no-op when any item comes from another folder", () => {
  assert.equal(isNoOpDrop([cell(1, 5), cell(2, 6)], 5), false);
});

test("an empty selection is not treated as a no-op drop", () => {
  // `dataTransfer` is unreadable during dragover, so an empty list means "payload
  // unknown", not "nothing to do". Suppressing the highlight there would break
  // every drag whose items we failed to stash.
  assert.equal(isNoOpDrop([], 5), false);
});

test("a folder dropped onto itself is a no-op", () => {
  assert.equal(isNoOpDrop([folder(5)], 5), true);
});

test("a folder dropped onto a different folder is not a no-op", () => {
  // Even if 5 is already 9's child: a folder item carries its own id as folderId,
  // so the parent relationship is unknown here and the move is allowed through.
  assert.equal(isNoOpDrop([folder(5)], 9), false);
});

test("folders are excluded from cell/group transfer buckets by the caller, not here", () => {
  // groupTransfersBySource is only ever handed one kind at a time; this pins the
  // fact that it keys purely on folderId and does not special-case `kind`.
  const buckets = groupTransfersBySource([folder(5)], 9);
  assert.deepEqual(buckets.get(5), [5]);
});
