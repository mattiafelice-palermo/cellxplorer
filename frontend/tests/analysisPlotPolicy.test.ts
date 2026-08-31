import assert from "node:assert/strict";
import test from "node:test";

import {
  plotViewSignature,
  renameSavedPlotInList,
  savedPlotPreviewSignature,
  savedPlotSelectionFromSpec,
  specForSavedPlotView,
  shouldOpenSavedPlotCardFromKey,
  validateSavedPlotName,
} from "../src/features/analyses/editor/policies/analysisPlotPolicy.ts";
import type { SavedAnalysisPlot } from "../src/api.ts";

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

function makeSavedPlot(id: string, name: string): SavedAnalysisPlot {
  const base = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  return {
    id,
    tab: "cycles",
    name,
    subtitle: "view",
    description: "description",
    selection: { entries: [], exclusions: [], hidden_replicate_group_ids: [] },
    computation: base.computation,
    aggregation: base.aggregation,
    presentation: base.presentation,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  };
}

test("saved plot rename changes only target metadata and trims the name", () => {
  const first = makeSavedPlot("p1", "First");
  const second = makeSavedPlot("p2", "Second");
  const original = [first, second];
  const result = renameSavedPlotInList(original, "p1", "  Shared view  ", "2026-01-02T00:00:00Z");

  assert.equal(result.error, null);
  assert.equal(result.changed, true);
  assert.deepEqual(result.plots[0], {
    ...first,
    name: "Shared view",
    modified_at: "2026-01-02T00:00:00Z",
  });
  assert.deepEqual(result.plots[1], second);
  assert.deepEqual(original, [first, second]);
  assert.equal(result.plots[0].id, "p1");
  assert.equal(result.plots[0].tab, "cycles");
  assert.strictEqual(result.plots[0].selection, first.selection);
  assert.strictEqual(result.plots[0].computation, first.computation);
  assert.strictEqual(result.plots[0].aggregation, first.aggregation);
  assert.strictEqual(result.plots[0].presentation, first.presentation);
});

test("saved plot rename validates blank and overlong names, while allowing duplicates", () => {
  const plots = [makeSavedPlot("p1", "First"), makeSavedPlot("p2", "Second")];
  const blank = renameSavedPlotInList(plots, "p1", " \t");
  const tooLong = renameSavedPlotInList(plots, "p1", "x".repeat(121));
  const first = renameSavedPlotInList(plots, "p1", "Shared");
  const duplicate = renameSavedPlotInList(first.plots, "p2", " Shared ");

  assert.match(blank.error ?? "", /Enter a saved plot name/);
  assert.match(tooLong.error ?? "", /120 characters or fewer/);
  assert.equal(first.error, null);
  assert.equal(duplicate.error, null);
  assert.equal(duplicate.plots[0].name, "Shared");
  assert.equal(duplicate.plots[1].name, "Shared");
});

test("saved plot card keyboard activation ignores nested controls", () => {
  assert.equal(shouldOpenSavedPlotCardFromKey("Enter", false), true);
  assert.equal(shouldOpenSavedPlotCardFromKey(" ", false), true);
  assert.equal(shouldOpenSavedPlotCardFromKey("Escape", false), false);
  assert.equal(shouldOpenSavedPlotCardFromKey("Enter", true), false);
  assert.equal(shouldOpenSavedPlotCardFromKey(" ", true), false);
});

test("unchanged rename is a no-op and rename does not affect scientific dirty signatures", () => {
  const saved = makeSavedPlot("p1", "First");
  const original = [saved];
  const unchanged = renameSavedPlotInList(original, "p1", " First ", "2026-01-02T00:00:00Z");
  const current = structuredClone(makeSpec([{ kind: "cell", ref_id: 1 }], [])) as any;
  current.saved_plots = [saved];
  current.presentation.quantity = "charge_capacity";
  const currentSignature = plotViewSignature(current);
  const renamed = renameSavedPlotInList(current.saved_plots, "p1", "Renamed", "2026-01-02T00:00:00Z");
  const renamedCurrent = { ...current, saved_plots: renamed.plots };

  assert.equal(unchanged.error, null);
  assert.equal(unchanged.changed, false);
  assert.strictEqual(unchanged.plots, original);
  assert.equal(validateSavedPlotName("  Renamed  ").value, "Renamed");
  assert.equal(plotViewSignature(renamedCurrent), currentSignature);
  assert.notEqual(plotViewSignature(current), plotViewSignature(specForSavedPlotView(current, saved)));
  assert.equal(renamedCurrent.saved_plots[0].id, "p1");
});

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

