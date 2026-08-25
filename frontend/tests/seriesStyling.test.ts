import assert from "node:assert/strict";
import test from "node:test";

import {
  composeSeriesKey,
  decimatePreviewTraces,
  cyclesSeriesDescriptors,
  timeCapacitySeriesDescriptors,
  timeCapacityVoltageSeriesDescriptor,
  applySeriesOverridePatch,
  emptySeriesRule,
  isEmptyOverride,
  isSecondarySeries,
  linkedSecondarySeriesKeys,
  matchingRules,
  moveSeriesWithinGroup,
  orderedSeriesDescriptors,
  orderedSeriesDescriptorsByGroup,
  primarySeriesKeyFor,
  pruneOverrides,
  resolveAllSeriesStyles,
  resolveSeriesStyle,
  seriesSelectionModifiers,
  seriesMatchesRule,
  seriesPaletteSlots,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  seriesRuleError,
  seriesLegendRanks,
  seriesQuantityGroupKey,
  seriesSelectionRange,
  seriesSelectionResult,
  sharedValue,
  shortSourceName,
  type BaseSeriesStyle,
  type SeriesDescriptor,
} from "../src/features/analyses/editor/plotting/seriesStyling.ts";
import type { SeriesStyleRule } from "../src/api.ts";

const base: BaseSeriesStyle = {
  color: "#111111",
  lineWidth: 2.5,
  lineDash: "solid",
  markerMode: "none",
  markerSymbol: "circle",
  markerSize: 5,
  markerOpen: false,
  opacity: 1,
};

const cell = (over: Partial<SeriesDescriptor> = {}): SeriesDescriptor => ({
  key: "c1",
  kind: "cell",
  label: "LFP 25C #1",
  cellName: "LFP 25C #1",
  groupName: "LFP 25C",
  ...over,
});

const rule = (over: Partial<SeriesStyleRule> = {}): SeriesStyleRule => ({
  ...emptySeriesRule(),
  id: "r1",
  ...over,
});

test("with no rules and no overrides a series keeps the base style", () => {
  const resolved = resolveSeriesStyle(base, cell(), [], {});
  assert.equal(resolved.color, "#111111");
  assert.equal(resolved.lineWidth, 2.5);
  assert.equal(resolved.name, "LFP 25C #1");
  assert.equal(resolved.hidden, false);
  assert.equal(resolved.showInLegend, true);
});

test("an explicit override replaces only the fields it sets", () => {
  const resolved = resolveSeriesStyle(base, cell(), [], {
    c1: { color: "#ff0000", line_dash: "dash" },
  });
  assert.equal(resolved.color, "#ff0000");
  assert.equal(resolved.lineDash, "dash");
  // Untouched fields still come from the base.
  assert.equal(resolved.lineWidth, 2.5);
  assert.equal(resolved.markerSymbol, "circle");
});

test("a matching rule styles the series in bulk", () => {
  const resolved = resolveSeriesStyle(
    base,
    cell(),
    [rule({ field: "group_name", operator: "contains", value: "25C", style: { color: "#0000ff" } })],
    {},
  );
  assert.equal(resolved.color, "#0000ff");
});

test("a later rule beats an earlier one", () => {
  const resolved = resolveSeriesStyle(
    base,
    cell(),
    [
      rule({ id: "a", value: "LFP", style: { color: "#111", line_width: 1 } }),
      rule({ id: "b", value: "25C", style: { color: "#222" } }),
    ],
    {},
  );
  assert.equal(resolved.color, "#222");
  // The first rule's other field survives: rules merge field by field.
  assert.equal(resolved.lineWidth, 1);
});

test("an explicit override always beats a rule", () => {
  const resolved = resolveSeriesStyle(
    base,
    cell(),
    [rule({ value: "LFP", style: { color: "#0000ff", line_width: 8 } })],
    { c1: { color: "#00ff00" } },
  );
  assert.equal(resolved.color, "#00ff00");
  // The rule still supplies what the user did not set by hand.
  assert.equal(resolved.lineWidth, 8);
});

test("a disabled rule and an empty pattern never match", () => {
  assert.equal(seriesMatchesRule(cell(), rule({ enabled: false, value: "LFP" })), false);
  assert.equal(seriesMatchesRule(cell(), rule({ value: "" })), false);
});

test("matching is case-insensitive unless asked otherwise", () => {
  assert.equal(seriesMatchesRule(cell(), rule({ value: "lfp" })), true);
  assert.equal(seriesMatchesRule(cell(), rule({ value: "lfp", case_sensitive: true })), false);
});

