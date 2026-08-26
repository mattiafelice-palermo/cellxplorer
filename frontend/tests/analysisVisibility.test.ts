import assert from "node:assert/strict";
import test from "node:test";

import {
  isAnalysisSegmentHidden,
  isAnalysisSampleHidden,
  isCellHiddenInAnalysis,
  isSeriesHidden,
  type CellSelectionContext,
} from "../src/features/analyses/editor/policies/analysisVisibility.ts";
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

test("a scoped exclusion keeps the legacy no-context result hidden", () => {
  const spec = specWithVisibility([
    {
      cell_id: 7,
      entry_kind: "replicate_group",
      entry_ref_id: 42,
    },
  ]);

  assert.equal(isCellHiddenInAnalysis(spec, 7), true);
});

test("a context that does not belong to the cell does not hide it", () => {
  const spec = specWithVisibility([
    { cell_id: 7, entry_kind: "cell", entry_ref_id: 7 },
  ]);

  assert.equal(
    isCellHiddenInAnalysis(spec, 7, [
      { cell_id: 8, entry_kind: "cell", entry_ref_id: 8 },
    ]),
    false,
  );
});

test("a direct occurrence can be hidden independently", () => {
  const spec = specWithVisibility([
    { cell_id: 7, entry_kind: "cell", entry_ref_id: 7 },
  ]);

  assert.equal(
    isCellHiddenInAnalysis(spec, 7, [
      { cell_id: 7, entry_kind: "cell", entry_ref_id: 7 },
    ]),
    true,
  );
});

test("result-row visibility uses the live draft and exact occurrence context", () => {
  const spec = specWithVisibility([
    { cell_id: 7, entry_kind: "replicate_group", entry_ref_id: 42 },
  ]);

  assert.equal(
    isAnalysisSampleHidden(spec, { cell_id: 7, group_id: 42, excluded: false }),
    true,
  );
  assert.equal(
    isAnalysisSampleHidden(spec, { cell_id: 7, group_id: null, excluded: false }),
    false,
  );
  assert.equal(
    isAnalysisSampleHidden(specWithVisibility([]), {
      cell_id: 7,
      group_id: null,
      excluded: true,
    }),
    true,
  );
});

test("segment and series visibility are read from presentation state", () => {
  const spec = specWithVisibility([]);
  spec.presentation = {
    hidden_analysis_segment_ids: ["segment-hidden"],
    hidden_series_ids: ["series-hidden"],
  } as AnalysisSpec["presentation"];

  assert.equal(isAnalysisSegmentHidden(spec, "segment-hidden"), true);
  assert.equal(isAnalysisSegmentHidden(spec, "segment-visible"), false);
  assert.equal(isSeriesHidden(spec, "series-hidden"), true);
  assert.equal(isSeriesHidden(spec, "series-visible"), false);
});
