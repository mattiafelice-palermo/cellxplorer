import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AnalysisSpec,
  ComputeResult,
  TimeCapacityRefinementResult,
  TimeCapacityResult,
} from "../src/api.ts";
import { TimeCapacityRefinementLifecycle } from "../src/features/analyses/editor/families/time-capacity/timeCapacityRefinementLifecycle.ts";
import {
  CYCLE_POINT_CLICK_RADIUS_PX,
  CYCLE_POINT_DRAG_THRESHOLD_PX,
  cyclePointAdjacentCycle,
  cyclePointSharedSamplePrefix,
  cyclePointVisibleSampleLabels,
  cyclePointInspectorPosition,
  cyclePointCandidatesForTraces,
  cyclePointCullRecords,
  cyclePointDetailRequest,
  cyclePointDetailSelectionEntries,
  cyclePointGestureIsRectangle,
  cyclePointInPolygon,
  cyclePointInRectangle,
  cyclePointMeasurePresentation,
  cyclePointRecordsForShape,
  cyclePointPreviewShape,
  cyclePointTableRecords,
  cyclePointSelectedCycles,
  cyclePointSelectedMarkerSize,
  cyclePointSelectionKey,
  cyclePointSortRecords,
  withoutCyclePointSelectionMetadata,
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

test("repeated polygon vertices never turn outside points into boundary points", () => {
  const polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  for (const vertices of [polygon, [...polygon, polygon[0]],
    [polygon[0], polygon[0], ...polygon.slice(1)]]) {
    assert.equal(cyclePointInPolygon({ x: 100, y: 100 }, vertices), false);
    assert.equal(cyclePointInPolygon({ x: 5, y: 5 }, vertices), true);
    assert.equal(cyclePointInPolygon({ x: 10, y: 5 }, vertices), true);
  }
  assert.equal(cyclePointInPolygon({ x: 5, y: 5 }, [polygon[0], polygon[0], polygon[0]]), false);
});

test("selection preserves trace appearance and caps small-marker emphasis", () => {
  const candidates = cyclePointCandidatesForTraces([{ ...trace(), mode: "markers",
    marker: { color: "#f03e3e", size: 12, symbol: "diamond-open" } }], project);
  assert.equal(candidates[0].color, "#f03e3e");
  assert.equal(candidates[0].markerSymbol, "diamond-open");
  assert.equal(cyclePointSelectedMarkerSize(candidates[0].markerSize!), 12);
  assert.equal(cyclePointSelectedMarkerSize(0), 5);
  assert.equal(cyclePointSelectedMarkerSize(5), 7);
  assert.equal(cyclePointSelectedMarkerSize(7), 8);
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

test("mixed primary and CE rows retain an explicit per-row measure identity", () => {
  const primary = baseRecord();
  const ce = baseRecord({
    key: "ce",
    seriesKey: "ce:c1",
    quantityKey: "coulombic_efficiency_pct",
    quantityLabel: "Coulombic efficiency (%)",
    axis: "y2",
  });
  assert.deepEqual(cyclePointMeasurePresentation([primary]), {
    yHeader: "Discharge capacity (mAh)",
    showMeasurePerRow: false,
  });
  assert.deepEqual(cyclePointMeasurePresentation([primary, ce]), {
    yHeader: "Y value",
    showMeasurePerRow: true,
  });
  assert.equal(primary.quantityLabel, "Discharge capacity (mAh)");
  assert.equal(ce.quantityLabel, "Coulombic efficiency (%)");
});

test("artifact sanitization removes only live point-selection metadata without mutating traces", () => {
  const selectable = trace();
  selectable.meta.otherMetadata = "preserved";
  const cleaned = withoutCyclePointSelectionMetadata([selectable]);
  assert.notEqual(cleaned[0], selectable);
  assert.deepEqual(cleaned[0].meta, { otherMetadata: "preserved" });
  assert.ok("cellxplorerCycleSelection" in selectable.meta);
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

test("cycle detail refinement rejects superseded and cancelled response generations", () => {
  const current = {
    data_signature: "overview",
  } as TimeCapacityResult;
  const responseFor = (generation: string): TimeCapacityRefinementResult => ({
    ...current,
    overview_data_signature: "overview",
    request_generation: generation,
  } as TimeCapacityRefinementResult);
  const lifecycle = new TimeCapacityRefinementLifecycle();
  const viewportA = { min: 0, max: 10 };
  const viewportB = { min: 2, max: 6 };

  lifecycle.cancelPending();
  const generationA = lifecycle.beginRequest(viewportA);
  lifecycle.cancelPending();
  const generationB = lifecycle.beginRequest(viewportB);
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationA), current, generationA, viewportA, "compat"),
    false,
  );
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationB), current, generationB, viewportB, "compat"),
    true,
  );

  lifecycle.cancelPending();
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationB), current, generationB, viewportB, "compat"),
    false,
  );
});

