import type {
  AnalysisSpec,
  CellSummary,
  ReplicateGroupSummary,
  SelectionEntry,
  TimeCapacityResult,
  TimeCapacityTrace,
} from "../../../../../api";
import { isAnalysisSampleHidden } from "../../policies/analysisVisibility.ts";
import {
  timeCapacityUsesContinuousTime,
  type TimeCapacityQueryConfig,
} from "../../policies/timeCapacityQueryPolicy.ts";
import {
  cycleRangeWidth,
  normalizeTimeCapacityRange,
  type TimeCapacityCycleRange,
} from "./timeCapacityCycleNavigationPolicy.ts";

export interface SelectedCellCycleSummary {
  id: number;
  name: string;
  total_cycles: number | null;
  group_id: number | null;
}

export interface TimeCapacityOutOfWindowCell {
  id: number;
  name: string;
  totalCycles: number;
}

export interface TimeCapacityOutOfWindowNoticeInfo {
  cells: TimeCapacityOutOfWindowCell[];
  windowStart: number;
  windowEnd: number;
  isSpecificCycles: boolean;
  maxHiddenCycle: number;
  minHiddenCycle: number;
  jumpRange: TimeCapacityCycleRange;
  dismissKey: string;
}

export function selectTimeCapacityCellCycleSummaries(
  selectionEntries: readonly Pick<SelectionEntry, "kind" | "ref_id">[] | null | undefined,
  cells: readonly Pick<CellSummary, "id" | "name" | "total_cycles">[] | null | undefined,
  replicateGroups:
    | readonly Pick<ReplicateGroupSummary, "id" | "cell_ids">[]
    | null
    | undefined,
): SelectedCellCycleSummary[] {
  if (!selectionEntries || !cells) return [];

  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const groupById = new Map((replicateGroups ?? []).map((group) => [group.id, group]));
  const summaries: SelectedCellCycleSummary[] = [];

  for (const entry of selectionEntries) {
    if (entry.kind === "cell") {
      const cell = cellById.get(entry.ref_id);
      if (!cell) continue;
      summaries.push({
        id: cell.id,
        name: cell.name,
        total_cycles: cell.total_cycles ?? null,
        group_id: null,
      });
      continue;
    }

    const group = groupById.get(entry.ref_id);
    if (!group) continue;
    for (const cellId of group.cell_ids) {
      const cell = cellById.get(cellId);
      if (!cell) continue;
      summaries.push({
        id: cell.id,
        name: cell.name,
        total_cycles: cell.total_cycles ?? null,
        group_id: group.id,
      });
    }
  }

  return summaries;
}

function hasFiniteValue(values: readonly (number | null)[] | undefined): boolean {
  return values?.some((value) => value !== null && Number.isFinite(value)) ?? false;
}

function traceHasPlottedData(trace: TimeCapacityTrace): boolean {
  if (hasFiniteValue(trace.voltage_v)) return true;
  if (trace.voltage_v_by_channel) {
    for (const values of Object.values(trace.voltage_v_by_channel)) {
      if (hasFiniteValue(values)) return true;
    }
  }
  if (hasFiniteValue(trace.derivative_y)) return true;
  if (hasFiniteValue(trace.display_x)) return true;
  if (hasFiniteValue(trace.cycle)) return true;
  return false;
}

function activeCycleWindow(
  config: Partial<TimeCapacityQueryConfig>,
  viewportCycleRange: TimeCapacityCycleRange | null | undefined,
  maxAvailableCycle: number | null | undefined,
): { start: number; end: number; isSpecificCycles: boolean } {
  const specificCycles = (config.cycles ?? []).filter(
    (cycle): cycle is number => Number.isFinite(cycle) && cycle >= 1,
  );
  if (specificCycles.length > 0) {
    return {
      start: Math.min(...specificCycles),
      end: Math.max(...specificCycles),
      isSpecificCycles: true,
    };
  }
  const range =
    viewportCycleRange ??
    normalizeTimeCapacityRange(config.cycle_start, config.cycle_end, maxAvailableCycle);
  return {
    start: range.start,
    end: range.end,
    isSpecificCycles: false,
  };
}

export function computeTimeCapacityOutOfWindowNotice({
  spec,
  config,
  selectedCellCycles,
  viewportCycleRange,
  maxAvailableCycle,
  result,
}: {
  spec: AnalysisSpec;
  config: Partial<TimeCapacityQueryConfig>;
  selectedCellCycles: readonly SelectedCellCycleSummary[] | null | undefined;
  viewportCycleRange?: TimeCapacityCycleRange | null;
  maxAvailableCycle: number | null | undefined;
  result?: TimeCapacityResult | null;
}): TimeCapacityOutOfWindowNoticeInfo | null {
  if (!selectedCellCycles?.length || timeCapacityUsesContinuousTime(config)) {
    return null;
  }

  const window = activeCycleWindow(config, viewportCycleRange, maxAvailableCycle);
  if (window.start <= 1) {
    return null;
  }

  const renderedCellIds = new Set<number>();
  for (const trace of result?.cell_traces ?? []) {
    if (traceHasPlottedData(trace)) {
      renderedCellIds.add(trace.cell_id);
    }
  }

  const hiddenById = new Map<number, TimeCapacityOutOfWindowCell>();
  for (const item of selectedCellCycles) {
    if (
      isAnalysisSampleHidden(spec, {
        cell_id: item.id,
        group_id: item.group_id,
      })
    ) {
      continue;
    }
    if (renderedCellIds.has(item.id) || hiddenById.has(item.id)) {
      continue;
    }
    if (item.total_cycles === null || !Number.isFinite(item.total_cycles)) {
      continue;
    }
    const totalCycles = Math.floor(item.total_cycles);
    if (totalCycles <= 0 || totalCycles >= window.start) {
      continue;
    }
    hiddenById.set(item.id, {
      id: item.id,
      name: item.name,
      totalCycles,
    });
  }

  if (hiddenById.size === 0) {
    return null;
  }

  const cells = [...hiddenById.values()].sort(
    (left, right) => right.totalCycles - left.totalCycles || left.name.localeCompare(right.name),
  );
  const maxHiddenCycle = cells[0].totalCycles;
  const minHiddenCycle = cells[cells.length - 1].totalCycles;
  const maxCycleBound =
    typeof maxAvailableCycle === "number" && Number.isFinite(maxAvailableCycle) && maxAvailableCycle > 0
      ? Math.floor(maxAvailableCycle)
      : null;
  const preferredWidth = window.isSpecificCycles
    ? Math.min(20, maxCycleBound ?? 20)
    : cycleRangeWidth({ start: window.start, end: window.end });
  const jumpEnd =
    maxCycleBound !== null
      ? Math.min(maxCycleBound, Math.max(1, preferredWidth))
      : Math.max(1, preferredWidth);

  return {
    cells,
    windowStart: window.start,
    windowEnd: window.end,
    isSpecificCycles: window.isSpecificCycles,
    maxHiddenCycle,
    minHiddenCycle,
    jumpRange: { start: 1, end: jumpEnd },
    dismissKey: [...hiddenById.keys()].sort((left, right) => left - right).join(","),
  };
}
