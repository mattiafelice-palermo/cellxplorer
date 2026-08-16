/**
 * Pure transformation for the detached Series-appearance legend preview.
 *
 * The source figure is the same family-specific preview used by the real plot.
 * Only traces that Plotly would expose in its legend survive; their scientific
 * data is replaced with one null-valued sentinel point so the detached
 * instance materialises authentic Plotly symbols without retaining or drawing
 * the curves.
 */

export type LegendPreviewFigure = {
  data: readonly unknown[];
  layout: Readonly<Record<string, unknown>>;
};

export type LegendPreviewEntry = {
  name: string;
  type: string;
  mode: string;
  opacity: number;
  line: {
    color: string | null;
    width: number;
    dash: string;
  };
  marker: {
    color: string | null;
    size: number;
    symbol: string | number | null;
  };
};

export const LEGEND_PREVIEW_WIDTH = 620;
export const LEGEND_PREVIEW_MIN_HEIGHT = 84;
export const LEGEND_PREVIEW_MAX_HEIGHT = 220;
export const LEGEND_PREVIEW_EXPANDED_WIDTH = 860;
export const LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT = LEGEND_PREVIEW_MIN_HEIGHT;
/** Plotly drops zero-length traces before creating their legend entries. */
export const LEGEND_PREVIEW_SENTINEL_X = 0;
export const LEGEND_PREVIEW_SENTINEL_Y = null;
/**
 * Keep Plotly live enough to expose its bounded legend scrollbar, while the
 * legend's own item click settings below make the surface passive.
 */
export const LEGEND_PREVIEW_CONFIG = {
  displayModeBar: false,
  responsive: true,
} as const;

function legendEntryRows(entryCount: number, orientation: "h" | "v"): number {
  return orientation === "v" ? entryCount : Math.max(1, Math.ceil(entryCount / 4));
}

/** Size a full legend to its content so the outer modal, not Plotly, owns overflow. */
export function expandedLegendPreviewHeight(entryCount: number, orientation: "h" | "v"): number {
  if (entryCount <= 0) return LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT;
  return Math.max(
    LEGEND_PREVIEW_EXPANDED_MIN_HEIGHT,
    48 + legendEntryRows(entryCount, orientation) * 24,
  );
}

/**
 * Enlarge the same passive legend figure for the optional full-size viewer.
 * The data array and nested legend object are intentionally reused, so the
 * expanded surface cannot drift from the embedded ordering or styling.
 */
export function expandLegendPreview(preview: LegendPreviewFigure): LegendPreviewFigure {
  const sourceLayout = isRecord(preview.layout) ? preview.layout : {};
  const sourceHeight = typeof sourceLayout.height === "number" ? sourceLayout.height : 0;
  const sourceLegend = isRecord(sourceLayout.legend) ? sourceLayout.legend : {};
  const orientation = sourceLegend.orientation === "v" ? "v" : "h";
  return {
    data: preview.data,
    layout: {
      ...sourceLayout,
      autosize: false,
      width: LEGEND_PREVIEW_EXPANDED_WIDTH,
      height: Math.max(
        sourceHeight,
        expandedLegendPreviewHeight(preview.data.length, orientation),
      ),
      margin: { l: 24, r: 24, t: 16, b: 16 },
    },
  };
}

const TRACE_PRESENTATION_FIELDS = [
  "type",
  "name",
  "legendgroup",
  "legendgrouptitle",
  "legendrank",
  "line",
  "marker",
  "mode",
  "opacity",
  "fill",
  "fillcolor",
  "connectgaps",
  "orientation",
  "stackgroup",
  "groupnorm",
] as const;

const LEGEND_STYLE_FIELDS = [
  "font",
  "grouptitlefont",
  "traceorder",
  "tracegroupgap",
  "itemsizing",
  "itemwidth",
  "entrywidth",
  "entrywidthmode",
  "indentation",
  "title",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clone the small style objects passed to Plotly without cloning trace data. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyValue(child)]));
}

