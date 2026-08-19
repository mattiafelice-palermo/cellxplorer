import type { Data } from "plotly.js";

import type {
  ContinuationPreviewRequest,
  ContinuationPreviewResult,
  ImportPreview,
} from "./api";

type PreviewDraft = Pick<
  ImportPreview,
  "staged_name" | "source_path" | "hash" | "size" | "inspection" | "metadata_only"
>;

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
): readonly [string, string[], string[], number] {
  const draftsByKey = new Map(drafts.map((draft) => [draft.staged_name, draft]));
  return [
    "continued-import-preview",
    [...order],
    order.map((key) => {
      const draft = draftsByKey.get(key);
      return draft ? draftIdentity(draft) : key;
    }),
    inspectionRevision,
  ];
}

/** Build the one backend request for the currently visible source order. */
export function continuationPreviewRequest(
  drafts: readonly PreviewDraft[],
  order: readonly string[],
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

export function continuationPreviewHasPoints(preview: ContinuationPreviewResult | undefined): boolean {
  return Boolean(preview?.segments.some((segment) => segment.x.length > 0 && segment.y.length > 0));
}
