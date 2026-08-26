import type { AnalysisSpec, SelectionEntry } from "../../../../api";

export interface CellSelectionContext {
  cell_id: number;
  entry_kind: SelectionEntry["kind"];
  entry_ref_id: number;
}

export interface AnalysisSampleVisibility {
  cell_id: number;
  group_id: number | null;
  excluded?: boolean | null;
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

/**
 * Resolve the visibility of one result row against the live analysis draft.
 * The server flag remains a fast authoritative path, while the draft check
 * makes retained/placeholder results respond to the sidebar immediately.
 */
export function isAnalysisSampleHidden(
  spec: AnalysisSpec,
  sample: AnalysisSampleVisibility,
): boolean {
  const context: CellSelectionContext =
    sample.group_id == null
      ? { cell_id: sample.cell_id, entry_kind: "cell", entry_ref_id: sample.cell_id }
      : {
          cell_id: sample.cell_id,
          entry_kind: "replicate_group",
          entry_ref_id: sample.group_id,
        };
  return Boolean(
    sample.excluded || isCellHiddenInAnalysis(spec, sample.cell_id, [context]),
  );
}

/** Display-only: has this analysis segment been hidden across all cells? */
export function isAnalysisSegmentHidden(spec: AnalysisSpec, segmentId: string): boolean {
  return (spec.presentation.hidden_analysis_segment_ids ?? []).includes(segmentId);
}

/** Display-only: has this individual series line been hidden? */
export function isSeriesHidden(spec: AnalysisSpec, seriesId: string): boolean {
  return (spec.presentation.hidden_series_ids ?? []).includes(seriesId);
}
