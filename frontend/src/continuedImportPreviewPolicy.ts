import type { Data, Layout } from "plotly.js";
import { withPreviewBreaks } from "./components/cellPreviewPlotModel.ts";

import type {
  ContinuationPreviewRequest,
  ContinuationPreviewResult,
  ImportPreview,
} from "./api";

type PreviewDraft = Pick<
  ImportPreview,
  "staged_name" | "source_path" | "hash" | "size" | "inspection" | "metadata_only" | "read_mode"
>;

export type ContinuationPreviewQuantity =
  | "voltage"
  | "discharge_capacity_mah"
  | "charge_capacity_mah"
  | "capacity_bundle";

export type ContinuationPreviewInterpretation = "source_chain" | "stitched";

/** Null requests every recorded row, including intervals without a cycle assignment. */
export function defaultContinuationVoltageRange(sourceCount: number, cycleCount: number) {
  return sourceCount === 1 && cycleCount > 20 ? { start: cycleCount - 19, end: cycleCount } : null;
}

export type ContinuationPreviewTimeUnit = "seconds" | "minutes" | "hours" | "days";

export type ContinuationPreviewTimeAxis = {
  unit: ContinuationPreviewTimeUnit;
  divisor: number;
  label: string;
};

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
    draft.read_mode ?? "safe",
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
        read_mode: draft.read_mode,
        allow_metadata_only: draft.metadata_only,
      })),
    proposed_order: [...order],
    quantity,
    interpretation,
  };
}

/** Match the Analysis cell picker: show a selected-range-relative time axis in minutes. */
export function continuationPreviewTimeAxis(
  preview: ContinuationPreviewResult,
): ContinuationPreviewTimeAxis | null {
  if (preview.quantity !== "voltage") return null;
  return { unit: "minutes", divisor: 60, label: "Time (min)" };
}

/** Rebase and scale only the display copy; scientific/cache values stay in seconds. */
export function scaleContinuationPreviewTimeAxis(
  preview: ContinuationPreviewResult,
): ContinuationPreviewResult {
  const axis = continuationPreviewTimeAxis(preview);
  if (!axis) return preview;
  // Only plotted coordinates are valid time values. Empty voltage segments
  // can carry cycle-range metadata, which must not be mistaken for seconds.
  const coordinates = preview.segments.flatMap((segment) => segment.x)
    .filter((value) => Number.isFinite(value));
  const origin = coordinates.length ? Math.min(...coordinates) : 0;
  const scale = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? (value - origin) / axis.divisor : value;
  return {
    ...preview,
    x_label: axis.label,
    segments: preview.segments.map((segment) => ({
      ...segment,
      x: segment.x.map((value) => (value - origin) / axis.divisor),
      display_x_start: segment.x.length ? scale(segment.display_x_start) : null,
      display_x_end: segment.x.length ? scale(segment.display_x_end) : null,
    })),
  };
}

/** Translate the backend's source-segment response into legend-free Plotly traces. */
export function buildContinuationPreviewTraces(
  preview: ContinuationPreviewResult,
  colorsBySourceKey: Record<string, string>,
  selectedSourceKey?: string | null,
): Data[] {
  return preview.segments.map((segment, index) => {
    const color = colorsBySourceKey[segment.source_key] ?? "#12b886";
    const selected = Boolean(selectedSourceKey && selectedSourceKey === segment.source_key);
    const voltage = preview.quantity === "voltage";
    return {
      x: withPreviewBreaks(segment.x, voltage ? segment.display_break_before : undefined),
      y: withPreviewBreaks(segment.y, voltage ? segment.display_break_before : undefined),
      connectgaps: false,
      type: "scatter",
      mode: "lines+markers",
      line: { width: selected ? (voltage ? 4 : 3) : 2, color },
      marker: { size: selected && !voltage ? 8 : 5, color },
      opacity: selectedSourceKey ? (selected ? 1 : 0.62) : 1,
      name: `Source ${index + 1} — ${segment.filename}`,
      hovertemplate:
        `Source ${index + 1} — ${segment.filename}<br>`
        + `${voltage ? (preview.x_label ?? "Time") : "Cycle"} %{x}<br>`
        + `${preview.label} %{y:.3f}<extra></extra>`,
      showlegend: false,
    } as Data;
  });
}

export type PreviewSourceLines = {
  number: number;
  filename: string;
  color: string;
  traces: ReadonlyArray<{ x: Array<number | null>; y: Array<number | null> }>;
};

