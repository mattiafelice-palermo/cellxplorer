import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultImportCellName,
  hasImportNameConflicts,
  importNameConflicts,
} from "../src/importNamePolicy.ts";
import { importRegistrationUiState } from "../src/importProgress.ts";

const draft = (cell_name: string, filename: string, staged_name = filename) => ({
  cell_name,
  filename,
  staged_name,
});

test("default Cell names prefer barcode and otherwise strip the filename extension", () => {
  assert.equal(defaultImportCellName({ barcode: "  ", filename: "cell.ndax" }), "  ");
  assert.equal(defaultImportCellName({ barcode: "barcode-1", filename: "cell.ndax" }), "barcode-1");
  assert.equal(defaultImportCellName({ barcode: null, filename: "cell.ndax" }), "cell");
});

test("trimmed duplicate Cell names identify every affected staged file", () => {
  const conflicts = importNameConflicts([
    draft(" Cell A ", "first.ndax"),
    draft("Cell A", "second.ndax"),
    draft("Cell B", "third.ndax"),
  ]);

  assert.equal(hasImportNameConflicts(conflicts[0].drafts), true);
  assert.deepEqual(conflicts.map((conflict) => ({
    name: conflict.name,
    filenames: conflict.drafts.map((item) => item.filename),
  })), [{ name: "Cell A", filenames: ["first.ndax", "second.ndax"] }]);
});

test("failed registration hides background continuation and unlocks the drafts", () => {
  assert.deepEqual(importRegistrationUiState(true, "failed"), {
    showContinue: false,
    editingLocked: false,
  });
  assert.deepEqual(importRegistrationUiState(true, "running"), {
    showContinue: true,
    editingLocked: true,
  });
  assert.deepEqual(importRegistrationUiState(true, "completed"), {
    showContinue: false,
    editingLocked: true,
  });
});
