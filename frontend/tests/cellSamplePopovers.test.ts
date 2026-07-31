import assert from "node:assert/strict";
import test from "node:test";

import { cellFacts, relatedAnalysesForCell } from "../src/cellSamplePopoverLogic.ts";

type Analysis = Parameters<typeof relatedAnalysesForCell>[2][number];

function analysis(id: number, title: string, refs: { kind: string; ref_id: number }[]): Analysis {
  return { id, title, entry_refs: refs } as unknown as Analysis;
}

const cells = new Map([
  [1, { id: 1, name: "NG_376" }],
  [2, { id: 2, name: "NG_377" }],
  [3, { id: 3, name: "NG_378" }],
]);
const groups = new Map([[9, { id: 9, name: "NG replicates", cell_ids: [1, 2, 3] }]]);

test("finds analyses that hold the cell directly", () => {
  const list = [
    analysis(1, "current", [{ kind: "cell", ref_id: 1 }]),
    analysis(2, "elsewhere", [{ kind: "cell", ref_id: 1 }]),
    analysis(3, "unrelated", [{ kind: "cell", ref_id: 2 }]),
  ];
  const related = relatedAnalysesForCell(1, 1, list, cells, groups, []);
  assert.deepEqual(related.map((r) => r.title), ["elsewhere"]);
});

test("finds analyses that hold the cell inside a replicate group", () => {
  // The samples panel lists group members individually, so membership has to
  // be followed or a cell would look unused when it plainly is not.
  const list = [analysis(2, "grouped", [{ kind: "replicate_group", ref_id: 9 }])];
  const related = relatedAnalysesForCell(3, 1, list, cells, groups, []);
  assert.equal(related.length, 1);
  assert.equal(related[0].entries[0].kind, "replicate_group");
  assert.deepEqual(related[0].entries[0].cells.map((c) => c.name), ["NG_376", "NG_377", "NG_378"]);
});

test("never offers the analysis being viewed", () => {
  const list = [analysis(7, "self", [{ kind: "cell", ref_id: 1 }])];
  assert.deepEqual(relatedAnalysesForCell(1, 7, list, cells, groups, []), []);
});

test("marks entries already present so they are not re-added", () => {
  const list = [
    analysis(2, "other", [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 2 },
      { kind: "replicate_group", ref_id: 9 },
    ]),
  ];
  const present = [
    { kind: "cell", ref_id: 2 },
    { kind: "replicate_group", ref_id: 9 },
  ];
  const [related] = relatedAnalysesForCell(1, 1, list, cells, groups, present);
  const byName = new Map(related.entries.map((e) => [e.name, e.alreadyHere]));
  assert.equal(byName.get("NG_376"), false);
  assert.equal(byName.get("NG_377"), true);
  assert.equal(byName.get("NG replicates"), true);
});

test("skips references the caches cannot resolve", () => {
  // A deleted cell or group must not produce an unnamed, unimportable row.
  const list = [
    analysis(2, "other", [
      { kind: "cell", ref_id: 1 },
      { kind: "cell", ref_id: 999 },
      { kind: "replicate_group", ref_id: 998 },
    ]),
  ];
  const [related] = relatedAnalysesForCell(1, 1, list, cells, groups, []);
  assert.deepEqual(related.entries.map((e) => e.name), ["NG_376"]);
});

test("an analysis with no entry_refs contributes nothing", () => {
  // Older backends return an empty list here; the panel must stay quiet rather
  // than claim the cell is unused anywhere.
  const list = [analysis(2, "old backend", [])];
  assert.deepEqual(relatedAnalysesForCell(1, 1, list, cells, groups, []), []);
});

test("cell facts prefer the computed analysis over the stored record", () => {
  const cell = { id: 1, name: "NG_376", total_cycles: 700, total_discharge_capacity_mah: 12 };
  const result = {
    cell_series: [
      {
        cell_id: 1,
        excluded: false,
        active_mass_mg: 334.63,
        metrics: { n_cycles: 767, max_discharge_capacity_mah: 49.8, retention_last_pct: 91.2 },
      },
    ],
  } as unknown as Parameters<typeof cellFacts>[1];

  const facts = cellFacts(cell, result);
  const byLabel = new Map(facts.map((f) => [f.label, f.value]));
  assert.equal(byLabel.get("Cycles"), "767");
  // 49.8 mAh over 0.33463 g
  assert.equal(byLabel.get("Max specific capacity"), "148.8 mAh/g");
  assert.ok(facts.every((f) => f.fromAnalysis));
});

test("cell facts fall back to import-time totals when nothing is computed", () => {
  const cell = {
    id: 1,
    name: "NG_376",
    total_cycles: 700,
    total_discharge_capacity_mah: 12.5,
    n_files: 3,
  };
  const facts = cellFacts(cell, undefined);
  const byLabel = new Map(facts.map((f) => [f.label, f.value]));
  assert.equal(byLabel.get("Cycles"), "700");
  assert.equal(byLabel.get("Total discharge"), "12.50 mAh");
  assert.ok(facts.every((f) => !f.fromAnalysis));
});

test("an excluded series does not count as computed", () => {
  const cell = { id: 1, name: "NG_376", total_cycles: 700 };
  const result = {
    cell_series: [{ cell_id: 1, excluded: true, metrics: { n_cycles: 767 } }],
  } as unknown as Parameters<typeof cellFacts>[1];
  const facts = cellFacts(cell, result);
  assert.equal(new Map(facts.map((f) => [f.label, f.value])).get("Cycles"), "700");
});
