import type { CellSummary, ReplicateGroupSummary } from "./api.ts";

export type CellLibraryColumn =
  | "cell"
  | "replicates"
  | "cycles"
  | "maxSpecificDischarge"
  | "totalCharge"
  | "totalDischarge"
  | "status"
  | "created";

export type SortDirection = "asc" | "desc";

export type CellLibrarySort = {
  column: CellLibraryColumn;
  direction: SortDirection;
};

export type CellLibraryStatus =
  | "Active"
  | "Complete"
  | "Ready"
  | "Changed"
  | "Source changing"
  | "Offline"
  | "Parsing"
  | "Calculating"
  | "Summary failed";

export type CellLibraryFilters = {
  cellText: string;
  replicateNameText: string;
  replicateCountMin: number | null;
  replicateCountMax: number | null;
  cyclesMin: number | null;
  cyclesMax: number | null;
  maxSpecificDischargeMin: number | null;
  maxSpecificDischargeMax: number | null;
  totalChargeMin: number | null;
  totalChargeMax: number | null;
  totalDischargeMin: number | null;
  totalDischargeMax: number | null;
  statuses: CellLibraryStatus[];
  createdFrom: string;
  createdTo: string;
};

export type CellLibraryRow = {
  cell: CellSummary;
  replicateGroups: ReplicateGroupSummary[];
};

export const CELL_LIBRARY_STATUS_ORDER: CellLibraryStatus[] = [
  "Active",
  "Complete",
  "Ready",
  "Changed",
  "Source changing",
  "Offline",
  "Parsing",
  "Calculating",
  "Summary failed",
];

export const DEFAULT_CELL_LIBRARY_SORT: CellLibrarySort = {
  column: "cell",
  direction: "asc",
};

export const EMPTY_CELL_LIBRARY_FILTERS: CellLibraryFilters = {
  cellText: "",
  replicateNameText: "",
  replicateCountMin: null,
  replicateCountMax: null,
  cyclesMin: null,
  cyclesMax: null,
  maxSpecificDischargeMin: null,
  maxSpecificDischargeMax: null,
  totalChargeMin: null,
  totalChargeMax: null,
  totalDischargeMin: null,
  totalDischargeMax: null,
  statuses: [],
  createdFrom: "",
  createdTo: "",
};

const STATUS_DATA_SEVERITY: Record<Exclude<CellLibraryStatus, "Active" | "Complete">, number> = {
  Ready: 0,
  Calculating: 1,
  Parsing: 2,
  "Source changing": 3,
  Changed: 4,
  Offline: 5,
  "Summary failed": 6,
};

