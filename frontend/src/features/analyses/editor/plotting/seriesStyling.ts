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
import type { SeriesStyleOverride, SeriesStyleRule, SeriesRuleField } from "../../../../api";

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
  /** Subplot index. Default 0. */
  plot?: number;
  /** Which y axis the series is drawn on. Default "y". */
  axis?: "y" | "y2";
  /** The quantity plotted, when it differs from the plot's primary quantity. Default null. */
  measure?: string | null;
  /** Identity within a plot/axis/measure, e.g. "c12", "g3", "dcir-abc". */
  sourceKey?: string;
  /** Default legend suffix when deriving a name from a linked primary, e.g. " CE". */
  secondarySuffix?: string;
  /** Human name of the plotted quantity, e.g. "Discharge capacity", "Coulombic efficiency". */
  measureLabel?: string;
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

export type SharedValue<T> = {
  value: T | undefined;
  mixed: boolean;
};

export type SeriesSelectionModifiers = {
  shiftKey: boolean;
  toggleKey: boolean;
};

/** Read modifier intent once from the pointer gesture that starts a selection. */
export function seriesSelectionModifiers(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): SeriesSelectionModifiers {
  return {
    shiftKey: event.shiftKey,
    toggleKey: event.ctrlKey || event.metaKey,
  };
}

/** Summarise a concrete series field without hiding disagreement behind a default. */
export function sharedValue<T>(values: readonly T[]): SharedValue<T> {
  if (values.length === 0) return { value: undefined, mixed: false };
  const first = values[0];
  return {
    value: values.every((value) => Object.is(value, first)) ? first : undefined,
    mixed: values.some((value) => !Object.is(value, first)),
  };
}

/** Return the inclusive range between two rows, or null when either key is absent. */
export function seriesSelectionRange(
  items: readonly Pick<SeriesDescriptor, "key">[],
  anchorKey: string | null,
  clickedKey: string,
): string[] | null {
  if (!anchorKey) return null;
  const anchorIndex = items.findIndex((item) => item.key === anchorKey);
  const clickedIndex = items.findIndex((item) => item.key === clickedKey);
  if (anchorIndex === -1 || clickedIndex === -1) return null;
  const start = Math.min(anchorIndex, clickedIndex);
  const end = Math.max(anchorIndex, clickedIndex);
  return items.slice(start, end + 1).map((item) => item.key);
}

/**
 * Resolve one concrete-series selection gesture. Row clicks and their
 * selection checkboxes both call this same policy, so the endpoint-inclusive
 * range cannot diverge between the two interaction paths.
 */
export function seriesSelectionResult(
  items: readonly Pick<SeriesDescriptor, "key">[],
  selectedKeys: Iterable<string>,
  anchorKey: string | null,
  clickedKey: string,
  modifiers: SeriesSelectionModifiers,
): { keys: string[]; anchor: string | null } {
  if (modifiers.shiftKey) {
    const range = seriesSelectionRange(items, anchorKey, clickedKey);
    if (range) return { keys: range, anchor: anchorKey };
  }

  if (modifiers.toggleKey) {
    const next = new Set(selectedKeys);
    if (next.has(clickedKey)) next.delete(clickedKey);
    else next.add(clickedKey);
    return { keys: Array.from(next), anchor: clickedKey };
  }

  return { keys: [clickedKey], anchor: clickedKey };
}

/**
 * Minimal shapes the descriptor builders need. Structural rather than the full
 * API types so they can be unit tested without a compute result.
 */
export interface CellSeriesLike {
  cell_id: number;
  cell_name: string;
  label: string;
  group_id: number | null;
  group_name: string | null;
  excluded: boolean;
}

export interface AggregateSeriesLike {
  group_id: number;
  group_name: string;
}

export function cellSeriesDescriptor(s: CellSeriesLike): SeriesDescriptor {
  return {
    key: `c${s.cell_id}`,
    kind: "cell",
    label: s.group_name ? `${s.label} (${s.group_name})` : s.label,
    cellName: s.cell_name,
    groupName: s.group_name,
  };
}

