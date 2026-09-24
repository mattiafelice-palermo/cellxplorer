export type CellPickerSortKey =
  | "name"
  | "cycle_count"
  | "max_specific_discharge_capacity_mah_g"
  | "created_at";

export type CellPickerSort = {
  key: CellPickerSortKey;
  direction: "asc" | "desc";
};

export type CellPickerCell = {
  id: number;
  name: string;
  cycle_count: number | null;
  max_specific_discharge_capacity_mah_g: number | null;
  created_at: string | null;
};

export type CellPickerBulkSelectionState = {
  checked: boolean;
  indeterminate: boolean;
  selectedCount: number;
};

/** Summarize selection for the selectable rows currently shown by the picker. */
export function cellPickerBulkSelectionState(
  visibleKeys: readonly string[],
  selectedKeys: ReadonlySet<string>,
): CellPickerBulkSelectionState {
  const selectedCount = visibleKeys.reduce(
    (count, key) => count + Number(selectedKeys.has(key)),
    0,
  );
  return {
    checked: visibleKeys.length > 0 && selectedCount === visibleKeys.length,
    indeterminate: selectedCount > 0 && selectedCount < visibleKeys.length,
    selectedCount,
  };
}

/** Toggle only currently shown keys while preserving selections hidden by filters. */
export function toggleCellPickerBulkSelection(
  selectedKeys: ReadonlySet<string>,
  visibleKeys: readonly string[],
): Set<string> {
  const next = new Set(selectedKeys);
  const allSelected = cellPickerBulkSelectionState(visibleKeys, selectedKeys).checked;
  visibleKeys.forEach((key) => {
    if (allSelected) next.delete(key);
    else next.add(key);
  });
  return next;
}

/** Keep selections across filters while excluding stale and already-added rows. */
export function selectableCellPickerSelection(
  selectedKeys: ReadonlySet<string>,
  availableKeys: readonly string[],
  existingKeys: ReadonlySet<string>,
): string[] {
  const available = new Set(availableKeys);
  return Array.from(selectedKeys).filter((key) => available.has(key) && !existingKeys.has(key));
}

function comparableValue(cell: CellPickerCell, key: CellPickerSortKey): number | string | null {
  if (key === "name") return cell.name;
  if (key === "cycle_count") {
    return typeof cell.cycle_count === "number" && Number.isFinite(cell.cycle_count)
      ? cell.cycle_count
      : null;
  }
  if (key === "max_specific_discharge_capacity_mah_g") {
    const value = cell.max_specific_discharge_capacity_mah_g;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  const value = cell[key];
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Sort one folder's cell rows, leaving unknown values at the bottom. */
export function sortCellPickerCells<T extends CellPickerCell>(
  cells: readonly T[],
  sort: CellPickerSort | null,
): T[] {
  if (!sort) return [...cells];
  return cells
    .map((cell, index) => ({ cell, index, value: comparableValue(cell, sort.key) }))
    .sort((left, right) => {
      if (left.value === null) return right.value === null ? left.index - right.index : 1;
      if (right.value === null) return -1;
      const order =
        typeof left.value === "string" && typeof right.value === "string"
          ? left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: "base" })
          : Number(left.value) - Number(right.value);
      return (sort.direction === "asc" ? order : -order) || left.index - right.index;
    })
    .map(({ cell }) => cell);
}

const FIRST_SORT_DIRECTION: Record<CellPickerSortKey, CellPickerSort["direction"]> = {
  name: "asc",
  cycle_count: "desc",
  max_specific_discharge_capacity_mah_g: "desc",
  created_at: "desc",
};

export function nextCellPickerSort(
  current: CellPickerSort | null,
  key: CellPickerSortKey,
): CellPickerSort {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: FIRST_SORT_DIRECTION[key] };
}
