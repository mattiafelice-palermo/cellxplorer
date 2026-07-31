import assert from "node:assert/strict";
import test from "node:test";

import type { ContinuationInspectResult } from "../src/api.ts";
import {
  acknowledgementFindingIds,
  applySuggestedOrder,
  findingSummary,
  isSubmitBlocked,
  scientificDraftIsValid,
  sourceRoleLabel,
} from "../src/continuationPolicy.ts";

function makeResult(
  overrides: Partial<ContinuationInspectResult> = {},
): ContinuationInspectResult {
  return {
    sources: [],
    suggested_order: [],
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

test("acknowledgementFindingIds collects confirmation severities only", () => {
  const ids = acknowledgementFindingIds(
    makeResult({
      findings: [
        {
          id: "confirm-1",
          code: "timestamp_overlap",
          severity: "confirmation",
          source_keys: ["a", "b"],
          title: "Overlap",
          message: "Overlap message",
          details: {},
        },
        {
          id: "warn-1",
          code: "timestamp_gap",
          severity: "warning",
          source_keys: ["a", "b"],
          title: "Gap",
          message: "Gap message",
          details: {},
        },
        {
          id: "block-1",
          code: "duplicate_hash",
          severity: "blocking",
          source_keys: ["a"],
          title: "Duplicate",
          message: "Duplicate message",
          details: {},
        },
      ],
    }),
  );
  assert.deepEqual(ids, ["confirm-1"]);
});

test("applySuggestedOrder preserves existing keys and reorders staged keys", () => {
  const next = applySuggestedOrder(
    ["existing-1", "staged-b", "staged-a"],
    ["staged-a", "staged-b"],
  );
  assert.deepEqual(next, ["existing-1", "staged-a", "staged-b"]);
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
