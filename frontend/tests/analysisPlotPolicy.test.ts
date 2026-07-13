import assert from "node:assert/strict";
import test from "node:test";

import {
  plotViewSignature,
  savedPlotPreviewSignature,
  savedPlotSelectionFromSpec,
  specForSavedPlotView,
} from "../src/analysisPlotPolicy.ts";

function makeSpec(
  entries: { kind: "cell" | "replicate_group"; ref_id: number }[],
  hiddenCellIds: number[],
  hiddenReplicateIds: number[] = []
) {
  return {
    spec_version: 5,
    type: "cycling",
    title: "analysis",
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    selection: {
      entries,
      exclusions: hiddenCellIds.map((cell_id) => ({ cell_id, reason: null })),
      hidden_replicate_group_ids: hiddenReplicateIds,
    },
    computation: {
      cycle_range: { start: 1, end: null },
      exclude_check_cycles_every_n: 0,
      retention_reference: { mode: "max_first_n", n: 5, cycle: null },
      formation_cycles: 3,
      polarization: { method: "mean", direction: "charge_minus_discharge" },
    },
    aggregation: { mode: "replicate_mean", dispersion: "std", min_n_for_band: 2 },
    presentation: {
      quantity: "discharge_capacity",
      normalize_by_mass: false,
      ce_overlay: true,
      show_individual_cells: true,
      legend: true,
    },
    saved_plots: [],
  } as const;
}

test("saved plots store hidden cells but not sample membership", () => {
  const spec = makeSpec(
    [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 2 },
    ],
    [2]
  );

  const savedSelection = savedPlotSelectionFromSpec(spec);

  assert.deepEqual(savedSelection.entries, []);
  assert.deepEqual(savedSelection.exclusions.map((e) => e.cell_id), [2]);
});

test("saved plots store hidden replicate groups", () => {
  const spec = makeSpec([{ kind: "replicate_group", ref_id: 7 }], [], [7]);

  const savedSelection = savedPlotSelectionFromSpec(spec);

  assert.deepEqual(savedSelection.hidden_replicate_group_ids, [7]);
});

test("plot signatures distinguish standalone and replicate-member visibility", () => {
  const standaloneHidden = makeSpec(
    [{ kind: "cell", ref_id: 1 }, { kind: "replicate_group", ref_id: 7 }],
    []
  );
  standaloneHidden.selection.exclusions = [
    { cell_id: 1, entry_kind: "cell", entry_ref_id: 1, reason: null },
  ];
  const memberHidden = makeSpec(
    [{ kind: "cell", ref_id: 1 }, { kind: "replicate_group", ref_id: 7 }],
    []
  );
  memberHidden.selection.exclusions = [
    { cell_id: 1, entry_kind: "replicate_group", entry_ref_id: 7, reason: null },
  ];

  assert.notEqual(plotViewSignature(standaloneHidden), plotViewSignature(memberHidden));
});

test("opening a saved plot keeps current analysis samples and restores only hidden cells", () => {
  const currentAnalysis = makeSpec(
    [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 3 },
    ],
    []
  );
  const legacySavedPlot = {
    id: "plot-1",
    tab: "cycles",
    name: "Saved view",
    subtitle: "view",
    description: null,
    selection: {
      entries: [
        { kind: "cell", ref_id: 1 },
        { kind: "cell", ref_id: 2 },
      ],
      exclusions: [{ cell_id: 1, reason: null }],
    },
    computation: currentAnalysis.computation,
    aggregation: currentAnalysis.aggregation,
    presentation: currentAnalysis.presentation,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as const;

  const restored = specForSavedPlotView(currentAnalysis, legacySavedPlot);

  assert.deepEqual(restored.selection.entries, currentAnalysis.selection.entries);
  assert.deepEqual(restored.selection.exclusions.map((e) => e.cell_id), [1]);
});

test("adding visible analysis samples does not dirty a saved plot view", () => {
  const before = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  const after = makeSpec(
    [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 2 },
    ],
    []
  );
  const hiddenChanged = makeSpec(
    [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 2 },
    ],
    [2]
  );

  assert.equal(plotViewSignature(before), plotViewSignature(after));
  assert.notEqual(plotViewSignature(before), plotViewSignature(hiddenChanged));
});

test("saved plot preview signature changes when analysis sample membership changes", () => {
  const savedPlot = {
    id: "plot-1",
    tab: "cycles",
    name: "Saved view",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: makeSpec([], []).computation,
    aggregation: makeSpec([], []).aggregation,
    presentation: makeSpec([], []).presentation,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as const;
  const before = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  const after = makeSpec(
    [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 2 },
    ],
    []
  );

  assert.notEqual(savedPlotPreviewSignature(before, savedPlot), savedPlotPreviewSignature(after, savedPlot));
});
