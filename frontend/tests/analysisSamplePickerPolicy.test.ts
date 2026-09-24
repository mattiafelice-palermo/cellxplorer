import assert from "node:assert/strict";
import test from "node:test";

import {
  cellPickerBulkSelectionState,
  nextCellPickerSort,
  selectableCellPickerSelection,
  sortCellPickerCells,
  toggleCellPickerBulkSelection,
  type CellPickerCell,
  type CellPickerSortKey,
} from "../src/features/analyses/editor/policies/analysisSamplePickerPolicy.ts";

const rows: CellPickerCell[] = [
  {
    id: 1,
    name: "Cell 10",
    cycle_count: 10,
    max_specific_discharge_capacity_mah_g: 120,
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: 2,
    name: "Cell 2",
    cycle_count: 30,
    max_specific_discharge_capacity_mah_g: 80,
    created_at: "2025-03-01T00:00:00Z",
  },
  {
    id: 3,
    name: "Cell unknown",
    cycle_count: null,
    max_specific_discharge_capacity_mah_g: null,
    created_at: null,
  },
];

test("cell picker sorts only the supplied cell list and keeps unknown metrics last", () => {
  const firstFolder = sortCellPickerCells(rows.slice(0, 2), {
    key: "cycle_count",
    direction: "desc",
  });
  const secondFolder = sortCellPickerCells(rows.slice(1), {
    key: "cycle_count",
    direction: "desc",
  });

  assert.deepEqual(firstFolder.map((cell) => cell.id), [2, 1]);
  assert.deepEqual(secondFolder.map((cell) => cell.id), [2, 3]);
  assert.deepEqual(rows.map((cell) => cell.id), [1, 2, 3], "sorting does not mutate folder order");
});

test("cell picker supports sorting by every displayed value", () => {
  const cases: [CellPickerSortKey, "asc" | "desc", number[]][] = [
    ["name", "asc", [2, 1, 3]],
    ["cycle_count", "desc", [2, 1, 3]],
    ["max_specific_discharge_capacity_mah_g", "desc", [1, 2, 3]],
    ["created_at", "desc", [2, 1, 3]],
  ];

  for (const [key, direction, expected] of cases) {
    assert.deepEqual(
      sortCellPickerCells(rows, { key, direction }).map((cell) => cell.id),
      expected,
      key,
    );
  }
});

test("cell picker sort header starts with useful direction and toggles on repeat clicks", () => {
  assert.deepEqual(nextCellPickerSort(null, "cycle_count"), {
    key: "cycle_count",
    direction: "desc",
  });
  assert.deepEqual(nextCellPickerSort({ key: "cycle_count", direction: "desc" }, "cycle_count"), {
    key: "cycle_count",
    direction: "asc",
  });
});

test("cell picker bulk selection is tri-state and only changes visible rows", () => {
  const visible = ["cell:1", "cell:2"];
  const selected = new Set(["cell:2", "cell:hidden"]);

  assert.deepEqual(cellPickerBulkSelectionState(visible, new Set()), {
    checked: false,
    indeterminate: false,
    selectedCount: 0,
  });
  assert.deepEqual(cellPickerBulkSelectionState(visible, selected), {
    checked: false,
    indeterminate: true,
    selectedCount: 1,
  });
  assert.deepEqual(toggleCellPickerBulkSelection(selected, visible), new Set([
    "cell:1",
    "cell:2",
    "cell:hidden",
  ]));

  const allVisibleSelected = new Set(["cell:1", "cell:2", "cell:hidden"]);
  assert.deepEqual(toggleCellPickerBulkSelection(allVisibleSelected, visible), new Set(["cell:hidden"]));
  assert.deepEqual(cellPickerBulkSelectionState(visible, new Set(["cell:1", "cell:2"])), {
    checked: true,
    indeterminate: false,
    selectedCount: 2,
  });
});

test("cell picker add keeps selected rows hidden by search while dropping stale or added rows", () => {
  assert.deepEqual(
    selectableCellPickerSelection(
      new Set(["cell:1", "cell:hidden-by-search", "cell:already-added", "cell:deleted"]),
      ["cell:1", "cell:hidden-by-search", "cell:already-added"],
      new Set(["cell:already-added"]),
    ),
    ["cell:1", "cell:hidden-by-search"],
  );
});
