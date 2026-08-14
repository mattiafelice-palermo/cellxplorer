import test from "node:test";
import assert from "node:assert/strict";

import {
  hasMetadataOnlySources,
  multiSourceAnalysisPolicy,
  protocolAnalysisFamilyForTab,
  selectedSourceCountCellsForSpec,
} from "../src/features/analyses/editor/policies/multiSourceAnalysisPolicy.ts";

test("maps the C-rate tab to the guarded rate-capability family", () => {
  assert.equal(protocolAnalysisFamilyForTab("crate"), "rate_capability");
  assert.equal(protocolAnalysisFamilyForTab("cycles"), null);
});

test("blocks a protocol family when any selected cell has multiple sources", () => {
  const policy = multiSourceAnalysisPolicy("chargeability", [
    { id: 1, name: "Cell A", source_count: 1 },
    { id: 2, name: "Cell B", source_count: 2 },
  ]);
  assert.equal(policy.supported, false);
  assert.deepEqual(policy.unsupportedCells, [
    { id: 2, name: "Cell B", source_count: 2 },
  ]);
  assert.deepEqual(policy.supportedAlternatives, ["cycles", "time_capacity"]);
});

test("keeps single-source and non-protocol tabs supported", () => {
  assert.equal(
    multiSourceAnalysisPolicy("dcir", [{ id: 1, name: "Cell A", source_count: 1 }]).supported,
    true,
  );
  assert.equal(
    multiSourceAnalysisPolicy("time_capacity", [{ id: 1, name: "Cell A", source_count: 8 }]).supported,
    true,
  );
});

test("keeps protocol analysis fail-closed while a selected source count is unresolved", () => {
  const policy = multiSourceAnalysisPolicy("dcir", [
    { id: 1, name: "Cell A", source_count: null },
  ]);
  assert.equal(policy.pending, true);
  assert.equal(policy.supported, false);
  assert.deepEqual(policy.unresolvedCells, [
    { id: 1, name: "Cell A", source_count: null },
  ]);
});

test("detects metadata-only cells in the live selection", () => {
  const selected = [
    { id: 1, name: "Canonical", source_count: 1, metadata_only: false },
    { id: 2, name: "BioLogic metadata", source_count: 1, metadata_only: true },
  ];
  assert.equal(hasMetadataOnlySources(selected), true);
  assert.equal(hasMetadataOnlySources([selected[0]]), false);
});

test("resolves metadata-only capability from current draft cells, groups, and removals", () => {
  const data = {
    selection_cells: [
      { id: 1, name: "Canonical", source_count: 1, metadata_only: false },
    ],
    selection_groups: [],
  };
  const availableCells = [
    { id: 1, name: "Canonical", n_files: 1, has_metadata_only: false },
    { id: 2, name: "BioLogic metadata", n_files: 1, has_metadata_only: true },
  ];
  const availableGroups = [
    {
      id: 7,
      cells: [
        { id: 1, name: "Canonical", has_metadata_only: false },
        { id: 2, name: "BioLogic metadata", has_metadata_only: true },
      ],
    },
  ];
  const cellSpec = { selection: { entries: [{ kind: "cell" as const, ref_id: 2 }] } };
  const groupSpec = {
    selection: { entries: [{ kind: "replicate_group" as const, ref_id: 7 }] },
  };
  const canonicalSpec = {
    selection: { entries: [{ kind: "cell" as const, ref_id: 1 }] },
  };

  assert.equal(
    hasMetadataOnlySources(
      selectedSourceCountCellsForSpec(data, cellSpec, availableCells, availableGroups),
    ),
    true,
  );
  assert.equal(
    hasMetadataOnlySources(
      selectedSourceCountCellsForSpec(data, groupSpec, availableCells, availableGroups),
    ),
    true,
  );
  assert.equal(
    hasMetadataOnlySources(
      selectedSourceCountCellsForSpec(data, canonicalSpec, availableCells, availableGroups),
    ),
    false,
  );
});
