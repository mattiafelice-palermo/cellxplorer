export type CellPickerSortKey =
  | "name"
  | "cycle_count"
  | "max_specific_discharge_capacity_mah_g"
  | "created_at"
  | "last_modified_at";

export type CellPickerSort = {
  key: CellPickerSortKey;
  direction: "asc" | "desc";
};

export type CellPickerSortState = {
  primary: CellPickerSort | null;
  secondary: CellPickerSort | null;
  primaryLocked: boolean;
};

export type CellPickerColumnFilter = {
  operator: string;
  value: string;
  secondValue: string;
};

export type CellPickerColumnFilters = Partial<
  Record<CellPickerSortKey, CellPickerColumnFilter>
>;

export type CellPickerColumnFilterOperator =
  | "contains"
  | "equals"
  | "eq"
  | "gt"
  | "lt"
  | "between"
  | "before"
  | "after";

export function cellPickerColumnHasFilter(
  filter: CellPickerColumnFilter | undefined,
  key: CellPickerSortKey,
): boolean {
  if (!filter || !filter.value.trim()) return false;
  return filter.operator !== "between" || Boolean(filter.secondValue.trim());
}

/** Update an Excel-style filter draft without clearing an operator before its value is entered. */
export function updateCellPickerColumnFilterDraft(
  filters: CellPickerColumnFilters,
  key: CellPickerSortKey,
  defaultFilter: CellPickerColumnFilter,
  patch: Partial<CellPickerColumnFilter>,
): CellPickerColumnFilters {
  return {
    ...filters,
    [key]: { ...(filters[key] ?? defaultFilter), ...patch },
  };
}

/** Apply Excel-style, per-column picker filters without changing folder order. */
export function cellMatchesPickerColumnFilters(
  cell: CellPickerCell,
  filters: CellPickerColumnFilters,
): boolean {
  for (const [rawKey, filter] of Object.entries(filters)) {
    const key = rawKey as CellPickerSortKey;
    if (!cellPickerColumnHasFilter(filter, key)) continue;
    const value = cell[key];
    if (key === "name") {
      const actual = cell.name.toLocaleLowerCase();
      const expected = filter.value.trim().toLocaleLowerCase();
      if (filter.operator === "equals" ? actual !== expected : !actual.includes(expected)) {
        return false;
      }
      continue;
    }
    if (key === "cycle_count" || key === "max_specific_discharge_capacity_mah_g") {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      const first = Number(filter.value);
      const second = Number(filter.secondValue);
      if (!Number.isFinite(first)) return false;
      switch (filter.operator) {
        case "gt": if (!(value > first)) return false; break;
        case "lt": if (!(value < first)) return false; break;
        case "between":
          if (!Number.isFinite(second) || value < Math.min(first, second) || value > Math.max(first, second)) return false;
          break;
        default:
          if (Math.abs(value - first) > 1e-9 * Math.max(1, Math.abs(value), Math.abs(first))) return false;
      }
      continue;
    }
    if (typeof value !== "string") return false;
    const actual = value.slice(0, 10);
    const first = filter.value.trim();
    const second = filter.secondValue.trim();
    if (!first) return false;
    switch (filter.operator) {
      case "before": if (!(actual < first)) return false; break;
      case "after": if (!(actual > first)) return false; break;
      case "between":
        if (!second || actual < (first < second ? first : second) || actual > (first > second ? first : second)) return false;
        break;
      default: if (actual !== first) return false;
    }
  }
  return true;
}

export const EMPTY_CELL_PICKER_SORT: CellPickerSortState = {
  primary: null,
  secondary: null,
  primaryLocked: false,
};

export type CellPickerSourceFacet = {
  system: string;
  format: string | null;
  technique: string | null;
};

export type CellPickerFilters = {
  sourceSystems: readonly string[];
  fileFormats: readonly string[];
  techniques: readonly string[];
};

export const EMPTY_CELL_PICKER_FILTERS: CellPickerFilters = {
  sourceSystems: [],
  fileFormats: [],
  techniques: [],
};

export const UNKNOWN_CELL_PICKER_FACET = "__unknown__";

