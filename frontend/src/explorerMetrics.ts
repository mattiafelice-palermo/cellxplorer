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
  max_specific_discharge_capacity_mah_g: number | null;
  summary_pending: boolean;
};

export function formatCycleCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  return value.toLocaleString();
}

/**
 * Specific capacity in mAh/g.
 *
 * Whole numbers: specific capacities sit in the tens to low hundreds, where a
 * decimal is noise, and an integer column is far easier to scan down.
 */
export function formatSpecificCapacity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  return Math.round(value).toLocaleString();
}

/** Raw capacity in mAh, used in tooltips rather than the column. */
export function formatCapacity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)} k`;
  return value.toFixed(1);
}
