/**
 * Presentation rules for the project explorer's metric columns.
 *
 * Kept apart from the tree so the "unknown is not zero" rule is pinned by tests:
 * a cell whose capacity summary is still being backfilled has no number yet, and
 * rendering that as 0 during an import reads to the user as data loss.
 */

/** Shown when a value is genuinely unknown — never for a real zero. */
export const UNKNOWN = "—";

export type RowMetrics = {
  cycle_count: number | null;
  max_discharge_capacity_mah: number | null;
  summary_pending: boolean;
};

export function formatCycleCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  return value.toLocaleString();
}

export function formatCapacity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  // Cell capacities span mAh to tens of Ah; past 10 000 mAh the extra digits are
  // noise in a narrow column.
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)} k`;
  return value.toFixed(1);
}

/**
 * Split plots into the batch fetched immediately and the rest, which load after.
 *
 * Nothing is hidden behind a "+N more": hovering a folder of analyses must not
 * fire an unbounded burst of thumbnail requests, but the user still ends up
 * seeing every plot.
 */
export function eagerAndLazyPlots<T>(plots: T[], eager: number): { eager: T[]; lazy: T[] } {
  const cut = Math.max(0, eager);
  return { eager: plots.slice(0, cut), lazy: plots.slice(cut) };
}