test("every operator behaves as named", () => {
  const d = cell({ label: "alpha-beta" });
  assert.equal(seriesMatchesRule(d, rule({ operator: "equals", value: "alpha-beta" })), true);
  assert.equal(seriesMatchesRule(d, rule({ operator: "equals", value: "alpha" })), false);
  assert.equal(seriesMatchesRule(d, rule({ operator: "starts_with", value: "alpha" })), true);
  assert.equal(seriesMatchesRule(d, rule({ operator: "ends_with", value: "beta" })), true);
  assert.equal(seriesMatchesRule(d, rule({ operator: "contains", value: "ha-be" })), true);
  assert.equal(seriesMatchesRule(d, rule({ operator: "matches", value: "^alpha.*a$" })), true);
});

test("an invalid regex matches nothing instead of throwing", () => {
  const bad = rule({ operator: "matches", value: "([unclosed" });
  assert.doesNotThrow(() => seriesMatchesRule(cell(), bad));
  assert.equal(seriesMatchesRule(cell(), bad), false);
  assert.ok(seriesRuleError(bad));
  assert.equal(seriesRuleError(rule({ operator: "matches", value: "^ok$" })), null);
  assert.equal(seriesRuleError(rule({ operator: "contains", value: "([unclosed" })), null);
});

test("a rule on a field the series lacks does not match", () => {
  const loose = cell({ groupName: null });
  assert.equal(seriesMatchesRule(loose, rule({ field: "group_name", value: "25C" })), false);
});

test("series type is matchable, so all aggregates can be styled at once", () => {
  const group: SeriesDescriptor = {
    key: "g3",
    kind: "group",
    label: "LFP 25C mean",
    cellName: null,
    groupName: "LFP 25C",
  };
  const rules = [rule({ field: "kind", operator: "equals", value: "group", style: { line_width: 4 } })];
  assert.equal(resolveSeriesStyle(base, group, rules, {}).lineWidth, 4);
  assert.equal(resolveSeriesStyle(base, cell(), rules, {}).lineWidth, 2.5);
});

test("matchingRules reports what applied, in order", () => {
  const rules = [
    rule({ id: "a", value: "LFP" }),
    rule({ id: "b", value: "nothing here" }),
    rule({ id: "c", field: "kind", operator: "equals", value: "cell" }),
  ];
  assert.deepEqual(matchingRules(cell(), rules).map((r) => r.id), ["a", "c"]);
});

test("name, legend visibility and hiding are per series", () => {
  const resolved = resolveSeriesStyle(base, cell(), [], {
    c1: { name: "Reference", show_in_legend: false, hidden: true },
  });
  assert.equal(resolved.name, "Reference");
  assert.equal(resolved.showInLegend, false);
  assert.equal(resolved.hidden, true);
});

test("plotly mode and symbol follow the resolved style", () => {
  const points = resolveSeriesStyle(base, cell(), [], { c1: { marker_mode: "points" } });
  assert.equal(seriesPlotlyMode(points), "markers");
  const both = resolveSeriesStyle(base, cell(), [], { c1: { marker_mode: "lines_points" } });
  assert.equal(seriesPlotlyMode(both), "lines+markers");
  assert.equal(seriesPlotlyMode(resolveSeriesStyle(base, cell(), [], {})), "lines");

  assert.equal(seriesPlotlySymbol(resolveSeriesStyle(base, cell(), [], {})), "circle");
  const open = resolveSeriesStyle(base, cell(), [], { c1: { marker_open: true, marker_symbol: "square" } });
  assert.equal(seriesPlotlySymbol(open), "square-open");
});

test("empty overrides are recognised and pruned", () => {
  assert.equal(isEmptyOverride(undefined), true);
  assert.equal(isEmptyOverride({}), true);
  assert.equal(isEmptyOverride({ color: null }), true);
  assert.equal(isEmptyOverride({ color: "#fff" }), false);
  assert.deepEqual(pruneOverrides({ c1: {}, c2: { color: "#fff" }, c3: { line_width: null } }), {
    c2: { color: "#fff" },
  });
});

test("bulk override patches every selected key and leaves other series untouched", () => {
  const next = applySeriesOverridePatch(
    {
      c1: { color: "#111111", line_width: 2 },
      c2: { marker_symbol: "square" },
      c9: { opacity: 0.4 },
    },
    new Set(["c2", "c1"]),
    { color: "#abcdef", opacity: 0.8 },
  );

  assert.deepEqual(next, {
    c1: { color: "#abcdef", line_width: 2, opacity: 0.8 },
    c2: { marker_symbol: "square", color: "#abcdef", opacity: 0.8 },
    c9: { opacity: 0.4 },
  });
});

test("bulk override null patches preserve unrelated fields and prune fall-through entries", () => {
  const next = applySeriesOverridePatch(
    {
      c1: { color: "#111111", line_width: 2 },
      c2: { marker_symbol: "square" },
    },
    ["c1", "c2"],
    { color: null, line_width: null },
  );

  assert.deepEqual(next, {
    c2: { marker_symbol: "square", color: null, line_width: null },
  });
  assert.equal("c1" in next, false);
});

