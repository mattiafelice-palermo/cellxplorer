import test from "node:test";
import assert from "node:assert/strict";
import { cycleEnergyBasis, energyUnavailableReasons, takeEnergyProvenance, withCycleEnergyNotice } from "../src/features/analyses/editor/families/cycles/cycleEnergyBasis.ts";
import type { EnergyProvenance } from "../src/api.ts";
import type * as Plotly from "plotly.js";

const provenance: EnergyProvenance = {
  charge: [{ basis: "calculated", reason: null, cumulative_basis: "calculated", cumulative_reason: null },
    { basis: "calculated", reason: null, cumulative_basis: "mixed", cumulative_reason: null }],
  discharge: [{ basis: "unavailable", reason: "negative net directional energy", cumulative_basis: "unavailable", cumulative_reason: "negative net directional energy" },
    { basis: "calculated", reason: null, cumulative_basis: "unavailable", cumulative_reason: "negative net directional energy" }],
};

test("energy basis distinguishes per-cycle recovery from an unavailable cumulative prefix", () => {
  assert.match(cycleEnergyBasis(provenance, "discharge_energy", 1), /calculated net ∫V dQ/);
  assert.match(cycleEnergyBasis(provenance, "cumulative_discharge_energy", 1), /unavailable.*negative net/);
  assert.match(cycleEnergyBasis(provenance, "energy_throughput", 1), /charge: mixed.*discharge: unavailable/);
  assert.equal(cycleEnergyBasis(provenance, "fec", 1), "");
  assert.equal(cycleEnergyBasis(undefined, "charge_energy", 0), "");
  assert.equal(cycleEnergyBasis(provenance, "charge_energy", 0).includes("discharge"), false);
  assert.deepEqual(energyUnavailableReasons(provenance, "energy_throughput"), ["discharge: negative net directional energy"]);
  assert.deepEqual(energyUnavailableReasons(provenance, "charge_energy"), []);
});

test("diagnostic filtering keeps energy basis aligned with retained scientific cycles", () => {
  assert.deepEqual(takeEnergyProvenance(provenance, [1])?.discharge, [provenance.discharge[1]]);
});

test("shared image and saved-plot layouts qualify only visible calculated energy", () => {
  const traces = [{ x: [1], y: [1], customdata: [["charge: calculated net ∫V dQ"]] }] as unknown as Plotly.Data[];
  assert.equal(withCycleEnergyNotice({}, traces, "charge_energy").annotations?.[0].text, "Calculated net energy ⓘ");
  assert.match(withCycleEnergyNotice({}, traces, "charge_energy").annotations?.[0].hovertext ?? "", /signed cell voltage/);
  assert.equal(withCycleEnergyNotice({}, traces, "fec").annotations, undefined);
  assert.equal(withCycleEnergyNotice({}, [{ ...traces[0], visible: "legendonly" }], "charge_energy").annotations, undefined);
  assert.equal(withCycleEnergyNotice({}, [{ ...traces[0], y: [null] }] as Plotly.Data[], "charge_energy").annotations, undefined);
  const existing: Partial<Plotly.Layout> = { annotations: [{ y: 1, yref: "paper", yshift: 12, text: "source qualification" }] };
  const qualified = withCycleEnergyNotice(existing, traces, "energy_throughput");
  assert.equal(qualified.annotations?.length, 2);
  assert.ok((qualified.annotations?.[1].yshift ?? 0) > 12);
  assert.equal(withCycleEnergyNotice({}, [{ x: [1, null], y: [1, 2], customdata: [["measured"], ["calculated net ∫V dQ"]] }] as Plotly.Data[], "charge_energy").annotations, undefined);
  assert.equal(cycleEnergyBasis(provenance, "energy_efficiency", 0, [{ basis: "measured", reason: null }]), "measured");
});
