import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import type { ContinuedScientificDraft } from "../src/continuationPolicy.ts";
import {
  assignContinuationSourceColors,
  buildContinuedImportSubmissionState,
  compactContinuationMetaLine,
  formatContinuationTimestamp,
  nextSelectedSourceKey,
} from "../src/continuedImportWorkspacePolicy.ts";

const PALETTE = ["#111111", "#222222", "#333333"];

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

function validDraft(): ContinuedScientificDraft {
  return {
    active_material_selection: "custom",
    active_mass_mg_override: 10,
    nominal_capacity_mah_override: 5,
    electrode_area_cm2_override: 1,
  };
}

test("assignContinuationSourceColors keeps a source's color after reorder", () => {
  const initial = assignContinuationSourceColors({}, ["a", "b"], PALETTE);
  const reordered = assignContinuationSourceColors(initial, ["b", "a"], PALETTE);
  assert.equal(reordered.a, initial.a);
  assert.equal(reordered.b, initial.b);
});

test("assignContinuationSourceColors preserves existing colors and assigns one new color when a source is added", () => {
  const initial = assignContinuationSourceColors({}, ["a", "b"], PALETTE);
  const withNew = assignContinuationSourceColors(initial, ["a", "b", "c"], PALETTE);
  assert.equal(withNew.a, initial.a);
  assert.equal(withNew.b, initial.b);
  assert.equal(withNew.c, PALETTE[2]);
});

test("assignContinuationSourceColors does not recolor survivors when a source is removed", () => {
  const initial = assignContinuationSourceColors({}, ["a", "b", "c"], PALETTE);
  const withoutB = assignContinuationSourceColors(initial, ["a", "c"], PALETTE);
  assert.equal(withoutB.a, initial.a);
  assert.equal(withoutB.c, initial.c);
  assert.equal(Object.keys(withoutB).length, 2);
});

test("assignContinuationSourceColors repeats the palette once every slot is used, rather than generating colors", () => {
  const assigned = assignContinuationSourceColors({}, ["a", "b", "c", "d"], PALETTE);
  assert.equal(assigned.a, PALETTE[0]);
  assert.equal(assigned.b, PALETTE[1]);
  assert.equal(assigned.c, PALETTE[2]);
  assert.equal(assigned.d, PALETTE[0]);
});

test("assignContinuationSourceColors is deterministic for identical inputs", () => {
  const previous = { a: PALETTE[1]! };
  const first = assignContinuationSourceColors(previous, ["a", "b"], PALETTE);
  const second = assignContinuationSourceColors(previous, ["a", "b"], PALETTE);
  assert.deepEqual(first, second);
});

test("nextSelectedSourceKey keeps the same source selected across reorder", () => {
  assert.equal(nextSelectedSourceKey("b", ["a", "b", "c"], ["c", "b", "a"]), "b");
});

test("nextSelectedSourceKey falls back to the nearest surviving neighbour when the selection is removed", () => {
  // "b" removed; the source that shifts into its old position ("c") is selected.
  assert.equal(nextSelectedSourceKey("b", ["a", "b", "c"], ["a", "c"]), "c");
  // Last source removed; falls back to the new last source.
  assert.equal(nextSelectedSourceKey("c", ["a", "b", "c"], ["a", "b"]), "b");
});

test("nextSelectedSourceKey falls back to the first source when there is no valid previous selection", () => {
  assert.equal(nextSelectedSourceKey(null, [], ["a", "b"]), "a");
  assert.equal(nextSelectedSourceKey("stale", ["stale"], ["a", "b"]), "a");
});

test("nextSelectedSourceKey returns null when no sources remain", () => {
  assert.equal(nextSelectedSourceKey("a", ["a"], []), null);
});

test("formatContinuationTimestamp keeps source wall-clock time while making it readable", () => {
  assert.equal(formatContinuationTimestamp("2026-07-10T14:41:20.7440"), "10/07/2026 14:41");
  assert.equal(formatContinuationTimestamp("2026-07-10 14:41:20"), "10/07/2026 14:41");
  assert.equal(formatContinuationTimestamp("not-a-timestamp"), "not-a-timestamp");
  assert.equal(formatContinuationTimestamp(null), null);
});

