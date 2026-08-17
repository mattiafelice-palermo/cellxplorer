import assert from "node:assert/strict";
import test from "node:test";

import type { FileProtocol, ProtocolGroup, ProtocolStep } from "../src/api.ts";
import {
  compareProtocolFamilies,
  isEmptyRestPauseStep,
  mapComparableProtocolStepNumbers,
  normalizeProtocolRate,
  WORKFLOW_COMPARISON_DIMENSIONS,
  type ProtocolComparisonDimensions,
} from "../src/features/analyses/editor/protocol/protocolComparability.ts";

const group = (repeat_count = 2): ProtocolGroup => ({
  id: "loop",
  kind: "repeated_block",
  label: "Loop",
  start_step: 1,
  end_step: 3,
  repeat_count,
  control_step: 3,
  depth: 0,
  step_numbers: [1, 2],
  all_step_numbers: [1, 2, 3],
  children: [],
  summary: `steps 1-3 x${repeat_count}`,
});

const step = (overrides: Partial<ProtocolStep> = {}): ProtocolStep => ({
  number: 1,
  type_id: 2,
  type: "CC discharge",
  direction: "discharge",
  current_ma: 10,
  c_rate: 0.5,
  c_rate_source: "explicit",
  target_voltage_v: null,
  stop_voltage_v: 2,
  stop_current_ma: 1,
  stop_c_rate: 0.05,
  stop_c_rate_source: "inferred",
  time_limit_s: 10,
  record_interval_s: 1,
  record_voltage_delta_v: null,
  protection_upper_v: 4.5,
  protection_lower_v: 2,
  loop_start_step: null,
  loop_count: null,
  summary: "CC discharge C/2 to 2 V",
  facts: [],
  conditions: [],
  ...overrides,
});

const protocol = (overrides: Partial<FileProtocol> = {}): FileProtocol => ({
  signature: "same-signature",
  n_steps: 3,
  n_executable_steps: 2,
  steps: [step(), step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: 40 })],
  groups: [group()],
  nominal_capacity_mah: 20,
  nominal_capacity_inferred: false,
  summary: {
    charge_cutoffs: [],
    discharge_cutoffs: [{ voltage_v: 2, step_count: 1 }],
    protection_windows: [{ lower_v: 2, upper_v: 4.5 }],
    record_intervals_s: [1],
  },
  warnings: [],
  ...overrides,
});

function row(result: ReturnType<typeof compareProtocolFamilies>, key: string) {
  const found = result.rows.find((item) => item.key === key);
  assert.ok(found, `missing comparison row: ${key}`);
  return found;
}

test("workflow mode ignores voltage cutoffs while strict mode reports them", () => {
  const reference = protocol();
  const candidate = protocol({
    signature: "different-voltage",
    steps: [
      step(),
      step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: 40, stop_voltage_v: 2.8, protection_lower_v: 2.8 }),
    ],
  });

  const workflow = compareProtocolFamilies(reference, candidate, "workflow");
  assert.equal(workflow.comparable, true);
  assert.equal(row(workflow, "voltage").status, "ignored");

  const strict = compareProtocolFamilies(reference, candidate, "strict");
  assert.equal(strict.comparable, false);
  assert.equal(strict.strictIdentityMatch, false);
  assert.equal(row(strict, "voltage").status, "different");
});

test("capacity-scaled currents do not make rate-controlled families different", () => {
  const reference = protocol();
  const candidate = protocol({
    steps: [
      step({ current_ma: 20, stop_current_ma: 2 }),
      step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: 40 }),
    ],
  });

  const result = compareProtocolFamilies(reference, candidate, "strict");
  assert.equal(result.comparable, true);
  assert.equal(row(result, "rates").status, "same");
});

