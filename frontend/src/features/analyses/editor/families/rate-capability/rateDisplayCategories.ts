/** Display grouping only: keep the measured rates for calculations, hover and export. */
export function groupedDisplayRates(values: readonly number[]): Map<number, number> {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
  const result = new Map<number, number>();
  for (let start = 0; start < sorted.length;) {
    const low = sorted[start];
    let end = start + 1;
    // Bound the whole span; a chain of near neighbours must not merge distinct rates.
    while (end < sorted.length && sorted[end] - low <= sorted[end] * 0.01 * (1 + 1e-12)) end++;
    const high = sorted[end - 1];
    let label = low;
    if (end - start > 1) {
      label = high;
      for (let precision = 1; precision <= 6; precision++) {
        const rounded = Number((low + (high - low) / 2).toPrecision(precision));
        if (rounded >= low && rounded <= high) {
          label = rounded;
          break;
        }
      }
    }
    for (let index = start; index < end; index++) result.set(sorted[index], label);
    start = end;
  }
  return result;
}
