import type { ProtocolFamilyGroup } from "../../../../api";

export type ProtocolGroupDefinition = Pick<
  ProtocolFamilyGroup,
  | "family_signatures"
  | "reference_signature"
  | "comparison_mode"
  | "comparison_dimensions"
  | "ignore_empty_rest_pause"
>;

/**
 * A grouping's family membership is identified independently of its generated
 * UI id. Sorting makes the identity stable when proposal order changes; JSON
 * avoids collisions if a signature ever contains a separator.
 */
export function protocolGroupMembershipKey(signatures: string[]): string {
  return JSON.stringify([...new Set(signatures)].sort());
}

export function protocolGroupDefinitionKey(
  definition: ProtocolGroupDefinition,
): string {
  return JSON.stringify({
    family_signatures: [...new Set(definition.family_signatures)].sort(),
    reference_signature: definition.reference_signature,
    comparison_mode: definition.comparison_mode,
    comparison_dimensions: {
      structure: Boolean(definition.comparison_dimensions.structure),
      termination: Boolean(definition.comparison_dimensions.termination),
      rates: Boolean(definition.comparison_dimensions.rates),
      timing: Boolean(definition.comparison_dimensions.timing),
      voltage: Boolean(definition.comparison_dimensions.voltage),
      recording: Boolean(definition.comparison_dimensions.recording),
    },
    ignore_empty_rest_pause: Boolean(definition.ignore_empty_rest_pause),
  });
}

export function protocolGroupForDefinition(
  groups: ProtocolFamilyGroup[],
  definition: ProtocolGroupDefinition,
): ProtocolFamilyGroup | undefined {
  const definitionKey = protocolGroupDefinitionKey(definition);
  return groups.find(
    (group) => protocolGroupDefinitionKey(group) === definitionKey,
  );
}

/**
 * Return every saved definition for one exact family membership. Membership
 * alone is deliberately not a complete group identity: two definitions may
 * use different comparison dimensions or empty-step policies.
 */
export function protocolGroupsForMembership(
  groups: ProtocolFamilyGroup[],
  familySignatures: string[],
): ProtocolFamilyGroup[] {
  const membershipKey = protocolGroupMembershipKey(familySignatures);
  return groups.filter(
    (group) => protocolGroupMembershipKey(group.family_signatures) === membershipKey,
  );
}

/**
 * Resolve a saved segment's group only from explicit provenance. Membership
 * is checked as a guard against stale metadata, but is never used to choose a
 * different group after the recorded group has been removed.
 */
export function protocolGroupForProvenance(
  groups: ProtocolFamilyGroup[],
  groupId: string | null | undefined,
  familySignatures: string[],
): ProtocolFamilyGroup | undefined {
  if (!groupId) return undefined;
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return undefined;
  return protocolGroupMembershipKey(group.family_signatures) === protocolGroupMembershipKey(familySignatures)
    ? group
    : undefined;
}

/**
 * Keep only selectable, unique named groupings. A single family already has a
 * raw protocol-family option and must not gain a duplicate named option. Two
 * definitions with the same family membership but different comparison
 * settings remain distinct because their scientific basis differs.
 */
export function normalizeProtocolGroups(
  groups: ProtocolFamilyGroup[],
): ProtocolFamilyGroup[] {
  const seenDefinitions = new Set<string>();
  return groups
    .map((group) => ({
      ...group,
      family_signatures: [...new Set(group.family_signatures ?? [])].filter(Boolean),
    }))
    .filter(
      (group) =>
        group.family_signatures.length > 1 &&
        group.family_signatures.includes(group.reference_signature),
    )
    .filter((group) => {
      const key = protocolGroupDefinitionKey(group);
      if (seenDefinitions.has(key)) return false;
      seenDefinitions.add(key);
      return true;
    });
}

/**
 * Merge newly proposed definitions into the complete saved list. Callers of
 * the grouping modal persist the callback result as the analysis-local group
 * collection, so replacing the list with only the current proposals would
 * silently remove earlier groups.
 */
export function mergeProtocolGroups(
  existing: ProtocolFamilyGroup[],
  additions: ProtocolFamilyGroup[],
): ProtocolFamilyGroup[] {
  const merged = normalizeProtocolGroups(existing);
  const seenDefinitions = new Set(merged.map(protocolGroupDefinitionKey));
  for (const group of normalizeProtocolGroups(additions)) {
    const key = protocolGroupDefinitionKey(group);
    if (seenDefinitions.has(key)) continue;
    seenDefinitions.add(key);
    merged.push(group);
  }
  return merged;
}
