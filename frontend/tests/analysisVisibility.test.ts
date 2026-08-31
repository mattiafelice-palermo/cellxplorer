import assert from "node:assert/strict";
import test from "node:test";

import {
  isAnalysisSegmentHidden,
  isAnalysisSampleHidden,
  isCellHiddenInAnalysis,
  isSeriesHidden,
  hiddenSeriesIdsAfterShowAll,
  hiddenSeriesIdsAfterShowOnly,
  plotSeriesVisibilityItems,
  visibilityAfterToggle,
  type CellSelectionContext,
} from "../src/features/analyses/editor/policies/analysisVisibility.ts";
import type { AnalysisSpec } from "../src/api.ts";

function specWithVisibility(
  exclusions: AnalysisSpec["selection"]["exclusions"],
  hiddenGroups: number[] = [],
  entries: AnalysisSpec["selection"]["entries"] = [],
): AnalysisSpec {
  return {
    selection: {
      entries,
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
  ], [], [
    { kind: "cell", ref_id: 7 },
    { kind: "replicate_group", ref_id: 42 },
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
    isAnalysisSampleHidden(specWithVisibility([], [], [{ kind: "cell", ref_id: 7 }]), {
      cell_id: 7,
      group_id: null,
      excluded: true,
    }),
    false,
  );
});

test("live selection hides stale visible rows and removed occurrences", () => {
  assert.equal(
    isAnalysisSampleHidden(
      specWithVisibility(
        [{ cell_id: 7, entry_kind: "cell", entry_ref_id: 7 }],
        [],
        [{ kind: "cell", ref_id: 7 }],
      ),
      { cell_id: 7, group_id: null, excluded: false },
    ),
    true,
  );
  assert.equal(
    isAnalysisSampleHidden(specWithVisibility([]), {
      cell_id: 7,
      group_id: null,
      excluded: false,
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

test("visibility toggles request the opposite of the current hidden state", () => {
  assert.equal(visibilityAfterToggle(false), false);
  assert.equal(visibilityAfterToggle(true), true);
});

test("show only isolates stable series keys and preserves the target", () => {
  const candidates = [
    { key: "series-a", label: "Same label" },
    { key: "series-b", label: "Same label" },
    { key: "series-c", label: "Third" },
  ];
  assert.deepEqual(hiddenSeriesIdsAfterShowOnly([], candidates, "series-a"), [
    "series-b",
    "series-c",
  ]);
  assert.deepEqual(
    hiddenSeriesIdsAfterShowOnly(["series-b", "series-c"], candidates, "series-a"),
    ["series-b", "series-c"],
    "isolating an already-isolated target is idempotent",
  );
  assert.deepEqual(hiddenSeriesIdsAfterShowOnly([], candidates, "series-b"), [
    "series-a",
    "series-c",
  ], "labels do not determine the target");
});

test("show all restores only applicable user-hidden series", () => {
  const candidates = [
    { key: "series-a", label: "A" },
    { key: "series-b", label: "B" },
  ];
  assert.deepEqual(
    hiddenSeriesIdsAfterShowAll(
      ["series-b", "excluded-cell", "unsupported-data"],
      candidates,
    ),
    ["excluded-cell", "unsupported-data"],
  );
});

test("visibility items deduplicate helper descriptors by stable key", () => {
  const spec = specWithVisibility([]);
  spec.presentation = { hidden_series_ids: ["series-b"] } as AnalysisSpec["presentation"];
  assert.deepEqual(
    plotSeriesVisibilityItems(
      [
        { key: "series-a", label: "A" },
        { key: "series-a", label: "A helper" },
        { key: "series-b", label: "B" },
      ],
      spec,
    ),
    [
      { key: "series-a", label: "A", hidden: false },
      { key: "series-b", label: "B", hidden: true },
    ],
  );
});
