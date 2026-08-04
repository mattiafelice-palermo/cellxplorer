import assert from "node:assert/strict";
import test from "node:test";

import {
  emptySeriesRule,
  isEmptyOverride,
  matchingRules,
  pruneOverrides,
  resolveSeriesStyle,
  seriesMatchesRule,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  seriesRuleError,
  type BaseSeriesStyle,
  type SeriesDescriptor,
} from "../src/seriesStyling.ts";
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

test("undefined rules and overrides are treated as none", () => {
  const resolved = resolveSeriesStyle(base, cell(), undefined, undefined);
  assert.equal(resolved.color, "#111111");
  assert.deepEqual(matchingRules(cell(), undefined), []);
});