/** Derive coverage from the plotted coordinates, including both capacity directions and CE. */
export function previewSourceSpans(sources: PreviewSourceLines[]) {
  return sources.flatMap(({ number, filename, color, traces }) => {
    let start = Infinity;
    let end = -Infinity;
    for (const { x, y } of traces) {
      x.forEach((point, index) => {
        if (point === null || !Number.isFinite(point) || !Number.isFinite(y[index])) return;
        start = Math.min(start, point);
        end = Math.max(end, point);
      });
    }
    return end >= start ? [{ number, filename, color, start, end }] : [];
  });
}

export type PreviewXAxisViewport = { start: number; end: number; width: number };

export function buildContinuationPreviewProvenanceLayout(
  spans: ReturnType<typeof previewSourceSpans>,
  viewport: PreviewXAxisViewport,
  sequentialAxis: boolean,
): Pick<Layout, "shapes" | "annotations"> {
  const shapes: NonNullable<Layout["shapes"]> = [];
  const annotations: NonNullable<Layout["annotations"]> = [];
  const { start, end, width } = viewport;
  if (end <= start || width <= 0) return { shapes, annotations };

  if (sequentialAxis) {
    spans.slice(1).forEach((next, index) => {
      const previous = spans[index];
      const join = (previous.end + next.start) / 2;
      if (previous.end > next.start || join < start || join > end) return;
      // A guide drawn from the measured viewport must never feed Plotly's next autorange.
      const fraction = (join - start) / (end - start);
      shapes.push({
        type: "line", xref: "paper", x0: fraction, x1: fraction, yref: "paper", y0: 0, y1: 1,
        line: { color: previous.color, width: 1.5, dash: "dash" },
      });
    });
  }

  const visible = spans.filter((span) => span.end >= start && span.start <= end).map((span) => {
    const center = (Math.max(start, span.start) + Math.min(end, span.end)) / 2;
    return { ...span, pixel: (center - start) / (end - start) * width };
  }).sort((a, b) => a.pixel - b.pixel || a.number - b.number);
  if (!visible.length) return { shapes, annotations };

  // Short recordings can be fractions of a pixel wide. Spread their badges while
  // keeping each leader attached to its true interval. Group only beyond screen capacity.
  const singleWidth = 16 + 7 * Math.max(...visible.map((span) => String(span.number).length));
  const compact = visible.length * singleWidth > width;
  const columns = Math.max(1, Math.floor(width / 72));
  const buckets = new Map<number, typeof visible>();
  visible.forEach((span, index) => {
    const key = compact ? Math.min(columns - 1, Math.floor(span.pixel / width * columns)) : index;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(span);
    else buckets.set(key, [span]);
  });
  const labels = [...buckets.values()].map((members) => {
    const first = members[0];
    const last = members[members.length - 1];
    const text = members.length === 1 ? String(first.number)
      : members.every((item, i) => item.number === first.number + i) ? `${first.number}–${last.number}`
      : `${first.number} +${members.length - 1}`;
    const anchor = (first.pixel + last.pixel) / 2;
    return { members, text, anchor, pixel: anchor, halfWidth: (14 + 7 * text.length) / 2 };
  });
  let left = 0;
  for (const label of labels) {
    label.pixel = Math.max(label.pixel, left + label.halfWidth);
    left = label.pixel + label.halfWidth + 2;
  }
  let right = width;
  for (const label of [...labels].reverse()) {
    label.pixel = Math.min(label.pixel, right - label.halfWidth);
    right = label.pixel - label.halfWidth - 2;
  }
  for (const { members, text, pixel, anchor } of labels) {
    const color = members.length === 1 ? members[0].color : "#64748b";
    const filenames = members.map((span) => {
      const filename = span.filename.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return `Source ${span.number} · ${filename}`;
    });
    annotations.push({
      x: anchor / width, xref: "paper", y: 1, yref: "paper",
      ax: pixel - anchor, ay: -22, axref: "pixel", ayref: "pixel",
      showarrow: true, arrowhead: 0, arrowwidth: 1, arrowcolor: color,
      xanchor: "center", yanchor: "middle", text,
      hovertext: filenames.join("<br>"),
      bgcolor: pastelSourceColor(color),
      bordercolor: color,
      borderwidth: 1, borderpad: 3,
      font: { color: "#1f2937", size: 12 },
    });
  }
  return { shapes, annotations };
}

function pastelSourceColor(color: string): string {
  const match = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return "#eefbf7";
  const channels = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16));
  const softened = channels.map((channel) => Math.round(channel + (255 - channel) * 0.78));
  return `#${softened.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function continuationPreviewHasPoints(preview: ContinuationPreviewResult | undefined): boolean {
  return Boolean(preview?.segments.some((segment) => segment.x.length > 0 && segment.y.length > 0));
}
