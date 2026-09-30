import assert from "node:assert/strict";
import test from "node:test";
import { indexedFileAvailable, indexedFileStatus, mergeIndexedSelection, type IndexedFile } from "../src/importSearch.ts";

const file = { path: "C:\\Data\\cell.ndax", name: "cell.ndax", kind: "file", recognition: "recognized", registered: false, metadata_state: "ready" } as IndexedFile;
test("registered sources remain previewable but cannot be staged", () => {
  assert.equal(indexedFileAvailable(file), true);
  const registered = { ...file, registered: true };
  assert.equal(indexedFileAvailable(registered), false);
  assert.equal(indexedFileStatus(registered), "Already in Cell Database");
  assert.equal(indexedFileAvailable({ ...file, recognition: "pending" }), false);
});
test("metadata failure does not reject recognized Neware sources", () => {
  assert.equal(indexedFileAvailable({ ...file, metadata_state: "unavailable" }), true);
  assert.equal(indexedFileStatus({ ...file, metadata_state: "unavailable" }), "Metadata unavailable");
});
test("staging across folder and indexed scopes coalesces normalized paths and preserves hidden sources", () => {
  const old = { ...file, path: "c:/data/CELL.ndax" };
  const hidden = { ...file, path: "C:/other/hidden.ndax" };
  const merged = mergeIndexedSelection(new Map([[old.path, old], [hidden.path, hidden]]), new Map([[file.path, file]]));
  assert.equal(merged.size, 2);
  assert.equal(merged.get(file.path), file);
  assert.equal(merged.get(hidden.path), hidden);
});
