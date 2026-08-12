/**
 * Pure helpers for grouping DCIR-specific cells by applicability.
 * These are testable in isolation without React or Mantine.
 */

/**
 * Group cells into applicable (with segments) and non-applicable (without segments).
 *
 * Returns a single grouped array with applicable cells first (enabled),
 * then non-applicable cells under a group heading (disabled).
 */
export function groupCellsByApplicability(
  cells: Array<{ id: number; name: string }>,
  applicableSegmentCounts: Map<number, number>
): Array<{
  group?: string;
  value: string;
  label: string;
  disabled?: boolean;
}> {
  const applicable = cells.filter(
    (cell) => (applicableSegmentCounts.get(cell.id) ?? 0) > 0
  );
  const nonApplicable = cells.filter(
    (cell) => (applicableSegmentCounts.get(cell.id) ?? 0) === 0
  );

  const result: Array<{
    group?: string;
    value: string;
    label: string;
    disabled?: boolean;
  }> = [];

  // Add applicable cells (no group for the first set)
  for (const cell of applicable) {
    result.push({
      value: String(cell.id),
      label: cell.name,
    });
  }

  // Add non-applicable cells under a group
  if (nonApplicable.length > 0) {
    for (const cell of nonApplicable) {
      result.push({
        group: "Cells with no DCIR segment",
        value: String(cell.id),
        label: cell.name,
        disabled: true,
      });
    }
  }

  return result;
}