export function aggregateSeriesDescriptor(
  agg: AggregateSeriesLike,
  compact = false,
): SeriesDescriptor {
  return {
    key: `g${agg.group_id}`,
    kind: "group",
    label: compact ? agg.group_name : `${agg.group_name} mean`,
    cellName: null,
    groupName: agg.group_name,
  };
}

/**
 * Every stylable series on the cycles plot, in draw order.
 *
 * `showIndividual` mirrors the plot: when replicate aggregates exist and
 * individual cells are hidden, those cells are not drawn and must not be listed.
 */
export function cyclesSeriesDescriptors(
  aggregates: AggregateSeriesLike[],
  cellSeries: CellSeriesLike[],
  showIndividualCells: boolean,
  includeCoulombicEfficiency = false,
  primaryMeasureLabel?: string,
): SeriesDescriptor[] {
  const out: SeriesDescriptor[] = [];
  for (const agg of aggregates) {
    const descriptor = aggregateSeriesDescriptor(agg);
    if (primaryMeasureLabel) descriptor.measureLabel = primaryMeasureLabel;
    out.push(descriptor);
  }
  const showIndividual = showIndividualCells || aggregates.length === 0;
  for (const s of cellSeries) {
    if (s.excluded) continue;
    if (s.group_id !== null && !showIndividual) continue;
    const descriptor = cellSeriesDescriptor(s);
    if (primaryMeasureLabel) descriptor.measureLabel = primaryMeasureLabel;
    out.push(descriptor);
  }
  if (includeCoulombicEfficiency) {
    // CE overlays always draw for aggregates, but only for solo (ungrouped)
    // cells — grouped members rely on their group's aggregate CE line, same
    // rule the trace builder applies regardless of showIndividualCells.
    for (const agg of aggregates) {
      const primary = aggregateSeriesDescriptor(agg);
      const sourceKey = `g${agg.group_id}`;
      out.push({
        key: composeSeriesKey({ sourceKey, axis: "y2", measure: "coulombic_efficiency" }),
        kind: primary.kind,
        label: `${agg.group_name} CE`,
        cellName: primary.cellName,
        groupName: primary.groupName,
        plot: 0,
        axis: "y2",
        measure: "coulombic_efficiency",
        sourceKey,
        secondarySuffix: " CE",
        measureLabel: "Coulombic efficiency",
      });
    }
    for (const s of cellSeries) {
      if (s.excluded || s.group_id !== null) continue;
      const primary = cellSeriesDescriptor(s);
      const sourceKey = `c${s.cell_id}`;
      out.push({
        key: composeSeriesKey({ sourceKey, axis: "y2", measure: "coulombic_efficiency" }),
        kind: primary.kind,
        label: `${s.label} CE`,
        cellName: primary.cellName,
        groupName: primary.groupName,
        plot: 0,
        axis: "y2",
        measure: "coulombic_efficiency",
        sourceKey,
        secondarySuffix: " CE",
        measureLabel: "Coulombic efficiency",
      });
    }
  }
  return out;
}

/**
 * Time/capacity series identity.
 *
 * This tab draws one line per cell but colours grouped cells together, so the
 * key is the group when there is one. Descriptors must use the same scheme as
 * the trace builder, or the editor would list series the plot cannot match.
 */
