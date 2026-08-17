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