test("shared values report mixed effective fields instead of a base default", () => {
  assert.deepEqual(sharedValue(["circle", "circle"]), { value: "circle", mixed: false });
  assert.deepEqual(sharedValue(["circle", "square"]), { value: undefined, mixed: true });
});

test("all-series homogenization applies the chosen old default in one explicit patch", () => {
  const descriptors = [cell({ key: "c1" }), cell({ key: "c2", label: "Cell 2" })];
  const mixedOverrides = { c2: { marker_symbol: "square" as const } };
  const before = resolveAllSeriesStyles({ descriptors, baseFor, overrides: mixedOverrides });
  assert.equal(sharedValue(descriptors.map((descriptor) => before.get(descriptor.key)!.markerSymbol)).mixed, true);

  const nextOverrides = applySeriesOverridePatch(mixedOverrides, ["c1", "c2"], {
    marker_symbol: "circle",
  });
  const after = resolveAllSeriesStyles({ descriptors, baseFor, overrides: nextOverrides });
  assert.equal(after.get("c1")!.markerSymbol, "circle");
  assert.equal(after.get("c2")!.markerSymbol, "circle");
  assert.equal(nextOverrides.c1.marker_symbol, "circle");
  assert.equal(nextOverrides.c2.marker_symbol, "circle");
});

test("all-series colour homogenization follows linked secondaries through their primaries", () => {
  const primaryA = cell({ key: "c1", sourceKey: "c1", label: "Cell 1" });
  const secondaryA = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell 1 CE",
  });
  const primaryB = cell({ key: "c2", sourceKey: "c2", label: "Cell 2" });
  const secondaryB = cell({
    key: "y2:ce:c2",
    sourceKey: "c2",
    axis: "y2",
    measure: "ce",
    label: "Cell 2 CE",
  });
  const descriptors = [primaryA, secondaryA, primaryB, secondaryB];
  const secondaryBase: BaseSeriesStyle = { ...base, color: "#00ff00" };
  const beforeOverrides = {
    c1: { color: "#ff0000" },
    c2: { color: "#0000ff" },
  };
  const resolve = (overrides: typeof beforeOverrides) =>
    resolveAllSeriesStyles({
      descriptors,
      baseFor: (descriptor) => (isSecondarySeries(descriptor) ? secondaryBase : base),
      overrides,
      linkSecondaryColors: true,
    });

  const before = resolve(beforeOverrides);
  assert.equal(sharedValue(descriptors.map((descriptor) => before.get(descriptor.key)!.color)).mixed, true);

  const nextOverrides = applySeriesOverridePatch(
    beforeOverrides,
    descriptors.map((descriptor) => descriptor.key),
    { color: "#abcdef" },
  );
  const after = resolve(nextOverrides);
  assert.deepEqual(
    descriptors.map((descriptor) => after.get(descriptor.key)!.color),
    ["#abcdef", "#abcdef", "#abcdef", "#abcdef"],
  );
  assert.deepEqual(
    linkedSecondarySeriesKeys(descriptors, descriptors.map((descriptor) => descriptor.key), nextOverrides, true),
    ["y2:ce:c1", "y2:ce:c2"],
  );
});

test("series selection ranges stay anchored and bounded to one ordered group", () => {
  const items = [{ key: "c1" }, { key: "c2" }, { key: "c3" }, { key: "c4" }];
  assert.deepEqual(seriesSelectionRange(items, "c1", "c3"), ["c1", "c2", "c3"]);
  assert.deepEqual(seriesSelectionRange(items, "c3", "c2"), ["c2", "c3"]);
  assert.equal(seriesSelectionRange(items, "missing", "c2"), null);
});

test("row and checkbox range gestures share an inclusive endpoint policy", () => {
  const items = [{ key: "c1" }, { key: "c2" }, { key: "c3" }, { key: "c4" }];
  const pointerGesture = seriesSelectionModifiers({ shiftKey: true, ctrlKey: false, metaKey: false });
  const releasedBeforeClick = seriesSelectionModifiers({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  const forward = seriesSelectionResult(items, ["c1"], "c1", "c4", pointerGesture);
  const reverse = seriesSelectionResult(items, ["c4"], "c4", "c2", {
    shiftKey: true,
    toggleKey: false,
  });

  assert.deepEqual(releasedBeforeClick, { shiftKey: false, toggleKey: false });
  assert.deepEqual(forward, { keys: ["c1", "c2", "c3", "c4"], anchor: "c1" });
  assert.deepEqual(
    seriesSelectionResult(items, ["c1"], "c1", "c4", releasedBeforeClick),
    { keys: ["c4"], anchor: "c4" },
  );
  assert.deepEqual(reverse, { keys: ["c2", "c3", "c4"], anchor: "c4" });
});

test("selection modifiers give Shift precedence over Ctrl/Cmd and preserve plain toggles", () => {
  const items = [{ key: "c1" }, { key: "c2" }, { key: "c3" }];
  const shiftAndToggle = seriesSelectionModifiers({ shiftKey: true, ctrlKey: true, metaKey: false });
  const plainToggle = seriesSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: true });

  assert.deepEqual(
    seriesSelectionResult(items, ["c1"], "c1", "c3", shiftAndToggle),
    { keys: ["c1", "c2", "c3"], anchor: "c1" },
  );
  assert.deepEqual(
    seriesSelectionResult(items, ["c1"], "c1", "c2", plainToggle),
    { keys: ["c1", "c2"], anchor: "c2" },
  );
});