test("compactContinuationMetaLine labels source dates and reports only the cycle count", () => {
  assert.equal(
    compactContinuationMetaLine({
      local_cycle_count: 1,
      start_time: "2026-07-10T14:41:20.7440",
      end_time: "2026-07-10T15:42:21.7440",
    }),
    "1 cycle · [S] 10/07/2026 14:41 · [E] 10/07/2026 15:42",
  );
  assert.equal(
    compactContinuationMetaLine({ local_cycle_count: 4, start_time: "2026-07-10T14:41:20", end_time: null }),
    "4 cycles · Started: 10/07/2026 14:41",
  );
});

test("buildContinuedImportSubmissionState carries the exact visible order and acknowledgement ids", () => {
  const inspection = result({
    findings: [
      { id: "confirm-1", code: "timestamp_overlap", severity: "confirmation", source_keys: ["a"], title: "Overlap", message: "", details: {} },
    ],
  });
  const state = buildContinuedImportSubmissionState(
    ["b", "a"],
    validDraft(),
    "Cell A",
    inspection,
    ["confirm-1"],
  );
  assert.deepEqual(state.order, ["b", "a"]);
  assert.deepEqual(state.acknowledgedFindingIds, ["confirm-1"]);
  assert.equal(state.canSubmit, true);
  assert.equal(state.inspectionStatus, "ready");
  assert.equal(state.reviewRequired, false);
});

test("buildContinuedImportSubmissionState blocks submission under two sources even with a clean inspection", () => {
  const state = buildContinuedImportSubmissionState(["a"], validDraft(), "Cell A", result(), []);
  assert.equal(state.canSubmit, false);
  assert.equal(state.inspectionStatus, "ready");
  assert.equal(state.reviewRequired, false);
});

test("buildContinuedImportSubmissionState reports when inspection is still required", () => {
  const state = buildContinuedImportSubmissionState(
    ["a", "b"],
    validDraft(),
    "Cell A",
    result({ inspection_complete: false, can_submit: false }),
    [],
  );
  assert.equal(state.inspectionStatus, "preparing");
  assert.equal(state.reviewRequired, false);
});

test("buildContinuedImportSubmissionState reports inspection errors without changing submission safety", () => {
  const state = buildContinuedImportSubmissionState(
    ["a", "b"],
    validDraft(),
    "Cell A",
    result({
      inspection_complete: false,
      can_submit: false,
      sources: [{ inspection_status: "error" } as ContinuationInspectResult["sources"][number]],
    }),
    [],
  );
  assert.equal(state.canSubmit, false);
  assert.equal(state.inspectionStatus, "error");
});

test("buildContinuedImportSubmissionState blocks submission for an invalid scientific draft", () => {
  const invalidDraft: ContinuedScientificDraft = {
    active_material_selection: "lfp",
    active_mass_mg_override: null,
    nominal_capacity_mah_override: null,
    electrode_area_cm2_override: null,
  };
  const state = buildContinuedImportSubmissionState(["a", "b"], invalidDraft, "Cell A", result(), []);
  assert.equal(state.canSubmit, false);
});

test("buildContinuedImportSubmissionState carries metadata-only source keys bound to acknowledged findings", () => {
  const inspection = result({
    sources: [
      { key: "metadata-a", kind: "staged", source_file_id: null, filename: "a.mpr", hash: "a", start_time: null, end_time: null, local_cycle_start: null, local_cycle_end: null, local_cycle_count: null, protocol_signature: null, device_info: null, channel: null, nominal_capacity_mah: null, active_mass_mg: null, inspection_status: "ready", canonical_cycling: false, metadata_only: true },
    ],
    findings: [
      { id: "metadata-a-confirm", code: "metadata_only_source", severity: "confirmation", source_keys: ["metadata-a"], title: "Metadata only", message: "", details: {} },
    ],
  });
  const state = buildContinuedImportSubmissionState(
    ["metadata-a", "b"],
    validDraft(),
    "Cell A",
    inspection,
    ["metadata-a-confirm"],
  );
  assert.deepEqual(state.metadataOnlySourceKeys, ["metadata-a"]);
});
