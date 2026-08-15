import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import {
  acknowledgedMetadataOnlySourceKeys,
  applySuggestedOrder,
  continuedImportCanSubmit,
  continuationSourceCanOpenRawData,
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

test("continued metadata-only acknowledgement is bound to the server finding source key", () => {
  const current = result({
    sources: [
      { key: "metadata-a", kind: "staged", source_file_id: null, filename: "a.mpr", hash: "a", start_time: null, end_time: null, local_cycle_start: null, local_cycle_end: null, local_cycle_count: null, protocol_signature: null, device_info: null, channel: null, nominal_capacity_mah: null, active_mass_mg: null, inspection_status: "ready", canonical_cycling: false, metadata_only: true },
      { key: "metadata-b", kind: "staged", source_file_id: null, filename: "b.mpr", hash: "b", start_time: null, end_time: null, local_cycle_start: null, local_cycle_end: null, local_cycle_count: null, protocol_signature: null, device_info: null, channel: null, nominal_capacity_mah: null, active_mass_mg: null, inspection_status: "ready", canonical_cycling: false, metadata_only: true },
    ],
    findings: [
      { id: "metadata-a-confirm", code: "metadata_only_source", severity: "confirmation", source_keys: ["metadata-a"], title: "Metadata only", message: "", details: {} },
      { id: "metadata-b-confirm", code: "metadata_only_source", severity: "confirmation", source_keys: ["metadata-b"], title: "Metadata only", message: "", details: {} },
    ],
  });
  assert.deepEqual(
    acknowledgedMetadataOnlySourceKeys(current, ["metadata-a-confirm"], ["metadata-a", "metadata-b"]),
    ["metadata-a"],
  );
  assert.deepEqual(
    acknowledgedMetadataOnlySourceKeys(current, ["metadata-a-confirm"], ["metadata-b"]),
    [],
  );
});

test("continued raw-data access follows source capability", () => {
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: false, canonical_cycling: true }), true);
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: true, canonical_cycling: false }), false);
  assert.equal(continuationSourceCanOpenRawData({ metadata_only: false, canonical_cycling: false }), false);
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