// The editor shipped once listing zero series because the panel discarded the
// time/capacity result. These pin that every tab produces a list.
const traceLike = (over: Record<string, unknown> = {}) => ({
  cell_id: 1,
  cell_name: "A",
  label: "A",
  group_id: null,
  group_name: null,
  excluded: false,
  ...over,
}) as Parameters<typeof timeCapacitySeriesDescriptors>[0][number];

test("cycles descriptors list aggregates and the cells that are drawn", () => {
  const aggregates = [{ group_id: 7, group_name: "LFP" }];
  const cells = [
    traceLike({ cell_id: 1, group_id: 7, group_name: "LFP" }),
    traceLike({ cell_id: 2, cell_name: "B", label: "B" }),
    traceLike({ cell_id: 3, cell_name: "C", label: "C", excluded: true }),
  ];

  // Individual cells hidden: grouped cells are not drawn, so not listed.
  const collapsed = cyclesSeriesDescriptors(aggregates, cells, false);
  assert.deepEqual(collapsed.map((d) => d.key), ["g7", "c2"]);

  // Individual cells shown: the grouped cell appears too.
  const expanded = cyclesSeriesDescriptors(aggregates, cells, true);
  assert.deepEqual(expanded.map((d) => d.key), ["g7", "c1", "c2"]);

  // Excluded cells are never listed.
  assert.equal(expanded.some((d) => d.key === "c3"), false);
});

test("with no aggregates every non-excluded cell is listed", () => {
  const cells = [traceLike({ cell_id: 1, group_id: 4, group_name: "G" })];
  assert.deepEqual(cyclesSeriesDescriptors([], cells, false).map((d) => d.key), ["c1"]);
});

test("time/capacity descriptors key grouped cells together and de-duplicate", () => {
  const traces = [
    traceLike({ cell_id: 1, group_id: 2, group_name: "G" }),
    traceLike({ cell_id: 5, cell_name: "E", label: "E", group_id: 2, group_name: "G" }),
    traceLike({ cell_id: 9, cell_name: "I", label: "I" }),
    traceLike({ cell_id: 10, cell_name: "J", label: "J", excluded: true }),
  ];
  const descriptors = timeCapacitySeriesDescriptors(traces);
  assert.deepEqual(descriptors.map((d) => d.key), ["g2", "c9"]);
  assert.equal(descriptors[0].kind, "group");
  assert.equal(descriptors[1].kind, "cell");
});

test("multi-voltage Time/Capacity descriptors expose independent channel keys", () => {
  const descriptors = timeCapacitySeriesDescriptors(
    [traceLike({ cell_id: 1, label: "Cell A" })],
    ["voltage", "working_potential", "counter_potential"],
  );

  assert.deepEqual(descriptors.map((descriptor) => descriptor.key), [
    "c1|voltage",
    "c1|working_potential",
    "c1|counter_potential",
  ]);
  assert.deepEqual(descriptors.map((descriptor) => descriptor.measureLabel), [
    "Cell voltage",
    "Working potential",
    "Counter potential",
  ]);
  assert.equal(descriptors[1].channel, "working_potential");
  assert.equal(descriptors[1].sourceKey, "c1");
  assert.equal(
    timeCapacityVoltageSeriesDescriptor(traceLike({ cell_id: 1 }), "counter_potential").key,
    "c1|counter_potential",
  );
});

test("channel overrides win while legacy Cell overrides remain the fallback", () => {
  const descriptor = timeCapacityVoltageSeriesDescriptor(
    traceLike({ cell_id: 1 }),
    "working_potential",
  );
  const legacy = resolveSeriesStyle(base, descriptor, [], { c1: { line_width: 4 } });
  const channel = resolveSeriesStyle(base, descriptor, [], {
    c1: { line_width: 4 },
    "c1|working_potential": { line_width: 1 },
  });

  assert.equal(legacy.lineWidth, 4);
  assert.equal(channel.lineWidth, 1);
});

test("a populated result never yields an empty series list", () => {
  const cells = [traceLike()];
  assert.ok(cyclesSeriesDescriptors([], cells, false).length > 0);
  assert.ok(timeCapacitySeriesDescriptors(cells).length > 0);
});