test("saved plot preview signature changes when saved styling changes", () => {
  const base = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  const savedPlot = {
    id: "plot-style",
    tab: "cycles",
    name: "Styled view",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: structuredClone(base.computation),
    aggregation: structuredClone(base.aggregation),
    presentation: structuredClone(base.presentation),
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as any;
  const before = savedPlotPreviewSignature(base, savedPlot);
  savedPlot.presentation.plot_style = {
    line_width: 4,
    series_colors: { "cell:1": "#ff0000" },
  };

  assert.notEqual(before, savedPlotPreviewSignature(base, savedPlot));
});

test("saved plot preview signature changes on an explicit plot update", () => {
  const base = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  const savedPlot = {
    id: "plot-updated",
    tab: "cycles",
    name: "Updated view",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: structuredClone(base.computation),
    aggregation: structuredClone(base.aggregation),
    presentation: structuredClone(base.presentation),
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as any;
  const before = savedPlotPreviewSignature(base, savedPlot);
  savedPlot.modified_at = "2026-01-02T00:00:00Z";

  assert.notEqual(before, savedPlotPreviewSignature(base, savedPlot));
});

test("saved plot preview signature includes the thumbnail renderer version", () => {
  const base = makeSpec([{ kind: "cell", ref_id: 1 }], []);
  const savedPlot = {
    id: "plot-renderer-version",
    tab: "cycles",
    name: "Versioned preview",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: structuredClone(base.computation),
    aggregation: structuredClone(base.aggregation),
    presentation: structuredClone(base.presentation),
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as any;

  assert.match(
    savedPlotPreviewSignature(base, savedPlot),
    /"thumbnail_renderer_version":\d+/
  );
});

test("saved auxiliary voltage plots restore their selected channel on cold open", () => {
  const base = makeSpec([{ kind: "cell", ref_id: 1 }], []) as any;
  base.computation.time_capacity = { voltage_channel: "working_potential" };
  const savedPlot = {
    id: "plot-working",
    tab: "time_capacity",
    name: "Working potential",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: structuredClone(base.computation),
    aggregation: structuredClone(base.aggregation),
    presentation: structuredClone(base.presentation),
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as any;

  const restored = specForSavedPlotView(base, savedPlot) as any;
  const primaryPlot = {
    ...savedPlot,
    computation: {
      ...savedPlot.computation,
      time_capacity: { voltage_channel: "voltage" },
    },
  };

  assert.equal(restored.computation.time_capacity.voltage_channel, "working_potential");
  assert.notEqual(
    savedPlotPreviewSignature(base, savedPlot),
    savedPlotPreviewSignature(base, primaryPlot)
  );
});

test("saved plot restore keeps global segment definitions and restores plot segment state", () => {
  const current = structuredClone(makeSpec([{ kind: "cell", ref_id: 1 }], []));
  current.protocol_segments = [
    {
      id: "formation",
      name: "Formation",
      targets: [{ protocol_signature: "protocol-a", step_indices: [1, 2] }],
    },
  ];
  current.computation.protocol_filter = { excluded_segment_ids: [], only_segment_ids: [] };
  current.presentation.hidden_protocol_segment_ids = [];
  const savedPlot = {
    id: "plot-segments",
    tab: "cycles",
    name: "Formation hidden",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: {
      ...current.computation,
      protocol_filter: { excluded_segment_ids: ["formation"], only_segment_ids: [] },
    },
    aggregation: current.aggregation,
    presentation: { ...current.presentation, hidden_protocol_segment_ids: ["formation"] },
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as const;

  const restored = specForSavedPlotView(current, savedPlot);

  assert.deepEqual(restored.protocol_segments, current.protocol_segments);
  assert.deepEqual(restored.computation.protocol_filter?.excluded_segment_ids, ["formation"]);
  assert.deepEqual(restored.presentation.hidden_protocol_segment_ids, ["formation"]);
});

test("saved plot previews invalidate when global segment targets change", () => {
  const before = structuredClone(makeSpec([{ kind: "cell", ref_id: 1 }], []));
  before.protocol_segments = [
    {
      id: "rpt",
      name: "RPT",
      targets: [{ protocol_signature: "protocol-a", step_indices: [3] }],
    },
  ];
  before.computation.protocol_filter = { excluded_segment_ids: ["rpt"], only_segment_ids: [] };
  before.presentation.hidden_protocol_segment_ids = [];
  const after = structuredClone(before);
  after.protocol_segments[0].targets[0].step_indices = [3, 4];
  const savedPlot = {
    id: "plot-rpt",
    tab: "cycles",
    name: "RPT removed",
    subtitle: "view",
    description: null,
    selection: { entries: [], exclusions: [] },
    computation: before.computation,
    aggregation: before.aggregation,
    presentation: before.presentation,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  } as const;

  assert.notEqual(savedPlotPreviewSignature(before, savedPlot), savedPlotPreviewSignature(after, savedPlot));
});
