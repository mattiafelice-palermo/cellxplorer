import type { ProtocolGroup } from "./api";

export type NeighbourDirection = "before" | "after" | "both";
export type NeighbourScope = "group" | "all";

/** Deepest protocol block that still owns this step number. */
export function findInnermostGroupContaining(
  groups: ProtocolGroup[],
  stepNumber: number
): ProtocolGroup | null {
  for (const group of groups) {
    if (!group.all_step_numbers.includes(stepNumber)) continue;
    const deeper = findInnermostGroupContaining(group.children, stepNumber);
    return deeper ?? group;
  }
  return null;
}

/** Every step in the innermost block(s) that contain the filtered matches. */
export function stepsInSameGroupsAsMatches(
  groups: ProtocolGroup[],
  matchSteps: Iterable<number>
): Set<number> {
  const result = new Set<number>();
  for (const step of matchSteps) {
    const group = findInnermostGroupContaining(groups, step);
    if (!group) continue;
    for (const number of group.all_step_numbers) {
      result.add(number);
    }
  }
  return result;
}

/** Steps within N positions before/after each match in protocol order. */
export function adjacentStepsAroundMatches(
  allSteps: number[],
  groups: ProtocolGroup[],
  matchSteps: Iterable<number>,
  count: number,
  direction: NeighbourDirection,
  scope: NeighbourScope
): Set<number> {
  const matches = [...matchSteps];
  if (matches.length === 0 || count < 1) return new Set();

  const indexByNumber = new Map(allSteps.map((number, index) => [number, index]));
  const result = new Set<number>();
  const steps = Math.min(Math.floor(count), 999);

  for (const step of matches) {
    const index = indexByNumber.get(step);
    if (index === undefined) continue;

    const allowed =
      scope === "all"
        ? null
        : new Set(findInnermostGroupContaining(groups, step)?.all_step_numbers ?? []);

    for (let distance = 1; distance <= steps; distance += 1) {
      if (direction === "before" || direction === "both") {
        const before = allSteps[index - distance];
        if (before !== undefined && (!allowed || allowed.has(before))) {
          result.add(before);
        }
      }
      if (direction === "after" || direction === "both") {
        const after = allSteps[index + distance];
        if (after !== undefined && (!allowed || allowed.has(after))) {
          result.add(after);
        }
      }
    }
  }

  return result;
}
