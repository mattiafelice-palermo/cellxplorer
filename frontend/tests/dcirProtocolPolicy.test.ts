import assert from "node:assert/strict";
import test from "node:test";

import type { FileProtocol, ProtocolFamilyGroup, ProtocolSegment, ProtocolStep } from "../src/api.ts";
import {
  mapComparableProtocolStepNumbers,
} from "../src/features/analyses/editor/protocol/protocolComparability.ts";
import {
  dcirIgnoreEmptyRestPauseForSegment,
  dcirTargetFromSteps,
} from "../src/features/analyses/editor/families/dcir/dcirProtocolPolicy.ts";

function step(overrides: Partial<ProtocolStep> = {}): ProtocolStep {
  return {
    number: 1,
    type_id: 1,
    type: "Rest",
    direction: "rest",
    current_ma: null,
    c_rate: null,
    c_rate_source: null,
    target_voltage_v: null,
    stop_voltage_v: null,
    stop_current_ma: null,
    stop_c_rate: null,
    stop_c_rate_source: null,
    time_limit_s: 30,
    record_interval_s: null,
    record_voltage_delta_v: null,
    protection_upper_v: null,
    protection_lower_v: null,
    loop_start_step: null,
    loop_count: null,
    summary: "Rest",
    facts: [],
    conditions: [],
    ...overrides,
  };
}

function protocol(signature: string, steps: ProtocolStep[]): FileProtocol {
  return {
    signature,
    n_steps: steps.length,
    n_executable_steps: steps.filter((item) => item.direction !== "control").length,
    steps,
    groups: [],
    summary: {
      charge_cutoffs: [],
      discharge_cutoffs: [],
      protection_windows: [],
      record_intervals_s: [],
    },
    warnings: [],
  };
}

function group(ignore_empty_rest_pause: boolean): ProtocolFamilyGroup {
  return {
    id: "grouped-dcir",
    name: "Grouped DCIR",
    family_signatures: ["reference", "candidate"],
    reference_signature: "reference",
    comparison_mode: "custom",
    comparison_dimensions: {
      structure: true,
      termination: false,
      rates: true,
      timing: true,
      voltage: false,
      recording: false,
    },
    ignore_empty_rest_pause,
  };
}

function segment(): ProtocolSegment {
  return {
    id: "segment-1",
    name: "DCIR",
    targets: [
      { protocol_signature: "reference", step_indices: [1, 2] },
      { protocol_signature: "candidate", step_indices: [1, 3] },
    ],
  };
}

test("group-authorized empty pauses are skipped for DCIR adjacency", () => {
  const reference = protocol("reference", [
    step({ number: 1, time_limit_s: 30 }),
    step({ number: 2, type_id: 2, type: "Discharge", direction: "discharge", current_ma: 10, time_limit_s: 30 }),
  ]);
  const candidate = protocol("candidate", [
    step({ number: 1, time_limit_s: 30 }),
    step({ number: 2, type: "Pause", time_limit_s: null }),
    step({ number: 3, type_id: 2, type: "Discharge", direction: "discharge", current_ma: 10, time_limit_s: 30 }),
  ]);
  const families = [
    { signature: reference.signature, protocol: reference },
    { signature: candidate.signature, protocol: candidate },
  ];

  assert.deepEqual(
    mapComparableProtocolStepNumbers(reference, candidate, [1, 2], { ignoreEmptyRestPause: true }),
    [1, 3],
  );
  assert.equal(dcirIgnoreEmptyRestPauseForSegment(segment(), families, [group(true)]), true);
  assert.ok(dcirTargetFromSteps({ signature: candidate.signature, protocol: candidate }, [1, 3], { ignoreEmptyRestPause: true }));
  assert.equal(dcirTargetFromSteps({ signature: candidate.signature, protocol: candidate }, [1, 3]), null);
});

test("configured pauses and disabled or conflicting policies are never skipped", () => {
  const candidate = protocol("candidate", [
    step({ number: 1, time_limit_s: 30 }),
    step({ number: 2, type: "Pause", time_limit_s: 5 }),
    step({ number: 3, type_id: 2, type: "Discharge", direction: "discharge", current_ma: 10, time_limit_s: 30 }),
  ]);
  const reference = protocol("reference", [
    step({ number: 1, time_limit_s: 30 }),
    step({ number: 2, type_id: 2, type: "Discharge", direction: "discharge", current_ma: 10, time_limit_s: 30 }),
  ]);
  const families = [
    { signature: reference.signature, protocol: reference },
    { signature: candidate.signature, protocol: candidate },
  ];

  assert.equal(dcirIgnoreEmptyRestPauseForSegment(segment(), families, [group(true)]), true);
  assert.equal(dcirTargetFromSteps({ signature: candidate.signature, protocol: candidate }, [1, 3], { ignoreEmptyRestPause: true }), null);
  assert.equal(dcirIgnoreEmptyRestPauseForSegment(segment(), families, [group(false)]), false);

  const conflicting = [group(true), { ...group(false), id: "grouped-dcir-2" }];
  assert.equal(dcirIgnoreEmptyRestPauseForSegment(segment(), families, conflicting), false);
});
