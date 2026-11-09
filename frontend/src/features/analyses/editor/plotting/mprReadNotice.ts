import { sourceLimitationFigureText, type LimitationFigureContext } from "../../../../sourceLimitations.ts";
import type * as Plotly from "plotly.js";
import type { Badge } from "../../../../api";

/** The same layout reaches live, saved, image and portable figures. */
export function withMprReadNotice(
  layout: Partial<Plotly.Layout>, badges: readonly Badge[] | undefined,
  context?: LimitationFigureContext,
): Partial<Plotly.Layout> {
  const notice = sourceLimitationFigureText(badges, context);
  if (!notice) return layout;
  return {
    ...layout,
    margin: { ...layout.margin, t: Math.max(40, layout.margin?.t ?? 0) },
    annotations: [...(layout.annotations ?? []), {
      text: notice,
      xref: "paper", yref: "paper", x: 0, y: 1, yshift: 12,
      xanchor: "left", yanchor: "bottom", showarrow: false,
      font: { size: 11, color: "#9c5a00" },
    }],
  };
}
