import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNormalWorkspace,
  buildCommitSavedPlotSpec,
  buildDiscardEditedSavedPlotSpec,
  buildDiscardNewPlotSpec,
  buildStablePersistSpec,
  captureNormalWorkspace,
  draftPreviewPlotId,
  isDraftPreviewPlotId,
  plotSessionBelongsToTab,
  resolveColdOpenWorkspace,
  savedPlotFromDraftSource,
  stripDraftPlots,
  type NormalWorkspaceSnapshot,
} from "../src/analysisDraftPolicy.ts";
import type { AnalysisDraftPlot, AnalysisSpec, SavedAnalysisPlot } from "../src/api.ts";
import { plotViewSignature } from "../src/analysisPlotPolicy.ts";

function makeSpec(quantity: string): AnalysisSpec {
  return {
    spec_version: 5,
    type: "cycling",
    title: "analysis",
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    selection: {
      entries: [{ kind: "cell", ref_id: 1 }],
      exclusions: [],
      hidden_replicate_group_ids: [],
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
      quantity,
      normalize_by_mass: false,
      ce_overlay: true,
      show_individual_cells: true,
      legend: true,
    },
    saved_plots: [],
    draft_plots: null,
    draft_plot: null,
  };
}

function makeDraft(quantity: string, tab: AnalysisDraftPlot["tab"] = "cycles"): AnalysisDraftPlot {
  return {
    tab,
    name: null,
    selection: {
      entries: [],
      exclusions: [],
      hidden_replicate_group_ids: [],
    },
    computation: makeSpec(quantity).computation,
    aggregation: makeSpec(quantity).aggregation,
    presentation: {
      ...makeSpec(quantity).presentation,
      quantity,
    },
    updated_at: "2026-07-25T12:00:00Z",
  };
}

function makeSaved(quantity: string, id = "p1"): SavedAnalysisPlot {
  const baseline = makeSpec(quantity);
  return {
    id,
    tab: "cycles",
    name: "Saved",
    subtitle: "",
    description: null,
    selection: { entries: [], exclusions: [], hidden_replicate_group_ids: [] },
    computation: baseline.computation,
    aggregation: baseline.aggregation,
    presentation: baseline.presentation,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
  };
}

test("stripDraftPlots clears draft fields", () => {
  const spec = makeSpec("discharge_capacity");
  spec.draft_plots = { cycles: makeDraft("energy") };
  const next = stripDraftPlots(spec);
  assert.equal(next.draft_plots, null);
  assert.equal(next.draft_plot, null);
});

test("stable persist for draft session restores normal and keeps membership", () => {
  const normalSpec = makeSpec("discharge_capacity");
  normalSpec.selection.entries = [];
  const normal = captureNormalWorkspace(normalSpec, "cycles");
  const draftView = makeSpec("charge_capacity");
  draftView.selection.entries = [{ kind: "cell", ref_id: 7 }];
  draftView.draft_plots = { cycles: makeDraft("charge_capacity") };

  const persisted = buildStablePersistSpec({
    current: draftView,
    mode: "draft_session",
    normal,
  });

  assert.equal(persisted.presentation.quantity, "discharge_capacity");
  assert.deepEqual(persisted.selection.entries, [{ kind: "cell", ref_id: 7 }]);
  assert.equal(persisted.draft_plots, null);
});

test("stable persist for edited saved plot writes the baseline, not the edits", () => {
  const saved = makeSaved("discharge_capacity");
  const edited = makeSpec("charge_capacity");
  edited.saved_plots = [saved];
  edited.selection.entries = [{ kind: "cell", ref_id: 9 }];

  const persisted = buildStablePersistSpec({
    current: edited,
    mode: "edited_saved",
    savedPlot: saved,
  });

  assert.equal(persisted.presentation.quantity, "discharge_capacity");
  assert.deepEqual(persisted.selection.entries, [{ kind: "cell", ref_id: 9 }]);
  assert.equal(persisted.draft_plots, null);
});

test("cold open strips drafts and opens the first saved plot", () => {
  const first = makeSaved("discharge_capacity", "p1");
  const second = makeSaved("charge_capacity", "p2");
  const spec = makeSpec("energy");
  spec.saved_plots = [first, second];
  spec.draft_plots = { cycles: makeDraft("energy") };

  const opened = resolveColdOpenWorkspace({
    spec,
    tab: "cycles",
    viewSignature: plotViewSignature,
  });

  assert.equal(opened.activeSavedPlotId, "p1");
  assert.equal(opened.plotSessionActive, true);
  assert.equal(opened.spec.presentation.quantity, "discharge_capacity");
  assert.equal(opened.spec.draft_plots, null);
  assert.equal(opened.changed, true);
});

test("cold open with no saved plots stays empty", () => {
  const fresh = makeSpec("discharge_capacity");
  fresh.selection.entries = [];
  fresh.draft_plots = { cycles: makeDraft("charge_capacity") };
  const opened = resolveColdOpenWorkspace({
    spec: fresh,
    tab: "cycles",
    viewSignature: plotViewSignature,
  });
  assert.equal(opened.plotSessionActive, false);
  assert.equal(opened.activeSavedPlotId, null);
  assert.equal(opened.spec.draft_plots, null);
});

