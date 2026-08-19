/**
 * Identify protocol diagnostic/support cycles after the fact.
 *
 * Diagnostic blocks contain supporting steps around the actual pulse. Those
 * cycles are not ordinary battery cycling and should be hidden together. The
 * detector therefore uses the lower of the charge and discharge capacities,
 * rather than trying to recognize a particular DCIR protocol.
 *
 * Each cell supplies its own baseline. After formation, a cycle is hidden when
 * its lower phase capacity is more than the configured tolerance below the
 * median of its neighbouring post-formation cycles. This remains a
 * presentation-level filter: stored and exported scientific data are kept.
 */

export interface DiagnosticCycleOptions {
  /** Cycles in the centred window used for the local reference. */
  window?: number;
  /**
   * Lower-tail deviation from the local median that marks a cycle as
   * diagnostic. 0.25 means "below 75% of the local median".
   */
  tolerance?: number;
  /** Leave short series alone; there is no reliable local baseline. */
  minCycles?: number;
  /** Number of initial formation cycles excluded from the baseline and filter. */
  formationCycles?: number;
}

export const DIAGNOSTIC_DEFAULTS: Required<DiagnosticCycleOptions> = {
  window: 21,
  tolerance: 0.25,
  minCycles: 12,
  formationCycles: 0,
};

/** The two phase capacities are combined by taking the lower value. */
export const DIAGNOSTIC_SIGNALS = [
  "charge_capacity_mah",
  "discharge_capacity_mah",
] as const;

function isFinitePositive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Return cycle numbers whose lower phase capacity is below the local baseline.
 *
 * `capacities` must be aligned with `cycles`. Nulls and non-positive values are
 * treated as unknown rather than evidence; a cycle is only judged when both
 * phase capacities were available to form the lower-capacity signal.
 */
export function findDiagnosticCycles(
  cycles: number[],
  capacities: (number | null)[],
  options: DiagnosticCycleOptions = {},
): Set<number> {
  const { window, tolerance, minCycles, formationCycles } = {
    ...DIAGNOSTIC_DEFAULTS,
    ...options,
  };
  const flagged = new Set<number>();
  const postFormationCount = cycles.filter((cycle) => cycle > formationCycles).length;
  if (postFormationCount < minCycles) return flagged;

  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < cycles.length; i += 1) {
    if (cycles[i] <= formationCycles) continue;
    const value = capacities[i];
    if (!isFinitePositive(value)) continue;

    const neighbourhood: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(capacities.length - 1, i + half); j += 1) {
      if (cycles[j] <= formationCycles) continue;
      const other = capacities[j];
      if (isFinitePositive(other)) neighbourhood.push(other);
    }
    const local = median(neighbourhood);
    if (local === null || local <= 0) continue;
    if (value < local * (1 - tolerance)) flagged.add(cycles[i]);
  }
  return flagged;
}

/** Diagnostic cycles in one series, judged on the lower phase capacity. */
export function findDiagnosticCyclesInSeries(
  series: { x: number[]; quantities: Record<string, (number | null)[]> },
  options: DiagnosticCycleOptions = {},
): Set<number> {
  const charge = series.quantities?.[DIAGNOSTIC_SIGNALS[0]];
  const discharge = series.quantities?.[DIAGNOSTIC_SIGNALS[1]];
  if (!charge || !discharge) return new Set();

  const capacities = series.x.map((_, index) => {
    const chargeCapacity = charge[index];
    const dischargeCapacity = discharge[index];
    if (!isFinitePositive(chargeCapacity) || !isFinitePositive(dischargeCapacity)) return null;
    return Math.min(chargeCapacity, dischargeCapacity);
  });
  return findDiagnosticCycles(series.x, capacities, options);
}

/** Union of diagnostic cycles across every series being plotted. */
export function findDiagnosticCyclesAcross(
  series: { x: number[]; quantities: Record<string, (number | null)[]> }[],
  options: DiagnosticCycleOptions = {},
): Set<number> {
  const all = new Set<number>();
  for (const one of series) {
    for (const cycle of findDiagnosticCyclesInSeries(one, options)) all.add(cycle);
  }
  return all;
}

/** Collapse a sorted cycle list into contiguous runs. */
export function cycleRanges(cycles: number[]): [number, number][] {
  const sorted = [...new Set(cycles)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const cycle of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && cycle === last[1] + 1) last[1] = cycle;
    else ranges.push([cycle, cycle]);
  }
  return ranges;
}

/** Render hidden cycles compactly. */
export function formatCycleRanges(cycles: number[], limit = Infinity): string {
  const ranges = cycleRanges(cycles);
  const shown = ranges.slice(0, limit);
  const text = shown.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
  const rest = ranges.length - shown.length;
  return rest > 0 ? `${text}, and ${rest} more` : text;
}

export interface DiagnosticSummary {
  hidden: number[];
  hiddenCount: number;
  shownCount: number;
  ranges: [number, number][];
}

/** Report both sides of the split: what was removed and what remains. */
export function summarizeHidden(allCycles: number[], hidden: Set<number>): DiagnosticSummary {
  const present = [...new Set(allCycles)];
  const removed = present.filter((cycle) => hidden.has(cycle)).sort((a, b) => a - b);
  return {
    hidden: removed,
    hiddenCount: removed.length,
    shownCount: present.length - removed.length,
    ranges: cycleRanges(removed),
  };
}
