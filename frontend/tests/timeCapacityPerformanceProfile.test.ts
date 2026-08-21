import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimeCapacityPerformanceProfiler,
  startTimeCapacityRecording,
  stopTimeCapacityRecording,
  timeCapacityProfileResultIsCurrent,
  timeCapacityResolvedCellCount,
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
  profiler.frontendPrepared(requestId, {
    resolvedCellCount: 3,
    plotlyTraceCount: 3,
  });
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
      response_source: "http",
      result_cache: "miss",
      raw_access: "indexed",
      http_round_trip_ms: 12,
      frontend_result_to_plot_props_ms: 3,
      plotly_update_ms: 4,
      total_interaction_ms: 12,
      returned_points: 42,
      resolved_cell_count: 3,
      trace_count: 3,
    },
  ]);
});

test("progressive profiling records bounded stream and Plotly boundaries", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  profiler.begin("stream", context);
  profiler.streamStart("stream", { streamRequestId: "wire-1", totalSeries: 2 });
  timer.advance(2);
  profiler.streamSeries("stream", { index: 1, totalSeries: 2, bytes: 128 });
  profiler.partialPlotlyComplete("stream");
  profiler.plotlyInitialized("stream", { remounted: true });
  timer.advance(3);
  profiler.streamSeries("stream", { index: 2, totalSeries: 2, bytes: 256 });
  profiler.streamComplete("stream");
  profiler.response("stream", {
    profile_version: 1,
    request_id: "stream",
    result_cache: "miss",
    raw_access: "indexed",
  }, 10);
  profiler.frontendPrepared("stream", { resolvedCellCount: 2, plotlyTraceCount: 2 });
  profiler.plotlyComplete("stream");
  const record = profiler.records()[0];
  assert.equal(record?.mode, "ndjson");
  assert.equal(record?.stream_request_id, "wire-1");
  assert.equal(record?.stream_total_series, 2);
  assert.deepEqual(record?.stream_series?.map((series) => series.index), [1, 2]);
  assert.equal(record?.partial_plotly_completions, 1);
  assert.equal(record?.partial_update_count, 1);
  assert.equal(record?.plotly_remount_count, 1);
  assert.equal(record?.selected_plot_strategy, "react_plotly_react");
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
  profiler.frontendPrepared("request-1", {
    resolvedCellCount: 1,
    plotlyTraceCount: 1,
  });
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
  profiler.frontendPrepared("old", { resolvedCellCount: 1, plotlyTraceCount: 1 });
  profiler.plotlyComplete("old");
  profiler.cancel("new");
  assert.deepEqual(profiler.records(), []);
});

test("a real backend digest does not invalidate the current frontend query identity", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  const frontendQuerySignature = JSON.stringify({ selection: ["replicate:4"], points: 4000 });
  const backendDataSignature = "analysis-cache-sha256:distinct-identity";

  assert.equal(
    timeCapacityProfileResultIsCurrent(
      frontendQuerySignature,
      frontendQuerySignature,
      { data_signature: backendDataSignature },
      false,
    ),
    true,
  );
  profiler.begin("real-http", context);
  profiler.response(
    "real-http",
    {
      profile_version: 1,
      request_id: "real-http",
      result_cache: "miss",
      raw_access: "indexed",
    },
    8,
  );
  profiler.frontendPrepared("real-http", { resolvedCellCount: 1, plotlyTraceCount: 2 });
  profiler.plotlyComplete("real-http");
  assert.equal(profiler.records().length, 1);
});