test("C-rate comparison uses the backend semantic normalization boundary", () => {
  assert.equal(normalizeProtocolRate(1 / 3), normalizeProtocolRate(0.333), "C/3 precision is equivalent");
  assert.notEqual(normalizeProtocolRate(1 / 3), normalizeProtocolRate(0.35), "C/3 and 0.35C stay distinct");
  assert.notEqual(normalizeProtocolRate(0.10), normalizeProtocolRate(0.119), "small rates do not use an absolute 0.02 window");

  const equivalent = compareProtocolFamilies(
    protocol({ steps: [step({ c_rate: 1 / 3 }), protocol().steps[1]] }),
    protocol({ steps: [step({ c_rate: 0.333 }), protocol().steps[1]] }),
    "workflow",
  );
  assert.equal(row(equivalent, "rates").status, "same");

  const distinct = compareProtocolFamilies(
    protocol({ steps: [step({ c_rate: 1 / 3 }), protocol().steps[1]] }),
    protocol({ steps: [step({ c_rate: 0.35 }), protocol().steps[1]] }),
    "workflow",
  );
  assert.equal(row(distinct, "rates").status, "different");
});

test("custom mode can opt voltage back into the comparison", () => {
  const reference = protocol();
  const candidate = protocol({
    signature: "different-voltage",
    steps: [
      step(),
      step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: 40, stop_voltage_v: 2.8, protection_lower_v: 2.8 }),
    ],
  });
  const custom: ProtocolComparisonDimensions = {
    ...WORKFLOW_COMPARISON_DIMENSIONS,
    voltage: true,
  };

  const result = compareProtocolFamilies(reference, candidate, "custom", custom);
  assert.equal(result.comparable, false);
  assert.equal(row(result, "voltage").status, "different");
  assert.equal(row(result, "recording").status, "ignored");
});

test("workflow mode detects a changed loop structure", () => {
  const result = compareProtocolFamilies(
    protocol(),
    protocol({ signature: "different-loop", groups: [group(3)] }),
    "workflow",
  );

  assert.equal(result.comparable, false);
  assert.equal(row(result, "structure").status, "different");
  assert.notEqual(row(result, "structure").reference, row(result, "structure").candidate);
});