test("cold open prefers a remembered plot id on the tab", () => {
  const first = makeSaved("discharge_capacity", "p1");
  const second = makeSaved("charge_capacity", "p2");
  const spec = makeSpec("energy");
  spec.saved_plots = [first, second];
  const opened = resolveColdOpenWorkspace({
    spec,
    tab: "cycles",
    viewSignature: plotViewSignature,
    preferredPlotId: "p2",
  });
  assert.equal(opened.activeSavedPlotId, "p2");
  assert.equal(opened.spec.presentation.quantity, "charge_capacity");
});

test("cold open for a tab without saved plots stays empty even if other tabs have plots", () => {
  const spec = makeSpec("discharge_capacity");
  spec.saved_plots = [makeSaved("discharge_capacity", "cycles-1")];
  const opened = resolveColdOpenWorkspace({
    spec,
    tab: "steps",
    viewSignature: plotViewSignature,
  });
  assert.equal(opened.plotSessionActive, false);
  assert.equal(opened.activeSavedPlotId, null);
});

test("draft preview plot ids are detectable and never look like saved ids", () => {
  assert.equal(isDraftPreviewPlotId(draftPreviewPlotId("cycles")), true);
  assert.equal(isDraftPreviewPlotId("e7e49df4-a2fd-47d1-a186-6dbd7a279315"), false);
});

test("plot session belongs only to its own family tab", () => {
  assert.equal(
    plotSessionBelongsToTab({
      tab: "steps",
      activeTab: "steps",
      plotSessionActive: true,
      activeSavedPlotId: "p1",
      activePlotTab: "cycles",
      plotWorkspaceTouched: false,
    }),
    false,
  );
  assert.equal(
    plotSessionBelongsToTab({
      tab: "cycles",
      activeTab: "cycles",
      plotSessionActive: true,
      activeSavedPlotId: "p1",
      activePlotTab: "cycles",
      plotWorkspaceTouched: false,
    }),
    true,
  );
  assert.equal(
    plotSessionBelongsToTab({
      tab: "steps",
      activeTab: "steps",
      plotSessionActive: true,
      activeSavedPlotId: null,
      activePlotTab: null,
      plotWorkspaceTouched: true,
    }),
    true,
  );
  assert.equal(
    plotSessionBelongsToTab({
      tab: "cycles",
      activeTab: "steps",
      plotSessionActive: true,
      activeSavedPlotId: null,
      activePlotTab: null,
      plotWorkspaceTouched: true,
    }),
    false,
  );
});

test("saving a plot clears draft fields", () => {
  const active = makeSpec("discharge_capacity");
  active.draft_plots = { cycles: makeDraft("charge_capacity") };
  const plot = savedPlotFromDraftSource({
    draft: makeDraft("charge_capacity"),
    name: "From draft",
    subtitle: "",
    description: null,
    id: "p-draft",
    modifiedAt: "2026-07-25T12:00:00Z",
  });
  const next = buildCommitSavedPlotSpec({
    current: active,
    plot,
    source: "draft",
    afterSave: "none",
  });
  assert.equal(next.saved_plots?.at(-1)?.presentation.quantity, "charge_capacity");
  assert.equal(next.draft_plots, null);
});

test("new-plot continuation clears drafts", () => {
  const active = makeSpec("discharge_capacity");
  active.draft_plots = {
    cycles: makeDraft("charge_capacity", "cycles"),
    steps: makeDraft("energy", "steps"),
  };
  const clean: NormalWorkspaceSnapshot = captureNormalWorkspace(
    makeSpec("discharge_capacity"),
    "cycles",
  );
  clean.presentation = {
    ...clean.presentation,
    quantity: "discharge_capacity",
    ce_overlay: false,
  };
  const plot = savedPlotFromDraftSource({
    draft: makeDraft("charge_capacity"),
    name: "Saved draft",
    subtitle: "",
    description: null,
    id: "p1",
    modifiedAt: "2026-07-25T12:00:00Z",
  });
  const next = buildCommitSavedPlotSpec({
    current: active,
    plot,
    source: "draft",
    afterSave: "new_plot",
    newPlotWorkspace: clean,
  });
  assert.equal(next.draft_plots, null);
  assert.equal(next.presentation.ce_overlay, false);
});

test("discard edited saved plot restores baseline", () => {
  const current = makeSpec("charge_capacity");
  const restored = makeSpec("discharge_capacity");
  const next = buildDiscardEditedSavedPlotSpec(current, restored);
  assert.equal(next.presentation.quantity, "discharge_capacity");
  assert.equal(next.draft_plots, null);
});

test("discard new plot restores normal and keeps membership", () => {
  const current = makeSpec("charge_capacity");
  current.selection.entries = [{ kind: "cell", ref_id: 11 }];
  const normalSpec = makeSpec("discharge_capacity");
  normalSpec.selection.entries = [];
  const next = buildDiscardNewPlotSpec(current, captureNormalWorkspace(normalSpec, "cycles"));
  assert.equal(next.presentation.quantity, "discharge_capacity");
  assert.deepEqual(next.selection.entries, [{ kind: "cell", ref_id: 11 }]);
});

test("applyNormalWorkspace does not drop saved plots", () => {
  const current = makeSpec("charge_capacity");
  current.saved_plots = [makeSaved("charge_capacity")];
  const next = applyNormalWorkspace(
    current,
    captureNormalWorkspace(makeSpec("discharge_capacity"), "cycles"),
  );
  assert.equal(next.saved_plots?.length, 1);
});
