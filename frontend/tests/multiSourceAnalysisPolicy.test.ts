import test from "node:test";
import assert from "node:assert/strict";

import {
  multiSourceAnalysisPolicy,
  protocolAnalysisFamilyForTab,
} from "../src/multiSourceAnalysisPolicy.ts";

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
