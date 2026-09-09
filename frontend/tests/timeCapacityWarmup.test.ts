import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisSpec, TimeCapacityResult } from "../src/api.ts";
import { voltageChannelDataIdentity } from "../src/features/analyses/editor/policies/voltageChannelPolicy.ts";
import {
  TimeCapacityWarmupSweep, timeCapacityRangeSpec, timeCapacityWarmupBody,
  WARMUP_INTERACTION_EVENTS,
  navigationWarmupCanAdmit, NavigationWarmupSlots,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityWarmupPolicy.ts";

test("finite sweep covers both production resolutions at every valid start", () => {
  const sweep = new TimeCapacityWarmupSweep(3, 7, 4);
  const tasks = Array.from({ length: 10 }, () => sweep.next()!);
  assert.deepEqual(tasks.filter(t => t.resolution === "full").map(t => t.range), [
    { start: 4, end: 6 }, { start: 5, end: 7 }, { start: 1, end: 3 },
    { start: 2, end: 4 }, { start: 3, end: 5 },
  ]);
  assert.equal(new Set(tasks.map(t => `${t.range.start}:${t.resolution}`)).size, 10);
  assert.equal(sweep.next(), null);
  assert.equal(sweep.next(), null);
});

test("empty and invalid extents do not start work; huge extents need no queue", () => {
  for (const [width, maximum] of [[0, 0], [4, 3], [1, NaN], [1.5, 8]]) {
    assert.equal(new TimeCapacityWarmupSweep(width, maximum, 1).next(), null);
  }
  const sweep = new TimeCapacityWarmupSweep(2, 1_000_000_000, 1);
  assert.deepEqual(sweep.next()?.range, { start: 1, end: 2 });
  assert.equal(new TimeCapacityWarmupSweep(7, 7, 5).next()?.range.end, 7);
});

test("explicit activity pauses warming but pointer movement does not", () => {
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("click"));
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("pointerdown"));
  assert.ok(WARMUP_INTERACTION_EVENTS.includes("wheel"));
  assert.ok(!WARMUP_INTERACTION_EVENTS.some(e => /move/.test(e)));
  assert.ok(!WARMUP_INTERACTION_EVENTS.some(e => e === ("focus" as string)));
});

test("four shared slots remain occupied across generations until actual completion", () => {
  const slots = new NavigationWarmupSlots();
  const releases = Array.from({ length: 4 }, () => slots.acquire()!);
  assert.equal(slots.running, 4);
  assert.equal(slots.acquire(), null);
  releases[2]();
  assert.equal(slots.running, 3);
  const replacement = slots.acquire()!;
  assert.equal(slots.running, 4);
  releases[2](); // A duplicate cleanup cannot release the replacement's slot.
  assert.equal(slots.acquire(), null);
  releases.forEach(release => release());
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

test("warmup uses production range/density and persists without changing the recipe", () => {
  const spec = {
    selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [1] },
    computation: { time_capacity: {
      cycle_start: 1, cycle_end: 3, cycles: [], max_points_per_cell: 4000,
      time_reference: "selected_range", display_mode: "consecutive", x_axis: "time",
    } },
  } as unknown as AnalysisSpec;
  const original = JSON.stringify(spec);
  const moving = timeCapacityWarmupBody(timeCapacityRangeSpec(
    spec, spec.computation.time_capacity!, { start: 5, end: 7 }, "moving",
  ));
  const settled = timeCapacityWarmupBody(timeCapacityRangeSpec(
    spec, spec.computation.time_capacity!, { start: 5, end: 7 }, "full",
  ));
  assert.equal(moving.spec.computation.time_capacity?.max_points_per_cell, 3000);
  assert.equal(settled.spec.computation.time_capacity?.max_points_per_cell, 4000);
  assert.equal(moving.spec.computation.time_capacity?.cycle_start, 5);
  assert.equal(moving.spec.computation.time_capacity?.time_reference, "selected_range");
  assert.deepEqual(moving.spec.selection.exclusions, []);
  assert.equal(moving.background, true);
  assert.equal(moving.persist, true);
  assert.equal(moving.viewport_width, 1200);
  assert.ok(!("job_token" in moving));
  assert.equal(JSON.stringify(spec), original);
});
