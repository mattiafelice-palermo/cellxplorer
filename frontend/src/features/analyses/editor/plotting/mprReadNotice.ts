import { sourceLimitationFigureText, type LimitationFigureContext } from "../../../../sourceLimitations.ts";
import type * as Plotly from "plotly.js";
import type { Badge } from "../../../../api";
export type SourceNoteLayout = Partial<Plotly.Layout> & { meta?: Record<string, unknown> };

/** Carry a qualification for standalone image exports. The editor shows source notes outside the graph. */
export function withMprReadNotice(
  layout: SourceNoteLayout, badges: readonly Badge[] | undefined,
  context?: LimitationFigureContext,
): SourceNoteLayout {
  const notice = sourceLimitationFigureText(badges, context);
  if (!notice) return layout;
  return { ...layout, meta: { ...layout.meta, cellxplorer_source_note: notice } };
}
