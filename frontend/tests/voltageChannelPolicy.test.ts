import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldShowVoltageChannelSelector,
  voltageChannelSelectorOptions,
  type VoltageChannelAvailability,
} from "../src/features/analyses/editor/policies/voltageChannelPolicy.ts";

function availability(
  overrides: Partial<Record<"working_potential" | "counter_potential", boolean>> = {}
): VoltageChannelAvailability {
  return {
    voltage: { available: true, label: "Cell voltage (V)", role: "cell" },
    working_potential: {
      available: overrides.working_potential ?? false,
      label: "Working potential vs ref (V)",
      role: "working_vs_reference",
    },
    counter_potential: {
      available: overrides.counter_potential ?? false,
      label: "Counter potential vs ref (V)",
      role: "counter_vs_reference",
    },
  };
}

test("an ordinary two-electrode source hides the selector entirely", () => {
  const options = voltageChannelSelectorOptions("voltage", availability());

  assert.deepEqual(options, [{ value: "voltage", label: "Cell voltage (V)" }]);
  assert.equal(shouldShowVoltageChannelSelector(options), false);
});

test("an available electrode potential shows the selector with the full, ordered option list", () => {
  const options = voltageChannelSelectorOptions(
    "voltage",
    availability({ working_potential: true })
  );

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("both electrode potentials available offer all three channels in primary-first order", () => {
  const options = voltageChannelSelectorOptions(
    "counter_potential",
    availability({ working_potential: true, counter_potential: true })
  );

  assert.deepEqual(
    options.map((option) => option.value),
    ["voltage", "working_potential", "counter_potential"]
  );
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("a saved plot pinned to a now-unavailable channel keeps that option instead of dropping it", () => {
  // The selection changed (or the source lost the channel) since the plot
  // was saved: working_potential is no longer available, but the plot's
  // persisted voltage_channel is still "working_potential".
  const options = voltageChannelSelectorOptions("working_potential", availability());

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  // The selector must still render so the user can see/change the pinned
  // (now-unavailable) selection rather than it silently vanishing.
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("counter_potential pinned but unavailable is retained the same way as working_potential", () => {
  const options = voltageChannelSelectorOptions("counter_potential", availability());

  assert.deepEqual(
    options.map((option) => option.value),
    ["voltage", "counter_potential"]
  );
});

test("no result yet (voltageChannels undefined) behaves like a two-electrode source", () => {
  const options = voltageChannelSelectorOptions("voltage", undefined);

  assert.deepEqual(options, [{ value: "voltage", label: "Cell voltage (V)" }]);
  assert.equal(shouldShowVoltageChannelSelector(options), false);
});

test("no result yet still retains a pinned electrode-potential selection rather than dropping it", () => {
  // A saved plot pinned to working_potential, opened before the live
  // Time/Capacity query has returned a result: the selector must still
  // show the pinned choice (using the fallback label) instead of silently
  // reverting the visible selection to "voltage" while data loads.
  const options = voltageChannelSelectorOptions("working_potential", undefined);

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});
