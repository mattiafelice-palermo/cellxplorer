import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import {
  applySuggestedOrder,
  continuedImportCanSubmit,
  continuationSourceCanOpenRawData,
  moveSource,
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

test("continued import allows non-blocking findings without acknowledgement", () => {
  const current = result({
    findings: [
      { id: "keep", code: "gap", severity: "confirmation", source_keys: [], title: "Keep", message: "", details: {} },
    ],
  });
  assert.equal(continuedImportCanSubmit(current, "Cell A"), true);
  assert.equal(continuedImportCanSubmit(result({ can_submit: false }), "Cell A"), false);
});

test("continued raw-data access follows source capability", () => {
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: false, canonical_cycling: true }), true);
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: true, canonical_cycling: false }), false);
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: false, canonical_cycling: false }), false);
  assert.equal(
    continuationSourceCanOpenRawData(
      { metadata_only: true, canonical_cycling: false, inspection_status: "ready" },
      { rawDataAvailable: true },
    ),
    true,
  );
  assert.equal(
    continuationSourceCanOpenRawData(
      { metadata_only: true, canonical_cycling: false, inspection_status: "error" },
      { rawDataAvailable: true },
    ),
    false,
  );
});

test("suggested order and keyboard movement keep the visible source order explicit", () => {
  assert.deepEqual(applySuggestedOrder(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"]);
  assert.deepEqual(moveSource(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveSource(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
});

test("continued import remains blocked while inspection is pending or has blocking findings", () => {
  const pending = result({ inspection_complete: false, can_submit: false });
  assert.equal(continuedImportCanSubmit(pending, "Cell A"), false);
  const blocked = result({
    can_submit: false,
    findings: [{ id: "block", code: "overlap", severity: "blocking", source_keys: [], title: "Blocked", message: "", details: {} }],
  });
  assert.equal(continuedImportCanSubmit(blocked, "Cell A"), false);
});