function stringColor(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Project the already-filtered, already-ordered trace presentation into UI rows. */
export function legendPreviewEntries(preview: LegendPreviewFigure): LegendPreviewEntry[] {
  return preview.data.flatMap((value) => {
    if (!isRecord(value)) return [];
    const line = isRecord(value.line) ? value.line : {};
    const marker = isRecord(value.marker) ? value.marker : {};
    return [
      {
        name: typeof value.name === "string" ? value.name : "",
        type: typeof value.type === "string" ? value.type : "",
        mode: typeof value.mode === "string" ? value.mode : "",
        opacity: Math.max(0, Math.min(1, finiteOr(value.opacity, 1))),
        line: {
          color: stringColor(line.color),
          width: Math.max(0, finiteOr(line.width, 2)),
          dash: typeof line.dash === "string" ? line.dash : "solid",
        },
        marker: {
          color: stringColor(marker.color),
          size: Math.max(0, finiteOr(marker.size, 6)),
          symbol:
            typeof marker.symbol === "string" || typeof marker.symbol === "number"
              ? marker.symbol
              : null,
        },
      },
    ];
  });
}

function hasLegendEntry(trace: Record<string, unknown>): boolean {
  if (trace.showlegend === false) return false;
  // Canonical builders set showlegend on every user-facing trace. The name
  // fallback also respects Plotly's default for a named trace from a builder
  // that omits the explicit boolean, while excluding unnamed helper traces.
  return trace.showlegend === true || typeof trace.name === "string";
}

function legendRank(trace: Record<string, unknown>, index: number): [number, number] {
  const rank = typeof trace.legendrank === "number" && Number.isFinite(trace.legendrank)
    ? trace.legendrank
    : 1000;
  return [rank, index];
}

/**
 * Height that keeps ordinary legends compact while bounding large ones.
 * Plotly 2.35.3 supplies the scrollbar when its content exceeds this surface;
 * do not rely on newer legend attributes that are absent from that runtime.
 */
export function legendPreviewHeight(entryCount: number, orientation: "h" | "v"): number {
  if (entryCount <= 0) return LEGEND_PREVIEW_MIN_HEIGHT;
  const rows = legendEntryRows(entryCount, orientation);
  return Math.min(
    LEGEND_PREVIEW_MAX_HEIGHT,
    Math.max(LEGEND_PREVIEW_MIN_HEIGHT, 48 + rows * 24),
  );
}

/**
 * Build a passive, legend-only Plotly figure from a real preview figure.
 *
 * The returned trace order is stable and follows `legendrank` (with source
 * order as the tie-breaker), matching the ranking used by the real figure
 * builders without changing their scientific trace order.
 */
export function buildLegendPreview(preview: LegendPreviewFigure): LegendPreviewFigure {
  const legendTraces = preview.data
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => isRecord(value) && hasLegendEntry(value))
    .map(({ value, index }) => {
      const trace = value as Record<string, unknown>;
      const legendTrace: Record<string, unknown> = {};
      for (const field of TRACE_PRESENTATION_FIELDS) {
        if (field in trace) legendTrace[field] = copyValue(trace[field]);
      }
      // The interactive preview may upgrade ordinary scatter traces to
      // scattergl. The detached surface is a legend-only SVG/HTML widget, so
      // preserve the effective line/marker style but avoid a WebGL-only trace
      // type that has no benefit with sentinel data.
      if (legendTrace.type === "scattergl") legendTrace.type = "scatter";
      legendTrace.name = trace.name ?? "";
      legendTrace.showlegend = true;
      // Keep the normal visible state so Plotly does not apply its muted
      // `legendonly` opacity. A zero-length trace is discarded before Plotly
      // builds its legend; the finite/null sentinel gives it one trace record
      // while the null ordinate prevents any marker, line, or bar from being
      // drawn. These are new scalar arrays, never slices of source data.
      legendTrace.x = [LEGEND_PREVIEW_SENTINEL_X];
      legendTrace.y = [LEGEND_PREVIEW_SENTINEL_Y];
      if ("z" in trace) legendTrace.z = [LEGEND_PREVIEW_SENTINEL_Y];
      return { trace: legendTrace, index };
    })
    .sort((left, right) => {
      const [leftRank, leftIndex] = legendRank(left.trace, left.index);
      const [rightRank, rightIndex] = legendRank(right.trace, right.index);
      return leftRank - rightRank || leftIndex - rightIndex;
    })
    .map(({ trace }) => trace);

  const sourceLayout = isRecord(preview.layout) ? preview.layout : {};
  const sourceLegend = isRecord(sourceLayout.legend) ? sourceLayout.legend : {};
  const orientation = sourceLegend.orientation === "v" ? "v" : "h";
  const legend: Record<string, unknown> = {
    orientation,
    x: 0,
    y: 1,
    xanchor: "left",
    yanchor: "top",
    itemclick: false,
    itemdoubleclick: false,
    groupclick: "toggleitem",
  };
  for (const field of LEGEND_STYLE_FIELDS) {
    if (field in sourceLegend) legend[field] = copyValue(sourceLegend[field]);
  }
  if (!("font" in legend) && "font" in sourceLayout) legend.font = copyValue(sourceLayout.font);

  const layout: Record<string, unknown> = {
    autosize: false,
    width: LEGEND_PREVIEW_WIDTH,
    height: legendPreviewHeight(legendTraces.length, orientation),
    margin: { l: 12, r: 12, t: 8, b: 8 },
    paper_bgcolor: sourceLayout.paper_bgcolor ?? "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    showlegend: true,
    hovermode: false,
    xaxis: { visible: false, showgrid: false, zeroline: false, showticklabels: false },
    yaxis: { visible: false, showgrid: false, zeroline: false, showticklabels: false },
    legend,
  };

  return { data: legendTraces, layout };
}
