/**
 * Identify diagnostic cycles (DCIR pulses, fast-charge probes) after the fact.
 *
 * Cycling protocols interleave short diagnostic cycles among the normal ones.
 * They discharge for seconds rather than hours, so they land near zero capacity
 * and wreck the vertical scale of a capacity plot.
 *
 * The detection deliberately keys on cycle *duration*, not capacity. A capacity
 * threshold cannot tell a DCIR pulse from a cell that genuinely died — both
 * look like "capacity collapsed" — and silently hiding real degradation is the
 * one outcome a scientific tool must never produce. A diagnostic cycle is short
 * because of what it is; a degraded cell still takes roughly a normal time to
 * discharge, it just delivers less.
 *
 * This is a presentation-level filter. It never changes stored or cached
 * scientific data, and callers are expected to report how many cycles it hid.
 */

export interface DiagnosticCycleOptions {
  /** Cycles in the centred window used for the local reference. */
  window?: number;
  /**
   * Relative deviation from the local median that marks a cycle as diagnostic.
   * 0.25 means "more than 25% away from its neighbours, in either direction".
   */
  tolerance?: number;
  /** Leave short series alone; there is no reliable local baseline. */
  minCycles?: number;
}

export const DIAGNOSTIC_DEFAULTS: Required<DiagnosticCycleOptions> = {
  // Wide enough to span a diagnostic block without letting it dominate: a
  // median tolerates up to half the window being contaminated, and a block is
  // typically a handful of cycles out of every eighty or so.
  window: 21,
  // Cycling under a fixed protocol is metronomic — observed blocks deviate by
  // 40% to 250%, while normal cycles sit within a fraction of a percent of
  // their neighbours. 25% leaves a wide margin on both sides.
  tolerance: 0.25,
  minCycles: 12,
};

/**
 * Signals compared against their own local baseline.
 *
 * Both are needed. A slow-rate capacity check discharges for far *longer* than
 * normal and delivers more capacity, so a "too short" rule misses it; a
 * fast-charge probe keeps a normal discharge and only its charge time betrays
 * it. Deviation in either signal, in either direction, marks the cycle.
 */
export const DIAGNOSTIC_SIGNALS = ["discharge_time_h", "charge_time_h"] as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Return the cycle numbers that look like diagnostics.
 *
 * `durations` must be aligned with `cycles`. Nulls are treated as unknown and
 * are never flagged — a missing measurement is not evidence of anything.
 */
export function findDiagnosticCycles(
  cycles: number[],
  durations: (number | null)[],
  options: DiagnosticCycleOptions = {}
): Set<number> {
  const { window, tolerance, minCycles } = { ...DIAGNOSTIC_DEFAULTS, ...options };
  const flagged = new Set<number>();
  if (cycles.length < minCycles) return flagged;

  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < cycles.length; i += 1) {
    const value = durations[i];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    const neighbourhood: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(durations.length - 1, i + half); j += 1) {
      const other = durations[j];
      if (other !== null && other !== undefined && Number.isFinite(other) && other > 0) {
        neighbourhood.push(other);
      }
    }
    const local = median(neighbourhood);
    // A local median of zero carries no information about scale.
    if (local === null || local <= 0) continue;
    if (Math.abs(value - local) > local * tolerance) flagged.add(cycles[i]);
  }
  return flagged;
}

/** Diagnostic cycles in one series, judged on every signal together. */
export function findDiagnosticCyclesInSeries(
  series: { x: number[]; quantities: Record<string, (number | null)[]> },
  options: DiagnosticCycleOptions = {}
): Set<number> {
  const flagged = new Set<number>();
  for (const signal of DIAGNOSTIC_SIGNALS) {
    const values = series.quantities?.[signal];
    if (!values) continue;
    for (const cycle of findDiagnosticCycles(series.x, values, options)) flagged.add(cycle);
  }
  return flagged;
}

/**
 * Union of the diagnostic cycles across every series being plotted.
 *
 * Series are filtered by cycle number rather than by index so that every
 * quantity — capacity on the left axis, coulombic efficiency on the right —
 * drops exactly the same cycles and cannot fall out of step.
 */
export function findDiagnosticCyclesAcross(
  series: { x: number[]; quantities: Record<string, (number | null)[]> }[],
  options: DiagnosticCycleOptions = {}
): Set<number> {
  const all = new Set<number>();
  for (const one of series) {
    for (const cycle of findDiagnosticCyclesInSeries(one, options)) all.add(cycle);
  }
  return all;
}
