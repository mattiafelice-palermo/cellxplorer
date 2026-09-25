import assert from "node:assert/strict";
import test from "node:test";

import {
  cellPickerBulkSelectionState,
  nextCellPickerSort,
  selectableCellPickerSelection,
  sortCellPickerCells,
  cellMatchesPickerFilters,
  cellMatchesPickerColumnFilters,
  cellPickerColumnHasFilter,
  cellPickerFacetValues,
  updateCellPickerFacetFilters,
  toggleCellPickerBulkSelection,
  updateCellPickerColumnFilterDraft,
  resolveCellPickerPreviewCellId,
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
  });
  assert.deepEqual(nextCellPickerSort(first, "cycle_count"), {
    ...first,
    primary: { key: "cycle_count", direction: "asc" },
  });
  assert.deepEqual(nextCellPickerSort(first, "last_modified_at"), {
    primary: { key: "last_modified_at", direction: "desc" },
  });
});

test("cell picker keeps unknown values last when sorting a single column", () => {
  const tied = [
    { ...rows[0], id: 4, cycle_count: 20, last_modified_at: "2025-02-01T00:00:00Z" },
    { ...rows[1], id: 5, cycle_count: 20, last_modified_at: "2025-04-01T00:00:00Z" },
    { ...rows[2], id: 6, cycle_count: null, last_modified_at: "2025-05-01T00:00:00Z" },
  ];
  assert.deepEqual(sortCellPickerCells(tied, {
    primary: { key: "cycle_count", direction: "desc" },
  }).map((cell) => cell.id), [4, 5, 6]);
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
  assert.deepEqual(cellPickerFacetValues([continuedCell], "format", {
    sourceSystems: ["biologic"],
    fileFormats: [],
    techniques: [],
  }), [".mpr"]);
  assert.deepEqual(cellPickerFacetValues([continuedCell], "technique", {
    sourceSystems: ["biologic"],
    fileFormats: [".mpr"],
    techniques: [],
  }), ["GCPL"]);
});

test("picker facet options narrow using the other active facets", () => {
  const cells = [
    { source_facets: [{ system: "biologic", format: ".mpr", technique: "GCPL" }] },
    { source_facets: [{ system: "neware", format: ".ndax", technique: null }] },
  ];
  assert.deepEqual(
    cellPickerFacetValues(cells, "format", {
      sourceSystems: ["biologic"],
      fileFormats: [],
      techniques: [],
    }),
    [".mpr"],
  );
  assert.deepEqual(
    cellPickerFacetValues(cells, "technique", {
      sourceSystems: ["neware"],
      fileFormats: [".ndax"],
      techniques: [],
    }),
    [UNKNOWN_CELL_PICKER_FACET],
  );
  assert.deepEqual(
    cellPickerFacetValues(cells, "format", {
      sourceSystems: [],
      fileFormats: [".mpr"],
      techniques: ["GCPL"],
    }),
    [".mpr", ".ndax"],
    "format choices stay available when the previous technique will be pruned by the new format",
  );
});

test("picker facet changes remove incompatible format and protocol selections", () => {
  const cells = [
    { source_facets: [{ system: "biologic", format: ".mpr", technique: "GCPL" }] },
    { source_facets: [{ system: "neware", format: ".ndax", technique: "GCD" }] },
  ];
  const neware = updateCellPickerFacetFilters(cells, EMPTY_CELL_PICKER_FILTERS, "system", ["neware"]);
  const selectedFormat = updateCellPickerFacetFilters(cells, neware, "format", [".ndax"]);
  const changedSystem = updateCellPickerFacetFilters(cells, selectedFormat, "system", ["biologic"]);

  assert.deepEqual(changedSystem, {
    sourceSystems: ["biologic"],
    fileFormats: [],
    techniques: [],
  });
  assert.deepEqual(cellPickerFacetValues(cells, "format", changedSystem), [".mpr"]);

  const changedFormat = updateCellPickerFacetFilters(cells, {
    sourceSystems: [],
    fileFormats: [".mpr"],
    techniques: ["GCPL"],
  }, "format", [".ndax"]);
  assert.deepEqual(changedFormat, {
    sourceSystems: [],
    fileFormats: [".ndax"],
    techniques: [],
  });
});

test("preview falls back when the selected Cell is filtered out", () => {
  assert.equal(resolveCellPickerPreviewCellId(1, 2, [2, 3]), 2);
  assert.equal(resolveCellPickerPreviewCellId(3, 2, [2, 3]), 3);
  assert.equal(resolveCellPickerPreviewCellId(null, 2, [2, 3]), 2);

});

test("picker column filters support text, numeric, and inclusive date ranges", () => {
  const cell = rows[0];
  assert.equal(cellPickerColumnHasFilter({ operator: "gt", value: "", secondValue: "" }, "cycle_count"), false);
  assert.equal(cellMatchesPickerColumnFilters(cell, {
    cycle_count: { operator: "gt", value: "9", secondValue: "" },
    name: { operator: "contains", value: "cell 1", secondValue: "" },
  }), true);
  assert.equal(cellMatchesPickerColumnFilters(cell, {
    max_specific_discharge_capacity_mah_g: {
      operator: "between",
      value: "119",
      secondValue: "121",
    },
  }), true);
  assert.equal(cellMatchesPickerColumnFilters(cell, {
    created_at: { operator: "between", value: "2025-01-01", secondValue: "2025-01-02" },
  }), true);
  assert.equal(cellMatchesPickerColumnFilters(cell, {
    created_at: { operator: "after", value: "2025-01-01", secondValue: "" },
  }), false);
  assert.equal(cellPickerColumnHasFilter({ operator: "between", value: "", secondValue: "121" }, "cycle_count"), false);
  assert.equal(cellMatchesPickerColumnFilters(cell, {
    cycle_count: { operator: "between", value: "", secondValue: "121" },
  }), true);
  assert.equal(cellPickerColumnHasFilter({ operator: "between", value: "119", secondValue: "121" }, "cycle_count"), true);
});

test("picker column filter operator remains selected while its value is blank", () => {
  const draft = updateCellPickerColumnFilterDraft(
    {},
    "cycle_count",
    { operator: "eq", value: "", secondValue: "" },
    { operator: "gt" },
  );
  assert.deepEqual(draft.cycle_count, { operator: "gt", value: "", secondValue: "" });
  assert.equal(cellPickerColumnHasFilter(draft.cycle_count, "cycle_count"), false);
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
