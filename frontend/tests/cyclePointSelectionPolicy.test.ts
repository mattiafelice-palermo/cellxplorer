import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisSpec, ComputeResult } from "../src/api.ts";
import {
  CYCLE_POINT_CLICK_RADIUS_PX,
  CYCLE_POINT_DRAG_THRESHOLD_PX,
  cyclePointAdjacentCycle,
  cyclePointCandidatesForTraces,
  cyclePointCullRecords,
  cyclePointDetailRequest,
  cyclePointDetailSelectionEntries,
  cyclePointGestureIsRectangle,
  cyclePointInPolygon,
  cyclePointInRectangle,
  cyclePointRecordsForShape,
  cyclePointSelectedCycles,
  cyclePointSelectionKey,
  cyclePointSortRecords,
  type CyclePointSelectionRecord,
  type CycleSelectableTraceMeta,
} from "../src/features/analyses/editor/families/cycles/cyclePointSelectionPolicy.ts";

const baseRecord = (
  overrides: Partial<CyclePointSelectionRecord> = {},
): CyclePointSelectionRecord => ({
  key: "c1|y|discharge_capacity|1|1|none|1|1",
  seriesKey: "c1",
  sampleKind: "cell",
  cellId: 1,
  groupId: null,
  sampleLabel: "Cell one",
  scientificCycle: 1,
  localCycle: 1,
  sourcePosition: 1,
  sourceFilename: "cell-one.ndax",
  detailCellIds: [1],
  quantityKey: "discharge_capacity",
  quantityLabel: "Discharge capacity (mAh)",
  axis: "y",
  displayedX: 1,
  displayedY: 3.2,
  renderedSeriesOrder: 0,
  ...overrides,
});

function trace(
  overrides: Partial<CycleSelectableTraceMeta["cellxplorerCycleSelection"]> = {},
) {
  return {
    x: [1, 2],
    y: [3.2, 3.3],
    meta: {
      cellxplorerCycleSelection: {
        version: 1,
        seriesKey: "c1",
        sampleKind: "cell",
        cellId: 1,
        groupId: null,
        sampleLabel: "Cell one",
        scientificCycles: [101, 102],
        localCycles: [1, 2],
        sourcePositions: [2, 2],
        sourceFilenames: ["continued.ndax", "continued.ndax"],
        detailCellIds: [[1], [1]],
        quantityKey: "discharge_capacity",
        quantityLabel: "Discharge capacity (mAh)",
        axis: "y",
        ...overrides,
      },
    } satisfies CycleSelectableTraceMeta,
  };
}

const project = (x: number, y: number, axis: "y" | "y2") => ({
  x: x * 10,
  y: (axis === "y2" ? 100 : 0) + y * 10,
});

test("the complete displacement classifies clicks and rectangle drags", () => {
  assert.equal(
    cyclePointGestureIsRectangle({ x: 0, y: 0 }, { x: CYCLE_POINT_DRAG_THRESHOLD_PX - 0.1, y: 0 }),
    false,
  );
  assert.equal(
    cyclePointGestureIsRectangle({ x: 0, y: 0 }, { x: 3.6, y: 4.8 }),
    true,
  );
});

test("rectangle containment includes every boundary", () => {
  assert.equal(cyclePointInRectangle({ x: 10, y: 20 }, { x: 10, y: 20 }, { x: 30, y: 40 }), true);
  assert.equal(cyclePointInRectangle({ x: 30, y: 40 }, { x: 10, y: 20 }, { x: 30, y: 40 }), true);
  assert.equal(cyclePointInRectangle({ x: 9.9, y: 30 }, { x: 10, y: 20 }, { x: 30, y: 40 }), false);
});

test("concave polygon containment includes edges and excludes its notch", () => {
  const polygon = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 8 },
    { x: 4, y: 4 },
    { x: 0, y: 8 },
  ];
  assert.equal(cyclePointInPolygon({ x: 2, y: 2 }, polygon), true);
  assert.equal(cyclePointInPolygon({ x: 6, y: 6 }, polygon), true);
  assert.equal(cyclePointInPolygon({ x: 4, y: 6 }, polygon), false);
  assert.equal(cyclePointInPolygon({ x: 6, y: 6 }, polygon), true);
  assert.equal(cyclePointInPolygon({ x: 6, y: 6.1 }, polygon), false);
});