test("termination conditions are separate from workflow structure", () => {
  const condition = {
    expression: "DischargeAh",
    name: "capacity",
    value: 1,
    comparator_id: 2,
    jump_step: 2,
  };
  const reference = protocol({
    steps: [step({ conditions: [condition] }), protocol().steps[1]],
  });
  const changedValue = protocol({
    steps: [step({ conditions: [{ ...condition, value: 2 }] }), protocol().steps[1]],
  });
  const changedJump = protocol({
    steps: [step({ conditions: [{ ...condition, jump_step: 1 }] }), protocol().steps[1]],
  });

  const workflow = compareProtocolFamilies(reference, changedValue, "workflow");
  assert.equal(workflow.comparable, true);
  assert.equal(row(workflow, "structure").status, "same");
  assert.equal(row(workflow, "termination").status, "ignored");

  const custom: ProtocolComparisonDimensions = {
    ...WORKFLOW_COMPARISON_DIMENSIONS,
    termination: true,
  };
  const changedValueResult = compareProtocolFamilies(reference, changedValue, "custom", custom);
  const changedJumpResult = compareProtocolFamilies(reference, changedJump, "custom", custom);
  assert.equal(changedValueResult.comparable, false);
  assert.equal(row(changedValueResult, "structure").status, "same");
  assert.equal(row(changedValueResult, "termination").status, "different");
  assert.match(row(changedValueResult, "termination").reference, /S1 if DischargeAh \[capacity\] cmp#2 1, jump S2/);
  assert.match(row(changedValueResult, "termination").candidate, /S1 if DischargeAh \[capacity\] cmp#2 2, jump S2/);
  assert.equal(row(changedJumpResult, "termination").status, "different");

  const changedComparator = protocol({
    steps: [step({ conditions: [{ ...condition, comparator_id: 3 }] }), protocol().steps[1]],
  });
  const changedBinding = protocol({
    steps: [step({ conditions: [{ ...condition, global_user_id: 72, stores_as: "User2" }] }), protocol().steps[1]],
  });
  const changedComparatorResult = compareProtocolFamilies(reference, changedComparator, "custom", custom);
  const changedBindingResult = compareProtocolFamilies(reference, changedBinding, "custom", custom);
  assert.equal(row(changedComparatorResult, "termination").status, "different");
  assert.equal(row(changedBindingResult, "termination").status, "different");
  assert.match(row(changedComparatorResult, "termination").candidate, /cmp#3/);
  assert.match(row(changedBindingResult, "termination").candidate, /global#72, stores as User2/);

  const renumbered = protocol({
    steps: [
      step({ number: 10, conditions: [{ ...condition, jump_step: 20 }] }),
      { ...protocol().steps[1], number: 20 },
    ],
  });
  const renumberedResult = compareProtocolFamilies(reference, renumbered, "custom", custom);
  assert.equal(row(renumberedResult, "structure").status, "same");
  assert.equal(row(renumberedResult, "termination").status, "same");
});

test("rate schedule evidence preserves step order", () => {
  const second = step({ number: 2, c_rate: 0.25, stop_c_rate: 0.05 });
  const reference = protocol({ steps: [step({ c_rate: 0.5 }), second] });
  const candidate = protocol({ steps: [step({ c_rate: 0.25 }), { ...second, c_rate: 0.5 }] });
  const result = compareProtocolFamilies(reference, candidate, "workflow");

  assert.equal(row(result, "rates").status, "different");
  assert.match(row(result, "rates").reference, /S1 C\/2/);
  assert.match(row(result, "rates").candidate, /S1 C\/4/);
});

test("missing timing values are compared as missing, not as zero", () => {
  const result = compareProtocolFamilies(
    protocol(),
    protocol({
      signature: "missing-timing",
      steps: [
        step({ time_limit_s: null }),
        step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: null }),
      ],
    }),
    "workflow",
  );

  assert.equal(result.comparable, false);
  assert.equal(row(result, "timing").status, "different");
  assert.match(row(result, "timing").candidate, /Unavailable/);
});

test("declared protocol controls participate in their scientific comparison dimensions", () => {
  const terminationCustom: ProtocolComparisonDimensions = {
    ...WORKFLOW_COMPARISON_DIMENSIONS,
    termination: true,
  };
  const capacityChanged = compareProtocolFamilies(
    protocol(),
    protocol({ steps: [step({ capacity_limit_mah: 12 }), protocol().steps[1]] }),
    "custom",
    terminationCustom,
  );
  assert.equal(row(capacityChanged, "termination").status, "different");
  assert.match(row(capacityChanged, "termination").candidate, /capacity cutoff 12 mAh/);

  const timingChanged = compareProtocolFamilies(
    protocol(),
    protocol({ steps: [step({ hold_duration_s: 4, rest_duration_s: 8 }), protocol().steps[1]] }),
    "workflow",
  );
  assert.equal(row(timingChanged, "timing").status, "different");
  assert.match(row(timingChanged, "timing").candidate, /hold 4 s; rest 8 s/);

  const redundantRestStorage = compareProtocolFamilies(
    protocol(),
    protocol({ steps: [step(), { ...protocol().steps[1], rest_duration_s: 40 }] }),
    "workflow",
  );
  assert.equal(row(redundantRestStorage, "timing").status, "same");
  const additionalRest = compareProtocolFamilies(
    protocol(),
    protocol({ steps: [step(), { ...protocol().steps[1], rest_duration_s: 80 }] }),
    "workflow",
  );
  assert.equal(row(additionalRest, "timing").status, "different");
  assert.match(row(additionalRest, "timing").candidate, /rest 80 s/);

  const nonLoopStorage = compareProtocolFamilies(
    protocol(),
    protocol({ steps: [step({ loop_body_inclusive: false }), protocol().steps[1]] }),
    "workflow",
  );
  assert.equal(row(nonLoopStorage, "structure").status, "same");

  const voltageChanged = compareProtocolFamilies(
    protocol({ signature: "gcpl-reference" }),
    protocol({ signature: "gcpl-candidate", steps: [step({ final_voltage_test_v: 3.1 }), protocol().steps[1]] }),
    "strict",
  );
  assert.equal(row(voltageChanged, "voltage").status, "different");
  assert.match(row(voltageChanged, "voltage").candidate, /final test 3.1 V/);
  assert.ok(voltageChanged.rows.some((item) => item.status === "different"));

  const loopChanged = compareProtocolFamilies(
    protocol({ steps: [step({ loop_count: 2, loop_body_inclusive: false }), protocol().steps[1]] }),
    protocol({ steps: [step({ loop_count: 2, loop_body_inclusive: true }), protocol().steps[1]] }),
    "workflow",
  );
  assert.equal(row(loopChanged, "structure").status, "different");
  assert.match(row(loopChanged, "structure").candidate, /inclusive/);
});

test("empty rest or pause detection fails closed for declared controls", () => {
  const empty = step({
    type: "Pause",
    direction: "rest",
    current_ma: null,
    c_rate: null,
    target_voltage_v: null,
    stop_voltage_v: null,
    stop_current_ma: null,
    stop_c_rate: null,
    time_limit_s: null,
    record_interval_s: null,
    record_voltage_delta_v: null,
    protection_upper_v: null,
    protection_lower_v: null,
  });
  assert.equal(isEmptyRestPauseStep(empty), true);
  assert.equal(isEmptyRestPauseStep({ ...empty, capacity_limit_mah: 1 }), false);
  assert.equal(isEmptyRestPauseStep({ ...empty, hold_duration_s: 2 }), false);
  assert.equal(isEmptyRestPauseStep({ ...empty, rest_duration_s: 2 }), false);
  assert.equal(isEmptyRestPauseStep({ ...empty, final_voltage_test_v: 3.2 }), false);
  assert.equal(isEmptyRestPauseStep({ ...empty, loop_body_inclusive: true }), false);
});

test("custom mode with no selected dimensions fails closed", () => {
  const result = compareProtocolFamilies(
    protocol(),
    protocol({ signature: "different-but-unchecked" }),
    "custom",
    {
      structure: false,
      termination: false,
      rates: false,
      timing: false,
      voltage: false,
      recording: false,
    },
  );

  assert.equal(result.comparable, false);
  assert.deepEqual(result.differingDimensions, []);
  assert.ok(result.rows.every((item) => item.status === "ignored"));
});

test("workflow can ignore empty rest or pause rows without treating them as executable steps", () => {
  const emptyPause = step({
    number: 2,
    type: "Pause",
    direction: "rest",
    current_ma: null,
    c_rate: null,
    target_voltage_v: null,
    stop_voltage_v: null,
    stop_current_ma: null,
    stop_c_rate: null,
    time_limit_s: null,
    record_interval_s: null,
    record_voltage_delta_v: null,
    protection_upper_v: null,
    protection_lower_v: null,
  });
  const reference = protocol({
    steps: [step({ number: 1 }), step({ number: 2, type_id: 4, type: "Rest", direction: "rest", c_rate: null, current_ma: null, stop_current_ma: null, stop_c_rate: null, time_limit_s: 40 })],
    groups: [],
  });
  const candidate = protocol({
    steps: [reference.steps[0], emptyPause, { ...reference.steps[1], number: 3 }],
    groups: [],
    signature: "empty-pause",
  });

  const strictWorkflow = compareProtocolFamilies(reference, candidate, "workflow");
  assert.equal(strictWorkflow.comparable, false);
  assert.equal(row(strictWorkflow, "structure").status, "different");
  assert.equal(row(strictWorkflow, "rates").status, "same");
  assert.equal(row(strictWorkflow, "timing").status, "same");

  const customWithTermination: ProtocolComparisonDimensions = {
    ...WORKFLOW_COMPARISON_DIMENSIONS,
    termination: true,
  };
  const customWithoutIgnoring = compareProtocolFamilies(
    reference,
    candidate,
    "custom",
    customWithTermination,
  );
  assert.equal(row(customWithoutIgnoring, "structure").status, "different");
  assert.equal(row(customWithoutIgnoring, "termination").status, "same");

  const ignoredWorkflow = compareProtocolFamilies(reference, candidate, "workflow", undefined, {
    ignoreEmptyRestPause: true,
  });
  assert.equal(ignoredWorkflow.comparable, true);
  assert.equal(ignoredWorkflow.rows.find((row) => row.key === "structure")?.status, "same");
  assert.equal(ignoredWorkflow.rows.find((row) => row.key === "timing")?.status, "same");

  assert.deepEqual(
    mapComparableProtocolStepNumbers(reference, candidate, [1, 2], { ignoreEmptyRestPause: true }),
    [1, 3],
  );
});
