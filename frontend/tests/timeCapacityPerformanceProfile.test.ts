import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimeCapacityPerformanceProfiler,
  type TimeCapacityPerformanceContext,
} from "../src/features/analyses/editor/performance/timeCapacityPerformanceProfile.ts";

const context: TimeCapacityPerformanceContext = {
  analysis_id: 7,
  selection_count: 3,
  cycle_start: 1,
  cycle_end: 20,
  explicit_cycle_count: 0,
  view: "voltage_current",
  x_axis: "time",
  display_mode: "consecutive",
  max_points_per_cell: 1000,
  compact: true,
  precision: "standard",
};

function clock() {
  let value = 100;
  return {
    now: () => value,
    advance: (milliseconds: number) => {
      value += milliseconds;
    },
  };
}

function finish(
  profiler: ReturnType<typeof createTimeCapacityPerformanceProfiler>,
  timer: ReturnType<typeof clock>,
  requestId: string,
) {
  profiler.begin(requestId, context);
  timer.advance(5);
  profiler.response(
    requestId,
    {
      profile_version: 1,
      request_id: requestId,
      result_cache: "miss",
      raw_access: "indexed",
      returned_points: 42,
    },
    12,
  );
  timer.advance(3);
  profiler.frontendPrepared(requestId, 3);
  timer.advance(4);
  profiler.plotlyComplete(requestId);
}

test("disabled profiling is inert and does not retain records", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.begin("disabled", context);
  profiler.response("disabled", undefined, 10);
  profiler.frontendPrepared("disabled", 1);
  profiler.plotlyComplete("disabled");
  assert.deepEqual(profiler.records(), []);
  assert.equal(profiler.exportJson(), "[]");
});

test("one request produces one completed record with separated boundaries", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  finish(profiler, timer, "request-1");

  assert.deepEqual(profiler.records(), [
    {
      ...context,
      profile_version: 1,
      request_id: "request-1",
      started_at_ms: 100,
      placeholder_was_visible: false,
      result_cache: "miss",
      raw_access: "indexed",
      http_round_trip_ms: 12,
      frontend_result_to_plot_props_ms: 3,
      plotly_update_ms: 4,
      total_interaction_ms: 12,
      returned_points: 42,
      trace_count: 3,
    },
  ]);
});

test("placeholder visibility is recorded but cannot finish a request", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  profiler.begin("request-1", context);
  profiler.placeholderVisible("request-1", true);
  profiler.response("request-1", {
    profile_version: 1,
    request_id: "request-1",
    result_cache: "hit",
    raw_access: "not_applicable",
  }, 8);
  profiler.plotlyComplete("request-1");
  assert.deepEqual(profiler.records(), []);
  timer.advance(2);
  profiler.frontendPrepared("request-1", 1);
  profiler.plotlyComplete("request-1");
  assert.equal(profiler.records()[0]?.placeholder_was_visible, true);
});

test("superseded and aborted requests cannot finish or overwrite the current request", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  profiler.begin("old", context);
  profiler.response("old", {
    profile_version: 1,
    request_id: "old",
    result_cache: "miss",
    raw_access: "legacy",
  }, 20);
  profiler.begin("new", { ...context, cycle_end: 150 });
  profiler.frontendPrepared("old", 1);
  profiler.plotlyComplete("old");
  profiler.cancel("new");
  assert.deepEqual(profiler.records(), []);
});

test("completion is identity-bound and retention/reset/export are bounded and deterministic", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now, 2);
  profiler.enable();
  finish(profiler, timer, "one");
  finish(profiler, timer, "two");
  finish(profiler, timer, "three");
  assert.deepEqual(profiler.records().map((record) => record.request_id), ["two", "three"]);
  const exported = profiler.exportJson();
  assert.equal(exported, JSON.stringify(profiler.records(), null, 2));
  assert.deepEqual(context, {
    analysis_id: 7,
    selection_count: 3,
    cycle_start: 1,
    cycle_end: 20,
    explicit_cycle_count: 0,
    view: "voltage_current",
    x_axis: "time",
    display_mode: "consecutive",
    max_points_per_cell: 1000,
    compact: true,
    precision: "standard",
  });
  profiler.reset();
  assert.deepEqual(profiler.records(), []);
  assert.equal(profiler.exportJson(), "[]");
});
