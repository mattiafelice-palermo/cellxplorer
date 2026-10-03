import type { PlotReferenceAxisId, PlotReferenceBinding, PlotReferenceLine, PlotStyle } from "../../../../api";

export const MAX_REFERENCE_LINES = 64;
export const REFERENCE_NAME_PREFIX = "cellxplorer-reference:";
export interface ReferenceAxis extends PlotReferenceBinding {
  label: string;
  numeric: boolean;
  /** The perpendicular plotting axis; X spans the whole stacked plot domain. */
  cross_axis: PlotReferenceAxisId;
}
const axisIds = ["x", "y", "y2", "y3"] as const;
const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const layoutMeta = (layout: Partial<Plotly.Layout>) => record((layout as { meta?: unknown }).meta);
const annotationName = (annotation: Partial<Plotly.Annotations>) => (annotation as { name?: string }).name;
const finite = (value: unknown, fallback: number, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const text = (value: unknown, fallback = "", limit = 500) => typeof value === "string" ? value.slice(0, limit) : fallback;
const color = (value: unknown, fallback: string) => {
  const candidate = text(value, "", 100).trim();
  return /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(candidate) ? candidate : fallback;
};
const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? value as T : fallback;
function binding(value: unknown): PlotReferenceBinding {
  const raw = record(value);
  return { axis: choice(raw.axis, axisIds, "y"), quantity: text(raw.quantity, "", 150), units: text(raw.units, "", 100) };
}

/** Deterministic and defensive at the persisted JSON boundary; never generate IDs on render. */
export function normalizeReferenceLines(value: unknown): PlotReferenceLine[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.slice(0, MAX_REFERENCE_LINES).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = record(entry), span = record(raw.span), label = record(raw.label);
    // Invalid threshold/span values are retained as a disabled row, never a fabricated threshold.
    const validPosition = typeof raw.position === "number" && Number.isFinite(raw.position);
    const validSpan = span.mode !== "bounded" ||
      (typeof span.min === "number" && Number.isFinite(span.min) &&
       typeof span.max === "number" && Number.isFinite(span.max) && span.min < span.max);
    const seed = text(raw.id, `reference-${index + 1}`, 128).trim() || `reference-${index + 1}`;
    let id = seed, suffix = 2;
    while (used.has(id)) id = `${seed}-${suffix++}`;
    used.add(id);
    return [{
      id, enabled: raw.enabled !== false && validPosition && validSpan,
      binding: binding(raw.binding), position: finite(raw.position, 0),
      span: { mode: choice(span.mode, ["domain", "bounded"], "domain"), binding: binding(span.binding), min: finite(span.min, 0), max: finite(span.max, 1) },
      color: color(raw.color, "#495057"), opacity: finite(raw.opacity, 1, 0, 1), width: finite(raw.width, 1.5, 0.1, 20),
      dash: choice(raw.dash, ["solid", "dot", "dash", "longdash"], "dash"), layer: choice(raw.layer, ["below", "above"], "above"),
      label: {
        visible: label.visible !== false, text: text(label.text), include_value: label.include_value !== false,
        include_units: label.include_units !== false, placement: choice(label.placement, ["line", "free"], "line"),
        along: finite(label.along, 0.5, 0, 1), side: choice(label.side, ["above", "below", "left", "right"], "above"),
        align: choice(label.align, ["left", "center", "right"], "center"), angle: finite(label.angle, 0, -180, 180),
        x: finite(label.x, 0.5, 0, 1), y: finite(label.y, 0.5, 0, 1), xshift: finite(label.xshift, 0, -1000, 1000), yshift: finite(label.yshift, 0, -1000, 1000),
        font_size: finite(label.font_size, 12, 6, 72), color: color(label.color, "#495057"),
        background: color(label.background, "rgba(255,255,255,0)"), border_color: color(label.border_color, "#495057"),
        border_width: finite(label.border_width, 0, 0, 10), border_pad: finite(label.border_pad, 2, 0, 30),
      },
    }];
  });
}
export function referenceAxis(axis: PlotReferenceAxisId, quantity: string, units: string, label: string, numeric = true, cross_axis: PlotReferenceAxisId = axis === "x" ? "y" : "x"): ReferenceAxis {
  return { axis, quantity, units, label, numeric, cross_axis };
}
/** Units come from the scientific default label, never the user-editable title. */
export function referenceUnits(label: string): string {
  const start = label.indexOf("(");
  return start >= 0 && label.endsWith(")") ? label.slice(start + 1, -1) : "";
}
export function axisBinding(axis: ReferenceAxis): PlotReferenceBinding {
  return { axis: axis.axis, quantity: axis.quantity, units: axis.units };
}
export function createReferenceLine(axis: ReferenceAxis, crossAxis: ReferenceAxis, id: string): PlotReferenceLine {
  return normalizeReferenceLines([{ id, position: 0, binding: axisBinding(axis), span: { binding: axisBinding(crossAxis) } }])[0];
}
export function referenceAxisMatches(bound: PlotReferenceBinding, axes: ReferenceAxis[]): ReferenceAxis | undefined {
  return axes.find((axis) => axis.numeric && axis.axis === bound.axis && axis.quantity === bound.quantity && axis.units === bound.units);
}
export function referenceLineIssue(line: PlotReferenceLine, axes: ReferenceAxis[]): string | null {
  if (!referenceAxisMatches(line.binding, axes)) return "This axis quantity or unit is unavailable. Select an axis to bind this line again.";
  if (line.span.mode === "bounded") {
    const cross = referenceAxisMatches(line.span.binding, axes);
    if (!cross || (cross.axis === "x") === (line.binding.axis === "x")) return "The span axis quantity or unit is unavailable. Select a compatible span axis.";
    if (!Number.isFinite(line.span.min) || !Number.isFinite(line.span.max) || line.span.min >= line.span.max) return "Span minimum must be smaller than maximum.";
  }
  return Number.isFinite(line.position) ? null : "Position must be finite.";
}
export function escapeReferenceText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
export function referenceLabelText(line: PlotReferenceLine): string {
  return escapeReferenceText([
    line.label.text,
    line.label.include_value ? String(line.position) : "",
    line.label.include_units ? line.binding.units : "",
  ].filter(Boolean).join(" "));
}

