import assert from "node:assert/strict";
import test from "node:test";

import type { ImportBrowseEntry } from "../src/api.ts";
import {
  clampImportBrowserLeftPaneWidth,
  folderSelectionState,
  importShownSelectionState,
  importKeyboardAction,
  importRowAction,
  maxImportBrowserLeftPaneWidth,
  isImportFolderCheckboxDisabled,
  resetImportBrowserNavigation,
  toggleImportShownSelection,
  toggleImportFileSelection,
  toggleImportFolderSelection,
} from "../src/importBrowserSelection.ts";

function file(path: string): ImportBrowseEntry {
  return { path, name: path.split(/[\\/]/).at(-1) ?? path, kind: "file", size: 1, modified_at: null };
}

function folder(path: string): ImportBrowseEntry {
  return { path, name: path.split(/[\\/]/).at(-1) ?? path, kind: "folder", size: null, modified_at: null };
}

test("folder row activation navigates without changing selection", () => {
  const entry = folder("C:/data");
  const selected = new Map([["C:/old.ndax", file("C:/old.ndax")]]);
  assert.equal(importRowAction(entry), "navigate");
  assert.equal(importKeyboardAction(entry, "Enter"), "navigate");
  assert.deepEqual([...toggleImportFileSelection(entry, [entry], selected, null).selected.keys()], ["C:/old.ndax"]);
});

test("folder checkbox selects and deselects the recursive folder selection", () => {
  const entry = folder("C:/data");
  const selected = toggleImportFolderSelection(new Map(), entry, [file("C:/data/a.ndax"), file("C:/data/nested/b.nda")]);
  assert.deepEqual([...selected.keys()], ["C:/data"]);
  assert.equal(folderSelectionState(entry, selected), "all");
  assert.equal(toggleImportFolderSelection(selected, entry).size, 0);
});

test("folder state supports mixed and empty known descendants", () => {
  const entry = folder("C:/data");
  const one = file("C:/data/a.ndax");
  const two = file("C:/data/b.ndax");
  assert.equal(folderSelectionState(entry, new Map([[one.path, one]]), [one.path, two.path]), "some");
  assert.equal(folderSelectionState(entry, new Map([[one.path, one], [two.path, two]]), [one.path, two.path]), "all");
  assert.equal(isImportFolderCheckboxDisabled(entry, []), true);
  assert.equal(isImportFolderCheckboxDisabled(entry, [one.path]), false);
});

test("file click toggles one file and keyboard Space toggles", () => {
  const entry = file("C:/data/a.ndax");
  assert.equal(importRowAction(entry), "toggle");
  assert.equal(importKeyboardAction(entry, " "), "toggle");
  const selected = toggleImportFileSelection(entry, [entry], new Map(), null).selected;
  assert.deepEqual([...selected.keys()], [entry.path]);
  assert.equal(toggleImportFileSelection(entry, [entry], selected, entry.path).selected.size, 0);
});

test("Shift range uses visible files only and excludes folders", () => {
  const first = file("C:/data/a.ndax");
  const middle = folder("C:/data/folder");
  const last = file("C:/data/z.nda");
  const result = toggleImportFileSelection(last, [first, middle, last], new Map(), first.path, { shiftKey: true });
  assert.deepEqual([...result.selected.keys()], [first.path, last.path]);
});

test("navigation resets the search and file range anchor", () => {
  assert.deepEqual(resetImportBrowserNavigation(), { search: "", lastSelectedPath: null });
});

test("shown selection includes selectable folders in folder-only views", () => {
  const entries = [folder("C:/data/one"), folder("C:/data/two")];
  const state = importShownSelectionState(entries, new Map());
  assert.equal(state.disabled, false);
  assert.equal(state.allSelected, false);
  assert.deepEqual([...toggleImportShownSelection(new Map(), entries).keys()], entries.map((entry) => entry.path));
});

test("shown selection handles mixed files and folders with an indeterminate state", () => {
  const entries = [folder("C:/data/folder"), file("C:/data/cell.ndax")];
  const selected = new Map([[entries[1].path, entries[1]]]);
  const state = importShownSelectionState(entries, selected);
  assert.equal(state.allSelected, false);
  assert.equal(state.someSelected, true);
  assert.deepEqual(
    [...toggleImportShownSelection(selected, entries).keys()],
    [entries[1].path, entries[0].path],
  );
});

test("shown selection is scoped to filtered entries and preserves hidden selections", () => {
  const hidden = file("C:/data/hidden.ndax");
  const shown = file("C:/data/shown.ndax");
  const selected = new Map([[hidden.path, hidden]]);
  const next = toggleImportShownSelection(selected, [shown]);
  assert.deepEqual([...next.keys()], [hidden.path, shown.path]);
  assert.deepEqual([...toggleImportShownSelection(next, [shown]).keys()], [hidden.path]);
});

test("clearing a shown folder preserves independently selected hidden descendants", () => {
  const shownFolder = folder("C:/data");
  const hidden = file("C:/data/hidden.ndax");
  const selected = new Map([
    [shownFolder.path, shownFolder],
    [hidden.path, hidden],
  ]);
  assert.deepEqual([...toggleImportShownSelection(selected, [shownFolder]).keys()], [hidden.path]);
});

test("disabled empty folders do not make shown selection available", () => {
  const empty = folder("C:/data/empty");
  const state = importShownSelectionState([empty], new Map(), () => false);
  assert.equal(state.disabled, true);
  assert.deepEqual([...toggleImportShownSelection(new Map(), [empty], () => false).keys()], []);
});

test("import browser pane width stays within the layout limits", () => {
  assert.equal(clampImportBrowserLeftPaneWidth(100), 200);
  assert.equal(clampImportBrowserLeftPaneWidth(999), 400);
  assert.equal(maxImportBrowserLeftPaneWidth(850), 278);
  assert.equal(clampImportBrowserLeftPaneWidth(400, 850), 278);
});
