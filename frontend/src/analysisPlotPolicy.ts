import type { AnalysisSpec, SavedAnalysisPlot } from "./api";

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function savedPlotSelectionFromSpec(spec: Pick<AnalysisSpec, "selection">): AnalysisSpec["selection"] {
  return {
    entries: [],
    exclusions: clone(spec.selection.exclusions ?? []),
    hidden_replicate_group_ids: clone(spec.selection.hidden_replicate_group_ids ?? []),
  };
}

export function specForSavedPlotView(base: AnalysisSpec, plot: SavedAnalysisPlot): AnalysisSpec {
  const next = clone(base);
  next.selection = {
    entries: clone(base.selection.entries ?? []),
    exclusions: clone(plot.selection?.exclusions ?? []),
    hidden_replicate_group_ids: clone(plot.selection?.hidden_replicate_group_ids ?? []),
  };
  next.computation = clone(plot.computation);
  next.aggregation = clone(plot.aggregation);
  next.presentation = clone(plot.presentation);
  return next;
}

export function plotViewSignature(spec: AnalysisSpec): string {
  return JSON.stringify({
    hidden_samples: (spec.selection.exclusions ?? [])
      .map((entry) => ({
        cell_id: entry.cell_id,
        entry_kind: entry.entry_kind ?? null,
        entry_ref_id: entry.entry_ref_id ?? null,
      }))
      .sort((a, b) =>
        `${a.entry_kind}:${a.entry_ref_id}:${a.cell_id}`.localeCompare(
          `${b.entry_kind}:${b.entry_ref_id}:${b.cell_id}`
        )
      ),
    hidden_replicate_group_ids: [...(spec.selection.hidden_replicate_group_ids ?? [])].sort((a, b) => a - b),
    computation: spec.computation,
    aggregation: spec.aggregation,
    presentation: spec.presentation,
  });
}

export function savedPlotPreviewSignature(base: AnalysisSpec, plot: SavedAnalysisPlot): string {
  const previewSpec = specForSavedPlotView(base, plot);
  return JSON.stringify({
    selection: previewSpec.selection,
    protocol_segments: previewSpec.protocol_segments ?? [],
    computation: previewSpec.computation,
    aggregation: previewSpec.aggregation,
    hidden_protocol_segment_ids: previewSpec.presentation.hidden_protocol_segment_ids ?? [],
  });
}
