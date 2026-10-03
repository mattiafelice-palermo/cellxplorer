import assert from "node:assert/strict";
import test from "node:test";
import type { RateCapabilityComputationSpec } from "../src/api.ts";
import {
  rateCapabilityEvidenceMessages,
  rateCapabilityNoMatchGuidance,
  rateCapabilityLimits,
  type RateCapabilityGuidanceCell,
} from "../src/features/analyses/editor/families/rate-capability/rateCapabilityGuidance.ts";

const config: RateCapabilityComputationSpec = {
  min_points: 5, cutoff_tolerance_v: 0.05, rate_tolerance_fraction: 0.04,
  families: Object.fromEntries(["charge", "discharge"].map((family) => [family, {
    enabled: true, charge_structure: "auto", fixed_rate_c: null, selected_rates_c: [],
    monotonic: "prefer", scaffold: "prefer",
  }])) as RateCapabilityComputationSpec["families"],
};

function cell(): RateCapabilityGuidanceCell {
  return {
    cell_id: 1, cell_name: "Example",
    families: { charge: { status: "not_detected" }, discharge: { status: "not_detected" } },
    recognition_evidence: {
      missing_nominal_rate_step_count: 0,
      families: {
        charge: { execution_count: 3, completed_rate_count: 3, unverified_voltage_execution_count: 0 },
        discharge: { execution_count: 0, completed_rate_count: 0, unverified_voltage_execution_count: 0 },
      },
    },
  };
}

test("no-match help explains the supported pattern and configured minimum without guessing a cause", () => {
  const message = rateCapabilityNoMatchGuidance(config);
  assert.match(message, /at least 5 distinct/);
  assert.match(message, /opposite direction stays fixed/);
  assert.match(message, /recognition rules.*protocol steps/);
  assert.doesNotMatch(message, /nominal capacity|corrupt|incomplete/);
});

test("completed-rate diagnostics use current limits and do not claim a compatible sweep", () => {
  const messages = rateCapabilityEvidenceMessages([cell()], config);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /3 distinct rates have verified completed pairs/);
  assert.match(messages[0], /minimum is 5/);
  assert.match(messages[0], /4% tolerance/);
  assert.match(messages[0], /0.01C/);
  assert.deepEqual(rateCapabilityEvidenceMessages([cell()], { ...config, min_points: 3 }), []);
});

test("missing nominal capacity requires explicit backend conversion evidence", () => {
  const item = cell();
  item.recognition_evidence = undefined;
  assert.deepEqual(rateCapabilityEvidenceMessages([item], config), []);
  item.recognition_evidence = cell().recognition_evidence;
  item.recognition_evidence!.missing_nominal_rate_step_count = 2;
  const message = rateCapabilityEvidenceMessages([item], config)[0];
  assert.match(message, /2 current-controlled protocol steps/);
  assert.match(message, /Set nominal capacity/);
  assert.match(message, /Steps with declared C-rates can already be used/);
});

test("unverified completion reports configured cutoff tolerance without diagnosing why a step ended", () => {
  const item = cell();
  item.recognition_evidence!.families.charge.completed_rate_count = 0;
  item.recognition_evidence!.families.charge.unverified_voltage_execution_count = 2;
  const messages = rateCapabilityEvidenceMessages([item], config);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /voltage completion could not be verified/);
  assert.match(messages[0], /0.05 V/);
  assert.match(messages[0], /does not establish why they ended/);
  assert.doesNotMatch(messages[0], /minimum|too early|corrupt/);
});

test("unexecuted protocols do not produce a zero-rate diagnosis", () => {
  const item = cell();
  item.recognition_evidence!.families.charge = { execution_count: 0, completed_rate_count: 0, unverified_voltage_execution_count: 0 };
  assert.deepEqual(rateCapabilityEvidenceMessages([item], config), []);
});

test("matched or disabled directions do not receive no-match diagnostics", () => {
  const matched = cell();
  matched.families.charge.status = "matched";
  assert.deepEqual(rateCapabilityEvidenceMessages([matched], config), []);
  const disabled = { ...config, families: { ...config.families, charge: { ...config.families.charge, enabled: false } } };
  assert.deepEqual(rateCapabilityEvidenceMessages([cell()], disabled), []);
});

test("help follows backend lower bounds and leaves scientific evidence unchanged", () => {
  assert.deepEqual(rateCapabilityLimits({ ...config, min_points: 1, cutoff_tolerance_v: 0, rate_tolerance_fraction: 0 }), {
    minimum: 2, voltage: 0.001, ratePercent: 0.1,
  });
  const items = [cell()];
  const original = structuredClone(items);
  rateCapabilityEvidenceMessages(items, config);
  assert.deepEqual(items, original);
});