/** Append to family geometry. The meta carries the exact axes into the draft editor. */
export function withReferenceLines(layout: Partial<Plotly.Layout>, style: PlotStyle, axes: ReferenceAxis[]): Partial<Plotly.Layout> {
  const shapes = [...(layout.shapes ?? [])], annotations = [...(layout.annotations ?? [])];
  const labelDomains: Record<string, { x: string; y: string }> = {};
  for (const line of normalizeReferenceLines(style.reference_lines)) {
    if (!line.enabled || referenceLineIssue(line, axes)) continue;
    const axis = referenceAxisMatches(line.binding, axes)!;
    const vertical = axis.axis === "x";
    const cross = axes.find((candidate) => candidate.axis === axis.cross_axis);
    const bounded = line.span.mode === "bounded";
    const crossId = bounded ? line.span.binding.axis : cross?.axis ?? (vertical ? "y" : "x");
    const crossRef = bounded ? crossId : vertical ? "paper" : `${crossId} domain`;
    const start = bounded ? line.span.min : 0, end = bounded ? line.span.max : 1;
    shapes.push({
      name: `${REFERENCE_NAME_PREFIX}${line.id}`, type: "line", layer: line.layer, opacity: line.opacity,
      xref: (vertical ? "x" : crossRef) as any, yref: (vertical ? crossRef : axis.axis) as any,
      x0: vertical ? line.position : start, x1: vertical ? line.position : end,
      y0: vertical ? start : line.position, y1: vertical ? end : line.position,
      line: { color: line.color, width: line.width, dash: line.dash }, editable: false,
    } as unknown as Partial<Plotly.Shape>);
    const label = line.label;
    if (!label.visible) continue;
    const along = start * (1 - label.along) + end * label.along;
    if (!Number.isFinite(along)) continue;
    const labelXDomain = "x", labelYDomain = vertical ? bounded ? crossId : "paper" : axis.axis;
    labelDomains[line.id] = { x: labelXDomain, y: labelYDomain };
    annotations.push({
      name: `${REFERENCE_NAME_PREFIX}${line.id}`, text: referenceLabelText(line), showarrow: false,
      xref: (label.placement === "free" ? `${labelXDomain} domain` : vertical ? "x" : crossRef) as any,
      yref: (label.placement === "free" ? labelYDomain === "paper" ? "paper" : `${labelYDomain} domain` : vertical ? crossRef : axis.axis) as any,
      x: label.placement === "free" ? label.x : vertical ? line.position : along,
      y: label.placement === "free" ? label.y : vertical ? along : line.position,
      xanchor: label.side === "left" ? "right" : label.side === "right" ? "left" : "center",
      yanchor: label.side === "above" ? "bottom" : label.side === "below" ? "top" : "middle",
      xshift: label.xshift, yshift: label.yshift, align: label.align, textangle: label.angle,
      font: { size: label.font_size, color: label.color }, opacity: line.opacity,
      bgcolor: label.background, bordercolor: label.border_color, borderwidth: label.border_width, borderpad: label.border_pad,
    } as unknown as Partial<Plotly.Annotations>);
  }
  const meta = layoutMeta(layout);
  return { ...layout, shapes, annotations, meta: { ...meta, cellxplorer_reference_axes: axes, cellxplorer_reference_labels: labelDomains } } as Partial<Plotly.Layout>;
}
export function referenceAxesFromLayout(layout: Partial<Plotly.Layout>): ReferenceAxis[] {
  const axes = layoutMeta(layout).cellxplorer_reference_axes;
  return Array.isArray(axes) ? axes : [];
}

