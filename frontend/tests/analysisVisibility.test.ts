import assert from "node:assert/strict";
import test from "node:test";

import { isCellHiddenInAnalysis, type CellSelectionContext } from "../src/analysisVisibility.ts";
import type { AnalysisSpec } from "../src/api.ts";

function specWithVisibility(
  exclusions: AnalysisSpec["selection"]["exclusions"],
  hiddenGroups: number[] = [],
): AnalysisSpec {
  return {
    selection: {
      entries: [],
      exclusions,
      hidden_replicate_group_ids: hiddenGroups,
    },
  } as AnalysisSpec;
}

const duplicateContexts: CellSelectionContext[] = [
  { cell_id: 7, entry_kind: "cell", entry_ref_id: 7 },
  { cell_id: 7, entry_kind: "replicate_group", entry_ref_id: 42 },
];

test("a scoped exclusion does not hide a cell that remains visible elsewhere", () => {
  const spec = specWithVisibility([
    {
      cell_id: 7,
      entry_kind: "replicate_group",
      entry_ref_id: 42,
    },
  ]);

  assert.equal(isCellHiddenInAnalysis(spec, 7, duplicateContexts), false);
});

test("a shared cell is hidden when every occurrence is hidden", () => {
  const spec = specWithVisibility([
    { cell_id: 7, entry_kind: "cell", entry_ref_id: 7 },
    {
      cell_id: 7,
      entry_kind: "replicate_group",
      entry_ref_id: 42,
    },
  ]);

  assert.equal(isCellHiddenInAnalysis(spec, 7, duplicateContexts), true);
});

test("a hidden replicate does not hide the same cell's standalone occurrence", () => {
  assert.equal(
    isCellHiddenInAnalysis(specWithVisibility([], [42]), 7, duplicateContexts),
    false,
  );
});

test("legacy cell-wide exclusions still hide every occurrence", () => {
  assert.equal(
    isCellHiddenInAnalysis(
      specWithVisibility([{ cell_id: 7 }]),
      7,
      duplicateContexts,
    ),
    true,
  );
});