test("one direct vertex uses a bounded nearest hit and empty space selects nothing", () => {
  const candidates = cyclePointCandidatesForTraces([trace()], project);
  const hit = cyclePointRecordsForShape(candidates, {
    kind: "polygon",
    vertices: [{ x: 10, y: 32 }],
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].scientificCycle, 101);
  assert.deepEqual(
    cyclePointRecordsForShape(candidates, {
      kind: "polygon",
      vertices: [{ x: 10 + CYCLE_POINT_CLICK_RADIUS_PX + 1, y: 50 }],
    }),
    [],
  );
});

test("two vertices select unique direct hits", () => {
  const candidates = cyclePointCandidatesForTraces([trace()], project);
  const selected = cyclePointRecordsForShape(candidates, {
    kind: "polygon",
    vertices: [
      { x: 10, y: 32 },
      { x: 10.5, y: 32.5 },
    ],
  });
  assert.equal(selected.length, 1);
});

test("trace metadata admits scientific traces while helpers, hidden and non-finite points stay out", () => {
  const primary = trace();
  const replicate = trace({
    seriesKey: "g7",
    sampleKind: "replicate",
    cellId: null,
    groupId: 7,
    sampleLabel: "Replicate seven",
  });
  const ce = trace({
    seriesKey: "ce:c1",
    quantityKey: "coulombic_efficiency_pct",
    quantityLabel: "Coulombic efficiency (%)",
    axis: "y2",
  });
  const hidden = { ...trace(), visible: "legendonly" };
  const nonFinite = { ...trace(), x: [NaN], y: [4] };
  const candidates = cyclePointCandidatesForTraces(
    [primary, {}, hidden, nonFinite, replicate, ce],
    project,
  );
  assert.equal(candidates.length, 6);
  assert.equal(candidates.filter((candidate) => candidate.sampleKind === "replicate").length, 2);
  assert.equal(candidates.filter((candidate) => candidate.axis === "y2").length, 2);
  assert.ok(candidates.find((candidate) => candidate.axis === "y2")!.screenY > 100);
});

test("stable keys distinguish Cell, replicate, primary, and CE identities", () => {
  const cell = baseRecord();
  const replicate = baseRecord({ sampleKind: "replicate", cellId: null, groupId: 4, seriesKey: "g4" });
  const ce = baseRecord({ axis: "y2", quantityKey: "coulombic_efficiency_pct", seriesKey: "ce:c1" });
  const keys = new Set(
    [cell, replicate, ce].map(({ key: _key, renderedSeriesOrder: _order, displayedX: _x, displayedY: _y, ...record }) =>
      cyclePointSelectionKey(record),
    ),
  );
  assert.equal(keys.size, 3);
});

test("reindexed display coordinates retain original scientific cycles and provenance", () => {
  const candidates = cyclePointCandidatesForTraces(
    [{ ...trace(), x: [1, 2] }],
    project,
  );
  assert.deepEqual(
    candidates.map((candidate) => [candidate.displayedX, candidate.scientificCycle, candidate.localCycle]),
    [
      [1, 101, 1],
      [2, 102, 2],
    ],
  );
});

test("rows sort by scientific cycle then draw order and selected-cycle navigation is unique", () => {
  const records = cyclePointSortRecords([
    baseRecord({ key: "b", scientificCycle: 8, renderedSeriesOrder: 0 }),
    baseRecord({ key: "c", scientificCycle: 4, renderedSeriesOrder: 2 }),
    baseRecord({ key: "a", scientificCycle: 4, renderedSeriesOrder: 1 }),
  ]);
  assert.deepEqual(records.map((record) => record.key), ["a", "c", "b"]);
  assert.deepEqual(cyclePointSelectedCycles(records), [4, 8]);
  assert.equal(cyclePointAdjacentCycle(records, 4, -1), null);
  assert.equal(cyclePointAdjacentCycle(records, 4, 1), 8);
  assert.equal(cyclePointAdjacentCycle(records, 8, 1), null);
});

test("visibility culling removes only hidden records and closes naturally on empty", () => {
  const first = baseRecord({ key: "first" });
  const second = baseRecord({ key: "second", cellId: 2, seriesKey: "c2" });
  assert.deepEqual(cyclePointCullRecords([first, second], new Set(["second"])), [second]);
  assert.deepEqual(cyclePointCullRecords([first], new Set()), []);
});

