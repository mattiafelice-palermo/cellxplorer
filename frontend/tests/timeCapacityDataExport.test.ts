import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisSpec, TimeCapacityResult, TimeCapacityTrace } from "../src/api.ts";
import { consecutiveTimeCapacityExportColumns } from "../src/features/analyses/editor/families/time-capacity/timeCapacityDataExport.ts";
import { DEFAULT_PLOT_STYLE } from "../src/features/analyses/editor/plotting/plotStyle.ts";

const config = {
  view: "voltage_current",
  x_axis: "time",
  time_unit: "min",
  display_mode: "consecutive",
  stacked: false,
  current_left: "current_ma",
  current_right: "none",
  electrode_area_cm2: null,
  voltage_channel: "voltage",
  voltage_channels: ["voltage"],
} as const;

function makeSpec(exclusions: AnalysisSpec["selection"]["exclusions"] = []): AnalysisSpec {
  return {
    selection: {
      entries: [
        { kind: "cell", ref_id: 1 },
        { kind: "cell", ref_id: 2 },
      ],
      exclusions,
      hidden_replicate_group_ids: [],
    },
    computation: { time_capacity: config },
    presentation: {
      hidden_series_ids: [],
      plot_styles: { time_capacity: structuredClone(DEFAULT_PLOT_STYLE) },
    },
  } as unknown as AnalysisSpec;
}

function makeTrace(cellId: number, name: string): TimeCapacityTrace {
  return {
    cell_id: cellId,
    cell_name: name,
    label: name,
    group_id: null,
    group_name: null,
    excluded: false,
    active_mass_mg: null,
    nominal_capacity_mah: 100,
    electrode_area_cm2: 2,
    cycle: [1, 1, 2],
    display_x: [0, 1, 2],
    time_s: [0, 60, 120],
    capacity_mah: [0, 1, 2],
    capacity_mah_g: [0, 1, 2],
    voltage_v: [3.1, 3.2, 3.3],
    current_ma: [10, 20, 30],
    phase: ["charge", "charge", "discharge"],
    status: [null, null, null],
    derivative_x: [],
    derivative_y: [],
    source_cycle: [4, 4, 5],
    sources: [{ position: 1, filename: `${name}.ndax`, hash: `${name}-hash` }],
    source_index: [0, 0, 0],
  };
}

function makeResult(): TimeCapacityResult {
  return {
    computed_at: "2026-09-03T00:00:00Z",
    type: "time_capacity",
    parser_version: "test",
    calc_version: "test",
    current_parser_version: "test",
    current_calc_version: "test",
    settings: config,
    cell_traces: [makeTrace(1, "Cell A"), makeTrace(2, "Cell B")],
    badges: [],
  } as unknown as TimeCapacityResult;
}

test("direct Time/Capacity export crops full-resolution values and applies live sample visibility", () => {
  const spec = makeSpec([{ cell_id: 2 }]);
  const before = structuredClone(spec);
  const columns = consecutiveTimeCapacityExportColumns(
    makeResult(),
    spec,
    config,
    DEFAULT_PLOT_STYLE,
    [0.5, 1.5],
  );

  assert.deepEqual(columns, [
    { header: "Cell", values: ["Cell A"] },
    { header: "Global cycle", values: [1] },
    { header: "Local cycle", values: [4] },
    { header: "Source position", values: [1] },
    { header: "Source file", values: ["Cell A.ndax"] },
    { header: "Source hash", values: ["Cell A-hash"] },
    { header: "Cell A | Time (min)", values: [1] },
    { header: "Cell A | Cell voltage (V)", values: [3.2] },
  ]);
  assert.deepEqual(spec, before);
});

test("direct Time/Capacity export includes configured stacked-current quantities", () => {
  const columns = consecutiveTimeCapacityExportColumns(
    { ...makeResult(), cell_traces: [makeTrace(1, "Cell A")] },
    makeSpec(),
    { ...config, stacked: true, current_left: "current_density", current_right: "c_rate" },
    DEFAULT_PLOT_STYLE,
    null,
  );

  assert.ok(columns);
  assert.deepEqual(columns.slice(-4), [
    { header: "Cell A Current density (mA/cm2) | Time (min)", values: [0, 1, 2] },
    { header: "Cell A Current density (mA/cm2) | Current density (mA/cm2)", values: [5, 10, 15] },
    { header: "Cell A C-rate (C) | Time (min)", values: [0, 1, 2] },
    { header: "Cell A C-rate (C) | C-rate (C)", values: [0.1, 0.2, 0.3] },
  ]);
});

test("multi-source results retain the established Plotly export fallback", () => {
  const trace = makeTrace(1, "Cell A");
  trace.source_descriptors = [
    {
      source_position: 2,
      filename: "continued.ndax",
      source_hash: "continued-hash",
      tracked_tail: true,
      local_cycle_start: 1,
      local_cycle_end: 2,
      local_cycle_count: 2,
      global_cycle_start: 6,
      global_cycle_end: 7,
    },
  ];
  assert.equal(
    consecutiveTimeCapacityExportColumns(
      { ...makeResult(), cell_traces: [trace] },
      makeSpec(),
      config,
      DEFAULT_PLOT_STYLE,
      null,
    ),
    null,
  );
});