export type ReferenceLabelMove = { id: string; x: number; y: number };
function ownedAnnotation(annotation: Partial<Plotly.Annotations>): boolean {
  const name = annotationName(annotation);
  return typeof name === "string" && name.startsWith(REFERENCE_NAME_PREFIX);
}
/** Plotly 2.35 has a global annotation-position flag. Never activate it around foreign annotations. */
export function referenceLabelDraggingSupported(layout: Partial<Plotly.Layout>): boolean {
  return Boolean(layout.annotations?.length && layout.annotations.every(ownedAnnotation));
}
export function referenceDragConfig(config: Partial<Plotly.Config> | undefined, layout: Partial<Plotly.Layout>): Partial<Plotly.Config> {
  return { ...config, editable: false, edits: { ...config?.edits, annotationPosition: referenceLabelDraggingSupported(layout), annotationText: false, annotationTail: false, shapePosition: false } };
}
function paperCoordinate(value: unknown, ref: unknown, fullLayout: Record<string, any>, dimension: "x" | "y"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (ref === "paper") return Math.max(0, Math.min(1, value));
  if (typeof ref !== "string") ref = dimension;
  const name = String(ref).replace(" domain", "");
  const axis = record(fullLayout[`${name[0]}axis${name.slice(1)}`]);
  const domain = axis.domain;
  if (!Array.isArray(domain) || domain.length !== 2) return null;
  let fraction = value;
  if (!String(ref).endsWith(" domain")) {
    const range = axis.range;
    if (!Array.isArray(range) || range.length !== 2) return null;
    const position = axis.type === "log" ? Math.log10(value) : value;
    fraction = (position - range[0]) / (range[1] - range[0]);
  }
  const result = domain[0] + fraction * (domain[1] - domain[0]);
  return Number.isFinite(result) ? Math.max(0, Math.min(1, result)) : null;
}
export function referenceLabelMoves(event: Readonly<Plotly.PlotRelayoutEvent>, layout: Partial<Plotly.Layout>, fullLayout: unknown): ReferenceLabelMove[] {
  if (!referenceLabelDraggingSupported(layout)) return [];
  const updates = event as Record<string, unknown>;
  const moves: ReferenceLabelMove[] = [];
  for (const [index, annotation] of (layout.annotations ?? []).entries()) {
    if (!(Object.prototype.hasOwnProperty.call(updates, `annotations[${index}].x`) || Object.prototype.hasOwnProperty.call(updates, `annotations[${index}].y`))) continue;
    const x = paperCoordinate(updates[`annotations[${index}].x`] ?? annotation.x, annotation.xref, record(fullLayout), "x");
    const y = paperCoordinate(updates[`annotations[${index}].y`] ?? annotation.y, annotation.yref, record(fullLayout), "y");
    const id = annotationName(annotation)!.slice(REFERENCE_NAME_PREFIX.length);
    const target = record(layoutMeta(layout).cellxplorer_reference_labels)[id];
    const domainFraction = (point: number | null, name: string) => {
      if (name === "paper") return point;
      const axis = record(record(fullLayout)[`${name[0]}axis${name.slice(1)}`]);
      const domain = axis.domain;
      if (point === null || !Array.isArray(domain) || domain[0] === domain[1]) return null;
      return Math.max(0, Math.min(1, (point - domain[0]) / (domain[1] - domain[0])));
    };
    const localX = target ? domainFraction(x, target.x) : x, localY = target ? domainFraction(y, target.y) : y;
    if (localX !== null && localY !== null) moves.push({ id, x: localX, y: localY });
  }
  return moves;
}
export function applyReferenceLabelMoves(style: PlotStyle, moves: ReferenceLabelMove[]): void {
  style.reference_lines = normalizeReferenceLines(style.reference_lines).map((line) => {
    const move = moves.find((candidate) => candidate.id === line.id);
    return move ? { ...line, label: { ...line.label, placement: "free", x: move.x, y: move.y } } : line;
  });
}