// The trace builders colour per cell/replicate group, so a cell's primary and
// its CE overlay share one palette slot. Numbering descriptors in order instead
// gave the CE the next palette colour, and the swatch in the series list then
// showed a colour the plot never drew.
test("a secondary series shares its primary's palette slot", () => {
  const ceKey = composeSeriesKey({ sourceKey: "c1", axis: "y2", measure: "coulombic_efficiency" });
  const slots = seriesPaletteSlots([
    cell({ key: "c1", sourceKey: "c1" }),
    cell({ key: ceKey, sourceKey: "c1", axis: "y2", measure: "coulombic_efficiency" }),
    cell({ key: "c2", sourceKey: "c2" }),
  ]);

  assert.equal(slots.get("c1"), 0);
  assert.equal(slots.get(ceKey), 0, "CE takes its primary's slot, not the next one");
  assert.equal(slots.get("c2"), 1, "the next primary still gets the next slot");
});

test("palette slots follow primary order regardless of where secondaries sit", () => {
  const ce1 = composeSeriesKey({ sourceKey: "c1", axis: "y2", measure: "coulombic_efficiency" });
  const ce2 = composeSeriesKey({ sourceKey: "c2", axis: "y2", measure: "coulombic_efficiency" });
  const slots = seriesPaletteSlots([
    cell({ key: "c1", sourceKey: "c1" }),
    cell({ key: ce1, sourceKey: "c1", axis: "y2", measure: "coulombic_efficiency" }),
    cell({ key: "c2", sourceKey: "c2" }),
    cell({ key: ce2, sourceKey: "c2", axis: "y2", measure: "coulombic_efficiency" }),
  ]);

  assert.deepEqual(
    [slots.get("c1"), slots.get(ce1), slots.get("c2"), slots.get(ce2)],
    [0, 0, 1, 1],
  );
});

test("a secondary with no primary in the list gets a slot of its own", () => {
  const orphan = composeSeriesKey({ sourceKey: "c9", axis: "y2", measure: "coulombic_efficiency" });
  const slots = seriesPaletteSlots([
    cell({ key: "c1", sourceKey: "c1" }),
    cell({ key: orphan, sourceKey: "c9", axis: "y2", measure: "coulombic_efficiency" }),
  ]);

  assert.equal(slots.get("c1"), 0);
  assert.equal(slots.get(orphan), 1, "an orphan must not borrow another series' colour");
});

test("long source filenames are truncated in the middle for hover labels", () => {
  const long = "UU_BVL_TOP_SK_LE_39714_01_C3D3_25C_10uL_NewLi__variant_0313.ndax";
  const short = shortSourceName(long);
  assert.equal(short.length, 34);
  assert.ok(short.startsWith("UU_BVL_TOP_SK_LE"));
  // The tail survives, which is what distinguishes one variant from another.
  assert.ok(short.endsWith("0313.ndax"));
  assert.ok(short.includes("…"));
});

test("short names and empty names pass through untouched", () => {
  assert.equal(shortSourceName("cell.ndax"), "cell.ndax");
  assert.equal(shortSourceName(""), "");
  const exact = "x".repeat(34);
  assert.equal(shortSourceName(exact), exact);
});

test("preview traces are thinned but keep their shape and endpoints", () => {
  const x = Array.from({ length: 5000 }, (_, i) => i);
  const y = x.map((v) => v * 2);
  const [trace] = decimatePreviewTraces([{ x, y, name: "a" }], 400);

  const nextX = trace.x as number[];
  const nextY = trace.y as number[];
  assert.ok(nextX.length <= 401, `expected <=401 points, got ${nextX.length}`);
  // Endpoints survive so the curve does not appear to stop early.
  assert.equal(nextX[0], 0);
  assert.equal(nextX[nextX.length - 1], 4999);
  // x and y stay aligned, which is what keeps hover data correct.
  assert.equal(nextX.length, nextY.length);
  nextX.forEach((value, index) => assert.equal(nextY[index], value * 2));
  assert.equal(trace.name, "a");
});

test("decimation leaves short traces and non-array fields alone", () => {
  const short = { x: [1, 2, 3], y: [4, 5, 6], line: { color: "#fff" } };
  const [same] = decimatePreviewTraces([short], 400);
  // Returned untouched, so no needless array churn.
  assert.equal(same, short);

  // A field whose length does not match x is not a per-point array.
  const [mixed] = decimatePreviewTraces(
    [{ x: Array.from({ length: 900 }, (_, i) => i), y: [1, 2], meta: "label" }],
    100,
  );
  assert.deepEqual(mixed.y, [1, 2]);
  assert.equal(mixed.meta, "label");
});

