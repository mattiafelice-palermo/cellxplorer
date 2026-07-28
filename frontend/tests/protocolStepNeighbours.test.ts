import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolGroup } from "../src/api.ts";
import {
  adjacentStepsAroundMatches,
  findInnermostGroupContaining,
  stepsInSameGroupsAsMatches,
} from "../src/protocolStepNeighbours.ts";

function group(
  id: string,
  all: number[],
  direct: number[],
  children: ProtocolGroup[] = [],
  depth = 0
): ProtocolGroup {
  return {
    id,
    kind: "sequence",
    label: id,
    start_step: all[0] ?? 0,
    end_step: all[all.length - 1] ?? 0,
    repeat_count: 1,
    control_step: null,
    depth,
    step_numbers: direct,
    all_step_numbers: all,
    children,
    summary: id,
  };
}

const tree: ProtocolGroup[] = [
  group(
    "outer",
    [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    [17, 18, 19, 20],
    [
      group("inner", [25, 26, 27, 28, 29, 30], [25, 26, 27, 28, 29, 30], [], 1),
    ],
    0
  ),
];

const allSteps = [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

test("findInnermostGroupContaining prefers the nested block", () => {
  assert.equal(findInnermostGroupContaining(tree, 27)?.id, "inner");
  assert.equal(findInnermostGroupContaining(tree, 18)?.id, "outer");
});

test("stepsInSameGroupsAsMatches returns every step in the innermost block", () => {
  const steps = stepsInSameGroupsAsMatches(tree, [27]);
  assert.deepEqual([...steps].sort((a, b) => a - b), [25, 26, 27, 28, 29, 30]);
});

test("adjacentStepsAroundMatches respects count, direction, and group scope", () => {
  const bothInGroup = adjacentStepsAroundMatches(allSteps, tree, [27], 1, "both", "group");
  assert.deepEqual([...bothInGroup].sort((a, b) => a - b), [26, 28]);

  const beforeOnly = adjacentStepsAroundMatches(allSteps, tree, [27], 2, "before", "group");
  assert.deepEqual([...beforeOnly].sort((a, b) => a - b), [25, 26]);

  const allScope = adjacentStepsAroundMatches(allSteps, tree, [27], 1, "after", "all");
  assert.deepEqual([...allScope], [28]);
});
