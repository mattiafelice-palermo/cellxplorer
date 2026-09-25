import assert from "node:assert/strict";
import test from "node:test";

import type { ImportBrowseEntry } from "../src/api.ts";
import {
  EMPTY_IMPORT_BROWSER_FILTERS,
  filterAndSortImportEntries,
  importEntryExtension,
  importEntryFormat,
  importEntrySupplier,
  nextImportBrowserSort,
  prioritizeImportHeaderHintPaths,
  type ImportBrowserSort,
  type ImportHeaderHint,
} from "../src/importFilePickerPolicy.ts";

const entries: ImportBrowseEntry[] = [
  { path: "folder", name: "Folder", kind: "folder", size: null, modified_at: null },
  { path: "b.mpr", name: "b.mpr", kind: "file", size: 50, modified_at: "2026-09-02T00:00:00Z" },
  { path: "a.ndax", name: "a.ndax", kind: "file", size: 100, modified_at: "2026-09-01T00:00:00Z" },
  { path: "c.mpr", name: "c.mpr", kind: "file", size: 25, modified_at: "2026-09-03T00:00:00Z" },
];
const hints = new Map<string, ImportHeaderHint>([
  ["b.mpr", { path: "b.mpr", source_format: "BioLogic EC-Lab", supplier: "BioLogic", technique: "GCPL", cycle_count: 18, error: null }],
  ["c.mpr", { path: "c.mpr", source_format: "BioLogic EC-Lab", supplier: "BioLogic", technique: "OCV", cycle_count: null, error: null }],
]);
const sort: ImportBrowserSort = { key: "name", direction: "asc" };

test("file browser resolves supplier and format immediately from extension", () => {
  assert.equal(importEntryFormat(entries[2]), "Neware NDAX");
  assert.equal(importEntrySupplier(entries[1]), "BioLogic");
  assert.equal(importEntryExtension(entries[2]), ".ndax");
});

test("filtering keeps folders first and filters files by scanned protocol", () => {
  const visible = filterAndSortImportEntries(entries, hints, "", {
    ...EMPTY_IMPORT_BROWSER_FILTERS,
    suppliers: ["BioLogic"],
    protocols: ["GCPL"],
  }, sort);
  assert.deepEqual(visible.map((entry) => entry.path), ["folder", "b.mpr"]);
});

test("unsupported Neware Excel files are removed after the automatic compatibility scan", () => {
  const excelEntries: ImportBrowseEntry[] = [
    { path: "good.xlsx", name: "good.xlsx", kind: "file", size: 100, modified_at: null },
    { path: "bad.xlsx", name: "bad.xlsx", kind: "file", size: 100, modified_at: null },
    { path: "unknown.xlsx", name: "unknown.xlsx", kind: "file", size: 100, modified_at: null },
  ];
  const excelHints = new Map<string, ImportHeaderHint>([
    ["good.xlsx", { path: "good.xlsx", source_format: "Neware Excel", supplier: "Neware", technique: null, cycle_count: null, compatible: true, registered: false, error: null }],
    ["bad.xlsx", { path: "bad.xlsx", source_format: null, supplier: null, technique: null, cycle_count: null, compatible: false, registered: false, error: "Not a supported workbook" }],
  ]);
  assert.deepEqual(filterAndSortImportEntries(excelEntries, excelHints, "", EMPTY_IMPORT_BROWSER_FILTERS, sort).map((entry) => entry.path), ["good.xlsx", "unknown.xlsx"]);
});

test("file browser sorts by size and leaves unavailable hint values last", () => {
  const visible = filterAndSortImportEntries(entries, hints, "", EMPTY_IMPORT_BROWSER_FILTERS, {
    key: "size",
    direction: "asc",
  });
  assert.deepEqual(visible.map((entry) => entry.path), ["folder", "c.mpr", "b.mpr", "a.ndax"]);
});

test("sorting a different import column starts with its preferred direction", () => {
  assert.deepEqual(nextImportBrowserSort(sort, "modified"), { key: "modified", direction: "desc" });
  assert.deepEqual(nextImportBrowserSort({ key: "modified", direction: "desc" }, "modified"), {
    key: "modified", direction: "asc",
  });
});

test("size and modified-date ranges filter using source file metadata", () => {
  const bySize = filterAndSortImportEntries(entries, hints, "", {
    ...EMPTY_IMPORT_BROWSER_FILTERS,
    minSize: "0.00005",
  }, sort);
  assert.deepEqual(bySize.map((entry) => entry.path), ["folder", "a.ndax"]);

  const byDate = filterAndSortImportEntries(entries, hints, "", {
    ...EMPTY_IMPORT_BROWSER_FILTERS,
    modifiedAfter: "2026-09-02",
    modifiedBefore: "2026-09-03",
  }, sort);
  assert.deepEqual(byDate.map((entry) => entry.path), ["folder", "b.mpr", "c.mpr"]);
});

test("extension filters and folder visibility are applied before sorting", () => {
  const visible = filterAndSortImportEntries(entries, hints, "", {
    ...EMPTY_IMPORT_BROWSER_FILTERS,
    extensions: [".mpr"],
  }, sort, false);
  assert.deepEqual(visible.map((entry) => entry.path), ["b.mpr", "c.mpr"]);
});

test("header scan prioritizes viewport order before the rest of the active sort", () => {
  const fartherDown = { path: "a.ndax", name: "a.ndax", kind: "file" as const, size: 100, modified_at: null };
  const inViewport = { path: "c.mpr", name: "c.mpr", kind: "file" as const, size: 25, modified_at: null };
  const nextVisible = { path: "b.mpr", name: "b.mpr", kind: "file" as const, size: 50, modified_at: null };
  const folder = { path: "folder", name: "folder", kind: "folder" as const, size: null, modified_at: null };
  assert.deepEqual(prioritizeImportHeaderHintPaths(
    [inViewport, folder],
    [fartherDown, inViewport, nextVisible],
    [folder, fartherDown, inViewport, nextVisible],
    new Set(["a.ndax"]),
    new Set(),
    new Set(),
    2,
  ), ["c.mpr", "b.mpr"]);
});
