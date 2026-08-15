import type { AnalysisSpec, SavedAnalysisPlot } from "../../../../api";

// Increment when thumbnail generation changes in a way that makes persisted
// PNG/SVG artifacts visually incompatible with the live plot renderer.
export const SAVED_PLOT_THUMBNAIL_RENDER_VERSION = 7;

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
    dcir_segments: spec.dcir_segments ?? [],
    computation: spec.computation,
    aggregation: spec.aggregation,
    presentation: spec.presentation,
  });
}

export function savedPlotPreviewSignature(base: AnalysisSpec, plot: SavedAnalysisPlot): string {
  const previewSpec = specForSavedPlotView(base, plot);
  return JSON.stringify({
    thumbnail_renderer_version: SAVED_PLOT_THUMBNAIL_RENDER_VERSION,
    saved_plot_modified_at: plot.modified_at,
    selection: previewSpec.selection,
    protocol_segments: previewSpec.protocol_segments ?? [],
    dcir_segments: previewSpec.dcir_segments ?? [],
    computation: previewSpec.computation,
    aggregation: previewSpec.aggregation,
    presentation: previewSpec.presentation,
  });
}
