import assert from "node:assert/strict";
import test from "node:test";
import type { ImportBrowseEntry } from "../src/api.ts";
import {
  importSourceVersion, importSourcePathKey, importSourceRejection,
  recordImportSourceRejection, pruneRejectedImportSelection,
  resetImportSourceRejections,
} from "../src/importSourceReadability.ts";
import {
  importKeyboardAction, importRowAction, toggleImportFileSelection, toggleImportShownSelection,
} from "../src/importBrowserSelection.ts";
import { indexedFileAvailable, type IndexedFile } from "../src/importSearch.ts";

const file = (name = "bad.mpr"): ImportBrowseEntry => ({ path: `C:/data/${name}`, name, kind: "file", size: 100, modified_at: "2026-10-28T10:00:00Z" });
const bad = file();
const rejection = { path: bad.path, version: importSourceVersion(bad), kind: "unsupported" as const, error: "Unsafe sequence" };

test("source rejection is bound to path aliases and exact file version", () => {
  const failures = recordImportSourceRejection(new Map(), rejection, bad);
  assert.equal(importSourceRejection({ ...bad, path: "c:\\DATA\\bad.mpr" }, failures)?.error, rejection.error);
  assert.equal(importSourceRejection({ ...bad, size: 101 }, failures), undefined);
  assert.equal(importSourceRejection({ ...bad, modified_at: "2026-10-28T11:00:00Z" }, failures), undefined);
  assert.equal(importSourceRejection({ ...bad, kind: "folder" }, failures), undefined);
});

test("late rejection from an older file or missing observation is ignored", () => {
  assert.equal(recordImportSourceRejection(new Map(), rejection, { ...bad, size: 102 }).size, 0);
  assert.equal(recordImportSourceRejection(new Map(), rejection, undefined).size, 0);
});

test("Refresh reconciles a same-size same-mtime replacement and ignores the old request", () => {
  const failures = recordImportSourceRejection(new Map(), rejection, bad);
  const reset = resetImportSourceRejections(failures, [bad.path]);
  assert.equal(importSourceRejection(bad, reset), undefined);
  assert.equal(recordImportSourceRejection(reset, { ...rejection, requestGeneration: 0 }, bad, 1).size, 0);
  assert.equal(recordImportSourceRejection(reset, { ...rejection, requestGeneration: 1 }, bad, 1).size, 1);
});

test("known unreadable files retain plain click and Enter error preview", () => {
  assert.equal(importRowAction(bad), "preview");
  assert.equal(importKeyboardAction(bad, "Enter"), "preview");
});

test("all inclusion methods and final Continue projection drop rejected files", () => {
  const good = file("good.mpr");
  const failures = new Map([[importSourcePathKey(bad.path), rejection]]);
  for (const method of ["checkbox", "space", "ctrl-click", "double-click", "shift-range", "select-all"]) {
    let selected: Map<string, ImportBrowseEntry>;
    if (method === "double-click") selected = new Map([[bad.path, bad], [good.path, good]]);
    else if (method === "select-all") selected = toggleImportShownSelection(new Map(), [bad, good]);
    else selected = toggleImportFileSelection(bad, [good, bad], new Map([[good.path, good]]), good.path, { shiftKey: method === "shift-range" }).selected;
    const safe = pruneRejectedImportSelection(selected, failures);
    assert.equal(safe.has(bad.path), false, method);
  }
  assert.equal(pruneRejectedImportSelection(new Map([[bad.path, bad]]), failures).size, 0);
});

test("indexed source rejection removes eligibility while retaining status reason", () => {
  const indexed = { ...bad, recognition: "recognized", registered: false, root_status: "ready" } as IndexedFile;
  assert.equal(indexedFileAvailable(indexed), true);
  assert.equal(indexedFileAvailable({ ...indexed, readability_error: rejection.error }), false);
});

test("a file that was selected before rejection is removed without removing valid peers", () => {
  const good = file("good.ndax");
  const selected = new Map([[good.path, good], [bad.path, bad]]);
  const failures = recordImportSourceRejection(new Map(), rejection, bad);
  assert.deepEqual([...pruneRejectedImportSelection(selected, failures).keys()], [good.path]);
  assert.equal(selected.size, 2);
});
