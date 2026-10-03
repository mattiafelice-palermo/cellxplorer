import assert from "node:assert/strict";
import test from "node:test";
import tinycolor from "tinycolor2";
import {
  applyCycleShading, cycleShadedColor, cycleShadingFraction, cycleShadingRangeReady,
  cycleShadingSampleKey, cycleShadingSupported, defaultCycleShadingConfig,
  normalizeCycleShading, normalizeCycleShadingConfig, resetCycleShading,
  resolvedCycleShading, withCycleShadingKey,
} from "../src/features/analyses/editor/plotting/cycleShading.ts";
import { normalizePlotStyle } from "../src/features/analyses/editor/plotting/plotStyle.ts";
import { seriesAppearancePreviewLayout } from "../src/features/analyses/editor/plotting/seriesPreviewLayout.ts";

const config = (patch = {}) => ({ ...defaultCycleShadingConfig(193), enabled: true, ...patch });
const hsl = (color: string) => tinycolor(color).toHsl();
const near = (actual: number, expected: number, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);

test("shading is offered only for Voltage/Capacity", () => {
  for (const axis of ["capacity_mah", "capacity_mah_g", "capacity_mah_cm2"]) assert.equal(cycleShadingSupported("voltage_current", axis), true);
  for (const view of [undefined, "dq_dv", "dv_dq", "derivative"]) assert.equal(cycleShadingSupported(view, "capacity_mah"), false);
  assert.equal(cycleShadingSupported("voltage_current", "time"), false);
});

test("unknown full range cannot enable fabricated defaults; explicit stored bounds can", () => {
  for (const maximum of [null, NaN, Infinity, 0]) {
    const unknown = defaultCycleShadingConfig(maximum);
    assert.equal(cycleShadingRangeReady(unknown), false);
    assert.equal(normalizeCycleShadingConfig({ ...unknown, enabled: true })!.enabled, false);
  }
  const manual = normalizeCycleShadingConfig({ enabled: true, cycle_start: 3, cycle_end: 50 })!;
  assert.equal(cycleShadingRangeReady(manual), true);
  assert.equal(manual.enabled, true);
  const full = defaultCycleShadingConfig(193);
  assert.deepEqual([full.cycle_start, full.cycle_end, full.range_source], [1, 193, "full"]);
  assert.equal(cycleShadingRangeReady(full), true);
});

test("normalization bounds values, rejects malformed ranges and sample keys", () => {
  assert.equal(normalizeCycleShadingConfig(null), undefined);
  for (const bounds of [{ cycle_start: 0, cycle_end: 2 }, { cycle_start: 5, cycle_end: 2 }, { cycle_start: 1, cycle_end: Infinity }]) {
    assert.equal(normalizeCycleShadingConfig(config(bounds))!.enabled, false);
  }
  const normalized = normalizeCycleShadingConfig(config({ bands: 100, first_lightness: -10, last_saturation: 120, cycle_end: 1e12 }))!;
  assert.deepEqual([normalized.bands, normalized.first_lightness, normalized.last_saturation, normalized.cycle_end], [20, 0, 100, 1e9]);
  assert.equal(cycleShadingSampleKey("g12|working_potential"), "g12");
  assert.equal(cycleShadingSampleKey("c3"), "c3");
  for (const key of ["c0", "__proto__", "unknown", "g-1"]) assert.equal(cycleShadingSampleKey(key), null);
  assert.deepEqual(Object.keys(normalizeCycleShading({ samples: { c1: config(), "c1|voltage": config(), nonsense: config() } })!.samples!), ["c1"]);
});

test("mode endpoints preserve hue and unaffected HSL component", () => {
  const base = "#2e86ab";
  for (const mode of ["lightness", "saturation", "both"] as const) {
    const settings = config({ mode });
    const first = hsl(cycleShadedColor(base, 1, settings));
    const last = hsl(cycleShadedColor(base, 193, settings));
    near(first.h, hsl(base).h, 1); near(last.h, hsl(base).h, 1);
    near(first.l, mode === "saturation" ? hsl(base).l : 0.3);
    near(last.l, mode === "saturation" ? hsl(base).l : 0.75);
    near(first.s, mode === "lightness" ? hsl(base).s : 0.35);
    near(last.s, mode === "lightness" ? hsl(base).s : 0.9);
  }
});

