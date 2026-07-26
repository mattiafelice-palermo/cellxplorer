import type { ProtocolGroup } from "./api";

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Fill in the nesting fields a group may lack.
 *
 * Protocol groups reach this panel from several places — a live backend, a
 * cached analysis result, an imported portable report — and those can predate
 * the nested-block fields. Deriving what is missing keeps an older payload
 * rendering as a flat list instead of blanking the page.
 */
export function normalizeGroup(group: ProtocolGroup): ProtocolGroup {
  const children = (group.children ?? []).map(normalizeGroup);
  const own = group.step_numbers ?? [];
  return {
    ...group,
    id: group.id ?? `${group.kind}-${group.start_step}-${group.end_step}`,
    depth: group.depth ?? 0,
    children,
    step_numbers: own,
    all_step_numbers:
      group.all_step_numbers ??
      uniqueSorted([...own, ...children.flatMap((child) => child.all_step_numbers)]),
  };
}
