import type { ProtocolFamilyGroup } from "../../../../api";

/**
 * A grouping is identified by the set of source families it contains, not by
 * the generated UI id. Sorting makes the identity stable when proposal order
 * changes; JSON avoids collisions if a signature ever contains a separator.
 */
export function protocolGroupMembershipKey(signatures: string[]): string {
  return JSON.stringify([...new Set(signatures)].sort());
}

export function protocolGroupForMembership(
  groups: ProtocolFamilyGroup[],
  signatures: string[],
): ProtocolFamilyGroup | undefined {
  const membershipKey = protocolGroupMembershipKey(signatures);
  return groups.find(
    (group) => protocolGroupMembershipKey(group.family_signatures) === membershipKey,
  );
}

/**
 * Keep only selectable, unique named groupings. A single family already has a
 * raw protocol-family option and must not gain a duplicate named option.
 */
export function normalizeProtocolGroups(
  groups: ProtocolFamilyGroup[],
): ProtocolFamilyGroup[] {
  const seenMemberships = new Set<string>();
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
      const key = protocolGroupMembershipKey(group.family_signatures);
      if (seenMemberships.has(key)) return false;
      seenMemberships.add(key);
      return true;
    });
}
