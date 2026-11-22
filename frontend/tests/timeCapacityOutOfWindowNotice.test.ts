import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisSpec, TimeCapacityResult, TimeCapacityTrace } from "../src/api.ts";
import {
  computeTimeCapacityOutOfWindowNotice,
  selectTimeCapacityCellCycleSummaries,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityOutOfWindowNoticePolicy.ts";
import type { TimeCapacityConfig } from "../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx";

function baseConfig(overrides: Partial<TimeCapacityConfig> = {}): TimeCapacityConfig {
  return {
    x_axis: "time",
    time_unit: "min",
    display_mode: "consecutive",
    time_reference: "selected_range",
    stacked: false,
    current_left: "current_ma",
    current_right: "none",
    electrode_area_cm2: null,
    view: "voltage_current",
    derivative_phase: "both",
    derivative_specific: false,
    derivative_absolute_discharge: true,
    smoothing_window: 7,
    cycle_start: 481,
    cycle_end: 500,
    cycles: [],
    max_points_per_cell: 4000,
    voltage_channel: "voltage",
    voltage_channels: ["voltage"],
    ...overrides,
  };
}

function makeSpec(
  entries: AnalysisSpec["selection"]["entries"],
  exclusions: AnalysisSpec["selection"]["exclusions"] = [],
  hiddenGroupIds: number[] = [],
): AnalysisSpec {
  return {
    selection: {
      entries,
      exclusions,
      hidden_replicate_group_ids: hiddenGroupIds,
    },
    computation: {
      enabled_families: ["time_capacity"],
      cycle_pairing: "charge_discharge",
      time_capacity: baseConfig(),
    },
    presentation: {
      hidden_series_ids: [],
      hidden_analysis_segment_ids: [],
    },
  } as unknown as AnalysisSpec;
}

function makeTrace(cellId: number, points: number[]): TimeCapacityTrace {
  return {
    cell_id: cellId,
    cell_name: `Cell ${cellId}`,
    label: `Cell ${cellId}`,
    group_id: null,
    group_name: null,
    excluded: false,
    active_mass_mg: null,
    nominal_capacity_mah: null,
    electrode_area_cm2: null,
    cycle: points.map((_, idx) => 481 + idx),
    time_s: points.map((_, idx) => idx * 10),
    capacity_mah: points.map((_, idx) => idx * 0.5),
    capacity_mah_g: points.map((_, idx) => idx * 5),
    voltage_v: points,
    current_ma: points.map(() => 1.0),
    phase: points.map(() => "charge"),
    status: points.map(() => "CC Chg"),
    derivative_x: [],
    derivative_y: [],
  };
}

function makeResult(cellTraces: TimeCapacityTrace[]): TimeCapacityResult {
  return {
    computed_at: "2026-11-22T12:00:00Z",
    type: "time_capacity",
    parser_version: "1",
    calc_version: "1",
    current_parser_version: "1",
    current_calc_version: "1",
    settings: baseConfig(),
    cell_traces: cellTraces,
    badges: [],
  };
}

test("detects shorter-cycling cells hidden before a late cycle-aligned window", () => {
  const cells = [
    { id: 1, name: "Long Cell", total_cycles: 500 },
    { id: 2, name: "Short Alpha", total_cycles: 12 },
    { id: 3, name: "Short Gamma", total_cycles: 80 },
    { id: 4, name: "Short Beta", total_cycles: 35 },
  ];
  const entries = cells.map((c) => ({ kind: "cell" as const, ref_id: c.id }));
  const spec = makeSpec(entries);
  const selectedCellCycles = selectTimeCapacityCellCycleSummaries(entries, cells, []);

  const notice = computeTimeCapacityOutOfWindowNotice({
    spec,
    config: baseConfig({ cycle_start: 481, cycle_end: 500 }),
    selectedCellCycles,
    maxAvailableCycle: 500,
    result: makeResult([makeTrace(1, [3.5, 3.6, 3.7])]),
  });

  assert.ok(notice);
  assert.deepEqual(
    notice.cells.map((c) => c.id),
    [3, 4, 2],
  );
  assert.equal(notice.windowStart, 481);
  assert.equal(notice.windowEnd, 500);
  assert.deepEqual(notice.jumpRange, { start: 1, end: 20 });
  assert.equal(notice.dismissKey, "2,3,4");

  // Stepping back slightly while the same cells remain outside keeps dismissKey stable.
  const shiftedNotice = computeTimeCapacityOutOfWindowNotice({
    spec,
    config: baseConfig({ cycle_start: 470, cycle_end: 489 }),
    selectedCellCycles,
    maxAvailableCycle: 500,
    result: makeResult([makeTrace(1, [3.5, 3.6])]),
  });
  assert.equal(shiftedNotice?.dismissKey, notice.dismissKey);
});

test("returns null in continuous mode or when window begins at cycle 1", () => {
  const cells = [
    { id: 1, name: "Long", total_cycles: 500 },
    { id: 2, name: "Short", total_cycles: 25 },
  ];
  const entries = cells.map((c) => ({ kind: "cell" as const, ref_id: c.id }));
  const spec = makeSpec(entries);
  const selectedCellCycles = selectTimeCapacityCellCycleSummaries(entries, cells, []);

  assert.equal(
    computeTimeCapacityOutOfWindowNotice({
      spec,
      config: baseConfig({ time_reference: "test_start", cycle_start: 481, cycle_end: 500 }),
      selectedCellCycles,
      maxAvailableCycle: 500,
      result: makeResult([makeTrace(1, [3.5])]),
    }),
    null,
  );

  assert.equal(
    computeTimeCapacityOutOfWindowNotice({
      spec,
      config: baseConfig({ cycle_start: 1, cycle_end: 20 }),
      selectedCellCycles,
      maxAvailableCycle: 500,
      result: makeResult([makeTrace(1, [3.5]), makeTrace(2, [3.4])]),
    }),
    null,
  );
});

test("ignores excluded cells, empty-cycle cells, and cells already rendering finite points", () => {
  const cells = [
    { id: 1, name: "Long", total_cycles: 300 },
    { id: 2, name: "Excluded Short", total_cycles: 10 },
    { id: 3, name: "No Cycles Yet", total_cycles: 0 },
    { id: 4, name: "Stale Count But Plotted", total_cycles: 15 },
    { id: 5, name: "Hidden Group Cell", total_cycles: 18 },
    { id: 6, name: "Visible Group Cell", total_cycles: 22 },
  ];
  const groups = [
    { id: 10, cell_ids: [5] },
    { id: 11, cell_ids: [6] },
  ];
  const entries = [
    { kind: "cell" as const, ref_id: 1 },
    { kind: "cell" as const, ref_id: 2 },
    { kind: "cell" as const, ref_id: 3 },
    { kind: "cell" as const, ref_id: 4 },
    { kind: "replicate_group" as const, ref_id: 10 },
    { kind: "replicate_group" as const, ref_id: 11 },
  ];
  const spec = makeSpec(
    entries,
    [{ cell_id: 2, entry_kind: "cell", entry_ref_id: 2 }],
    [10],
  );
  const selectedCellCycles = selectTimeCapacityCellCycleSummaries(entries, cells, groups);

  const notice = computeTimeCapacityOutOfWindowNotice({
    spec,
    config: baseConfig({ cycle_start: 281, cycle_end: 300 }),
    selectedCellCycles,
    maxAvailableCycle: 300,
    result: makeResult([makeTrace(1, [3.5]), makeTrace(4, [3.6])]),
  });

  assert.ok(notice);
  assert.deepEqual(
    notice.cells.map((c) => c.id),
    [6],
  );
});

test("handles specific cycles list with earlier jump bounds", () => {
  const cells = [
    { id: 1, name: "Long", total_cycles: 200 },
    { id: 2, name: "Short", total_cycles: 40 },
  ];
  const entries = cells.map((c) => ({ kind: "cell" as const, ref_id: c.id }));
  const spec = makeSpec(entries);
  const selectedCellCycles = selectTimeCapacityCellCycleSummaries(entries, cells, []);

  const notice = computeTimeCapacityOutOfWindowNotice({
    spec,
    config: baseConfig({ cycles: [100, 120] }),
    selectedCellCycles,
    maxAvailableCycle: 200,
    result: makeResult([makeTrace(1, [3.5])]),
  });

  assert.ok(notice);
  assert.equal(notice.isSpecificCycles, true);
  assert.equal(notice.windowStart, 100);
  assert.equal(notice.windowEnd, 120);
  assert.deepEqual(notice.jumpRange, { start: 1, end: 20 });
});
