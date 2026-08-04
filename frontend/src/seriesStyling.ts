/**
 * Per-series plot styling: descriptors, rule matching, and resolution.
 *
 * Appearance comes from three layers, resolved here and nowhere else so the
 * live plot, saved thumbnails and exported figures cannot disagree:
 *
 *   1. the tab's base `PlotStyle` (applies to every series)
 *   2. matching rules, in order, later winning
 *   3. the explicit per-series override
 *
 * An explicit override always beats a rule: a rule is a bulk convenience, and
 * silently overwriting something the user set by hand would be a trap.
 *
 * Pure by design — no React, no Plotly, no network. Everything here is unit
 * tested in `frontend/tests/seriesStyling.test.ts`.
 */
import type { SeriesStyleOverride, SeriesStyleRule, SeriesRuleField } from "./api";

export type SeriesKind = "cell" | "group";

/** One stylable line on a plot. */
export interface SeriesDescriptor {
  /** Stable identity, and the key into `series_overrides`: `c12`, `g3`, `ce:c12`. */
  key: string;
  kind: SeriesKind;
  /** Legend text before any override. */
  label: string;
  cellName: string | null;
  groupName: string | null;
}

/** Everything a trace needs, after all three layers are applied. */
export interface ResolvedSeriesStyle {
  name: string;
  color: string;
  lineWidth: number;
  lineDash: "solid" | "dot" | "dash" | "longdash";
  lineShape: "linear" | "spline" | "hv";
  markerMode: "none" | "points" | "lines_points";
  markerSymbol: string;
  markerSize: number;
  markerOpen: boolean;
  opacity: number;
  shadow: boolean;
  showInLegend: boolean;
  hidden: boolean;
}

/** The tab-wide defaults a series starts from. */
export interface BaseSeriesStyle {
  color: string;
  lineWidth: number;
  lineDash: ResolvedSeriesStyle["lineDash"];
  lineShape?: ResolvedSeriesStyle["lineShape"];
  markerMode: ResolvedSeriesStyle["markerMode"];
  markerSymbol: string;
  markerSize: number;
  markerOpen: boolean;
  opacity: number;
}

export const SERIES_RULE_FIELDS: { value: SeriesRuleField; label: string }[] = [
  { value: "label", label: "Series name" },
  { value: "cell_name", label: "Cell name" },
  { value: "group_name", label: "Replicate group" },
  { value: "kind", label: "Series type" },
];

export const SERIES_RULE_OPERATORS: { value: SeriesStyleRule["operator"]; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "is exactly" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "matches", label: "matches regex" },
];

/** The value a rule tests. `null` when the series has no such field. */
export function seriesFieldValue(
  descriptor: SeriesDescriptor,
  field: SeriesRuleField,
): string | null {
  switch (field) {
    case "label":
      return descriptor.label;
    case "cell_name":
      return descriptor.cellName;
    case "group_name":
      return descriptor.groupName;
    case "kind":
      return descriptor.kind;
    default:
      return null;
  }
}

/**
 * Whether a rule matches a series.
 *
 * A disabled rule, an empty pattern, or a field the series does not have never
 * matches. An invalid regex never matches either, and never throws: a typo
 * halfway through typing must not blank the plot.
 */
export function seriesMatchesRule(
  descriptor: SeriesDescriptor,
  rule: SeriesStyleRule,
): boolean {
  if (rule.enabled === false) return false;
  const pattern = rule.value ?? "";
  if (!pattern) return false;
  const raw = seriesFieldValue(descriptor, rule.field);
  if (raw === null) return false;

  if (rule.operator === "matches") {
    try {
      return new RegExp(pattern, rule.case_sensitive ? "" : "i").test(raw);
    } catch {
      return false;
    }
  }

  const subject = rule.case_sensitive ? raw : raw.toLocaleLowerCase();
  const needle = rule.case_sensitive ? pattern : pattern.toLocaleLowerCase();
  switch (rule.operator) {
    case "equals":
      return subject === needle;
    case "starts_with":
      return subject.startsWith(needle);
    case "ends_with":
      return subject.endsWith(needle);
    case "contains":
    default:
      return subject.includes(needle);
  }
}

