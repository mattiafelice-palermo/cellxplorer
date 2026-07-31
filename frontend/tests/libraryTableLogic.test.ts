import assert from "node:assert/strict";
import test from "node:test";

import type { CellSummary, ReplicateGroupSummary } from "../src/api.ts";
import {
  CELL_LIBRARY_STATUS_ORDER,
  DEFAULT_CELL_LIBRARY_SORT,
  EMPTY_CELL_LIBRARY_FILTERS,
  activeCellLibraryColumnFilter,
  buildCellLibraryRows,
  cellLibraryStatuses,
  compareCellLibrarySortValues,
  filterCellLibraryRows,
  processCellLibraryRows,
  sortCellLibraryRows,
  type CellLibraryFilters,
  type CellLibraryRow,
} from "../src/libraryTableLogic.ts";

function makeCell(overrides: Partial<CellSummary> = {}): CellSummary {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "Cell A",
    description: overrides.description ?? null,
    archived: false,
    cycling_status: "active",
    tags: [],
    scientific_metadata: {
      active_mass_mg: {
        source_value: 5,
        override_value: null,
        legacy_value: null,
        effective_value: 5,
      },
      nominal_capacity_mah: {
        source_value: null,
        override_value: null,
        legacy_value: null,
        effective_value: null,
      },
      electrode_area_cm2: {
        source_value: null,
        override_value: null,
        legacy_value: null,
        effective_value: null,
      },
    },
    scientific_presets: {
      active_material: { preset_id: null, name: null, specific_capacity_mah_g: null },
      electrode_area_preset_id: null,
      electrode_area_preset_name: null,
    },
    n_files: 1,
    total_cycles: 10,
    total_charge_capacity_mah: 100,
    total_discharge_capacity_mah: 95,
    max_specific_discharge_capacity_mah_g: 150,
    has_offline: false,
    has_changed: false,
    has_changing: false,
    has_parsing: false,
    has_summary_pending: false,
    has_summary_error: false,
    created_at: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeGroup(id: number, name: string, cellIds: number[]): ReplicateGroupSummary {
  return {
    id,
    name,
    description: null,
    cell_ids: cellIds,
    cells: cellIds.map((cellId) => ({
      id: cellId,
      name: `Cell ${cellId}`,
      description: null,
      archived: false,
      total_charge_capacity_mah: null,
      total_discharge_capacity_mah: null,
    })),
    average_total_charge_capacity_mah: null,
    average_total_discharge_capacity_mah: null,
    folder_ids: [],
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function row(
  cell: CellSummary,
  replicateGroups: ReplicateGroupSummary[] = [],
): CellLibraryRow {
  return { cell, replicateGroups };
}

test("default cell-name sort is case-insensitive and numeric-aware", () => {
  const rows = [
    row(makeCell({ id: 1, name: "cell10" })),
    row(makeCell({ id: 2, name: "Cell2" })),
    row(makeCell({ id: 3, name: "cell 1" })),
  ];
  const sorted = sortCellLibraryRows(rows, DEFAULT_CELL_LIBRARY_SORT);
  assert.deepEqual(
    sorted.map(({ cell }) => cell.name),
    ["cell 1", "Cell2", "cell10"],
  );
});

test("descending numeric sort orders largest values first", () => {
  const rows = [
    row(makeCell({ id: 1, total_cycles: 5 })),
    row(makeCell({ id: 2, total_cycles: 20 })),
    row(makeCell({ id: 3, total_cycles: 12 })),
  ];
  const sorted = sortCellLibraryRows(rows, { column: "cycles", direction: "desc" });
  assert.deepEqual(
    sorted.map(({ cell }) => cell.total_cycles),
    [20, 12, 5],
  );
});

test("null numeric values remain last in both directions", () => {
  const rows = [
    row(makeCell({ id: 1, total_charge_capacity_mah: null })),
    row(makeCell({ id: 2, total_charge_capacity_mah: 50 })),
    row(makeCell({ id: 3, total_charge_capacity_mah: 10 })),
  ];
  const asc = sortCellLibraryRows(rows, { column: "totalCharge", direction: "asc" });
  const desc = sortCellLibraryRows(rows, { column: "totalCharge", direction: "desc" });
  assert.equal(asc.at(-1)?.cell.id, 1);
  assert.equal(desc.at(-1)?.cell.id, 1);
});

test("cell text searches name and description", () => {
  const rows = [
    row(makeCell({ id: 1, name: "Alpha", description: "baseline" })),
    row(makeCell({ id: 2, name: "Beta", description: "contains alpha note" })),
    row(makeCell({ id: 3, name: "Gamma", description: null })),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, cellText: "alpha" },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [1, 2]);
});

test("replicate-name filter matches any group name", () => {
  const rows = [
    row(makeCell({ id: 1 }), [makeGroup(1, "Batch A", [1])]),
    row(makeCell({ id: 2 }), [makeGroup(2, "Control", [2])]),
    row(makeCell({ id: 3 }), []),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, replicateNameText: "batch" },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [1]);
});

test("replicate count min/max supports zero", () => {
  const rows = [
    row(makeCell({ id: 1 }), []),
    row(makeCell({ id: 2 }), [makeGroup(1, "A", [2])]),
    row(makeCell({ id: 3 }), [makeGroup(2, "B", [3]), makeGroup(3, "C", [3])]),
  ];
  const zeroOnly = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, replicateCountMax: 0 },
    { replicateFiltersEnabled: true },
  );
  const atLeastTwo = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, replicateCountMin: 2 },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(zeroOnly.map(({ cell }) => cell.id), [1]);
  assert.deepEqual(atLeastTwo.map(({ cell }) => cell.id), [3]);
});

