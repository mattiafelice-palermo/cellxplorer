import type { Data, Layout } from "plotly.js";

import type {
  ContinuationPreviewRequest,
  ContinuationPreviewResult,
  ImportPreview,
} from "./api";

type PreviewDraft = Pick<
  ImportPreview,
  "staged_name" | "source_path" | "hash" | "size" | "inspection" | "metadata_only"
>;

export type ContinuationPreviewQuantity =
  | "voltage"
  | "discharge_capacity_mah"
  | "charge_capacity_mah";

export type ContinuationPreviewInterpretation = "source_chain" | "stitched";

export type ContinuationPreviewFailureSource = {
  filename: string;
  reason: string;
};

export function continuationPreviewFailureSources(detail: unknown): ContinuationPreviewFailureSource[] {
  if (!detail || typeof detail !== "object" || !("sources" in detail)) return [];
  const sources = (detail as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const record = source as Record<string, unknown>;
    const filename = typeof record.filename === "string" ? record.filename.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    return filename && reason ? [{ filename, reason }] : [];
  });
}

function draftIdentity(draft: PreviewDraft): string {
  return [
    draft.staged_name,
    draft.hash,
    draft.inspection?.size ?? draft.size,
    draft.inspection?.mtime_ns ?? "",
    draft.source_path ?? "",
  ].join("\u0000");
}

/** Query identity includes visible order and every inspected source fingerprint. */
export function continuationPreviewQueryKey(
  order: readonly string[],
  drafts: readonly PreviewDraft[],
  inspectionRevision = 0,
  quantity: ContinuationPreviewQuantity = "discharge_capacity_mah",
  interpretation: ContinuationPreviewInterpretation = "stitched",
): readonly [string, string[], string[], number, ContinuationPreviewQuantity, ContinuationPreviewInterpretation] {
  const draftsByKey = new Map(drafts.map((draft) => [draft.staged_name, draft]));
  return [
    "continued-import-preview",
    [...order],
    order.map((key) => {
      const draft = draftsByKey.get(key);
      return draft ? draftIdentity(draft) : key;
    }),
    inspectionRevision,
    quantity,
    interpretation,
  ];
}

/** Build the one backend request for the currently visible source order. */
export function continuationPreviewRequest(
  drafts: readonly PreviewDraft[],
  order: readonly string[],
  quantity: ContinuationPreviewQuantity = "discharge_capacity_mah",
  interpretation: ContinuationPreviewInterpretation = "stitched",
): ContinuationPreviewRequest {
  const draftsByKey = new Map(drafts.map((draft) => [draft.staged_name, draft]));
  return {
    sources: order
      .map((key) => draftsByKey.get(key))
      .filter((draft): draft is PreviewDraft => Boolean(draft))
      .map((draft) => ({
        staged_name: draft.staged_name,
        source_path: draft.source_path,
        inspection: draft.inspection,
        allow_metadata_only: draft.metadata_only,
    })),
    proposed_order: [...order],
    quantity,
    interpretation,
  };
}

/** Translate the backend's source-segment response into legend-free Plotly traces. */
export function buildContinuationPreviewTraces(
  preview: ContinuationPreviewResult,
  colorsBySourceKey: Record<string, string>,
): Data[] {
  return preview.segments.map((segment, index) => {
    const color = colorsBySourceKey[segment.source_key] ?? "#12b886";
    return {
      x: segment.x,
      y: segment.y,
      type: "scatter",
      mode: "lines+markers",
      line: { width: 2, color },
      marker: { size: 5, color },
      name: `Source ${index + 1} — ${segment.filename}`,
      hovertemplate:
        `Source ${index + 1} — ${segment.filename}<br>`
        + "Cycle %{x}<br>"
        + `${preview.label} %{y:.3f}<extra></extra>`,
      showlegend: false,
    } as Data;
  });
}

/**
 * Build file-provenance guides independently of the active interpretation.
 * Each backend segment gets one dashed marker and one bottom source number;
 * colors identify the physical file, not the inferred cycle grouping.
 */
export function buildContinuationPreviewProvenanceLayout(
  preview: ContinuationPreviewResult,
  colorsBySourceKey: Record<string, string>,
): Pick<Layout, "shapes" | "annotations"> {
  const shapes: NonNullable<Layout["shapes"]> = [];
  const annotations: NonNullable<Layout["annotations"]> = [];

  preview.segments.forEach((segment, index) => {
    const points = segment.x.filter((value) => Number.isFinite(value));
    const start = Number.isFinite(segment.global_cycle_start)
      ? segment.global_cycle_start
      : points[0] ?? null;
    const end = Number.isFinite(segment.global_cycle_end)
      ? segment.global_cycle_end
      : points[points.length - 1] ?? null;
    if (start === null || end === null) return;

    const next = preview.segments[index + 1];
    const nextStart = next && Number.isFinite(next.global_cycle_start)
      ? next.global_cycle_start
      : next?.x.find((value) => Number.isFinite(value)) ?? null;
    const boundary = nextStart !== null ? (end + nextStart) / 2 : end;
    const color = colorsBySourceKey[segment.source_key] ?? "#12b886";
    shapes.push({
      type: "line",
      x0: boundary,
      x1: boundary,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color, width: 1, dash: "dash" },
      opacity: 0.72,
    });
    annotations.push({
      x: (start + end) / 2,
      y: -0.18,
      xref: "x",
      yref: "paper",
      text: String(index + 1),
      showarrow: false,
      font: { color, size: 11 },
    });
  });

  return { shapes, annotations };
}

export function continuationPreviewHasPoints(preview: ContinuationPreviewResult | undefined): boolean {
  return Boolean(preview?.segments.some((segment) => segment.x.length > 0 && segment.y.length > 0));
}