/** Report a rule's regex problem for the editor, or `null` when it is fine. */
export function seriesRuleError(rule: SeriesStyleRule): string | null {
  if (rule.operator !== "matches") return null;
  if (!rule.value) return null;
  try {
    new RegExp(rule.value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression";
  }
}

/** Rules that apply to a series, in application order. */
export function matchingRules(
  descriptor: SeriesDescriptor,
  rules: SeriesStyleRule[] | undefined,
): SeriesStyleRule[] {
  return (rules ?? []).filter((rule) => seriesMatchesRule(descriptor, rule));
}

function assign<T>(current: T, next: T | null | undefined): T {
  return next === null || next === undefined ? current : next;
}

function applyOverride(
  resolved: ResolvedSeriesStyle,
  override: SeriesStyleOverride | undefined,
): ResolvedSeriesStyle {
  if (!override) return resolved;
  return {
    name: assign(resolved.name, override.name),
    color: assign(resolved.color, override.color),
    lineWidth: assign(resolved.lineWidth, override.line_width),
    lineDash: assign(resolved.lineDash, override.line_dash),
    lineShape: assign(resolved.lineShape, override.line_shape),
    markerMode: assign(resolved.markerMode, override.marker_mode),
    markerSymbol: assign(resolved.markerSymbol, override.marker_symbol),
    markerSize: assign(resolved.markerSize, override.marker_size),
    markerOpen: assign(resolved.markerOpen, override.marker_open),
    opacity: assign(resolved.opacity, override.opacity),
    shadow: assign(resolved.shadow, override.shadow),
    showInLegend: assign(resolved.showInLegend, override.show_in_legend),
    hidden: assign(resolved.hidden, override.hidden),
  };
}

/**
 * Final appearance for one series.
 *
 * `base` already carries the palette colour for this series, so a plot with no
 * overrides and no rules resolves to exactly the previous behaviour.
 */
export function resolveSeriesStyle(
  base: BaseSeriesStyle,
  descriptor: SeriesDescriptor,
  rules: SeriesStyleRule[] | undefined,
  overrides: Record<string, SeriesStyleOverride> | undefined,
): ResolvedSeriesStyle {
  let resolved: ResolvedSeriesStyle = {
    name: descriptor.label,
    color: base.color,
    lineWidth: base.lineWidth,
    lineDash: base.lineDash,
    lineShape: base.lineShape ?? "linear",
    markerMode: base.markerMode,
    markerSymbol: base.markerSymbol,
    markerSize: base.markerSize,
    markerOpen: base.markerOpen,
    opacity: base.opacity,
    shadow: false,
    showInLegend: true,
    hidden: false,
  };

  for (const rule of matchingRules(descriptor, rules)) {
    resolved = applyOverride(resolved, rule.style);
  }
  // Last, so a hand-set value is never taken away by a bulk rule.
  return applyOverride(resolved, overrides?.[descriptor.key]);
}

/** Plotly `mode` for a resolved series. */
export function seriesPlotlyMode(style: ResolvedSeriesStyle): "lines" | "markers" | "lines+markers" {
  if (style.markerMode === "points") return "markers";
  if (style.markerMode === "lines_points") return "lines+markers";
  return "lines";
}

/** Plotly marker symbol, honouring the open/filled choice. */
export function seriesPlotlySymbol(style: ResolvedSeriesStyle): string {
  return style.markerOpen ? `${style.markerSymbol}-open` : style.markerSymbol;
}

/** Whether an override carries any instruction at all. */
export function isEmptyOverride(override: SeriesStyleOverride | undefined): boolean {
  if (!override) return true;
  return Object.values(override).every((value) => value === undefined || value === null);
}

/** Drop empty entries so a saved spec does not accumulate `{}` per series. */
export function pruneOverrides(
  overrides: Record<string, SeriesStyleOverride>,
): Record<string, SeriesStyleOverride> {
  const next: Record<string, SeriesStyleOverride> = {};
  for (const [key, override] of Object.entries(overrides)) {
    if (!isEmptyOverride(override)) next[key] = override;
  }
  return next;
}

export function newSeriesRuleId(): string {
  return `rule-${Math.random().toString(36).slice(2, 10)}`;
}

/** A rule that matches nothing yet, for the editor's "add" action. */
export function emptySeriesRule(): SeriesStyleRule {
  return {
    id: newSeriesRuleId(),
    enabled: true,
    field: "label",
    operator: "contains",
    value: "",
    case_sensitive: false,
    style: {},
  };
}