test("CSS colors, alpha, neutral colors and invalid colors retain their identities", () => {
  for (const base of ["red", "rgb(255, 0, 0)", "hsl(0, 100%, 50%)"]) {
    assert.equal(cycleShadedColor(base, 1, config()), "#990000");
  }
  near(hsl(cycleShadedColor("rgba(255,0,0,0.4)", 1, config())).a, 0.4);
  assert.equal(hsl(cycleShadedColor("gray", 1, config({ mode: "both" }))).s, 0);
  for (const cycle of [null, undefined, NaN, Infinity, 0, -1]) assert.equal(cycleShadedColor("red", cycle, config()), "red");
  assert.equal(cycleShadedColor("invalid-color", 1, config()), "invalid-color");
  assert.equal(cycleShadedColor("red", 1, config({ enabled: false })), "red");
});

test("fixed mapping clamps endpoints, reverses and steps without navigation rebalance", () => {
  const smooth = config({ cycle_start: 10, cycle_end: 30 });
  assert.deepEqual([1, 10, 20, 30, 193].map((cycle) => cycleShadingFraction(cycle, smooth)), [0, 0, 0.5, 1, 1]);
  assert.equal(cycleShadingFraction(20, config({ cycle_start: 20, cycle_end: 20 })), 0);
  const reversed = { ...smooth, reverse: true };
  assert.equal(cycleShadedColor("red", 10, reversed), cycleShadedColor("red", 30, smooth));
  const stepped = config({ cycle_start: 1, cycle_end: 101, bands: 4, progression: "stepped" as const });
  assert.deepEqual([1, 20, 26, 51, 76, 101].map((cycle) => cycleShadingFraction(cycle, stepped)), [0, 0, 1 / 3, 2 / 3, 1, 1]);
  const persisted = JSON.parse(JSON.stringify(smooth));
  defaultCycleShadingConfig(500); // A later available maximum does not change a stored mapping.
  assert.equal(cycleShadedColor("red", 20, persisted), cycleShadedColor("red", 20, smooth));
});

test("sample application and reset are immutable, bounded and preserve other settings", () => {
  const original = applyCycleShading(undefined, config(), null);
  const before = structuredClone(original);
  const selected = applyCycleShading(original, config({ reverse: true }), ["c1", "g2", "invalid"]);
  assert.deepEqual(original, before);
  assert.equal(resolvedCycleShading(selected, "c1")!.reverse, true);
  assert.equal(resolvedCycleShading(selected, "c3")!.reverse, false);
  const reset = resetCycleShading(selected, ["c1"])!;
  assert.equal(resolvedCycleShading(reset, "c1")!.enabled, false);
  assert.equal(resolvedCycleShading(reset, "c1")!.cycle_end, 193);
  assert.equal(resolvedCycleShading(reset, "g2")!.enabled, true);
  assert.equal(resetCycleShading(selected, null), undefined);
  assert.equal(applyCycleShading(selected, config(), null).samples, undefined);
  const style = normalizePlotStyle({ cycle_shading: selected } as never);
  assert.deepEqual(normalizePlotStyle(JSON.parse(JSON.stringify(style))).cycle_shading, selected);
  assert.equal(normalizePlotStyle(undefined).cycle_shading, undefined);
});

test("mapping key is bounded and multiline; reference annotations/shapes are retained", () => {
  const layout = { margin: { t: 10, l: 30 }, annotations: [{ text: "reference" }], shapes: [{ type: "line" }] } as Partial<Plotly.Layout>;
  assert.equal(withCycleShadingKey(layout, []), layout);
  const traces = Array.from({ length: 6 }, (_, i) => ({ cellxplorer_cycle_shading: config({ cycle_end: 193 + i, mode: "both", reverse: true, progression: "stepped" }) })) as Plotly.Data[];
  const result = withCycleShadingKey(layout, traces);
  assert.equal(result.shapes, layout.shapes);
  assert.equal(result.annotations![0], layout.annotations![0]);
  const text = result.annotations![1].text!;
  assert.match(text, /<br>L 30→75%, S 35→90%<br>reversed · 5 bands/);
  assert.match(text, /\+3 other fixed mappings/);
  assert.equal(text.split("<br>").length, 10);
  assert.ok(text.split("<br>").every((line) => line.length <= 42));
  assert.equal(layout.margin!.t, 10);
  const preview = seriesAppearancePreviewLayout(result as Record<string, unknown>, 620, 465);
  assert.equal(preview.margin.t, result.margin!.t, "preview fitting retains the key's required top space");
  assert.equal(preview.annotations, result.annotations);
  assert.equal(preview.shapes, result.shapes);
  assert.equal(preview.showlegend, false);
});