test("React Query memory hits do not inherit prior HTTP profiling facts", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();

  profiler.begin("server-miss", context);
  profiler.response(
    "server-miss",
    {
      profile_version: 1,
      request_id: "server-miss",
      result_cache: "miss",
      raw_access: "indexed",
      backend_compute_ms: 25,
      response_bytes: 900,
      resolved_cell_count: 2,
    },
    40,
  );
  profiler.frontendPrepared("server-miss", { resolvedCellCount: 2, plotlyTraceCount: 4 });
  profiler.plotlyComplete("server-miss");

  profiler.begin("memory-hit", context);
  profiler.memoryCacheHit("memory-hit");
  profiler.frontendPrepared("memory-hit", { resolvedCellCount: 2, plotlyTraceCount: 4 });
  profiler.plotlyComplete("memory-hit");

  const record = profiler.records()[1];
  assert.equal(record?.response_source, "react_query_memory");
  assert.equal(record?.result_cache, "unknown");
  assert.equal(record?.raw_access, "not_applicable");
  assert.equal(record?.http_round_trip_ms, 0);
  assert.equal(record?.backend_compute_ms, undefined);
  assert.equal(record?.response_bytes, undefined);
  assert.equal(record?.resolved_cell_count, 2);
});

test("resolved Cells and Plotly traces remain separate from selection entries", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  assert.equal(
    timeCapacityResolvedCellCount([
      { cell_id: 11 },
      { cell_id: 11 },
      { cell_id: 12 },
    ]),
    2,
  );
  profiler.begin("multi-cell", { ...context, selection_count: 1 });
  profiler.response("multi-cell", {
    profile_version: 1,
    request_id: "multi-cell",
    result_cache: "hit",
    raw_access: "not_applicable",
  }, 0);
  profiler.frontendPrepared("multi-cell", {
    resolvedCellCount: 2,
    plotlyTraceCount: 6,
  });
  profiler.plotlyComplete("multi-cell");
  const record = profiler.records()[0];
  assert.equal(record?.selection_count, 1);
  assert.equal(record?.resolved_cell_count, 2);
  assert.equal(record?.trace_count, 6);
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

test("in-app start resets an older capture and enables a fresh recording", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  profiler.enable();
  finish(profiler, timer, "old");
  assert.equal(profiler.records().length, 1);

  startTimeCapacityRecording(profiler);

  assert.equal(profiler.isEnabled(), true);
  assert.deepEqual(profiler.records(), []);
  finish(profiler, timer, "fresh");
  assert.deepEqual(profiler.records().map((record) => record.request_id), ["fresh"]);
});

test("stop disables recording while preserving the exact bounded export", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  startTimeCapacityRecording(profiler);
  finish(profiler, timer, "completed");
  const recordsBeforeStop = profiler.records();

  const exported = stopTimeCapacityRecording(profiler, new Date(2026, 7, 21, 15, 4, 5));

  assert.equal(profiler.isEnabled(), false);
  assert.deepEqual(profiler.records(), recordsBeforeStop);
  assert.equal(exported.recordCount, recordsBeforeStop.length);
  assert.equal(exported.filename, "cellxplorer-time-capacity-profile-20260821-150405.json");
  assert.equal(exported.payload, JSON.stringify(recordsBeforeStop, null, 2));
  assert.deepEqual(JSON.parse(exported.payload), recordsBeforeStop);
});

test("zero-record stop is deterministic and non-throwing", () => {
  const profiler = createTimeCapacityPerformanceProfiler();
  startTimeCapacityRecording(profiler);

  const exported = stopTimeCapacityRecording(profiler, new Date(2026, 0, 2, 3, 4, 5));

  assert.equal(profiler.isEnabled(), false);
  assert.equal(exported.recordCount, 0);
  assert.equal(exported.payload, "[]");
  assert.equal(exported.filename, "cellxplorer-time-capacity-profile-20260102-030405.json");
});

test("profiler snapshots notify the Debug surface without stopping when it is not mounted", () => {
  const timer = clock();
  const profiler = createTimeCapacityPerformanceProfiler(timer.now);
  const snapshots: Array<{ enabled: boolean; completedRecords: number }> = [];
  const unsubscribe = profiler.subscribe(() => snapshots.push(profiler.getSnapshot()));

  profiler.enable();
  finish(profiler, timer, "while-closed");
  assert.deepEqual(profiler.getSnapshot(), { enabled: true, completedRecords: 1 });
  assert.deepEqual(snapshots, [
    { enabled: true, completedRecords: 0 },
    { enabled: true, completedRecords: 1 },
  ]);

  unsubscribe();
  profiler.disable();
});
