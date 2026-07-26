import type { AnalysisSpec, SelectionEntry } from "./api";

export interface CellSelectionContext {
  cell_id: number;
  entry_kind: SelectionEntry["kind"];
  entry_ref_id: number;
}

function exclusionAppliesToContext(
  exclusion: AnalysisSpec["selection"]["exclusions"][number],
  cellId: number,
  context: CellSelectionContext,
) {
  return (
    exclusion.cell_id === cellId &&
    (exclusion.entry_kind == null || exclusion.entry_kind === context.entry_kind) &&
    (exclusion.entry_ref_id == null || exclusion.entry_ref_id === context.entry_ref_id)
  );
}

/**
 * A cell-level series is shared by every selection occurrence of that cell.
 * Hide it only when all those occurrences are hidden. Without context metadata,
 * retain the legacy any-exclusion behavior for older result families.
 */
export function isCellHiddenInAnalysis(
  spec: AnalysisSpec,
  cellId: number,
  contexts?: readonly CellSelectionContext[],
): boolean {
  const exclusions = (spec.selection.exclusions ?? []).filter(
    (exclusion) => exclusion.cell_id === cellId,
  );
  if (
    exclusions.some(
      (exclusion) =>
        exclusion.entry_kind == null && exclusion.entry_ref_id == null,
    )
  ) {
    return true;
  }
  if (contexts === undefined) return exclusions.length > 0;

  const cellContexts = contexts.filter((context) => context.cell_id === cellId);
  if (cellContexts.length === 0) return false;
  const hiddenGroups = new Set(spec.selection.hidden_replicate_group_ids ?? []);
  return cellContexts.every(
    (context) =>
      (context.entry_kind === "replicate_group" &&
        hiddenGroups.has(context.entry_ref_id)) ||
      exclusions.some((exclusion) =>
        exclusionAppliesToContext(exclusion, cellId, context),
      ),
  );
}
