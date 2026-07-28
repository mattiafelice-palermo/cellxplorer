import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolStep } from "../src/api.ts";
import {
  cRateExamples,
  formatCRate,
  operatorLabel,
  operatorsFor,
  parseCRate,
  parseDuration,
  protocolFilterValueOptions,
  stepMatches,
  stepMatchesFilter,
} from "../src/protocolStepFilters.ts";

function step(partial: Partial<ProtocolStep>): ProtocolStep {
  return {
    number: 1,
    type_id: 1,
    type: "CC charge",
    direction: "charge",
    current_ma: null,
    c_rate: null,
    c_rate_source: null,
    target_voltage_v: null,
    stop_voltage_v: null,
    stop_current_ma: null,
    stop_c_rate: null,
    stop_c_rate_source: null,
    time_limit_s: null,
    record_interval_s: null,
    record_voltage_delta_v: null,
    protection_upper_v: null,
    protection_lower_v: null,
    loop_start_step: null,
    loop_count: null,
    summary: "",
    ...partial,
  } as ProtocolStep;
}

const filter = (field: string, operator: string, value: string) =>
  ({ id: "f", field, operator, value }) as Parameters<typeof stepMatchesFilter>[1];

test("C-rates are read in the notation the app already uses", () => {
  assert.ok(Math.abs(parseCRate("C/3")! - 1 / 3) < 1e-9);
  assert.ok(Math.abs(parseCRate("c / 20")! - 0.05) < 1e-9);
  assert.equal(parseCRate("1.5C"), 1.5);
  assert.equal(parseCRate("0.333"), 0.333);
  assert.equal(parseCRate("nonsense"), null);
  assert.equal(parseCRate("C/0"), null);
});

test("durations accept units, and bare numbers mean seconds", () => {
  assert.equal(parseDuration("30"), 30);
  assert.equal(parseDuration("30s"), 30);
  assert.equal(parseDuration("45min"), 2700);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("bad"), null);
});

test("comparisons run on numbers, not on formatted text", () => {
  // "1.5C" vs "C/3" would sort wrongly as strings; the numeric field must win.
  const fast = step({ number: 27, c_rate: 1.5008 });
  const slow = step({ number: 25, c_rate: 0.3335 });
  assert.ok(stepMatchesFilter(fast, filter("rate", ">", "1C")));
  assert.ok(!stepMatchesFilter(slow, filter("rate", ">", "1C")));
  assert.ok(stepMatchesFilter(slow, filter("rate", "<", "C/2")));
});

test("equality on a rate matches what the row displays", () => {
  // The real step reads 0.33353 but is shown as "C/3"; asking for "= C/3"
  // must find the step the reader is looking at, so rate equality allows the
  // same 2% the display rounding does.
  const shownAsCOver3 = step({ c_rate: 0.3335318642048839 });
  assert.ok(stepMatchesFilter(shownAsCOver3, filter("rate", "=", "C/3")));
  assert.ok(stepMatchesFilter(step({ c_rate: 1.5008933 }), filter("rate", "=", "1.5C")));
  // But a genuinely different rate still does not match.
  assert.ok(!stepMatchesFilter(step({ c_rate: 0.5 }), filter("rate", "=", "C/3")));
});

test("exact fields keep a tight tolerance", () => {
  // 3.65 V and 3.72 V are different cut-offs, not rounding of each other.
  assert.ok(!stepMatchesFilter(step({ stop_voltage_v: 3.72 }), filter("cutoff", "=", "3.65")));
  assert.ok(stepMatchesFilter(step({ stop_voltage_v: 3.65 }), filter("cutoff", "=", "3.65")));
  assert.ok(!stepMatchesFilter(step({ number: 26 }), filter("number", "=", "25")));
});

test("a step without the field cannot satisfy a comparison", () => {
  // A rest has no rate; "rate > 1C" must not return it.
  const rest = step({ type: "Rest", direction: "rest", time_limit_s: 1800 });
  assert.ok(!stepMatchesFilter(rest, filter("rate", ">", "1C")));
  assert.ok(!stepMatchesFilter(rest, filter("rate", "<", "1C")));
  assert.ok(stepMatchesFilter(rest, filter("maxtime", ">=", "30min")));
});

test("an unreadable filter value filters nothing rather than everything", () => {
  const s = step({ c_rate: 0.5 });
  assert.ok(stepMatchesFilter(s, filter("rate", ">", "abc")));
  assert.ok(stepMatchesFilter(s, filter("rate", ">", "")));
});

test("cut-off falls back from the CC target to the CV hold voltage", () => {
  const cc = step({ stop_voltage_v: 2.8 });
  const cv = step({ type: "CCCV charge", target_voltage_v: 3.65 });
  assert.ok(stepMatchesFilter(cc, filter("cutoff", "=", "2.8")));
  assert.ok(stepMatchesFilter(cv, filter("cutoff", "=", "3.65")));
});

test("conditions match by exact expression", () => {
  const soc = step({
    number: 25,
    c_rate: 0.3335,
    stop_voltage_v: 2.8,
    conditions: [
      { expression: "DischargeAh-0.5*User1", name: "AhCount", value: 0, comparator_id: 4, jump_step: null },
    ],
  });
  const plain = step({ number: 15, c_rate: 0.3335, stop_voltage_v: 2.8 });
  assert.ok(stepMatchesFilter(soc, filter("condition", "=", "DischargeAh-0.5*User1")));
  assert.ok(!stepMatchesFilter(plain, filter("condition", "=", "DischargeAh-0.5*User1")));
  assert.ok(stepMatchesFilter(plain, filter("condition", "!=", "DischargeAh-0.5*User1")));
});