test("customdata is thinned in lockstep with the points", () => {
  const x = Array.from({ length: 1000 }, (_, i) => i);
  const customdata = x.map((i) => [i, `f${i}`]);
  const [trace] = decimatePreviewTraces([{ x, y: x, customdata }], 100);
  const nextX = trace.x as number[];
  const nextCustom = trace.customdata as [number, string][];
  assert.equal(nextX.length, nextCustom.length);
  nextX.forEach((value, index) => assert.equal(nextCustom[index][0], value));
});

test("undefined rules and overrides are treated as none", () => {
  const resolved = resolveSeriesStyle(base, cell(), undefined, undefined);
  assert.equal(resolved.color, "#111111");
  assert.deepEqual(matchingRules(cell(), undefined), []);
});

// --- composeSeriesKey ---------------------------------------------------

test("composeSeriesKey composes from structured identity, omitting defaults", () => {
  assert.equal(composeSeriesKey({ sourceKey: "c12" }), "c12");
  assert.equal(composeSeriesKey({ sourceKey: "c12", plot: 0, axis: "y", measure: null }), "c12");
  assert.equal(
    composeSeriesKey({ sourceKey: "c12", axis: "y2", measure: "coulombic_efficiency" }),
    "y2:coulombic_efficiency:c12",
  );
  assert.equal(
    composeSeriesKey({ sourceKey: "g3", plot: 1, measure: "voltage" }),
    "p1:voltage:g3",
  );
});

test("a primary series' composed key equals its legacy key, so saved plots need no migration", () => {
  assert.equal(composeSeriesKey({ sourceKey: "c12", plot: 0, axis: "y", measure: null }), "c12");
  assert.equal(composeSeriesKey({ sourceKey: "g7" }), "g7");
});

// --- primarySeriesKeyFor / isSecondarySeries -----------------------------

test("primarySeriesKeyFor returns null for a primary descriptor", () => {
  assert.equal(primarySeriesKeyFor(cell({ sourceKey: "c12" })), null);
  assert.equal(primarySeriesKeyFor(cell({ sourceKey: "c12", axis: "y", measure: null })), null);
  // No sourceKey at all: nothing to link to.
  assert.equal(primarySeriesKeyFor(cell()), null);
});

test("primarySeriesKeyFor resolves the primary axis/measure key for a secondary", () => {
  assert.equal(
    primarySeriesKeyFor(cell({ sourceKey: "c12", axis: "y2", measure: "ce" })),
    "c12",
  );
  assert.equal(
    primarySeriesKeyFor(cell({ sourceKey: "g3", plot: 1, measure: "voltage" })),
    "p1:g3",
  );
});

test("isSecondarySeries is true only for y2 axis or a named measure", () => {
  assert.equal(isSecondarySeries(cell({ sourceKey: "c1" })), false);
  assert.equal(isSecondarySeries(cell({ sourceKey: "c1", axis: "y", measure: null })), false);
  assert.equal(isSecondarySeries(cell({ sourceKey: "c1", axis: "y2" })), true);
  assert.equal(isSecondarySeries(cell({ sourceKey: "c1", measure: "coulombic_efficiency" })), true);
});

test("bulk colour policy identifies only selected linked secondary series", () => {
  const primary = cell({ key: "c1", sourceKey: "c1" });
  const linked = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
  });
  const independent = cell({
    key: "y2:ce:c2",
    sourceKey: "c2",
    axis: "y2",
    measure: "ce",
  });
  const orphan = cell({
    key: "y2:ce:c9",
    sourceKey: "c9",
    axis: "y2",
    measure: "ce",
  });

  assert.deepEqual(
    linkedSecondarySeriesKeys(
      [primary, linked, independent],
      ["c1", "y2:ce:c1", "y2:ce:c2"],
      { "y2:ce:c2": { link_color: false } },
      true,
    ),
    ["y2:ce:c1"],
  );
  assert.deepEqual(
    linkedSecondarySeriesKeys([primary, linked], ["c1"], {}, true),
    [],
    "unselected secondary series must not disable a bulk colour edit",
  );
  assert.deepEqual(
    linkedSecondarySeriesKeys([primary, linked], ["y2:ce:c1"], {}, false),
    [],
    "the plot-wide link default is the same default used by the editor",
  );
  assert.deepEqual(
    linkedSecondarySeriesKeys([orphan], ["y2:ce:c9"], {}, true),
    [],
    "an orphan secondary keeps its independent colour even when linking is enabled",
  );
});

test("stored series order ignores stale and duplicate keys without mutating inputs", () => {
  const descriptors = [
    cell({ key: "c1", label: "One" }),
    cell({ key: "c2", label: "Two" }),
    cell({ key: "c3", label: "Three" }),
  ];
  const storedOrder = ["c3", "stale", "c3"];
  const before = descriptors.map((descriptor) => descriptor.key);

  assert.deepEqual(
    orderedSeriesDescriptors(descriptors, storedOrder).map((descriptor) => descriptor.key),
    ["c3", "c1", "c2"],
  );
  assert.deepEqual(descriptors.map((descriptor) => descriptor.key), before);
  assert.deepEqual(storedOrder, ["c3", "stale", "c3"]);
});

