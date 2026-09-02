import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AnalysisSpec } from "../src/api.ts";
import { timeCapacityTraceIsHidden } from "../src/features/analyses/editor/families/time-capacity/timeCapacityVisibility.ts";
import {
  timeCapacityCompatibilitySignature,
  timeCapacityDataSignature,
  timeCapacityPlotExportReady,
  timeCapacityPlaceholderCompatible,
  timeCapacityPlaceholderData,
  timeCapacityRetainedPanResult,
  timeCapacityScientificRequestSpec,
  type TimeCapacityQueryConfig,
} from "../src/features/analyses/editor/policies/timeCapacityQueryPolicy.ts";

type CompatibilitySpec = Pick<
  AnalysisSpec,
  "selection" | "protocol_segments" | "computation" | "presentation"
>;

function makeSpec(): CompatibilitySpec {
  return {
    selection: {
      entries: [{ kind: "cell", ref_id: 7 }],
      exclusions: [],
      hidden_replicate_group_ids: [],
    },
    protocol_segments: [
      {
        id: "rpt",
        name: "RPT",
        targets: [{ protocol_signature: "protocol-a", step_indices: [1, 2] }],
      },
    ],
    computation: {
      cycle_range: { start: 1, end: 3 },
      exclude_check_cycles_every_n: 0,
      retention_reference: { mode: "max_first_n", n: 5, cycle: null },
      formation_cycles: 3,
      polarization: { method: "mean", direction: "charge_minus_discharge" },
      protocol_filter: { excluded_segment_ids: [], only_segment_ids: [] },
    },
    presentation: {
      quantity: "discharge_capacity",
      ce_overlay: true,
      show_individual_cells: true,
      legend: true,
      hidden_protocol_segment_ids: [],
    },
  };
}

function makeConfig(): TimeCapacityQueryConfig {
  return {
    x_axis: "time",
    time_unit: "min",
    display_mode: "consecutive",
    stacked: false,
    current_left: "current_ma",
    current_right: "none",
    electrode_area_cm2: null,
    view: "voltage_current",
    derivative_phase: "both",
    derivative_specific: false,
    derivative_absolute_discharge: true,
    smoothing_window: 7,
    cycle_start: 1,
    cycle_end: 3,
    cycles: [],
    max_points_per_cell: 4000,
    voltage_channel: "voltage",
  };
}

function signature(
  spec: CompatibilitySpec = makeSpec(),
  config: TimeCapacityQueryConfig = makeConfig(),
  viewportWidth = 1200,
): string {
  return timeCapacityCompatibilitySignature(spec, config, viewportWidth);
}

test("range and density changes are compatible placeholder identities", () => {
  const range = makeConfig();
  const widerRange = { ...range, cycle_end: 20 };
  const explicitCycles = { ...range, cycle_start: null, cycle_end: null, cycles: [1, 20] };
  const denser = { ...range, max_points_per_cell: 8000 };

  assert.equal(signature(makeSpec(), range), signature(makeSpec(), widerRange));
  assert.equal(signature(makeSpec(), range), signature(makeSpec(), explicitCycles));
  assert.equal(signature(makeSpec(), range), signature(makeSpec(), denser));
  assert.equal(signature(makeSpec(), range, 1200), signature(makeSpec(), range, 6000));
});

test("analysis-sample visibility does not change Time/Capacity scientific identities", () => {
  const visible = makeSpec();
  const hidden = makeSpec();
  hidden.selection.exclusions = [{ cell_id: 7, reason: null }];
  hidden.selection.hidden_replicate_group_ids = [42];

  assert.equal(signature(visible), signature(hidden));
  assert.equal(
    timeCapacityDataSignature(visible, makeConfig(), 1200),
    timeCapacityDataSignature(hidden, makeConfig(), 1200),
  );
});

test("analysis sample membership still changes the Time/Capacity data identity", () => {
  const selected = makeSpec();
  const changedSelection = makeSpec();
  changedSelection.selection.entries = [{ kind: "cell", ref_id: 8 }];

  assert.notEqual(
    timeCapacityDataSignature(selected, makeConfig(), 1200),
    timeCapacityDataSignature(changedSelection, makeConfig(), 1200),
  );
});

test("scientific request specs neutralize only display visibility without mutating the live spec", () => {
  const live = makeSpec();
  live.selection.exclusions = [{ cell_id: 7, reason: null }];
  live.selection.hidden_replicate_group_ids = [42];
  const before = structuredClone(live);

  const scientific = timeCapacityScientificRequestSpec(live);

  assert.deepEqual(scientific.selection.entries, live.selection.entries);
  assert.deepEqual(scientific.selection.exclusions, []);
  assert.deepEqual(scientific.selection.hidden_replicate_group_ids, []);
  assert.deepEqual(scientific.computation, live.computation);
  assert.deepEqual(scientific.presentation, live.presentation);
  assert.notStrictEqual(scientific.selection, live.selection);
  assert.deepEqual(live, before);
});

