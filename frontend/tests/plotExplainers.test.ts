import assert from "node:assert/strict";
import test from "node:test";

import {
  getCycleQuantityExplainer,
  getTimeCapacityExplainer,
} from "../src/plotExplainers.ts";

test("cycle quantity explainers describe normalized capacity inputs and formula", () => {
  const explainer = getCycleQuantityExplainer("discharge_capacity", true);

  assert.equal(explainer.title, "Discharge capacity");
  assert.match(explainer.formula, /mAh\/g/);
  assert.match(explainer.formula, /active material mass/);
  assert.ok(explainer.requires.includes("active_material_mg"));
});

test("cycle quantity explainers include delta-v polarization percentage", () => {
  const explainer = getCycleQuantityExplainer("polarization_pct", false);

  assert.equal(explainer.title, "Polarization (% DeltaV)");
  assert.match(explainer.formula, /DeltaV/);
  assert.match(explainer.notes.join(" "), /charge and discharge/i);
});

test("time/capacity explainers describe specific capacity and current density", () => {
  const explainer = getTimeCapacityExplainer("capacity_mah_g", "current_density");

  assert.match(explainer.formula, /mAh\/g/);
  assert.match(explainer.secondaryFormula ?? "", /mA\/cm2/);
  assert.ok(explainer.requires.includes("electrode_area_cm2"));
});
