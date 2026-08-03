import assert from "node:assert/strict";
import test from "node:test";

import { visibleCellMetadataEntries } from "../src/cellMetadataDisplay.ts";

test("curated and user metadata stay in the flat list", () => {
  const entries = visibleCellMetadataEntries({
    builder: "CY",
    active_material_mg: "333.77",
    operator_note: "checked",
  });
  assert.deepEqual(entries, [
    ["builder", "CY"],
    ["active_material_mg", "333.77"],
    ["operator_note", "checked"],
  ]);
});

test("legacy raw header rows are hidden so old cells do not double-list the header", () => {
  const entries = visibleCellMetadataEntries({
    builder: "CY",
    "raw.Step.Head_Info.Creator.Value": "CY",
    "raw.Step.User_Info.Custom.Field": "legacy",
  });
  assert.deepEqual(entries, [["builder", "CY"]]);
});

test("override rows are hidden because the scientific rows already render them", () => {
  const entries = visibleCellMetadataEntries({
    "override.active_mass_mg": "25.0",
    "override.active_material_name": "LFP",
    builder: "CY",
  });
  assert.deepEqual(entries, [["builder", "CY"]]);
});

test("a cell with only hidden metadata yields an empty list", () => {
  assert.deepEqual(visibleCellMetadataEntries({ "raw.a": "1", "override.b": "2" }), []);
  assert.deepEqual(visibleCellMetadataEntries({}), []);
});

test("keys that merely contain the hidden prefixes are kept", () => {
  const entries = visibleCellMetadataEntries({
    "cell.raw.note": "kept",
    "operator.override.note": "kept",
  });
  assert.deepEqual(entries, [
    ["cell.raw.note", "kept"],
    ["operator.override.note", "kept"],
  ]);
});