test("live Analysis-sample visibility filters an already returned Time/Capacity trace", () => {
  const visible = makeSpec() as AnalysisSpec;
  const hidden = structuredClone(visible);
  hidden.selection.exclusions = [{ cell_id: 7, reason: null }];

  const trace = { cell_id: 7, group_id: null, excluded: false };
  assert.equal(timeCapacityTraceIsHidden(trace, visible), false);
  assert.equal(timeCapacityTraceIsHidden(trace, hidden), true);
  assert.equal(signature(visible), signature(hidden));
});

test("selection and protocol visibility changes are incompatible", () => {
  const selected = makeSpec();
  const changedSelection = makeSpec();
  changedSelection.selection.entries = [{ kind: "cell", ref_id: 8 }];
  const changedFilter = makeSpec();
  changedFilter.computation.protocol_filter = {
    excluded_segment_ids: ["rpt"],
    only_segment_ids: [],
  };
  const changedHidden = makeSpec();
  changedHidden.presentation.hidden_protocol_segment_ids = ["rpt"];

  assert.notEqual(signature(selected), signature(changedSelection));
  assert.notEqual(signature(selected), signature(changedFilter));
  assert.notEqual(signature(selected), signature(changedHidden));
});

test("coordinate, mode, normalization, voltage, and derivative changes are incompatible", () => {
  const changes: Array<(config: TimeCapacityQueryConfig) => TimeCapacityQueryConfig> = [
    (config) => ({ ...config, x_axis: "capacity_mah" }),
    (config) => ({ ...config, time_unit: "h" }),
    (config) => ({ ...config, display_mode: "overlap_mirror" }),
    (config) => ({ ...config, electrode_area_cm2: 2.5 }),
    (config) => ({ ...config, voltage_channel: "working_potential" }),
    (config) => ({ ...config, view: "dqdv" }),
    (config) => ({ ...config, derivative_phase: "discharge" }),
    (config) => ({ ...config, derivative_specific: true }),
    (config) => ({ ...config, derivative_absolute_discharge: false }),
    (config) => ({ ...config, smoothing_window: 11 }),
  ];

  for (const change of changes) {
    assert.notEqual(signature(), signature(makeSpec(), change(makeConfig())));
  }
});

test("placeholder data is retained only for the same compatibility identity", () => {
  const compatible = signature();
  const incompatible = signature(makeSpec(), { ...makeConfig(), x_axis: "capacity_mah" });
  const previous = { cell_traces: [{ cycle: [1, 2] }] };

  assert.equal(timeCapacityPlaceholderCompatible(compatible, compatible), true);
  assert.equal(timeCapacityPlaceholderCompatible(compatible, incompatible), false);
  assert.deepEqual(
    timeCapacityPlaceholderData(
      previous,
      ["time-capacity", 7, compatible, "old-range"],
      7,
      compatible,
    ),
    previous,
  );
  assert.equal(
    timeCapacityPlaceholderData(
      previous,
      ["time-capacity", 7, incompatible, "old-axis"],
      7,
      compatible,
    ),
    undefined,
  );
  assert.equal(
    timeCapacityPlaceholderData(
      previous,
      ["time-capacity", 8, compatible, "other-analysis"],
      7,
      compatible,
    ),
    undefined,
  );
});

test("plot export remains available for a displayed range during query replacement", () => {
  assert.equal(timeCapacityPlotExportReady(false, true, false, true), true);
  assert.equal(timeCapacityPlotExportReady(true, true, false, true), false);
  assert.equal(timeCapacityPlotExportReady(false, false, false, true), false);
  assert.equal(timeCapacityPlotExportReady(false, true, true, true), false);
  assert.equal(timeCapacityPlotExportReady(false, true, false, false), false);
});

test("an active pan retains the last valid result when a refill has no data", () => {
  const previous = { cell_traces: [{ cycle: [1, 2, 3] }] };
  const current = { cell_traces: [{ cycle: [4, 5, 6] }] };
  assert.equal(timeCapacityRetainedPanResult(undefined, previous, true), previous);
  assert.equal(timeCapacityRetainedPanResult(undefined, previous, false), undefined);
  assert.equal(timeCapacityRetainedPanResult(current, previous, true), current);
});

