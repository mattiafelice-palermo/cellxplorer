import type { TimeCapacityResult } from "./api";

export const PLOT_TIME_UNITS = [
  { value: "s", label: "Seconds" },
  { value: "min", label: "Minutes" },
  { value: "h", label: "Hours" },
  { value: "d", label: "Days" },
];

const secondsPerUnit = { s: 1, min: 60, h: 3600, d: 86400 };
export type PlotTimeUnit = keyof typeof secondsPerUnit;

export function secondsPerPlotTimeUnit(unit: PlotTimeUnit) {
  return secondsPerUnit[unit] ?? 1;
}

export function secondsResultInDays<T extends TimeCapacityResult>(result: T): T {
  const days = (seconds: number) => seconds / secondsPerUnit.d;
  return {
    ...result,
    settings: { ...result.settings, time_unit: "d" },
    cell_traces: result.cell_traces.map((trace) => ({
      ...trace,
      display_x: trace.display_x?.map((x) => x === null ? null : days(x)),
      display_cycle_spans: trace.display_cycle_spans && Object.fromEntries(
        Object.entries(trace.display_cycle_spans).map(([cycle, [start, end]]) => [cycle, [days(start), days(end)]]),
      ),
    })),
  };
}