test("numeric inclusive min/max bounds filter scientific columns", () => {
  const rows = [
    row(makeCell({ id: 1, total_discharge_capacity_mah: 0 })),
    row(makeCell({ id: 2, total_discharge_capacity_mah: 50 })),
    row(makeCell({ id: 3, total_discharge_capacity_mah: 120 })),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, totalDischargeMin: 0, totalDischargeMax: 50 },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [1, 2]);
});

test("null scientific values are excluded only when a bound is active", () => {
  const rows = [
    row(makeCell({ id: 1, max_specific_discharge_capacity_mah_g: null })),
    row(makeCell({ id: 2, max_specific_discharge_capacity_mah_g: 180 })),
  ];
  const unbounded = filterCellLibraryRows(rows, EMPTY_CELL_LIBRARY_FILTERS, {
    replicateFiltersEnabled: true,
  });
  const bounded = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, maxSpecificDischargeMin: 0 },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(unbounded.map(({ cell }) => cell.id), [1, 2]);
  assert.deepEqual(bounded.map(({ cell }) => cell.id), [2]);
});

test("multiple statuses combine with OR", () => {
  const rows = [
    row(makeCell({ id: 1, has_changed: true })),
    row(makeCell({ id: 2, has_offline: true })),
    row(makeCell({ id: 3 })),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, statuses: ["Changed", "Offline"] },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [1, 2]);
});

test("status filter combines with another column using AND", () => {
  const rows = [
    row(makeCell({ id: 1, name: "Target", has_changed: true })),
    row(makeCell({ id: 2, name: "Other", has_changed: true })),
    row(makeCell({ id: 3, name: "Target", has_offline: true })),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, cellText: "target", statuses: ["Changed"] },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [1]);
});

test("Ready derivation matches the current badge condition", () => {
  const ready = makeCell({ id: 1 });
  const changed = makeCell({ id: 2, has_changed: true });
  const complete = makeCell({ id: 3, cycling_status: "complete" });
  assert.ok(cellLibraryStatuses(ready).includes("Ready"));
  assert.ok(cellLibraryStatuses(ready).includes("Active"));
  assert.ok(!cellLibraryStatuses(changed).includes("Ready"));
  assert.ok(!cellLibraryStatuses(complete).includes("Ready"));
});

test("date range filtering is inclusive on local-day boundaries", () => {
  const rows = [
    row(makeCell({ id: 1, created_at: "2026-01-10T08:00:00.000Z" })),
    row(makeCell({ id: 2, created_at: "2026-01-11T08:00:00.000Z" })),
    row(makeCell({ id: 3, created_at: "2026-01-12T08:00:00.000Z" })),
  ];
  const filtered = filterCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, createdFrom: "2026-01-11", createdTo: "2026-01-11" },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(filtered.map(({ cell }) => cell.id), [2]);
});

test("stable tie behavior preserves original order", () => {
  const rows = [
    row(makeCell({ id: 1, name: "Same" })),
    row(makeCell({ id: 2, name: "Same" })),
    row(makeCell({ id: 3, name: "Same" })),
  ];
  const sorted = sortCellLibraryRows(rows, DEFAULT_CELL_LIBRARY_SORT);
  assert.deepEqual(sorted.map(({ cell }) => cell.id), [1, 2, 3]);
});

test("empty filters return all rows", () => {
  const rows = [
    row(makeCell({ id: 1 })),
    row(makeCell({ id: 2, has_changed: true })),
  ];
  const filtered = filterCellLibraryRows(rows, EMPTY_CELL_LIBRARY_FILTERS, {
    replicateFiltersEnabled: true,
  });
  assert.equal(filtered.length, 2);
});

test("compareCellLibrarySortValues keeps nulls last when descending", () => {
  assert.equal(compareCellLibrarySortValues(null, 5, "desc"), 1);
  assert.equal(compareCellLibrarySortValues(5, null, "desc"), -1);
});

test("activeCellLibraryColumnFilter detects column-specific filters", () => {
  const filters: CellLibraryFilters = {
    ...EMPTY_CELL_LIBRARY_FILTERS,
    statuses: ["Ready"],
  };
  assert.equal(activeCellLibraryColumnFilter("status", filters), true);
  assert.equal(activeCellLibraryColumnFilter("cell", filters), false);
});

test("buildCellLibraryRows attaches replicate groups from a map", () => {
  const cells = [makeCell({ id: 1 }), makeCell({ id: 2, name: "B" })];
  const map = new Map<number, ReplicateGroupSummary[]>([
    [1, [makeGroup(10, "Group A", [1])]],
  ]);
  const rows = buildCellLibraryRows(cells, map);
  assert.equal(rows[0]?.replicateGroups.length, 1);
  assert.equal(rows[1]?.replicateGroups.length, 0);
});

test("processCellLibraryRows filters before sorting", () => {
  const rows = [
    row(makeCell({ id: 1, name: "Zeta", total_cycles: 20 })),
    row(makeCell({ id: 2, name: "Alpha", total_cycles: 5 })),
    row(makeCell({ id: 3, name: "Beta", total_cycles: 30, has_changed: true })),
  ];
  const processed = processCellLibraryRows(
    rows,
    { ...EMPTY_CELL_LIBRARY_FILTERS, statuses: ["Changed"] },
    { column: "cycles", direction: "desc" },
    { replicateFiltersEnabled: true },
  );
  assert.deepEqual(processed.map(({ cell }) => cell.id), [3]);
});

test("status order list matches the locked filter order", () => {
  assert.deepEqual(CELL_LIBRARY_STATUS_ORDER, [
    "Active",
    "Complete",
    "Ready",
    "Changed",
    "Source changing",
    "Offline",
    "Parsing",
    "Calculating",
    "Summary failed",
  ]);
});