test("series order stays within quantity groups and maps to deterministic legend ranks", () => {
  const primaryOne = cell({ key: "c1", measureLabel: "Capacity" });
  const primaryTwo = cell({ key: "c2", measureLabel: "Capacity" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    measureLabel: "Efficiency",
  });
  const descriptors = [primaryOne, primaryTwo, secondary];

  assert.deepEqual(
    orderedSeriesDescriptorsByGroup(descriptors, [secondary.key, primaryTwo.key, primaryOne.key]).map(
      (descriptor) => descriptor.key,
    ),
    [primaryTwo.key, primaryOne.key, secondary.key],
  );
  assert.equal(seriesQuantityGroupKey(primaryOne), seriesQuantityGroupKey(primaryTwo));
  assert.notEqual(seriesQuantityGroupKey(primaryOne), seriesQuantityGroupKey(secondary));
  assert.deepEqual(
    [...seriesLegendRanks(descriptors, [secondary.key, primaryTwo.key, primaryOne.key]).entries()],
    [
      [primaryTwo.key, 0],
      [primaryOne.key, 1],
      [secondary.key, 2],
    ],
  );
});

test("moving a series changes only its own quantity group", () => {
  const descriptors = [
    cell({ key: "c1", measureLabel: "Capacity" }),
    cell({ key: "c2", measureLabel: "Capacity" }),
    cell({ key: "ce1", measureLabel: "Efficiency" }),
  ];
  assert.deepEqual(
    moveSeriesWithinGroup(descriptors, undefined, "c1", "c2"),
    ["c2", "c1", "ce1"],
  );
  assert.equal(
    moveSeriesWithinGroup(descriptors, undefined, "c1", "ce1"),
    null,
    "cross-group moves are rejected",
  );
});

test("panel row order does not change palette slots keyed by trace identity", () => {
  const descriptors = [
    cell({ key: "c1", sourceKey: "c1" }),
    cell({ key: "c2", sourceKey: "c2" }),
  ];
  const storedOrder = ["c2", "c1"];
  const rows = orderedSeriesDescriptorsByGroup(descriptors, storedOrder);
  const slotsBefore = seriesPaletteSlots(descriptors);
  // The trace builders continue to resolve palette slots from canonical
  // descriptor identity; only the panel/legend presentation order changes.
  const slotsAfter = seriesPaletteSlots(descriptors);

  assert.deepEqual(rows.map((descriptor) => descriptor.key), ["c2", "c1"]);
  assert.deepEqual([...slotsBefore.entries()], [...slotsAfter.entries()]);
});

// --- resolveAllSeriesStyles ----------------------------------------------

const baseFor = () => base;

test("a y2 series takes its primary's colour by default", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE own label",
  });
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    overrides: { c1: { color: "#ff0000" } },
  });
  assert.equal(resolved.get("c1")!.color, "#ff0000");
  assert.equal(resolved.get("y2:ce:c1")!.color, "#ff0000");
});

test("linking off leaves the secondary's own colour", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE",
  });
  const secondaryBase: BaseSeriesStyle = { ...base, color: "#00ff00" };
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor: (d) => (d.key === "y2:ce:c1" ? secondaryBase : base),
    overrides: { c1: { color: "#ff0000" } },
    linkSecondaryColors: false,
  });
  assert.equal(resolved.get("c1")!.color, "#ff0000");
  assert.equal(resolved.get("y2:ce:c1")!.color, "#00ff00");
});

test("a per-series link_color override beats the tab-level default in both directions", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE",
  });
  const secondaryBase: BaseSeriesStyle = { ...base, color: "#00ff00" };
  const baseForMixed = (d: SeriesDescriptor) => (d.key === "y2:ce:c1" ? secondaryBase : base);

  // Tab default is linking ON, but this series opts out.
  const off = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor: baseForMixed,
    overrides: { c1: { color: "#ff0000" }, "y2:ce:c1": { link_color: false } },
    linkSecondaryColors: true,
  });
  assert.equal(off.get("y2:ce:c1")!.color, "#00ff00");

  // Tab default is linking OFF, but this series opts in.
  const on = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor: baseForMixed,
    overrides: { c1: { color: "#ff0000" }, "y2:ce:c1": { link_color: true } },
    linkSecondaryColors: false,
  });
  assert.equal(on.get("y2:ce:c1")!.color, "#ff0000");
});

test("the secondary inherits a colour the primary got from a rule (two-pass ordering)", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A", groupName: "LFP" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE",
  });
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    rules: [rule({ field: "group_name", value: "LFP", style: { color: "#123456" } })],
  });
  assert.equal(resolved.get("c1")!.color, "#123456");
  assert.equal(resolved.get("y2:ce:c1")!.color, "#123456");
});

