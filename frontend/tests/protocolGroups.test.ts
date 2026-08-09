import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGroup } from "../src/features/analyses/editor/protocol/protocolGroupNormalization.ts";

/**
 * Protocol groups reach the panel from a live backend, a cached analysis
 * result and imported portable reports. Those sources upgrade at different
 * times, so a payload without the nesting fields must still render — reading
 * `all_step_numbers` off an older group threw and blanked the whole page.
 */
const legacyGroup = {
  kind: "repeated_block",
  label: "Repeated block",
  start_step: 8,
  end_step: 12,
  repeat_count: 2,
  control_step: 13,
  step_numbers: [8, 9, 10, 11, 12],
  summary: "Steps 8-12, repeated 2 times",
} as unknown as Parameters<typeof normalizeGroup>[0];

test("a group without nesting fields is filled in rather than crashing", () => {
  const group = normalizeGroup(legacyGroup);
  assert.deepEqual(group.all_step_numbers, [8, 9, 10, 11, 12]);
  assert.deepEqual(group.children, []);
  assert.equal(group.depth, 0);
  assert.ok(group.id, "an id is derived so React keys stay stable");
});

test("derived ids are distinct for different ranges", () => {
  const a = normalizeGroup(legacyGroup);
  const b = normalizeGroup({ ...legacyGroup, start_step: 20, end_step: 24 });
  assert.notEqual(a.id, b.id);
});

test("a legacy group with no steps at all is safe to render", () => {
  const empty = normalizeGroup({
    ...legacyGroup,
    step_numbers: undefined,
  } as unknown as Parameters<typeof normalizeGroup>[0]);
  assert.deepEqual(empty.step_numbers, []);
  assert.deepEqual(empty.all_step_numbers, []);
});

test("nested children are normalized too, and roll up into the parent", () => {
  const parent = normalizeGroup({
    ...legacyGroup,
    start_step: 1,
    end_step: 20,
    step_numbers: [1, 2],
    children: [
      { ...legacyGroup, step_numbers: [8, 9] },
      { ...legacyGroup, start_step: 15, end_step: 16, step_numbers: [15, 16] },
    ],
  } as unknown as Parameters<typeof normalizeGroup>[0]);

  // Selecting the parent must still select everything it runs.
  assert.deepEqual(parent.all_step_numbers, [1, 2, 8, 9, 15, 16]);
  assert.equal(parent.children.length, 2);
  assert.ok(parent.children.every((child) => Array.isArray(child.all_step_numbers)));
});

test("values already present are left untouched", () => {
  const modern = normalizeGroup({
    ...legacyGroup,
    id: "loop-13",
    depth: 2,
    children: [],
    all_step_numbers: [8, 9, 10, 11, 12],
  } as unknown as Parameters<typeof normalizeGroup>[0]);
  assert.equal(modern.id, "loop-13");
  assert.equal(modern.depth, 2);
});
