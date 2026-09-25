import assert from "node:assert/strict";
import test from "node:test";

import {
  cellPickerBulkSelectionState,
  nextCellPickerSort,
  selectableCellPickerSelection,
  sortCellPickerCells,
  cellMatchesPickerFilters,
  cellPickerFacetValues,
  toggleCellPickerBulkSelection,
  toggleCellPickerPrimarySortLock,
  EMPTY_CELL_PICKER_FILTERS,
  EMPTY_CELL_PICKER_SORT,
  UNKNOWN_CELL_PICKER_FACET,
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
    last_modified_at: "2025-03-01T00:00:00Z",
    source_facets: [{ system: "biologic", format: ".mpr", technique: "GCPL" }],
  },
  {
    id: 2,
    name: "Cell 2",
    cycle_count: 30,
    max_specific_discharge_capacity_mah_g: 80,
    created_at: "2025-03-01T00:00:00Z",
    last_modified_at: null,
    source_facets: [{ system: "neware", format: ".ndax", technique: null }],
  },
  {
    id: 3,
    name: "Cell unknown",
    cycle_count: null,
    max_specific_discharge_capacity_mah_g: null,
    created_at: null,
    last_modified_at: null,
    source_facets: [],
  },
];

test("cell picker sorts only the supplied cell list and keeps unknown metrics last", () => {
  const sort = {
    primary: { key: "cycle_count", direction: "desc" } as const,
    secondary: null,
    primaryLocked: false,
  };
  const firstFolder = sortCellPickerCells(rows.slice(0, 2), sort);
  const secondFolder = sortCellPickerCells(rows.slice(1), sort);

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
    ["last_modified_at", "desc", [1, 2, 3]],
  ];

  for (const [key, direction, expected] of cases) {
    assert.deepEqual(
      sortCellPickerCells(rows, {
        primary: { key, direction },
        secondary: null,
        primaryLocked: false,
      }).map((cell) => cell.id),
      expected,
      key,
    );
  }
});

test("cell picker sort header starts with useful direction and toggles on repeat clicks", () => {
  const first = nextCellPickerSort(EMPTY_CELL_PICKER_SORT, "cycle_count");
  assert.deepEqual(first, {
    primary: { key: "cycle_count", direction: "desc" },
    secondary: null,
    primaryLocked: false,
  });
  assert.deepEqual(nextCellPickerSort(first, "cycle_count"), {
    ...first,
    primary: { key: "cycle_count", direction: "asc" },
  });
  const locked = toggleCellPickerPrimarySortLock(first);
  assert.equal(locked.primaryLocked, true);
  assert.deepEqual(nextCellPickerSort(locked, "last_modified_at").secondary, {
    key: "last_modified_at",
    direction: "desc",
  });
});

test("cell picker secondary sort breaks ties while unknown values stay last", () => {
  const tied = [
    { ...rows[0], id: 4, cycle_count: 20, last_modified_at: "2025-02-01T00:00:00Z" },
    { ...rows[1], id: 5, cycle_count: 20, last_modified_at: "2025-04-01T00:00:00Z" },
    { ...rows[2], id: 6, cycle_count: null, last_modified_at: "2025-05-01T00:00:00Z" },
  ];
  assert.deepEqual(sortCellPickerCells(tied, {
    primary: { key: "cycle_count", direction: "desc" },
    secondary: { key: "last_modified_at", direction: "desc" },
    primaryLocked: true,
  }).map((cell) => cell.id), [5, 4, 6]);
});

test("locking the primary sort keeps its groups in order and sorts only ties", () => {
  const primary = nextCellPickerSort(EMPTY_CELL_PICKER_SORT, "cycle_count");
  const locked = toggleCellPickerPrimarySortLock(primary);
  const sort = nextCellPickerSort(locked, "last_modified_at");
  assert.equal(sort.primaryLocked, true);
  assert.deepEqual(sort.primary, primary.primary);
  assert.deepEqual(sort.secondary, { key: "last_modified_at", direction: "desc" });
  const cells = [
    { ...rows[0], id: 10, cycle_count: 5, last_modified_at: "2025-03-01T00:00:00Z" },
    { ...rows[0], id: 11, cycle_count: 8, last_modified_at: "2025-01-01T00:00:00Z" },
    { ...rows[0], id: 12, cycle_count: 8, last_modified_at: "2025-04-01T00:00:00Z" },
  ];
  assert.deepEqual(sortCellPickerCells(cells, sort).map((cell) => cell.id), [12, 11, 10]);
});

test("picker facets require one source file to satisfy all selected facets", () => {
  const continuedCell = {
    source_facets: [
      { system: "biologic", format: ".mpr", technique: "GCPL" },
      { system: "neware", format: ".ndax", technique: null },
    ],
  };
  assert.equal(cellMatchesPickerFilters(continuedCell, {
    sourceSystems: ["biologic"],
    fileFormats: [".mpr"],
    techniques: ["GCPL"],
  }), true);
  assert.equal(cellMatchesPickerFilters(continuedCell, {
    sourceSystems: ["biologic"],
    fileFormats: [".ndax"],
    techniques: ["GCPL"],
  }), false);
  assert.equal(cellMatchesPickerFilters(continuedCell, EMPTY_CELL_PICKER_FILTERS), true);
  assert.deepEqual(cellPickerFacetValues([continuedCell], "technique"), ["GCPL", UNKNOWN_CELL_PICKER_FACET]);
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