export function cellLibraryStatuses(cell: CellSummary): CellLibraryStatus[] {
  const statuses: CellLibraryStatus[] = [];
  if (cell.cycling_status === "complete") statuses.push("Complete");
  else statuses.push("Active");

  if (cell.has_parsing) statuses.push("Parsing");
  if (cell.has_summary_pending) statuses.push("Calculating");
  if (cell.has_summary_error) statuses.push("Summary failed");
  if (cell.has_changed) statuses.push("Changed");
  if (cell.has_changing) statuses.push("Source changing");
  if (cell.has_offline) statuses.push("Offline");

  if (
    cell.cycling_status !== "complete" &&
    !cell.has_changed &&
    !cell.has_changing &&
    !cell.has_offline &&
    !cell.has_parsing &&
    !cell.has_summary_pending &&
    !cell.has_summary_error
  ) {
    statuses.push("Ready");
  }

  return statuses;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function matchesNumericBounds(
  value: number | null | undefined,
  min: number | null,
  max: number | null,
): boolean {
  const boundActive = min !== null || max !== null;
  if (!boundActive) return true;
  const numeric = finiteNumber(value);
  if (numeric === null) return false;
  if (min !== null && numeric < min) return false;
  if (max !== null && numeric > max) return false;
  return true;
}

function localDateBoundary(value: string, end: boolean): number | null {
  if (!value.trim()) return null;
  const parts = value.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [year, month, day] = parts;
  if (end) return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function createdTimestamp(cell: CellSummary): number | null {
  const timestamp = new Date(cell.created_at).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function matchesCreatedRange(cell: CellSummary, filters: CellLibraryFilters): boolean {
  const from = localDateBoundary(filters.createdFrom, false);
  const to = localDateBoundary(filters.createdTo, true);
  if (from === null && to === null) return true;
  const timestamp = createdTimestamp(cell);
  if (timestamp === null) return false;
  if (from !== null && timestamp < from) return false;
  if (to !== null && timestamp > to) return false;
  return true;
}

function matchesReplicateFilters(
  row: CellLibraryRow,
  filters: CellLibraryFilters,
  replicateFiltersEnabled: boolean,
): boolean {
  if (!replicateFiltersEnabled) return true;

  const nameText = filters.replicateNameText.trim().toLocaleLowerCase();
  if (nameText) {
    const matchesName = row.replicateGroups.some((group) =>
      group.name.toLocaleLowerCase().includes(nameText)
    );
    if (!matchesName) return false;
  }

  const count = row.replicateGroups.length;
  if (filters.replicateCountMin !== null && count < filters.replicateCountMin) return false;
  if (filters.replicateCountMax !== null && count > filters.replicateCountMax) return false;
  return true;
}

export function activeCellLibraryColumnFilter(
  column: CellLibraryColumn,
  filters: CellLibraryFilters,
): boolean {
  switch (column) {
    case "cell":
      return Boolean(filters.cellText.trim());
    case "replicates":
      return (
        Boolean(filters.replicateNameText.trim()) ||
        filters.replicateCountMin !== null ||
        filters.replicateCountMax !== null
      );
    case "cycles":
      return filters.cyclesMin !== null || filters.cyclesMax !== null;
    case "maxSpecificDischarge":
      return (
        filters.maxSpecificDischargeMin !== null || filters.maxSpecificDischargeMax !== null
      );
    case "totalCharge":
      return filters.totalChargeMin !== null || filters.totalChargeMax !== null;
    case "totalDischarge":
      return filters.totalDischargeMin !== null || filters.totalDischargeMax !== null;
    case "status":
      return filters.statuses.length > 0;
    case "created":
      return Boolean(filters.createdFrom || filters.createdTo);
    default:
      return false;
  }
}

export function filterCellLibraryRows(
  rows: CellLibraryRow[],
  filters: CellLibraryFilters,
  options: { replicateFiltersEnabled: boolean },
): CellLibraryRow[] {
  const cellText = filters.cellText.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const { cell } = row;
    if (cellText) {
      const haystack = `${cell.name}\n${cell.description ?? ""}`.toLocaleLowerCase();
      if (!haystack.includes(cellText)) return false;
    }
    if (!matchesReplicateFilters(row, filters, options.replicateFiltersEnabled)) return false;
    if (!matchesNumericBounds(cell.total_cycles, filters.cyclesMin, filters.cyclesMax)) return false;
    if (
      !matchesNumericBounds(
        cell.max_specific_discharge_capacity_mah_g,
        filters.maxSpecificDischargeMin,
        filters.maxSpecificDischargeMax,
      )
    ) {
      return false;
    }
    if (
      !matchesNumericBounds(
        cell.total_charge_capacity_mah,
        filters.totalChargeMin,
        filters.totalChargeMax,
      )
    ) {
      return false;
    }
    if (
      !matchesNumericBounds(
        cell.total_discharge_capacity_mah,
        filters.totalDischargeMin,
        filters.totalDischargeMax,
      )
    ) {
      return false;
    }
    if (filters.statuses.length > 0) {
      const statuses = cellLibraryStatuses(cell);
      if (!filters.statuses.some((status) => statuses.includes(status))) return false;
    }
    if (!matchesCreatedRange(cell, filters)) return false;
    return true;
  });
}

export function cellLibrarySortValue(
  row: CellLibraryRow,
  column: CellLibraryColumn,
): string | number | null {
  const { cell } = row;
  switch (column) {
    case "cell":
      return cell.name.toLocaleLowerCase();
    case "replicates":
      return row.replicateGroups.length;
    case "cycles":
      return finiteNumber(cell.total_cycles);
    case "maxSpecificDischarge":
      return finiteNumber(cell.max_specific_discharge_capacity_mah_g);
    case "totalCharge":
      return finiteNumber(cell.total_charge_capacity_mah);
    case "totalDischarge":
      return finiteNumber(cell.total_discharge_capacity_mah);
    case "status": {
      const lifecycle = cell.cycling_status === "complete" ? 0 : 1;
      const dataSeverity = cellLibraryStatuses(cell)
        .filter((status): status is Exclude<CellLibraryStatus, "Active" | "Complete"> =>
          status !== "Active" && status !== "Complete"
        )
        .reduce(
          (max, status) => Math.max(max, STATUS_DATA_SEVERITY[status]),
          0,
        );
      return lifecycle * 1000 + dataSeverity;
    }
    case "created":
      return createdTimestamp(cell);
    default:
      return null;
  }
}

export function compareCellLibrarySortValues(
  left: string | number | null,
  right: string | number | null,
  direction: SortDirection,
): number {
  const leftMissing =
    left === null || (typeof left === "number" && !Number.isFinite(left));
  const rightMissing =
    right === null || (typeof right === "number" && !Number.isFinite(right));
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "asc" ? comparison : -comparison;
}

export function sortCellLibraryRows(
  rows: CellLibraryRow[],
  sort: CellLibrarySort,
): CellLibraryRow[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((left, right) => {
    const comparison = compareCellLibrarySortValues(
      cellLibrarySortValue(left.row, sort.column),
      cellLibrarySortValue(right.row, sort.column),
      sort.direction,
    );
    if (comparison !== 0) return comparison;
    return left.index - right.index;
  });
  return indexed.map(({ row }) => row);
}

export function processCellLibraryRows(
  rows: CellLibraryRow[],
  filters: CellLibraryFilters,
  sort: CellLibrarySort,
  options: { replicateFiltersEnabled: boolean },
): CellLibraryRow[] {
  const filtered = filterCellLibraryRows(rows, filters, options);
  return sortCellLibraryRows(filtered, sort);
}

export function buildCellLibraryRows(
  cells: CellSummary[],
  groupsByCellId: Map<number, ReplicateGroupSummary[]>,
): CellLibraryRow[] {
  return cells.map((cell) => ({
    cell,
    replicateGroups: groupsByCellId.get(cell.id) ?? [],
  }));
}
