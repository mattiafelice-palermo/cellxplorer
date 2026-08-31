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

/** One user-visible series target in the current plot context. */
export interface SeriesVisibilityCandidate {
  /** Stable application identity persisted in `hidden_series_ids`. */
  key: string;
  /** Human-readable text for the action label; never used as identity. */
  label: string;
}

export interface PlotSeriesVisibilityItem extends SeriesVisibilityCandidate {
  hidden: boolean;
}

/** Convert the current hidden state into the visibility requested by a toggle. */
export function visibilityAfterToggle(currentlyHidden: boolean): boolean {
  return currentlyHidden;
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

/** Resolve one retained result row against the live analysis draft.
 *
 * Visibility is display-only, so cycle and Time/Capacity queries may retain a
 * result whose `excluded` flag reflects an older draft. The live selection is
 * therefore authoritative in both directions: it must be possible to hide a
 * visible cached row and to reveal a cached row that was previously hidden.
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
  const occurrenceIsSelected = (spec.selection.entries ?? []).some(
    (entry) =>
      entry.kind === context.entry_kind && entry.ref_id === context.entry_ref_id,
  );
  if (!occurrenceIsSelected) return true;
  return isCellHiddenInAnalysis(spec, sample.cell_id, [context]);
}

/** Display-only: has this analysis segment been hidden across all cells? */
export function isAnalysisSegmentHidden(spec: AnalysisSpec, segmentId: string): boolean {
  return (spec.presentation.hidden_analysis_segment_ids ?? []).includes(segmentId);
}

/** Display-only: has this individual series line been hidden? */
export function isSeriesHidden(spec: AnalysisSpec, seriesId: string): boolean {
  return (spec.presentation.hidden_series_ids ?? []).includes(seriesId);
}

/**
 * Deduplicate current plot targets by their stable key and resolve their
 * persisted hidden state. Duplicate descriptors occur for secondary/helper
 * traces, which are represented by their first-class primary target instead.
 */
export function plotSeriesVisibilityItems(
  candidates: readonly SeriesVisibilityCandidate[],
  spec: AnalysisSpec,
): PlotSeriesVisibilityItem[] {
  const seen = new Set<string>();
  const items: PlotSeriesVisibilityItem[] = [];
  for (const candidate of candidates) {
    if (!candidate.key || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    items.push({ ...candidate, hidden: isSeriesHidden(spec, candidate.key) });
  }
  return items;
}

/**
 * Return the persisted hidden set after isolating one applicable target.
 * Higher-level exclusions are absent from `candidates`, so they remain
 * untouched and cannot be resurrected by either visibility action.
 */
export function hiddenSeriesIdsAfterShowOnly(
  currentHidden: readonly string[] | undefined,
  candidates: readonly SeriesVisibilityCandidate[],
  targetKey: string,
): string[] {
  const applicable = plotSeriesVisibilityKeys(candidates);
  if (!applicable.has(targetKey)) return [...(currentHidden ?? [])];
  const next = new Set(currentHidden ?? []);
  for (const key of applicable) {
    if (key === targetKey) next.delete(key);
    else next.add(key);
  }
  return [...next];
}

/** Restore only user-hidden keys represented by the current applicable set. */
export function hiddenSeriesIdsAfterShowAll(
  currentHidden: readonly string[] | undefined,
  candidates: readonly SeriesVisibilityCandidate[],
): string[] {
  const applicable = plotSeriesVisibilityKeys(candidates);
  return (currentHidden ?? []).filter((key) => !applicable.has(key));
}

/** Plotly must remain a passive legend; visibility belongs to the app state. */
export function disablePlotlyLegendVisibility(
  layout: Partial<Plotly.Layout> | undefined,
): Partial<Plotly.Layout> {
  return {
    ...(layout ?? {}),
    legend: {
      ...(layout?.legend ?? {}),
      itemclick: false,
      itemdoubleclick: false,
    },
  };
}

/** Event callback return value that cancels Plotly's native legend mutation. */
export function blockPlotlyLegendVisibility(): false {
  return false;
}

function plotSeriesVisibilityKeys(
  candidates: readonly SeriesVisibilityCandidate[],
): Set<string> {
  return new Set(candidates.map((candidate) => candidate.key).filter(Boolean));
}
