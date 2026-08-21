import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTimeCapacityProgress,
  parseTimeCapacityStreamEvent,
  timeCapacityProgressCue,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityStreaming.ts";

const trace = {
  cell_id: 1,
  cell_name: "Cell 1",
  label: "Cell 1",
  group_id: null,
  group_name: null,
  excluded: false,
  active_mass_mg: null,
  nominal_capacity_mah: null,
  electrode_area_cm2: null,
  cycle: [1],
  time_s: [0],
  capacity_mah: [0],
  capacity_mah_g: [0],
  capacity_mah_cm2: [0],
  voltage_v: [3.5],
  current_ma: [1],
  phase: ["charge"],
  status: ["CC_Chg"],
  derivative_x: [],
  derivative_y: [],
} as const;

function start() {
  return parseTimeCapacityStreamEvent({
    type: "start",
    stream_version: 1,
    request_id: "stream-1",
    total_series: 2,
    data_signature: "result-key",
    source_data_signature: "source-key",
    cache_status: "miss",
  });
}

function series(index: number) {
  return parseTimeCapacityStreamEvent({
    type: "series",
    stream_version: 1,
    request_id: "stream-1",
    index,
    total_series: 2,
    trace,
  });
}

test("stream parser validates events and reducer assembles exact trace order", () => {
  const generation = "generation-a";
  let state = applyTimeCapacityProgress(null, generation, start());
  assert.equal(state?.status, "starting");
  assert.equal(timeCapacityProgressCue(state), "0 of 2 series loaded · calculating…");
  state = applyTimeCapacityProgress(state, generation, series(1));
  assert.equal(state?.status, "partial");
  assert.equal(state?.traces.length, 1);
  assert.equal(timeCapacityProgressCue(state), "1 of 2 series loaded · calculating…");
  state = applyTimeCapacityProgress(state, generation, series(2));
  state = applyTimeCapacityProgress(
    state,
    generation,
    parseTimeCapacityStreamEvent({
      type: "complete",
      stream_version: 1,
      request_id: "stream-1",
      total_series: 2,
      metadata: { type: "time_capacity", settings: {}, badges: [] },
    }),
  );
  assert.equal(state?.status, "complete");
  assert.equal(state?.result?.cell_traces.length, 2);
  assert.equal(state?.result?.cell_traces[0]?.cell_id, 1);
});

test("stale generations cannot update progressive state", () => {
  const state = applyTimeCapacityProgress(null, "generation-a", start());
  const staleSeries = applyTimeCapacityProgress(state, "generation-b", series(1));
  assert.equal(staleSeries, state);
});

test("partial state is discarded by a typed terminal error", () => {
  let state = applyTimeCapacityProgress(null, "generation-a", start());
  state = applyTimeCapacityProgress(state, "generation-a", series(1));
  state = applyTimeCapacityProgress(
    state,
    "generation-a",
    parseTimeCapacityStreamEvent({
      type: "error",
      stream_version: 1,
      request_id: "stream-1",
      error: { code: "compute_failed", message: "failed" },
    }),
  );
  assert.equal(state?.status, "error");
  assert.deepEqual(state?.traces, []);
  assert.equal(state?.error, "failed");
});

test("unknown events and out-of-order series fail closed", () => {
  assert.throws(() => parseTimeCapacityStreamEvent({ type: "future", stream_version: 1 }));
  const state = applyTimeCapacityProgress(
    applyTimeCapacityProgress(null, "generation-a", start()),
    "generation-a",
    series(1),
  );
  assert.throws(() => applyTimeCapacityProgress(state, "generation-a", series(1)));
});
