import assert from "node:assert/strict";
import test from "node:test";

import { editPreviewWindow, fullPreviewCycleWindow, pickerCycleExtentKey, pickerNeedsCycleExtent, pickerPreviewWindow, shiftPreviewCycleWindow } from "../src/analysisCellPreviewPolicy.ts";
import type { CellSummary } from "../src/api.ts";

test("picker resolves a continued Cell with one programmed cycle in the active analysis pairing", () => {
  const cell = { id: 41, total_cycles: 1, cycle_count_ready: true, n_files: 6,
    source_facets: [{ system: "biologic", technique: "GCPL" }, { system: "biologic", technique: "OCV" }] } as CellSummary;
  assert.equal(pickerNeedsCycleExtent(cell, "programmed"), true);
  assert.equal(pickerNeedsCycleExtent({ ...cell, n_files: 1 }, "programmed"), false);
  assert.notEqual(pickerCycleExtentKey(cell, "programmed"), pickerCycleExtentKey(cell, "discharge_charge"));
  assert.notEqual(pickerCycleExtentKey(cell, "programmed"), pickerCycleExtentKey({ ...cell, last_data_update_at: "later" }, "programmed"));
  const voltage = pickerPreviewWindow(51, "voltage");
  assert.deepEqual(voltage, { start: 32, end: 51 });
  assert.deepEqual(pickerPreviewWindow(51, "capacity"), { start: 1, end: 51 });
  assert.deepEqual(editPreviewWindow({ start: 1, end: 51 }, "end", 30), { start: 1, end: 30 });
  assert.deepEqual(editPreviewWindow(voltage, "end", 30), { start: 30, end: 30 });
});

test("capacity and CE preview starts with the complete available cycle range", () => {
  assert.deepEqual(fullPreviewCycleWindow(767), { start: 1, end: 767 });
  assert.equal(fullPreviewCycleWindow(0), null);
});

test("cycle preview windows move by their span and clamp at either end", () => {
  assert.deepEqual(shiftPreviewCycleWindow({ start: 5, end: 10 }, 100, -1), { start: 1, end: 5 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 10, end: 15 }, 100, -1), { start: 5, end: 10 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 5, end: 10 }, 100, 1), { start: 10, end: 15 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 85, end: 95 }, 100, 1), { start: 95, end: 100 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 1, end: 1 }, 0, 1), { start: 0, end: 0 });
});
