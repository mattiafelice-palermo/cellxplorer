import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import {
  applySuggestedOrder,
  continuedImportCanSubmit,
  moveSource,
  preserveAcknowledgements,
} from "../src/continuationPolicy.ts";

function result(overrides: Partial<ContinuationInspectResult> = {}): ContinuationInspectResult {
  return {
    sources: [],
    suggested_order: [],
    findings: [],
    inspection_complete: true,
    can_submit: true,
    ...overrides,
  };
}

test("continued import preserves only acknowledgements for unchanged findings", () => {
  const current = result({
    findings: [
      { id: "keep", code: "gap", severity: "confirmation", source_keys: [], title: "Keep", message: "", details: {} },
      { id: "drop", code: "gap", severity: "confirmation", source_keys: [], title: "Drop", message: "", details: {} },
    ],
  });
  assert.deepEqual(preserveAcknowledgements(["keep", "drop", "unknown"], current), ["keep", "drop"]);
  assert.equal(continuedImportCanSubmit(current, "Cell A", ["keep", "drop"]), true);
  assert.equal(continuedImportCanSubmit(current, "Cell A", ["keep"]), false);
});

test("suggested order and keyboard movement keep the visible source order explicit", () => {
  assert.deepEqual(applySuggestedOrder(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"]);
  assert.deepEqual(moveSource(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveSource(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
});

test("continued import remains blocked while inspection is pending or has blocking findings", () => {
  const pending = result({ inspection_complete: false, can_submit: false });
  assert.equal(continuedImportCanSubmit(pending, "Cell A", []), false);
  const blocked = result({
    can_submit: false,
    findings: [{ id: "block", code: "overlap", severity: "blocking", source_keys: [], title: "Blocked", message: "", details: {} }],
  });
  assert.equal(continuedImportCanSubmit(blocked, "Cell A", []), false);
});