test("detail entries deduplicate Cells already covered by a selected replicate", () => {
  const group = baseRecord({
    key: "g4",
    sampleKind: "replicate",
    cellId: null,
    groupId: 4,
    seriesKey: "g4",
    detailCellIds: [1, 2],
  });
  const directMember = baseRecord({ key: "c1", cellId: 1, seriesKey: "c1", detailCellIds: [1] });
  const other = baseRecord({ key: "c3", cellId: 3, seriesKey: "c3", detailCellIds: [3] });
  const result = {
    cell_series: [
      { cell_id: 1, group_id: 4 },
      { cell_id: 2, group_id: 4 },
    ],
  } as ComputeResult;
  assert.deepEqual(cyclePointDetailSelectionEntries([group, directMember, other], result), [
    { kind: "cell", ref_id: 1 },
    { kind: "cell", ref_id: 2 },
    { kind: "cell", ref_id: 3 },
  ]);
});

const spec = (): AnalysisSpec =>
  ({
    spec_version: 4,
    type: "cycling",
    title: "Test",
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    selection: {
      entries: [
        { kind: "cell", ref_id: 1 },
        { kind: "cell", ref_id: 99 },
      ],
      exclusions: [{ cell_id: 99 }],
      hidden_replicate_group_ids: [7],
    },
    protocol_segments: [],
    computation: {
      cycle_range: { start: null, end: null },
      exclude_check_cycles_every_n: 0,
      retention_reference: { mode: "max_first_n", n: 5, cycle: null },
      formation_cycles: 3,
      polarization: { method: "mean", direction: "charge_minus_discharge" },
      protocol_filter: { excluded_segment_ids: ["p1"], only_segment_ids: [] },
      time_capacity: {
        x_axis: "capacity_mah",
        time_unit: "h",
        display_mode: "overlap_reset",
        stacked: false,
        current_left: "current_ma",
        current_right: "none",
        electrode_area_cm2: 1.5,
        view: "voltage_current",
        derivative_phase: "both",
        derivative_specific: false,
        derivative_absolute_discharge: true,
        smoothing_window: 7,
        cycle_start: 10,
        cycle_end: 20,
        cycles: [],
        max_points_per_cell: 4000,
        voltage_channel: "voltage",
        voltage_channels: ["voltage"],
      },
    },
    aggregation: { min_n_for_band: 2 },
    presentation: { hidden_protocol_segment_ids: ["hidden-p"] },
  }) as AnalysisSpec;

test("detail projection uses the original global cycle, narrows entries, and does not mutate live state", () => {
  const live = spec();
  const before = structuredClone(live);
  const reindexed = baseRecord({ displayedX: 2, scientificCycle: 121 });
  const request = cyclePointDetailRequest(live, [reindexed], 121, "time", "voltage");

  assert.deepEqual(live, before);
  assert.deepEqual(request.spec.selection.entries, [{ kind: "cell", ref_id: 1 }]);
  assert.deepEqual(request.spec.selection.exclusions, []);
  assert.deepEqual(request.spec.selection.hidden_replicate_group_ids, []);
  assert.deepEqual(request.spec.computation.time_capacity?.cycles, []);
  assert.equal(request.spec.computation.time_capacity?.cycle_start, 121);
  assert.equal(request.spec.computation.time_capacity?.cycle_end, 121);
  assert.equal(request.spec.computation.time_capacity?.time_unit, "h");
  assert.deepEqual(request.spec.computation.protocol_filter, before.computation.protocol_filter);
  assert.ok(request.compatibilitySignature.includes('"x_axis":"time"'));
  assert.ok(request.dataSignature.includes('"start":121'));
  assert.ok(request.dataSignature.includes('"end":121'));
});

test("detail request identity follows X and voltage choices while preserving one request object", () => {
  const live = spec();
  const record = baseRecord();
  const time = cyclePointDetailRequest(live, [record], 1, "time", "voltage");
  const capacity = cyclePointDetailRequest(live, [record], 1, "capacity_mah", "voltage");
  const potential = cyclePointDetailRequest(live, [record], 1, "time", "working_potential");
  assert.notEqual(time.dataSignature, capacity.dataSignature);
  assert.notEqual(time.dataSignature, potential.dataSignature);
  assert.equal(time.spec.computation.time_capacity?.x_axis, "time");
  assert.deepEqual(potential.spec.computation.time_capacity?.voltage_channels, ["working_potential"]);
});
