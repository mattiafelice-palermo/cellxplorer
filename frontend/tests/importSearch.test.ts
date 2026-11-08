import assert from "node:assert/strict";
import test from "node:test";
import { searchIndexProgressLabel, indexedFileAvailable, indexedFileStatus, mergeIndexedSelection, type IndexedFile } from "../src/importSearch.ts";

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

test("index progress distinguishes discovery from known header work", () => {
  assert.equal(searchIndexProgressLabel("discovering", 300, 0, 0), "Finding files · 300 candidates found");
  assert.equal(searchIndexProgressLabel("metadata", 300, 57, 181), "Checking source headers · 57 / 181");
  assert.equal(searchIndexProgressLabel("metadata", 300, 0, 0), "Finishing scan · no headers need checking");
  assert.equal(searchIndexProgressLabel("complete", 2659, 2659, 2659), "Scan complete · 2659 / 2659 headers checked");
  assert.equal(searchIndexProgressLabel("complete", 300, 0, 0), "Scan complete · no headers needed checking");
});
