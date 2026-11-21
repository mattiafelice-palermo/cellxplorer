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
