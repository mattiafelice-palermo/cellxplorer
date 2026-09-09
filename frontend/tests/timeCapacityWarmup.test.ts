import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisSpec, TimeCapacityResult } from "../src/api.ts";
import { voltageChannelDataIdentity } from "../src/features/analyses/editor/policies/voltageChannelPolicy.ts";
import {
  timeCapacityRangeSpec, timeCapacityPreparationBody, timeCapacityPreparationUnsupportedReason,
  WARMUP_INTERACTION_EVENTS,
  navigationWarmupCanAdmit, NavigationWarmupSlots,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityWarmupPolicy.ts";

test("explicit activity pauses warming but pointer movement does not", () => {
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("click"));
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("pointerdown"));
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("wheel"));
  assert.ok(!WARMUP_INTERACTION_EVENTS.some(e => /move/.test(e)));
  assert.ok(!WARMUP_INTERACTION_EVENTS.some(e => e === ("focus" as string)));
});

test("one preparation batch remains occupied across generations until actual completion", () => {
  const slots = new NavigationWarmupSlots();
  const release = slots.acquire()!;
  assert.equal(slots.running, 1);
  assert.equal(slots.acquire(), null);
  release();
  assert.equal(slots.running, 0);
  const replacement = slots.acquire()!;
  release(); // A duplicate cleanup cannot release the replacement's slot.
  assert.equal(slots.acquire(), null);
  assert.equal(slots.running, 1);
  replacement();
  assert.equal(slots.running, 0);
});

test("admission waits for idle and the existing request to finish, then resumes", () => {
  assert.equal(navigationWarmupCanAdmit(1499, 0, false), false);
  assert.equal(navigationWarmupCanAdmit(1500, 0, false), true);
  assert.equal(navigationWarmupCanAdmit(5000, 0, true), false);
  assert.equal(navigationWarmupCanAdmit(5000, 4999, false), false);
  assert.equal(navigationWarmupCanAdmit(6500, 4999, false), true);
});

test("sweep source identity survives range signatures but changes with source bytes", () => {
  const result = {
    source_data_signature: "range-one", parser_version: "parser", calc_version: "calc",
    cell_traces: [{ cell_id: 1, source_descriptors: [
      { source_position: 0, source_hash: "original", status: "parsed" },
    ] }],
  } as unknown as TimeCapacityResult;
  const moved = { ...result, source_data_signature: "range-two" };
  assert.equal(voltageChannelDataIdentity(result), voltageChannelDataIdentity(moved));
  const changed = structuredClone(moved);
  changed.cell_traces[0].source_descriptors![0].source_hash = "changed";
  assert.notEqual(voltageChannelDataIdentity(result), voltageChannelDataIdentity(changed));
});

test("preparation ignores window and density without changing the recipe or requesting persistence", () => {
  const spec = {
    selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [1] },
    computation: { time_capacity: {
      cycle_start: 1, cycle_end: 3, cycles: [], max_points_per_cell: 4000,
      time_reference: "selected_range", display_mode: "consecutive", x_axis: "time", view: "voltage_current",
    } },
  } as unknown as AnalysisSpec;
  const original = JSON.stringify(spec);
  const moving = timeCapacityRangeSpec(
    spec, spec.computation.time_capacity!, { start: 5, end: 7 }, "moving",
  );
  const settled = timeCapacityRangeSpec(
    spec, spec.computation.time_capacity!, { start: 5, end: 7 }, "full",
  );
  assert.equal(moving.computation.time_capacity?.max_points_per_cell, 3000);
  assert.equal(settled.computation.time_capacity?.max_points_per_cell, 4000);
  const prepared = timeCapacityPreparationBody(spec, spec.computation.time_capacity!);
  const differentWindow = { ...moving.computation.time_capacity!, cycle_start: 100, cycle_end: 500 };
  assert.deepEqual(timeCapacityPreparationBody(spec, differentWindow), prepared);
  assert.deepEqual(prepared.spec.selection.exclusions, []);
  assert.deepEqual(Object.keys(prepared), ["spec"]);
  assert.equal(timeCapacityPreparationUnsupportedReason(spec, spec.computation.time_capacity!), "");
  for (const cfg of [
    { time_reference: "test_start" }, { cycles: [1, 3] }, { x_axis: "capacity_mah" },
    { view: "dq_dv" }, { voltage_channels: ["working_potential"] },
  ]) {
    assert.notEqual(timeCapacityPreparationUnsupportedReason(spec,
      { ...spec.computation.time_capacity!, ...cfg } as typeof differentWindow), "");
  }
  const filtered = structuredClone(spec);
  filtered.computation.protocol_filter = { excluded_segment_ids: ["segment"], only_segment_ids: [] };
  assert.notEqual(timeCapacityPreparationUnsupportedReason(filtered, spec.computation.time_capacity!), "");
  assert.equal(JSON.stringify(spec), original);
});
