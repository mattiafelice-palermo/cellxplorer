import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import {
  applySuggestedOrder,
  continuationFindingAction,
  continuationInspectionHasErrors,
  continuationInspectionShouldPoll,
  continuedInspectionStatus,
  findingSummary,
  isSubmitBlocked,
  scientificDraftIsValid,
  sourceRoleLabel,
  shouldAutoApplySuggestedOrder,
} from "../src/continuationPolicy.ts";

function makeResult(
  overrides: Partial<ContinuationInspectResult> = {},
): ContinuationInspectResult {
  return {
    sources: [],
    suggested_order: [],
    suggested_order_basis: "selection_order",
    findings: [],
    inspection_complete: true,
    can_submit: true,
    ...overrides,
  };
}

test("isSubmitBlocked follows can_submit from the server", () => {
  assert.equal(isSubmitBlocked(makeResult({ can_submit: true })), false);
  assert.equal(isSubmitBlocked(makeResult({ can_submit: false })), true);
  assert.equal(isSubmitBlocked(makeResult({ inspection_complete: false })), true);
});

test("applySuggestedOrder preserves existing keys and reorders staged keys", () => {
  const next = applySuggestedOrder(
    ["existing-1", "staged-b", "staged-a"],
    ["staged-a", "staged-b"],
  );
  assert.deepEqual(next, ["existing-1", "staged-a", "staged-b"]);
});

test("automatic ordering requires complete unique timestamp evidence and no manual reorder", () => {
  const recorded = makeResult({
    suggested_order: ["a", "b", "c"],
    suggested_order_basis: "recorded_timestamps",
  });
  assert.equal(shouldAutoApplySuggestedOrder(recorded, ["a", "c", "b"]), true);
  assert.equal(shouldAutoApplySuggestedOrder(recorded, ["a", "c", "b"], true), false);
  assert.equal(shouldAutoApplySuggestedOrder(recorded, ["a", "b", "c"]), false);
  assert.equal(shouldAutoApplySuggestedOrder(
    makeResult({
      inspection_complete: false,
      suggested_order: ["a", "b", "c"],
      suggested_order_basis: "recorded_timestamps",
    }),
    ["a", "c", "b"],
  ), false);
  assert.equal(shouldAutoApplySuggestedOrder(
    makeResult({
      suggested_order: ["a", "b", "c"],
      suggested_order_basis: "selection_order",
    }),
    ["a", "c", "b"],
  ), false);
});

test("sourceRoleLabel marks the final source as the tracked tail", () => {
  const sources = [
    {
      key: "existing-1",
      kind: "existing" as const,
      source_file_id: 1,
      filename: "a.ndax",
      hash: "a",
      start_time: null,
      end_time: null,
      local_cycle_start: null,
      local_cycle_end: null,
      local_cycle_count: null,
      protocol_signature: null,
      device_info: null,
      channel: null,
      nominal_capacity_mah: null,
      active_mass_mg: null,
      inspection_status: "ready" as const,
    },
    {
      key: "staged-b",
      kind: "staged" as const,
      source_file_id: null,
      filename: "b.ndax",
      hash: "b",
      start_time: null,
      end_time: null,
      local_cycle_start: null,
      local_cycle_end: null,
      local_cycle_count: null,
      protocol_signature: null,
      device_info: null,
      channel: null,
      nominal_capacity_mah: null,
      active_mass_mg: null,
      inspection_status: "ready" as const,
    },
  ];
  assert.equal(sourceRoleLabel(sources[0], 0, 2), "Historical source");
  assert.equal(sourceRoleLabel(sources[1], 1, 2), "Tracked tail");
});

test("findingSummary combines title, message, and source keys", () => {
  const summary = findingSummary({
    id: "gap-1",
    code: "timestamp_gap",
    severity: "warning",
    source_keys: ["staged-a", "staged-b"],
    title: "Gap between source files",
    message: "There is about 6.0 days between files.",
    details: {},
  });
  assert.match(summary, /Gap between source files/);
  assert.match(summary, /staged-a → staged-b/);
});

test("inline finding action keeps every non-blocking finding out of the import gate", () => {
  const findings = [
    { id: "warning", code: "gap", severity: "warning" as const, source_keys: ["a"], title: "Gap", message: "", details: {} },
    { id: "info", code: "note", severity: "info" as const, source_keys: [], title: "Note", message: "", details: {} },
  ];
  const informational = makeResult({ findings });
  assert.equal(continuationFindingAction(informational), null);
  assert.equal(continuationFindingAction(makeResult({
    findings: [{ id: "confirm", code: "overlap", severity: "confirmation", source_keys: ["a", "b"], title: "Overlap", message: "", details: {} }],
  })), null);
  assert.equal(continuationFindingAction(makeResult({
    findings: [{ id: "confirm", code: "overlap", severity: "confirmation", source_keys: ["a", "b"], title: "Overlap", message: "", details: {} }],
  }), ["confirm"]), null);
  assert.equal(continuationFindingAction(makeResult({
    findings: [{ id: "block", code: "duplicate", severity: "blocking", source_keys: ["a"], title: "Duplicate", message: "", details: {} }],
  })), "blocking");
  assert.equal(continuationFindingAction(makeResult({ inspection_complete: false, findings })), null);
});

test("continued inspection status distinguishes not-started, preparing, and errored results", () => {
  assert.equal(continuedInspectionStatus(undefined), "not_started");
  assert.equal(continuedInspectionStatus(makeResult({ inspection_complete: false })), "preparing");
  assert.equal(continuedInspectionStatus(undefined, true), "error");
  const failedSource = { inspection_status: "error" } as ContinuationInspectResult["sources"][number];
  const failed = makeResult({ inspection_complete: false, sources: [failedSource] });
  assert.equal(continuedInspectionStatus(failed), "error");
  assert.equal(continuationInspectionHasErrors(failed), true);
});

test("continuation inspection polls while pending unless any source failed", () => {
  const pending = { inspection_status: "pending" } as ContinuationInspectResult["sources"][number];
  const failed = { inspection_status: "error" } as ContinuationInspectResult["sources"][number];
  const ready = { inspection_status: "ready" } as ContinuationInspectResult["sources"][number];

  assert.equal(continuationInspectionShouldPoll(undefined), false);
  assert.equal(continuationInspectionShouldPoll(makeResult({ sources: [pending] })), true);
  assert.equal(continuationInspectionShouldPoll(makeResult({ sources: [failed, ready] })), false);
  assert.equal(continuationInspectionShouldPoll(makeResult({ sources: [failed, pending] })), false);
});

test("continued scientific overrides reject incomplete preset combinations", () => {
  assert.equal(scientificDraftIsValid({
    active_material_selection: "lfp",
    active_mass_mg_override: null,
    nominal_capacity_mah_override: 4,
    electrode_area_cm2_override: null,
  }), false);
  assert.equal(scientificDraftIsValid({
    active_material_selection: "lfp",
    active_mass_mg_override: 10,
    nominal_capacity_mah_override: 4,
    electrode_area_cm2_override: null,
  }), true);
  assert.equal(scientificDraftIsValid({
    active_material_selection: "custom",
    active_mass_mg_override: Number.NaN,
    nominal_capacity_mah_override: null,
    electrode_area_cm2_override: null,
  }), false);
});
