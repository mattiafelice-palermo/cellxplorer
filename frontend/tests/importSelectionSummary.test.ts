import assert from "node:assert/strict";
import test from "node:test";

import type { ImportFolderFile } from "../src/api.ts";
import {
  LARGE_IMPORT_WARNING_THRESHOLD,
  formatImportBytes,
  summarizeImportSelection,
} from "../src/importSelectionSummary.ts";

function candidate(
  path: string,
  size: number,
  rootPath: string,
  label = "Batch",
): ImportFolderFile {
  return {
    path,
    relative_path: path.split("/").at(-1) ?? path,
    filename: path.split("/").at(-1) ?? path,
    size,
    selection_root: { kind: "folder", path: rootPath, label },
  };
}

test("large threshold is exclusive and selected totals are exact", () => {
  const files = Array.from({ length: LARGE_IMPORT_WARNING_THRESHOLD + 1 }, (_, index) =>
    candidate(`C:/batch/${index}.ndax`, index + 1, "C:/batch"),
  );
  const summary = summarizeImportSelection(files, new Set(files.slice(0, 31).map((file) => file.path!)));
  assert.equal(summary.fileCount, 31);
  assert.equal(summary.totalBytes, 496);
  assert.equal(summary.isLarge, true);
  assert.equal(summarizeImportSelection(files.slice(0, 30)).isLarge, false);
});

test("roots preserve first appearance and identical labels remain distinct", () => {
  const files = [
    candidate("C:/one/a.ndax", 10, "C:/one/batch", "batch"),
    candidate("C:/two/b.ndax", 20, "C:/two/batch", "batch"),
    candidate("C:/one/c.ndax", 30, "C:/one/batch", "batch"),
    {
      ...candidate("C:/loose.nda", 40, "C:/loose.nda", "Loose files"),
      selection_root: { kind: "file" as const, path: "C:/loose.nda", label: "Loose files" },
    },
  ];
  const summary = summarizeImportSelection(files);
  assert.deepEqual(summary.roots.map((root) => root.path), ["C:/one/batch", "C:/two/batch", null]);
  assert.deepEqual(summary.roots.map((root) => root.fileCount), [2, 1, 1]);
  assert.deepEqual(summary.roots.map((root) => root.totalBytes), [40, 20, 40]);
  assert.notEqual(summary.roots[0].key, summary.roots[1].key);
});

test("byte formatting handles zero, small, and GiB values", () => {
  assert.equal(formatImportBytes(0), "0 B");
  assert.equal(formatImportBytes(512), "512 B");
  assert.equal(formatImportBytes(1024), "1 KB");
  assert.equal(formatImportBytes(1024 ** 3), "1 GB");
});
