import type { AnalysisSpec, CellSummary } from "./api.ts";

export type PreviewCycleWindow = { start: number; end: number };

export function pickerCycleExtentKey(cell: CellSummary, pairing: AnalysisSpec["computation"]["cycle_pairing"]) {
  return JSON.stringify([cell.id, pairing ?? "programmed", cell.n_files, cell.total_cycles,
    cell.cycle_count_ready, cell.last_data_update_at, cell.last_modified_at]);
}

/** Only the focused preview resolves measured phase pairs. Library totals describe recorded cycles. */
export function pickerNeedsCycleExtent(cell: CellSummary, pairing: AnalysisSpec["computation"]["cycle_pairing"]) {
  if (pairing && pairing !== "programmed") return true;
  return Boolean(cell.source_facets?.some(source => source.system === "biologic" && source.technique?.trim().toUpperCase() !== "OCV"))
    && (cell.n_files > 1 || !cell.total_cycles);
}

export function pickerPreviewWindow(count: number, tab: "voltage" | "capacity", edit?: PreviewCycleWindow): PreviewCycleWindow {
  if (count < 1) return { start: 0, end: 0 };
  const start = Math.min(count, Math.max(1, edit?.start ?? (tab === "voltage" ? count - 19 : 1)));
  return { start, end: Math.max(start, Math.min(count, edit?.end ?? count)) };
}

export function editPreviewWindow(window: PreviewCycleWindow, bound: "start" | "end", value: number): PreviewCycleWindow {
  return bound === "start" ? { start: value, end: Math.max(value, window.end) }
    : { start: Math.min(value, window.start), end: value };
}

/** Capacity/CE previews start with the entire available cycle range selected. */
export function fullPreviewCycleWindow(cycleCount: number): PreviewCycleWindow | null {
  const count = Math.trunc(cycleCount);
  return Number.isFinite(count) && count > 0 ? { start: 1, end: count } : null;
}

/** Shift the visible cycle window by its span, clamping both ends at the data bounds. */
export function shiftPreviewCycleWindow(
  window: PreviewCycleWindow,
  cycleCount: number,
  direction: -1 | 1,
): PreviewCycleWindow {
  if (cycleCount < 1) return { start: 0, end: 0 };
  const start = Math.max(1, Math.min(Math.trunc(window.start), cycleCount));
  const end = Math.max(start, Math.min(Math.trunc(window.end), cycleCount));
  const step = Math.max(1, end - start);
  return direction < 0
    ? { start: Math.max(1, start - step), end: Math.max(1, end - step) }
    : { start: Math.min(cycleCount, start + step), end: Math.min(cycleCount, end + step) };
}