export type CellPickerCell = {
  id: number;
  name: string;
  cycle_count: number | null;
  max_specific_discharge_capacity_mah_g: number | null;
  created_at: string | null;
  last_modified_at: string | null;
  source_facets: readonly CellPickerSourceFacet[];
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

function selectedFacetValue(value: string | null | undefined): string {
  return value?.trim() || UNKNOWN_CELL_PICKER_FACET;
}

/** A Cell matches when one of its source files satisfies all active facets. */
export function cellMatchesPickerFilters(
  cell: { source_facets?: readonly CellPickerSourceFacet[] },
  filters: CellPickerFilters,
): boolean {
  if (
    filters.sourceSystems.length === 0 &&
    filters.fileFormats.length === 0 &&
    filters.techniques.length === 0
  ) return true;
  return (cell.source_facets ?? []).some((source) =>
    (filters.sourceSystems.length === 0 || filters.sourceSystems.includes(selectedFacetValue(source.system))) &&
    (filters.fileFormats.length === 0 || filters.fileFormats.includes(selectedFacetValue(source.format))) &&
    (filters.techniques.length === 0 || filters.techniques.includes(selectedFacetValue(source.technique)))
  );
}

/** Expose a hierarchy: system -> format -> technique, independent of downstream selections. */
export function cellPickerFacetValues(
  cells: readonly { source_facets?: readonly CellPickerSourceFacet[] }[],
  facet: "system" | "format" | "technique",
  filters: CellPickerFilters = EMPTY_CELL_PICKER_FILTERS,
): string[] {
  const values = new Set<string>();
  const filtersForFacet: CellPickerFilters = facet === "system"
    ? EMPTY_CELL_PICKER_FILTERS
    : facet === "format"
      ? { sourceSystems: filters.sourceSystems, fileFormats: [], techniques: [] }
      : { sourceSystems: filters.sourceSystems, fileFormats: filters.fileFormats, techniques: [] };
  cells.forEach((cell) => (cell.source_facets ?? []).forEach((source) => {
    if (cellMatchesPickerFilters({ source_facets: [source] }, filtersForFacet)) {
      values.add(selectedFacetValue(source[facet]));
    }
  }));
  return Array.from(values).sort((left, right) => {
    if (left === UNKNOWN_CELL_PICKER_FACET) return right === UNKNOWN_CELL_PICKER_FACET ? 0 : 1;
    if (right === UNKNOWN_CELL_PICKER_FACET) return -1;
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** Change one facet and prune only downstream selections made incompatible by that change. */
export function updateCellPickerFacetFilters(
  cells: readonly { source_facets?: readonly CellPickerSourceFacet[] }[],
  filters: CellPickerFilters,
  facet: "system" | "format" | "technique",
  values: readonly string[],
): CellPickerFilters {
  const next: CellPickerFilters = facet === "system"
    ? { ...filters, sourceSystems: values }
    : facet === "format"
      ? { ...filters, fileFormats: values }
      : { ...filters, techniques: values };
  const systemScoped: CellPickerFilters = { ...next, fileFormats: [], techniques: [] };
  const formatsToKeep = facet === "system" || facet === "format"
    ? new Set(cellPickerFacetValues(cells, "format", systemScoped))
    : new Set(next.fileFormats);
  const fileFormats = next.fileFormats.filter((value) => formatsToKeep.has(value));
  const formatScoped: CellPickerFilters = { ...next, fileFormats, techniques: [] };
  const compatibleTechniques = new Set(cellPickerFacetValues(cells, "technique", formatScoped));
  return {
    ...next,
    fileFormats,
    techniques: next.techniques.filter((value) => compatibleTechniques.has(value)),
  };
}

/** True only when every source is a BioLogic CP/OCV metadata-only source. */
export function cellHasOnlyMetadataOnlyBiologicSources(
  sources: readonly CellPickerSourceFacet[] | null | undefined,
): boolean {
  return Boolean(sources?.length) && (sources ?? []).every((source) =>
    source.system === "biologic" && ["CP", "OCV"].includes((source.technique ?? "").toUpperCase()),
  );
}

/** Keep the current preview only while it remains among the currently displayed cells. */
export function resolveCellPickerPreviewCellId(
  currentPreviewId: number | null,
  defaultPreviewId: number | null,
  visibleCellIds: readonly number[],
): number | null {
  return currentPreviewId !== null && visibleCellIds.includes(currentPreviewId)
    ? currentPreviewId
    : defaultPreviewId;
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

/** Sort one folder's cells by primary and optional tie-break criteria. */
export function sortCellPickerCells<T extends CellPickerCell>(
  cells: readonly T[],
  sort: CellPickerSortState,
): T[] {
  const criteria = [sort.primary, sort.secondary].filter((value): value is CellPickerSort => value !== null);
  if (criteria.length === 0) return [...cells];
  return cells.map((cell, index) => ({ cell, index })).sort((left, right) => {
    for (const criterion of criteria) {
      const leftValue = comparableValue(left.cell, criterion.key);
      const rightValue = comparableValue(right.cell, criterion.key);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue !== null) return 1;
        if (rightValue === null && leftValue !== null) return -1;
        continue;
      }
      const order = typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" })
        : Number(leftValue) - Number(rightValue);
      if (order !== 0) return criterion.direction === "asc" ? order : -order;
    }
    return left.index - right.index;
  }).map(({ cell }) => cell);
}

const FIRST_SORT_DIRECTION: Record<CellPickerSortKey, CellPickerSort["direction"]> = {
  name: "asc",
  cycle_count: "desc",
  max_specific_discharge_capacity_mah_g: "desc",
  created_at: "desc",
  last_modified_at: "desc",
};

function nextSort(current: CellPickerSort | null, key: CellPickerSortKey): CellPickerSort {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: FIRST_SORT_DIRECTION[key] };
}

export function nextCellPickerSort(
  current: CellPickerSortState,
  key: CellPickerSortKey,
): CellPickerSortState {
  if (!current.primary) {
    return { primary: nextSort(null, key), secondary: null, primaryLocked: false };
  }
  if (current.primary.key === key) {
    return { ...current, primary: nextSort(current.primary, key) };
  }
  if (current.secondary?.key === key) {
    return { ...current, secondary: nextSort(current.secondary, key) };
  }
  if (!current.primaryLocked) {
    return { primary: nextSort(null, key), secondary: null, primaryLocked: false };
  }
  return { ...current, secondary: nextSort(current.secondary, key) };
}

export function toggleCellPickerPrimarySortLock(
  current: CellPickerSortState,
): CellPickerSortState {
  if (!current.primary) return current;
  const primaryLocked = !current.primaryLocked;
  return {
    ...current,
    primaryLocked,
    secondary: primaryLocked ? current.secondary : null,
  };
}

export function removeCellPickerSecondarySort(
  current: CellPickerSortState,
): CellPickerSortState {
  return { ...current, secondary: null };
}

export function setCellPickerSortLevel(
  current: CellPickerSortState,
  key: CellPickerSortKey,
  direction: CellPickerSort["direction"],
  level: "primary" | "secondary",
): CellPickerSortState {
  if (level === "primary" || !current.primary) {
    return {
      primary: { key, direction },
      secondary: null,
      primaryLocked: false,
    };
  }
  if (current.primary.key === key) return current;
  return {
    ...current,
    secondary: { key, direction },
    primaryLocked: true,
  };
}
