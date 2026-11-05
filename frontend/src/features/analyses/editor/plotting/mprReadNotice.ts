import type * as Plotly from "plotly.js";
import type { Badge } from "../../../../api";

/** The same layout reaches live, saved, image and portable figures. */
export function withMprReadNotice(
  layout: Partial<Plotly.Layout>, badges: readonly Badge[] | undefined,
): Partial<Plotly.Layout> {
  if (!badges?.some((badge) => badge.kind === "exploratory_mpr")) return layout;
  return {
    ...layout,
    margin: { ...layout.margin, t: Math.max(40, layout.margin?.t ?? 0) },
    annotations: [...(layout.annotations ?? []), {
      text: "Permissive MPR source · inspect source warnings",
      xref: "paper", yref: "paper", x: 0, y: 1, yshift: 12,
      xanchor: "left", yanchor: "bottom", showarrow: false,
      font: { size: 11, color: "#9c5a00" },
    }],
  };
}