test("the secondary inherits a colour the primary got from an explicit override", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE",
  });
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    overrides: { c1: { color: "#abcdef" } },
  });
  assert.equal(resolved.get("y2:ce:c1")!.color, "#abcdef");
});

test("secondary name derives from the primary's resolved name plus a suffix, and follows a rename", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "own label",
    secondarySuffix: " CE",
  });
  const resolved = resolveAllSeriesStyles({ descriptors: [primary, secondary], baseFor });
  assert.equal(resolved.get("c1")!.name, "Cell A");
  assert.equal(resolved.get("y2:ce:c1")!.name, "Cell A CE");

  // Renaming the primary via an override flows into the derived name.
  const renamed = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    overrides: { c1: { name: "Reference Cell" } },
  });
  assert.equal(renamed.get("c1")!.name, "Reference Cell");
  assert.equal(renamed.get("y2:ce:c1")!.name, "Reference Cell CE");
});

test("an explicit name override on the secondary beats derivation", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "own label",
    secondarySuffix: " CE",
  });
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    overrides: { "y2:ce:c1": { name: "Custom CE Name" } },
  });
  assert.equal(resolved.get("y2:ce:c1")!.name, "Custom CE Name");
});

test("secondaryNameMode independent leaves the secondary's own label", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "own label",
    secondarySuffix: " CE",
  });
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor,
    secondaryNameMode: "independent",
  });
  assert.equal(resolved.get("y2:ce:c1")!.name, "own label");
});

test("a missing primary does not throw and leaves the secondary untouched", () => {
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "own label",
  });
  let resolved: Map<string, ReturnType<typeof resolveSeriesStyle>> | undefined;
  assert.doesNotThrow(() => {
    resolved = resolveAllSeriesStyles({ descriptors: [secondary], baseFor });
  });
  assert.equal(resolved!.get("y2:ce:c1")!.color, base.color);
  assert.equal(resolved!.get("y2:ce:c1")!.name, "own label");
});

test("linking copies colour only — the secondary keeps its own lineDash/lineWidth/markerSize", () => {
  const primary = cell({ key: "c1", sourceKey: "c1", label: "Cell A" });
  const secondary = cell({
    key: "y2:ce:c1",
    sourceKey: "c1",
    axis: "y2",
    measure: "ce",
    label: "Cell A CE",
  });
  const secondaryBase: BaseSeriesStyle = {
    ...base,
    lineDash: "dash",
    lineWidth: 9,
    markerSize: 20,
  };
  const resolved = resolveAllSeriesStyles({
    descriptors: [primary, secondary],
    baseFor: (d) => (d.key === "y2:ce:c1" ? secondaryBase : base),
    overrides: { c1: { color: "#ff0000" } },
  });
  const secondaryStyle = resolved.get("y2:ce:c1")!;
  assert.equal(secondaryStyle.color, "#ff0000");
  assert.equal(secondaryStyle.lineDash, "dash");
  assert.equal(secondaryStyle.lineWidth, 9);
  assert.equal(secondaryStyle.markerSize, 20);
});

test("measureLabel is set on primary and CE descriptors when provided", () => {
  const aggregates = [{ group_id: 1, group_name: "LFP" }];
  const cells = [
    traceLike({ cell_id: 1, group_id: 1, group_name: "LFP" }),
    traceLike({ cell_id: 2, cell_name: "B", label: "B" }),
  ];

  // With CE enabled and a measureLabel provided
  const withCE = cyclesSeriesDescriptors(aggregates, cells, true, true, "Discharge capacity");

  // Primary descriptors should have measureLabel set
  const primaryDescriptors = withCE.filter((d) => d.axis !== "y2" || !d.measure);
  primaryDescriptors.forEach((d) => {
    assert.equal(d.measureLabel, "Discharge capacity", `Primary descriptor ${d.key} should have measureLabel`);
  });

  // CE descriptors should have measureLabel "Coulombic efficiency" and axis "y2"
  const ceDescriptors = withCE.filter((d) => d.axis === "y2" && d.measure === "coulombic_efficiency");
  assert.ok(ceDescriptors.length > 0, "Should have CE descriptors");
  ceDescriptors.forEach((d) => {
    assert.equal(d.measureLabel, "Coulombic efficiency");
    assert.equal(d.axis, "y2");
  });

  // Without CE, no CE descriptors should appear
  const noCE = cyclesSeriesDescriptors(aggregates, cells, true, false, "Discharge capacity");
  const noDescriptorsWithCE = noCE.filter((d) => d.axis === "y2" && d.measure === "coulombic_efficiency");
  assert.equal(noDescriptorsWithCE.length, 0, "Should have no CE descriptors when includeCoulombicEfficiency is false");
});