export function timeCapacitySeriesDescriptor(trace: CellSeriesLike): SeriesDescriptor {
  return {
    key: trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`,
    kind: trace.group_id ? "group" : "cell",
    label: trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label,
    cellName: trace.cell_name,
    groupName: trace.group_name,
  };
}

/** Stylable time/capacity series, de-duplicated by key. */
export function timeCapacitySeriesDescriptors(traces: CellSeriesLike[]): SeriesDescriptor[] {
  const seen = new Set<string>();
  const out: SeriesDescriptor[] = [];
  for (const trace of traces) {
    if (trace.excluded) continue;
    const descriptor = timeCapacitySeriesDescriptor(trace);
    if (seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    out.push(descriptor);
  }
  return out;
}

/**
 * Compose a series key from its structured identity.
 *
 * Defaults are omitted entirely so a primary series on plot 0's primary axis
 * and measure produces exactly its legacy `sourceKey` — saved plots need no
 * migration.
 */
export function composeSeriesKey(parts: {
  sourceKey: string;
  plot?: number;
  axis?: "y" | "y2";
  measure?: string | null;
}): string {
  const segments: string[] = [];
  if (parts.plot !== undefined && parts.plot !== 0) segments.push(`p${parts.plot}`);
  if (parts.axis !== undefined && parts.axis !== "y") segments.push(parts.axis);
  if (typeof parts.measure === "string" && parts.measure.length > 0) segments.push(parts.measure);
  segments.push(parts.sourceKey);
  return segments.join(":");
}

/**
 * The key of the same source on the same plot's primary axis and primary
 * measure — i.e. what a secondary series is linked to.
 *
 * `null` when the descriptor is already primary, or has no `sourceKey`.
 */
export function primarySeriesKeyFor(descriptor: SeriesDescriptor): string | null {
  if (!descriptor.sourceKey) return null;
  const isPrimary =
    (descriptor.axis === undefined || descriptor.axis === "y") &&
    (descriptor.measure === undefined || descriptor.measure === null);
  if (isPrimary) return null;
  return composeSeriesKey({ sourceKey: descriptor.sourceKey, plot: descriptor.plot });
}

/** True when a series is on the secondary axis, or plots a named (non-primary) measure. */
export function isSecondarySeries(descriptor: SeriesDescriptor): boolean {
  if (descriptor.axis === "y2") return true;
  return typeof descriptor.measure === "string" && descriptor.measure.length > 0;
}

/** Stable grouping key used by the Series panel and legend-order policy. */
export function seriesQuantityGroupKey(descriptor: SeriesDescriptor): string {
  return `${descriptor.plot ?? 0}:${descriptor.measureLabel ?? descriptor.axis ?? "y"}`;
}

/**
 * Apply a stored presentation order to one descriptor list.
 *
 * The descriptor array remains the source of truth for new rows, while the
 * stored list only supplies a preference for keys that still exist. A map and
 * a seen set make stale and duplicate stored keys harmless without mutating
 * either input.
 */
export function orderedSeriesDescriptors(
  descriptors: SeriesDescriptor[],
  storedOrder?: readonly string[],
): SeriesDescriptor[] {
  const byKey = new Map<string, SeriesDescriptor>();
  for (const descriptor of descriptors) {
    if (!byKey.has(descriptor.key)) byKey.set(descriptor.key, descriptor);
  }

  const ordered: SeriesDescriptor[] = [];
  const seen = new Set<string>();
  for (const key of storedOrder ?? []) {
    const descriptor = byKey.get(key);
    if (!descriptor || seen.has(key)) continue;
    seen.add(key);
    ordered.push(descriptor);
  }
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    ordered.push(descriptor);
  }
  return ordered;
}

/** Apply stored order inside each existing quantity group, never across groups. */
export function orderedSeriesDescriptorsByGroup(
  descriptors: SeriesDescriptor[],
  storedOrder?: readonly string[],
): SeriesDescriptor[] {
  const groups = new Map<string, SeriesDescriptor[]>();
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    const groupKey = seriesQuantityGroupKey(descriptor);
    const group = groups.get(groupKey);
    if (group) group.push(descriptor);
    else groups.set(groupKey, [descriptor]);
  }
  return Array.from(groups.values()).flatMap((group) =>
    orderedSeriesDescriptors(group, storedOrder),
  );
}

/**
 * Move one series within its current quantity group. A null result means the
 * keys are missing, identical, or belong to different groups.
 */
export function moveSeriesWithinGroup(
  descriptors: SeriesDescriptor[],
  storedOrder: readonly string[] | undefined,
  activeKey: string,
  overKey: string,
): string[] | null {
  const active = descriptors.find((descriptor) => descriptor.key === activeKey);
  const over = descriptors.find((descriptor) => descriptor.key === overKey);
  if (!active || !over) return null;
  const groupKey = seriesQuantityGroupKey(active);
  if (groupKey !== seriesQuantityGroupKey(over) || activeKey === overKey) return null;

  const ordered = orderedSeriesDescriptorsByGroup(descriptors, storedOrder);
  const group = ordered.filter((descriptor) => seriesQuantityGroupKey(descriptor) === groupKey);
  const from = group.findIndex((descriptor) => descriptor.key === activeKey);
  const to = group.findIndex((descriptor) => descriptor.key === overKey);
  if (from === -1 || to === -1) return null;

  const moved = [...group];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  let groupIndex = 0;
  return ordered.map((descriptor) =>
    seriesQuantityGroupKey(descriptor) === groupKey
      ? moved[groupIndex++].key
      : descriptor.key,
  );
}

/** Map each series key to a deterministic Plotly legend rank. */
export function seriesLegendRanks(
  descriptors: SeriesDescriptor[],
  storedOrder?: readonly string[],
): Map<string, number> {
  return new Map(
    orderedSeriesDescriptorsByGroup(descriptors, storedOrder).map((descriptor, index) => [
      descriptor.key,
      index,
    ]),
  );
}

/**
 * Selected secondary series whose colour is currently inherited from their
 * primary. A bulk colour edit cannot truthfully include one of these series:
 * the explicit colour override would be accepted but immediately replaced by
 * the linked primary colour during resolution.
 */
export function linkedSecondarySeriesKeys(
  descriptors: SeriesDescriptor[],
  selectedKeys: Iterable<string>,
  overrides: Record<string, SeriesStyleOverride> | undefined,
  linkSecondaryColors = false,
): string[] {
  const selected = new Set(selectedKeys);
  const descriptorKeys = new Set(descriptors.map((descriptor) => descriptor.key));
  return descriptors
    .filter((descriptor) => selected.has(descriptor.key) && isSecondarySeries(descriptor))
    .filter(
      (descriptor) => {
        const primaryKey = primarySeriesKeyFor(descriptor);
        return (
          primaryKey !== null &&
          descriptorKeys.has(primaryKey) &&
          (overrides?.[descriptor.key]?.link_color ?? linkSecondaryColors) === true
        );
      },
    )
    .map((descriptor) => descriptor.key);
}

/**
 * Which palette slot each series draws its default colour from.
 *
 * The trace builders hand out palette colours per cell/replicate group, so a
 * cell's primary series and its secondary (the CE overlay) share one slot.
 * Numbering every descriptor in order instead would give a CE series the *next*
 * palette colour, and anything resolving colours from these slots — the swatch
 * in the series list, the starting colour in the per-series editor — would then
 * disagree with what is actually drawn on the plot.
 *
 * A secondary whose primary is not in the list still gets its own slot, so an
 * orphan is never silently drawn in another series' colour.
 */
export function seriesPaletteSlots(descriptors: SeriesDescriptor[]): Map<string, number> {
  const slots = new Map<string, number>();
  let next = 0;
  for (const descriptor of descriptors) {
    if (isSecondarySeries(descriptor)) continue;
    slots.set(descriptor.key, next++);
  }
  for (const descriptor of descriptors) {
    if (!isSecondarySeries(descriptor)) continue;
    const primaryKey = primarySeriesKeyFor(descriptor);
    const primarySlot = primaryKey === null ? undefined : slots.get(primaryKey);
    slots.set(descriptor.key, primarySlot ?? next++);
  }
  return slots;
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
    showInLegend: true,
    hidden: false,
  };

  for (const rule of matchingRules(descriptor, rules)) {
    resolved = applyOverride(resolved, rule.style);
  }
  // Last, so a hand-set value is never taken away by a bulk rule.
  return applyOverride(resolved, overrides?.[descriptor.key]);
}

/**
 * Resolve every descriptor's style, then link secondary series (y2 axis or a
 * named measure) to their primary's resolved colour and, by default, derive
 * their legend name from it.
 *
 * Two passes, deliberately: pass 1 resolves every series independently
 * (base -> rules -> explicit override) exactly like `resolveSeriesStyle`, so
 * a primary's colour from a rule or an override is already final before any
 * secondary reads it in pass 2.
 */
export function resolveAllSeriesStyles(input: {
  descriptors: SeriesDescriptor[];
  baseFor: (d: SeriesDescriptor) => BaseSeriesStyle;
  rules?: SeriesStyleRule[];
  overrides?: Record<string, SeriesStyleOverride>;
  linkSecondaryColors?: boolean;
  secondaryNameMode?: "derive" | "independent";
  secondaryNameSuffix?: string | null;
}): Map<string, ResolvedSeriesStyle> {
  const {
    descriptors,
    baseFor,
    rules,
    overrides,
    linkSecondaryColors = true,
    secondaryNameMode = "derive",
    secondaryNameSuffix = null,
  } = input;

  // Pass 1: resolve every descriptor independently.
  const resolved = new Map<string, ResolvedSeriesStyle>();
  for (const descriptor of descriptors) {
    resolved.set(descriptor.key, resolveSeriesStyle(baseFor(descriptor), descriptor, rules, overrides));
  }

  // Pass 2: link secondaries to their primary's resolved style.
  for (const descriptor of descriptors) {
    if (!isSecondarySeries(descriptor)) continue;
    const primaryKey = primarySeriesKeyFor(descriptor);
    if (primaryKey === null) continue;
    const primary = resolved.get(primaryKey);
    if (!primary) continue;

    const style = resolved.get(descriptor.key);
    if (!style) continue;

    const override = overrides?.[descriptor.key];
    const linkEnabled = override?.link_color ?? linkSecondaryColors ?? true;
    if (linkEnabled) {
      style.color = primary.color;
    }

    const hasExplicitName = override?.name !== undefined && override?.name !== null;
    if (secondaryNameMode === "derive" && !hasExplicitName) {
      const suffix = secondaryNameSuffix ?? descriptor.secondarySuffix ?? "";
      style.name = `${primary.name}${suffix}`;
    }
  }

  return resolved;
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

/**
 * Shorten a source filename for hover labels.
 *
 * Plotly cannot wrap or clip hover text, so a long `.ndax` name stretched the
 * box across the plot. Truncating in the middle keeps the distinguishing head
 * and the extension, which is what tells two variants apart.
 */
export function shortSourceName(name: string, max = 34): string {
  if (!name || name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** Points kept per preview trace. The preview is ~620 px wide; more is invisible. */
export const PREVIEW_MAX_POINTS = 400;

function everyNth<T>(values: T[], step: number): T[] {
  const out: T[] = [];
  for (let index = 0; index < values.length; index += step) out.push(values[index]);
  // Always keep the last point so the curve does not appear to stop early.
  if (values.length && out[out.length - 1] !== values[values.length - 1]) {
    out.push(values[values.length - 1]);
  }
  return out;
}

/**
 * Thin the preview's traces.
 *
 * The editor redraws on every change, and a time/capacity plot can carry tens
 * of thousands of points per cell. At preview size those points land on the
 * same pixels, so drawing them all only costs time. Styling — colour, dash,
 * markers, width — reads identically from a decimated curve.
 *
 * Only positional arrays are thinned, and only in lockstep, so a trace's points
 * stay aligned with its hover data.
 */
export function decimatePreviewTraces<T extends Record<string, unknown>>(
  traces: T[],
  maxPoints = PREVIEW_MAX_POINTS,
): T[] {
  return traces.map((trace) => {
    const x = trace.x as unknown[] | undefined;
    if (!Array.isArray(x) || x.length <= maxPoints) return trace;
    const step = Math.ceil(x.length / maxPoints);
    const next: Record<string, unknown> = { ...trace };
    for (const key of ["x", "y", "customdata", "text", "meta"]) {
      const value = trace[key];
      if (Array.isArray(value) && value.length === x.length) {
        next[key] = everyNth(value, step);
      }
    }
    return next as T;
  });
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

/**
 * Apply one explicit override patch to a concrete selection.
 *
 * Selection is deliberately an iterable so callers can keep their native
 * Set state. Keys are sorted before new entries are written, which keeps the
 * resulting object deterministic without mutating either input. `null` is
 * retained as the existing fall-through sentinel until the complete entry is
 * pruned.
 */
export function applySeriesOverridePatch(
  overrides: Record<string, SeriesStyleOverride>,
  keys: Iterable<string>,
  patch: SeriesStyleOverride,
): Record<string, SeriesStyleOverride> {
  const next = { ...overrides };
  const selectedKeys = Array.from(new Set(keys)).sort();
  for (const key of selectedKeys) {
    const merged = { ...(next[key] ?? {}), ...patch };
    if (isEmptyOverride(merged)) delete next[key];
    else next[key] = merged;
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
