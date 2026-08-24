import type { CellSummary, ReplicateGroupSummary, SelectionEntry } from "../../../../../api";

export interface TimeCapacityCycleRange {
  start: number;
  end: number;
}

export type TimeCapacityCycleRangePatch = {
  start?: number | string | null;
  end?: number | string | null;
};

export const TIME_CAPACITY_WINDOW_PRESETS = [1, 5, 10, 20, 50, 100] as const;

const HISTORY_LIMIT = 50;

function positiveInteger(value: number | string | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : fallback;
}

function positiveMaximum(value: number | string | null | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function cycleRangeWidth(range: TimeCapacityCycleRange): number {
  return Math.max(1, range.end - range.start + 1);
}

export function cycleRangesEqual(
  left: TimeCapacityCycleRange,
  right: TimeCapacityCycleRange,
): boolean {
  return left.start === right.start && left.end === right.end;
}

/**
 * Normalize stored/manual endpoints without silently preserving an old width.
 * Navigation actions use normalizeCycleRangeForNavigation when width
 * preservation is required.
 */
export function normalizeTimeCapacityRange(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined = null,
): TimeCapacityCycleRange {
  let normalizedStart = positiveInteger(start, 1);
  let normalizedEnd = positiveInteger(end, Math.max(normalizedStart, 3));
  if (normalizedEnd < normalizedStart) normalizedEnd = normalizedStart;

  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum !== null) {
    normalizedStart = Math.min(normalizedStart, maximum);
    normalizedEnd = Math.min(normalizedEnd, maximum);
    if (normalizedEnd < normalizedStart) normalizedEnd = normalizedStart;
  }

  return { start: normalizedStart, end: normalizedEnd };
}

/** Clamp a window while preserving its inclusive width whenever possible. */
export function clampCycleWindow(
  preferredStart: number | string | null | undefined,
  requestedWidth: number | string | null | undefined,
  maxAvailableCycle: number | string,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  if (maximum === null) return normalizeTimeCapacityRange(preferredStart, preferredStart);

  const width = Math.min(positiveInteger(requestedWidth, 1), maximum);
  if (width >= maximum) return { start: 1, end: maximum };

  const latestStart = maximum - width + 1;
  const start = clamp(positiveInteger(preferredStart, 1), 1, latestStart);
  return { start, end: start + width - 1 };
}

/** Normalize a current/stored range for an action that must preserve its width. */
export function normalizeCycleRangeForNavigation(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const current = normalizeTimeCapacityRange(start, end);
  const maximum = positiveMaximum(maxAvailableCycle);
  return maximum === null
    ? current
    : clampCycleWindow(current.start, cycleRangeWidth(current), maximum);
}

export function shiftTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  direction: -1 | 1,
  mode: "cycle" | "window",
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) {
    if (direction !== -1 || mode !== "cycle") return current;
    const start = Math.max(1, current.start - 1);
    return { start, end: start + cycleRangeWidth(current) - 1 };
  }

  const amount = mode === "window" ? cycleRangeWidth(current) : 1;
  return clampCycleWindow(current.start + direction * amount, cycleRangeWidth(current), maximum);
}

export function resizeTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  requestedWidth: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;
  return clampCycleWindow(current.start, requestedWidth, maximum);
}

export function centerTimeCapacityCycleRange(
  range: TimeCapacityCycleRange,
  targetCycle: number | string | null | undefined,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const current = normalizeCycleRangeForNavigation(range.start, range.end, maximum);
  if (maximum === null) return current;

  const target = positiveInteger(targetCycle, current.start);
  return clampCycleWindow(target - Math.floor(cycleRangeWidth(current) / 2), cycleRangeWidth(current), maximum);
}

/** Apply one exact From/To edit, including the locked crossing behaviour. */
export function normalizeManualTimeCapacityRange(
  current: TimeCapacityCycleRange,
  patch: TimeCapacityCycleRangePatch,
  maxAvailableCycle: number | null | undefined,
): TimeCapacityCycleRange {
  const maximum = positiveMaximum(maxAvailableCycle);
  const baseline = normalizeTimeCapacityRange(current.start, current.end, maximum);
  const hasStart = patch.start !== undefined;
  const hasEnd = patch.end !== undefined;
  let start = hasStart ? positiveInteger(patch.start, baseline.start) : baseline.start;
  let end = hasEnd ? positiveInteger(patch.end, baseline.end) : baseline.end;

  if (maximum !== null) {
    start = Math.min(start, maximum);
    end = Math.min(end, maximum);
  }

  if (hasStart && !hasEnd && start > end) end = start;
  else if (hasEnd && !hasStart && end < start) start = end;
  else if (end < start) end = start;

  return { start, end };
}

export function cycleWindowOptions(
  currentWidth: number,
  maxAvailableCycle: number | null | undefined,
): number[] {
  const maximum = positiveMaximum(maxAvailableCycle);
  const width = positiveInteger(currentWidth, 1);
  const options: number[] = TIME_CAPACITY_WINDOW_PRESETS.filter(
    (preset) => maximum === null || preset <= maximum,
  );
  if (!options.includes(width as (typeof TIME_CAPACITY_WINDOW_PRESETS)[number])) {
    options.push(width);
  }
  return [...new Set(options)].sort((left, right) => left - right);
}

export function appendTimeCapacityCycleHistory(
  history: readonly TimeCapacityCycleRange[],
  range: TimeCapacityCycleRange,
  limit = HISTORY_LIMIT,
): TimeCapacityCycleRange[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const last = history[history.length - 1];
  if (last && cycleRangesEqual(last, range)) return [...history];
  return [...history, range].slice(-boundedLimit);
}

export function timeCapacityRangeNavigationDisabled(
  cycles: readonly number[] | null | undefined,
): boolean {
  return (cycles ?? []).length > 0;
}

export function timeCapacityPreviousViewDisabled(
  cycles: readonly number[] | null | undefined,
  historyLength: number,
): boolean {
  return timeCapacityRangeNavigationDisabled(cycles) || historyLength <= 0;
}

export function selectedTimeCapacityCycleMax(
  selectionEntries: readonly Pick<SelectionEntry, "kind" | "ref_id">[] | null | undefined,
  cells: readonly Pick<CellSummary, "id" | "total_cycles">[] | null | undefined,
  replicateGroups:
    | readonly Pick<ReplicateGroupSummary, "id" | "cell_ids">[]
    | null
    | undefined,
): number | null {
  if (!selectionEntries || !cells) return null;

  const groupById = new Map((replicateGroups ?? []).map((group) => [group.id, group]));
  const selectedCellIds = new Set<number>();
  for (const entry of selectionEntries) {
    if (entry.kind === "cell") selectedCellIds.add(entry.ref_id);
    else groupById.get(entry.ref_id)?.cell_ids.forEach((cellId) => selectedCellIds.add(cellId));
  }

  const totalsByCellId = new Map(cells.map((cell) => [cell.id, cell.total_cycles]));
  const validTotals = [...selectedCellIds]
    .map((cellId) => totalsByCellId.get(cellId))
    .filter((total): total is number => total !== undefined && Number.isFinite(total) && total > 0)
    .map((total) => Math.floor(total))
    .filter((total) => total > 0);

  return validTotals.length > 0 ? Math.max(...validTotals) : null;
}