test("inspector wiring invalidates refinement generations and relayout clears the full selection", () => {
  const inspectorSource = readFileSync(
    fileURLToPath(
      new URL(
        "../src/features/analyses/editor/families/cycles/CyclePointInspector.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const selectionSource = readFileSync(
    fileURLToPath(
      new URL(
        "../src/features/analyses/editor/families/cycles/useCyclePointSelection.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(inspectorSource, /new TimeCapacityRefinementLifecycle\(\)/);
  assert.match(inspectorSource, /refinementLifecycle\.cancelPending\(\)/);
  assert.match(inspectorSource, /refinementLifecycle\.acceptResponse\(/);
  assert.match(selectionSource, /const invalidateGeometry = useCallback\(\(\) => \{[\s\S]*?clear\(\);[\s\S]*?\}, \[clear\]\);/);
});


test("inspector placement avoids selected bounds and stays inside the viewport at each UI scale", () => {
  for (const scale of [0.9, 1, 1.1]) {
    for (const viewport of [{ width: 1100, height: 620 }, { width: 1350, height: 900 }]) {
      for (const anchor of [
        { left: 600, right: 610, top: 300, bottom: 310 },
        { left: 400, right: 800, top: 480, bottom: 510 },
        { left: 10, right: 1000, top: 100, bottom: 180 },
        { left: 10, right: 1000, top: 410, bottom: 600 },
      ]) {
        const position = cyclePointInspectorPosition(anchor, viewport.width, viewport.height, 600 * scale, scale);
        const height = Math.min(600 * scale, position.maxHeight);
        assert.equal(position.outsideViewport, false);
        assert.ok(position.left >= 8 && position.top >= 8);
        assert.ok(position.left + position.width <= viewport.width - 8);
        assert.ok(position.top + height <= viewport.height - 8);
        assert.ok(position.maxHeight <= viewport.height * 0.7);
        assert.ok(position.left + position.width <= anchor.left || position.left >= anchor.right ||
          position.top + height <= anchor.top || position.top >= anchor.bottom);
      }
    }
  }
});

test("inspector uses above or below space before reducing its height", () => {
  const position = cyclePointInspectorPosition({ left: 400, right: 650, top: 550, bottom: 600 }, 1100, 900, 500, 1);
  assert.equal(position.top, 38);
  assert.equal(position.width, 520);
  assert.equal(position.maxHeight, 530);
  assert.equal(position.outsideViewport, false);
});

test("inspector permits document scrolling only when the selection leaves no usable viewport space", () => {
  const position = cyclePointInspectorPosition({ left: 0, right: 1100, top: 0, bottom: 620 }, 1100, 620, 600, 1);
  assert.equal(position.outsideViewport, true);
  assert.equal(position.top, 632);
});


test("polygon boundaries tolerate Plotly subpixel rounding without including nearby outside points", () => {
  const vertices = [{ x: 171.67, y: 378.33 }, { x: 658.33, y: 378.33 }, { x: 415, y: 91.67 }];
  assert.equal(cyclePointInPolygon({ x: 171 + 2 / 3, y: 378 + 1 / 3 }, vertices), true);
  assert.equal(cyclePointInPolygon({ x: 171.64, y: 378.36 }, vertices), false);
  assert.equal(cyclePointInPolygon({ x: 658.33, y: 91.67 }, [...vertices, vertices[0]]), false);
});


test("shared family prefixes preserve the informative numeric identifiers", () => {
  const prefix = '1012-BQV00000000000';
  const labels = [prefix + '2436-1', prefix + '2437-1', prefix + '2438-1'];
  assert.equal(cyclePointSharedSamplePrefix(labels), prefix);
  assert.deepEqual(labels.map(label => label.slice(prefix.length)), ['2436-1', '2437-1', '2438-1']);
  assert.equal(cyclePointSharedSamplePrefix(['Long family 1234', 'Long family 1235']), 'Long family ');
  assert.equal(cyclePointSharedSamplePrefix(['Experiment_batch_A.ndax', 'Experiment_batch_B.ndax']), 'Experiment_batch_');
});

test("sample prefixes stay intact for single, duplicate, short, unrelated or empty-suffix names", () => {
  for (const labels of [[], ['One sample'], ['Repeated family name', 'Repeated family name'],
    ['Cell A', 'Cell B'], ['Experiment one', 'Different two'], ['Experiment', 'Experiment extra']]) {
    assert.equal(cyclePointSharedSamplePrefix(labels), '');
  }
});

test("prefix context includes only visible selectable samples and deduplicates their quantities", () => {
  const visible = trace({ sampleLabel: 'Experiment_A' });
  const hidden = { ...trace({ sampleLabel: 'Unrelated hidden Cell' }), visible: 'legendonly' };
  assert.deepEqual(cyclePointVisibleSampleLabels([visible, visible, hidden, { name: 'helper' } as any]), ['Experiment_A']);
});


test("live rectangle and cursor polygon previews add and remove points without mutating committed records", () => {
  const candidates = cyclePointCandidatesForTraces([{
    ...trace({ scientificCycles: [1, 2, 3] }), x: [2, 8, 20], y: [2, 8, 20],
  }], (x, y) => ({ x, y }));
  const committed = cyclePointRecordsForShape(candidates, { kind: "polygon", vertices: [{ x: 20, y: 20 }] }, 1);
  const start = { x: 0, y: 0 };
  const selected = (shape: ReturnType<typeof cyclePointPreviewShape>) => shape
    ? cyclePointRecordsForShape(candidates, shape, 1).map((record) => record.scientificCycle) : [];
  assert.deepEqual(selected(cyclePointPreviewShape({ start, end: { x: 10, y: 10 } }, [], null)), [1, 2]);
  assert.deepEqual(selected(cyclePointPreviewShape({ start, end: { x: 4, y: 4 } }, [], null)), [1]);
  const vertices = [start, { x: 10, y: 0 }];
  assert.deepEqual(selected(cyclePointPreviewShape(null, vertices, { x: 10, y: 10 })), [1, 2]);
  assert.deepEqual(selected(cyclePointPreviewShape(null, vertices, { x: 0, y: 5 })), [1]);
  assert.deepEqual(vertices, [start, { x: 10, y: 0 }]);
  assert.deepEqual(committed.map((record) => record.scientificCycle), [3]);
  assert.equal(cyclePointPreviewShape(null, [], null), null);
  assert.deepEqual(cyclePointPreviewShape(null, [start], start), { kind: "polygon", vertices: [start] });
});


test("table sorting and series filtering preserve cycle identity and all rows for a clicked cycle", () => {
  const records = [
    baseRecord({key:"a", seriesKey:"c1", scientificCycle:80, displayedX:74, displayedY:148}),
    baseRecord({key:"b", seriesKey:"c2", scientificCycle:80, displayedX:74, displayedY:146}),
    baseRecord({key:"c", seriesKey:"c1", scientificCycle:82, displayedX:76, displayedY:147}),
    baseRecord({key:"d", seriesKey:"c2", scientificCycle:82, displayedX:76, displayedY:149}),
  ];
  const sorted = cyclePointTableRecords(records, "all", {key:"displayedY",direction:"asc"});
  assert.deepEqual(sorted.map(r=>r.key), ["b","c","a","d"]);
  assert.deepEqual(sorted.filter(r=>r.scientificCycle===sorted[0].scientificCycle).map(r=>r.seriesKey).sort(), ["c1","c2"]);
  assert.deepEqual(cyclePointTableRecords(records,"c1",{key:"scientificCycle",direction:"desc"}).map(r=>r.key), ["c","a"]);
  assert.deepEqual(cyclePointTableRecords(records,"all",{key:"displayedX",direction:"desc"}).map(r=>r.scientificCycle), [82,82,80,80]);
  assert.deepEqual(records.map(r=>r.key), ["a","b","c","d"]);
});

test("inspector placement reserves pinned detail height and uses document fallback when needed", () => {
  const beside = cyclePointInspectorPosition({left:20,right:100,top:20,bottom:650},1100,700,650,1,530);
  assert.equal(beside.outsideViewport,false);
  assert.ok(beside.maxHeight>=530);
  assert.ok(beside.top+Math.min(650,beside.maxHeight)<=700);
  const blocked = cyclePointInspectorPosition({left:0,right:1100,top:200,bottom:600},1100,700,650,1,530);
  assert.equal(blocked.outsideViewport,true);
  assert.ok(blocked.top>600);
  assert.ok(blocked.maxHeight>=530);
});
