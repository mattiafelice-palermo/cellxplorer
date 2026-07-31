import assert from "node:assert/strict";
import test from "node:test";

import { sourceRoleLabel, moveSource } from "../src/continuationPolicy.ts";

const existing = (key: string) => ({
  key,
  kind: "existing" as const,
  source_file_id: Number(key),
  filename: `${key}.ndax`,
  hash: "hash",
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
});

test("existing-cell source lists mark only the final source as the tracked tail", () => {
  const sources = [existing("1"), existing("2"), existing("3")];
  assert.equal(sourceRoleLabel(sources[0], 0, sources.length), "Historical source");
  assert.equal(sourceRoleLabel(sources[2], 2, sources.length), "Tracked tail");
});

test("management reorder cannot move beyond a Test boundary", () => {
  assert.deepEqual(moveSource([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveSource([1, 2, 3], 2, 1), [1, 2, 3]);
});
