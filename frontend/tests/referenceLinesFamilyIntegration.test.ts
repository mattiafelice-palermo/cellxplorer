import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as plotStyle from "../src/features/analyses/editor/plotting/plotStyle.ts";
import * as plotLayout from "../src/features/analyses/editor/plotting/plotLayout.ts";
import * as axisLayout from "../src/features/analyses/editor/plotting/plotAxisLayout.ts";
import * as referenceLines from "../src/features/analyses/editor/plotting/plotReferenceLines.ts";
import * as voltage from "../src/features/analyses/editor/policies/voltageChannelPolicy.ts";
import * as timePolicy from "../src/features/analyses/editor/policies/timeCapacityQueryPolicy.ts";
import * as timeVisibility from "../src/features/analyses/editor/families/time-capacity/timeCapacityVisibility.ts";
import * as visibility from "../src/features/analyses/editor/policies/analysisVisibility.ts";

/** Evaluate the actual family module; UI/query hooks are not invoked by layout builders. */
function family(name: string, file: string): Record<string, any> {
  const source = readFileSync(new URL(`../src/features/analyses/editor/families/${name}/${file}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const stubs = new Map<string, unknown>([
    ["plotStyle", plotStyle], ["plotLayout", plotLayout], ["plotAxisLayout", axisLayout], ["plotReferenceLines", referenceLines],
    ["voltageChannelPolicy", voltage], ["timeCapacityQueryPolicy", timePolicy], ["timeCapacityVisibility", timeVisibility], ["analysisVisibility", visibility],
  ]);
  runInNewContext(compiled, { exports: module.exports, require(id: string) {
    const base = id.split("/").pop()!.replace(/\.tsx?$/, "");
    if (stubs.has(base)) return stubs.get(base);
    if (id === "react") return { memo: (value: unknown) => value };
    return {};
  } });
  return module.exports;
}
const cycles = family("cycles", "CyclePlotCard");
const tc = family("time-capacity", "TimeCapacityPlotCard");
const dcir = family("dcir", "DcirPlotCard");
const steps = family("steps", "StepsPlotCard");
const chargeability = family("chargeability", "ChargeabilityPlotCard");
const crate = family("rate-capability", "RateCapabilityPlotCard");
const spec = () => ({ selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [] }, computation: {}, aggregation: {}, presentation: { legend: false, ce_overlay: true, quantity: "discharge_capacity", normalize_by_mass: false, plot_styles: {} } });
const traces = [{ type: "scatter", x: [1, 2], y: [4, 8] }, { type: "scatter", x: [1, 2], y: [80, 90], yaxis: "y2" }];
const add = (s: any, scope: string, layout: any, axisId = "y") => {
  const axes = referenceLines.referenceAxesFromLayout(layout);
  const axis = axes.find((candidate) => candidate.axis === axisId)!;
  const cross = axes.find((candidate) => candidate.axis === axis.cross_axis)!;
  const line = referenceLines.createReferenceLine(axis, cross, "integration"); line.position = 5;
  plotStyle.writeScopedStyle(s, scope as any, (style) => { style.reference_lines = [line]; });
  return line;
};

test("production Cycles builder supports X, left Y and CE and rejects quantity/unit reinterpretation", () => {
  for (const axis of ["x", "y", "y2"]) {
    const s = spec(); const base = cycles.cyclePlotLayout(undefined, s, traces); add(s, "cycles", base, axis);
    const layout = cycles.cyclePlotLayout(undefined, s, traces);
    assert.equal(layout.shapes.length, 1); assert.equal(layout.annotations.length, 1);
    if (axis === "y") {
      s.presentation.normalize_by_mass = true; assert.equal(cycles.cyclePlotLayout(undefined, s, traces).shapes.length, 0);
      s.presentation.normalize_by_mass = false; s.presentation.quantity = "charge_capacity"; assert.equal(cycles.cyclePlotLayout(undefined, s, traces).shapes.length, 0);
    } else if (axis === "y2") {
      s.presentation.ce_overlay = false; assert.equal(cycles.cyclePlotLayout(undefined, s, traces).shapes.length, 0);
    }
    assert.equal(layout.uirevision, base.uirevision);
  }
});

test("all four production simple-family builders include references and preserve built-in geometry", () => {
  const configurations = [
    ["dcir", dcir.dcirLayoutForSpec], ["steps", steps.stepsLayoutForSpec],
    ["chargeability", (s: any) => chargeability.chargeabilityLayoutForSpec(s, undefined, traces)],
    ["crate", (s: any) => crate.rateCapabilityLayoutForSpec(s, undefined, traces)],
  ] as const;
  for (const [scope, build] of configurations) {
    const s: any = spec(); const base = build(s, traces); const line = add(s, scope, base);
    const layout = build(s, traces);
    assert.equal(layout.shapes.length, base.shapes.length + 1, scope);
    assert.equal(layout.shapes.at(-1).name, referenceLines.REFERENCE_NAME_PREFIX + line.id);
    assert.equal(layout.annotations.length, base.annotations.length + 1);
  }
});

test("production C-rate X categorical transitions suppress and restore saved numeric thresholds", () => {
  const s: any = spec(); s.presentation.rate_capability_view = { x_spacing: "proportional", y_axis: "retention_pct" };
  let base = crate.rateCapabilityLayoutForSpec(s, undefined, traces);
  add(s, "crate", base, "x"); assert.equal(crate.rateCapabilityLayoutForSpec(s, undefined, traces).shapes.length, 2);
  s.presentation.rate_capability_view.x_spacing = "equal";
  const category = crate.rateCapabilityLayoutForSpec(s, undefined, traces);
  assert.equal(category.xaxis.type, "category"); assert.equal(category.shapes.length, 1, "built-in 100% reference remains");
  s.presentation.rate_capability_view.x_spacing = "proportional";
  assert.equal(crate.rateCapabilityLayoutForSpec(s, undefined, traces).shapes.length, 2);
});

test("production Time/Capacity derivative/voltage/current layouts share composition and exact bindings", () => {
  const result = { cell_traces: [{ cell_id: 1, series_key: "c1", current_ma: [1], phase: ["charge"], nominal_capacity_mah: 1, electrode_area_cm2: 1 }] };
  for (const view of ["voltage_current", "dqdv", "dvdq"]) {
    const s: any = spec(); s.computation.time_capacity = { view, stacked: view === "voltage_current", current_left: "current_ma", current_right: "current_density", voltage_channels: ["voltage"] };
    s.presentation.plot_styles.time_capacity = plotStyle.normalizePlotStyle({ show_frame: true });
    const initial = tc.timeCapacityLayout(result, s, traces);
    const ids = referenceLines.referenceAxesFromLayout(initial).filter((axis) => axis.numeric).map((axis) => axis.axis);
    assert.deepEqual(Array.from(ids), view === "voltage_current" ? ["x", "y", "y2", "y3"] : ["x", "y"]);
    for (const id of ids) {
      add(s, "time_capacity", initial, id);
      const final = tc.timeCapacityLayout(result, s, traces);
      assert.equal(final.shapes.length, initial.shapes.length + 1, `${view}/${id}`);
      assert.equal(final.annotations.length, 1); assert.equal(final.xaxis.matches, initial.xaxis.matches);
      assert.equal(final.uirevision, initial.uirevision);
      if (id === "y2") assert.equal(final.shapes.at(-1).yref, "y2");
      if (id === "y3") assert.equal(final.shapes.at(-1).yref, "y3");
    }
  }
});

test("Time/Capacity voltage-channel, time-unit and derivative-normalization changes hide saved thresholds", () => {
  const result = { cell_traces: [] };
  const s: any = spec(); s.computation.time_capacity = { voltage_channels: ["voltage"] };
  add(s, "time_capacity", tc.timeCapacityLayout(result, s, traces), "y");
  s.computation.time_capacity.voltage_channels = ["working_potential"];
  assert.equal(tc.timeCapacityLayout(result, s, traces).shapes.length, 0);
  add(s, "time_capacity", tc.timeCapacityLayout(result, s, traces), "x");
  s.computation.time_capacity.time_unit = "h";
  assert.equal(tc.timeCapacityLayout(result, s, traces).shapes.length, 0);
  s.computation.time_capacity = { view: "dqdv", derivative_specific: false };
  add(s, "time_capacity", tc.timeCapacityLayout(result, s, traces), "y");
  s.computation.time_capacity.derivative_specific = true;
  assert.equal(tc.timeCapacityLayout(result, s, traces).shapes.length, 0);
});