test("live and saved-preview Time/Capacity queries forward React Query cancellation", () => {
  const liveSource = readFileSync(
    new URL("../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx", import.meta.url),
    "utf8",
  );
  const navigationSource = readFileSync(
    new URL("../src/features/analyses/editor/families/time-capacity/TimeCapacityCycleNavigation.tsx", import.meta.url),
    "utf8",
  );
  const savedPreviewSource = readFileSync(
    new URL("../src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx", import.meta.url),
    "utf8",
  );
  const headerSource = readFileSync(
    new URL("../src/features/analyses/editor/plotting/PlotHeader.tsx", import.meta.url),
    "utf8",
  );
  const editorSource = readFileSync(
    new URL("../src/features/analyses/editor/AnalysisEditor.tsx", import.meta.url),
    "utf8",
  );

  assert.match(liveSource, /queryFn: async \(\{ signal \}\) =>/);
  assert.match(liveSource, /compact: true,\s*\n\s*\}, \{ signal \}\);/);
  assert.match(liveSource, /timeCapacityPlotExportReady/);
  assert.match(liveSource, /timeCapacityScientificRequestSpec/);
  const queryStart = liveSource.indexOf("const timeResult = useQuery");
  assert.ok(queryStart >= 0);
  assert.match(liveSource.slice(queryStart), /spec: scientificRequestSpec,/);
  assert.match(liveSource, /canPlotExport=\{plotExportReady && !dataExporting\}/);
  assert.match(liveSource, /panActive \|\| resultIsRetainedPanFallback/);
  assert.match(liveSource, /timeResult\.isPlaceholderData \|\| resultIsRetainedPanFallback/);
  assert.match(liveSource, /const token = transientPreviewRequest \? null : newComputeToken\(\)/);
  assert.match(liveSource, /onReadyChange\?\.\(readyForParent\)/);
  assert.match(liveSource, /panSettlingWindowRef\.current = \{ \.\.\.range \}/);
  assert.match(liveSource, /interpolatedXRangeForCycleIndex\(/);
  assert.match(liveSource, /queryClient\.prefetchQuery\(/);
  assert.match(liveSource, /absolute_time_origin_cycle: panRequest\.window\.start/);
  assert.match(liveSource, /const panRelayoutInFlightRef = useRef\(false\)/);
  assert.match(liveSource, /if \(panPendingRef\.current\) queuePanFrameRef\.current\(\)/);
  assert.match(liveSource, /timeCapacityCommittedNavigationOnRange/);
  assert.match(liveSource, /timeCapacityCommittedNavigationOnRequestSettled/);
  assert.match(liveSource, /scheduleCommittedNavigationRange\(range\)/);
  assert.match(liveSource, /timeCapacitySpecWithCycleRange/);
  assert.match(liveSource, /if \(cyclePreviewRange === null && committedNavigationRange\)/);
  assert.match(liveSource, /timeCapacityPreviewOnMove\(/);
  assert.match(liveSource, /timeCapacityBufferOnMove\(/);
  assert.match(navigationSource, /const final = previewAtPointer\(\s*event\.clientX,/s);
  assert.doesNotMatch(navigationSource, /onPreview\(finalRange, final\.position\)/);
  assert.match(navigationSource, /const final = previewAtPointer\([\s\S]*onCommit\(finalRange\);/);
  assert.match(navigationSource, /onPointerDown=\{\(event\) => \{[\s\S]*onActivate\(event\.ctrlKey\)/);
  assert.match(navigationSource, /if \(event\.detail === 0\) onActivate\(event\.ctrlKey\)/);
  assert.match(navigationSource, /navigateTimeCapacityCycleRange\(\s*buttonRangeRef\.current,/s);
  assert.match(liveSource, /if \(!plotExportReady \|\| !plotDivRef\.current/);
  assert.match(liveSource, /new TimeCapacityRefinementLifecycle\(\)/);
  assert.match(
    liveSource,
    /useLayoutEffect\(\(\) => \{\s*if \(stackedModeChanged\) invalidateRefinement\(\);/s,
  );
  assert.match(liveSource, /timeCapacityRefinementDisplayIsCurrent\(/);
  assert.match(liveSource, /const refinementViewport =/);
  assert.match(liveSource, /next\.xaxis2 = \{ \.\.\.\(base\.xaxis2 \?\? \{\}\)/);
  assert.match(liveSource, /if \(panPresentationActive \|\| cfg\.stacked \|\| !refinementTransition\) return null;/);
  assert.match(liveSource, /timeCapacityRefinementCanSchedule\(active, spec\)/);
  assert.match(liveSource, /refinementLifecycle\.acceptResponse\(/);
  assert.match(headerSource, /const plotExportEnabled = canPlotExport \?\? canExport/);
  assert.match(headerSource, /getExportPreview && plotExportEnabled/);
  assert.match(headerSource, /disabled=\{!plotExportEnabled\}/);
  assert.match(savedPreviewSource, /queryFn: \(\{ signal \}\) =>/);
  assert.match(savedPreviewSource, /background: warmup,\s*\n\s*\}, \{ signal \}\),/);

  assert.doesNotMatch(editorSource, /autosave/i);
  const persistStart = editorSource.indexOf("const buildPersistPayload");
  const displayResultStart = editorSource.indexOf("const displayResult", persistStart);
  assert.ok(persistStart >= 0 && displayResultStart > persistStart);
  const persistenceSource = editorSource.slice(persistStart, displayResultStart);
  assert.match(persistenceSource, /const persistAnalysisSpec =/);
  assert.doesNotMatch(persistenceSource, /useEffect|setTimeout|signatureAtSchedule/);

  const updateStart = editorSource.indexOf("const applyUpdateActivePlot");
  const updateEnd = editorSource.indexOf("const updateActivePlot", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const updateSource = editorSource.slice(updateStart, updateEnd);
  assert.match(updateSource, /setSpec\(next\)/);
  assert.match(updateSource, /persistAnalysisSpec\(persistSpec, persistTitle\)/);
  assert.match(editorSource, /dirty \? "Unsaved" : "Saved"/);
});
