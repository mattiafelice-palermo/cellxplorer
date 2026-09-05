import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisSpec, AnalysisTabKey, SavedAnalysisPlot } from "../src/api.ts";
import { familyPlotViewSignature, familyPreloadAdmissionAllowed, familyPreloadCandidates, familyPreloadIdentity } from "../src/features/analyses/editor/policies/analysisFamilyRetention.ts";

function plot(id: string, tab: AnalysisTabKey, modified_at = "2026-09-05") {
  return { id, tab, modified_at } as SavedAnalysisPlot;
}

test("speculative work waits for idle, yields to foreground queries, and stops at two views", () => {
  const ready = { idleMs: 2000, speculativeCount: 0, foregroundFetching: 0, documentVisible: true };
  assert.equal(familyPreloadAdmissionAllowed(ready), true);
  assert.equal(familyPreloadAdmissionAllowed({ ...ready, speculativeCount: 1 }), true);
  assert.equal(familyPreloadAdmissionAllowed({ ...ready, speculativeCount: 2 }), false);
  assert.equal(familyPreloadAdmissionAllowed({ ...ready, idleMs: 1999 }), false);
  assert.equal(familyPreloadAdmissionAllowed({ ...ready, foregroundFetching: 1 }), false);
  assert.equal(familyPreloadAdmissionAllowed({ ...ready, documentVisible: false }), false);
});

test("idle preparation chooses one saved view per unopened family in priority order", () => {
  const plots = [plot("dcir", "dcir"), plot("cycle1", "cycles"), plot("cycle2", "cycles"), plot("tc", "time_capacity"), plot("recap", "recap")];
  const before = JSON.stringify(plots);
  const candidates = familyPreloadCandidates(plots, "time_capacity", new Set(), new Set(), {});
  assert.deepEqual(candidates.map((item) => item.id), ["cycle1", "dcir"]);
  assert.equal(JSON.stringify(plots), before);
});

test("visited families and attempted saved revisions are skipped; changed saved views can be retried", () => {
  const cycles = plot("cycles", "cycles");
  const plots = [cycles, plot("dcir", "dcir"), plot("steps", "steps")];
  const attempted = new Set([familyPreloadIdentity(cycles)]);
  assert.deepEqual(familyPreloadCandidates(plots, "time_capacity", new Set(["dcir"]), attempted, {}).map((item) => item.id), ["steps"]);
  assert.equal(familyPreloadCandidates([plot("cycles", "cycles", "changed")], "time_capacity", new Set(), attempted, {})[0].id, "cycles");
});

test("preparation honors a remembered saved view and falls back when it was deleted", () => {
  const plots = [plot("first", "cycles"), plot("remembered", "cycles")];
  assert.equal(familyPreloadCandidates(plots, "time_capacity", new Set(), new Set(), { cycles: "remembered" })[0].id, "remembered");
  assert.equal(familyPreloadCandidates(plots.slice(0, 1), "time_capacity", new Set(), new Set(), { cycles: "remembered" })[0].id, "first");
  assert.deepEqual(familyPreloadCandidates([], "time_capacity", new Set(), new Set(), {}), []);
});

test("restored plot identity ignores saved-card metadata but includes scientific and visible inputs", () => {
  const spec = {
    selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [] },
    computation: { cycle_range: { start: 1, end: 20 } },
    aggregation: { mode: "none" },
    presentation: { quantity: "discharge_capacity_mah" },
    protocol_segments: [],
    saved_plots: [],
  } as unknown as AnalysisSpec;
  const baseline = familyPlotViewSignature(spec);
  assert.equal(familyPlotViewSignature(structuredClone(spec)), baseline);
  assert.equal(familyPlotViewSignature({ ...spec, saved_plots: [plot("renamed", "cycles")] }), baseline);
  for (const mutate of [
    (next: AnalysisSpec) => { next.selection.entries[0].ref_id = 2; },
    (next: AnalysisSpec) => { next.selection.exclusions = [{ cell_id: 1 }]; },
    (next: AnalysisSpec) => { next.computation.cycle_range.end = 30; },
    (next: AnalysisSpec) => { next.presentation.quantity = "voltage_mean_v"; },
    (next: AnalysisSpec) => { next.protocol_segments = [{ id: "changed" }] as AnalysisSpec["protocol_segments"]; },
  ]) {
    const next = structuredClone(spec);
    mutate(next);
    assert.notEqual(familyPlotViewSignature(next), baseline);
  }
});