test("step type matches the displayed type label", () => {
  const cc = step({ type: "CC charge" });
  assert.ok(stepMatchesFilter(cc, filter("type", "=", "CC charge")));
  assert.ok(!stepMatchesFilter(cc, filter("type", "=", "Rest")));
  assert.ok(stepMatchesFilter(cc, filter("type", "!=", "Rest")));
});

test("type and condition filters expose equals, different than, and contains", () => {
  assert.deepEqual(operatorsFor("type"), ["=", "!=", "contains"]);
  assert.deepEqual(operatorsFor("condition"), ["=", "!=", "contains"]);
  assert.deepEqual(operatorsFor("rate"), ["=", "!=", "<", "<=", ">", ">="]);
  assert.ok(!operatorsFor("number").includes("contains"));
  assert.equal(operatorLabel("="), "equals");
  assert.equal(operatorLabel("!="), "different than");
  assert.equal(operatorLabel("contains"), "contains");
});

test("type and condition support substring contains", () => {
  const cc = step({ type: "CCCV charge" });
  assert.ok(stepMatchesFilter(cc, filter("type", "contains", "charge")));
  assert.ok(!stepMatchesFilter(cc, filter("type", "contains", "rest")));

  const soc = step({
    conditions: [
      { expression: "DischargeAh-0.5*User1", name: "AhCount", value: 0, comparator_id: 4, jump_step: null },
    ],
  });
  assert.ok(stepMatchesFilter(soc, filter("condition", "contains", "User1")));
  assert.ok(!stepMatchesFilter(step({}), filter("condition", "contains", "User1")));
});

test("protocol filter suggestions come from the active protocol only", () => {
  const steps = [
    step({ number: 1, type: "Rest", c_rate: null, stop_voltage_v: 2.8 }),
    step({
      number: 2,
      type: "CC charge",
      c_rate: 0.3335318,
      conditions: [{ expression: "2.4*User1", name: "FC", value: null, comparator_id: null, jump_step: null }],
    }),
    step({ number: 3, type: "CC charge", c_rate: 1.5, stop_voltage_v: 3.65 }),
  ];
  assert.deepEqual(protocolFilterValueOptions(steps, "type"), ["CC charge", "Rest"]);
  assert.deepEqual(protocolFilterValueOptions(steps, "condition"), ["2.4*User1"]);
  assert.deepEqual(protocolFilterValueOptions(steps, "number"), ["1", "2", "3"]);
  assert.ok(protocolFilterValueOptions(steps, "rate").includes(formatCRate(0.3335318)));
  assert.ok(protocolFilterValueOptions(steps, "rate").includes("1.5C"));
  assert.ok(protocolFilterValueOptions(steps, "cutoff").includes("2.8"));
  assert.ok(protocolFilterValueOptions(steps, "cutoff").includes("3.65"));
});

test("filters combine with AND", () => {
  const s = step({ number: 27, c_rate: 1.5, time_limit_s: 30 });
  const filters = [filter("rate", ">", "1C"), filter("maxtime", "<=", "1min")];
  assert.ok(stepMatches(s, filters as never, ""));
  assert.ok(!stepMatches(s, [...filters, filter("number", "=", "99")] as never, ""));
});

test("free-text search covers the visible row, including the condition", () => {
  const s = step({
    number: 87,
    type: "CCCV charge",
    summary: "CCCV charge | at 3.65 V | until C/20",
    conditions: [
      { expression: "2.4*User1", name: "FC", value: null, comparator_id: null, jump_step: null },
    ],
  });
  assert.ok(stepMatches(s, [], "3.65"));
  assert.ok(stepMatches(s, [], "2.4*User1"));
  assert.ok(!stepMatches(s, [], "nothing here"));
});

test("C-rate examples convert against the nominal capacity", () => {
  const examples = cRateExamples(50.37);
  assert.deepEqual(
    examples.map((e) => e.label),
    ["C/20", "C/10", "C/3", "C/2", "1C", "1.5C"]
  );
  assert.equal(examples.find((e) => e.label === "1C")!.current, "50.4 mA");
  assert.equal(examples.find((e) => e.label === "C/2")!.current, "25.2 mA");
  assert.deepEqual(cRateExamples(null), []);
  assert.deepEqual(cRateExamples(0), []);
});

test("rate equality is forgiving but never merges neighbouring fractions", () => {
  // The reported case: an inferred 1.49937 must answer to "= 1.5C".
  assert.ok(stepMatchesFilter(step({ c_rate: 1.49937 }), filter("rate", "=", "1.5C")));
  assert.ok(stepMatchesFilter(step({ c_rate: 0.3335318 }), filter("rate", "=", "C/3")));

  // A flat 0.05C allowance would make C/20 (0.05) reach C/10 (0.1). It must not.
  assert.ok(!stepMatchesFilter(step({ c_rate: 0.1 }), filter("rate", "=", "C/20")));
  assert.ok(!stepMatchesFilter(step({ c_rate: 0.05 }), filter("rate", "=", "C/10")));
  assert.ok(stepMatchesFilter(step({ c_rate: 0.0503 }), filter("rate", "=", "C/20")));
});
