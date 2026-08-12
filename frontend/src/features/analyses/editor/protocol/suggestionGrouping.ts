/**
 * Pure helpers for grouping protocol segment suggestions by family.
 * Shared across all protocol-based workflows (not DCIR-specific).
 */

export interface SuggestionItem {
  value: string;
  label: string;
}

export interface GroupedSuggestion {
  group: string;
  items: SuggestionItem[];
}

/**
 * Group suggestions by protocol family.
 *
 * Each group heading names the protocol and its cell(s), e.g.
 * "Protocol 1 · NG_20251127_LFP_LP_MoL_376_FM_CY_FC" or
 * "Protocol 1 · NG_20251127_LFP_LP_MoL_376_FM_CY_FC +2 more"
 */
export function groupSuggestionsByFamily(
  suggestions: Array<{
    id: string;
    label: string;
    protocolNumber: number | null;
    signature: string;
    cellNames: string[];
  }>
): GroupedSuggestion[] {
  const bySignature = new Map<
    string,
    {
      protocolNumber: number | null;
      cellNames: string[];
      items: SuggestionItem[];
    }
  >();

  for (const suggestion of suggestions) {
    const family = bySignature.get(suggestion.signature) || {
      protocolNumber: suggestion.protocolNumber,
      cellNames: suggestion.cellNames,
      items: [],
    };
    family.items.push({
      value: suggestion.id,
      label: suggestion.label,
    });
    bySignature.set(suggestion.signature, family);
  }

  // Sort by protocol number, then by signature for stability
  const sorted = [...bySignature.entries()].sort(([, a], [, b]) => {
    if (a.protocolNumber !== null && b.protocolNumber !== null) {
      return a.protocolNumber - b.protocolNumber;
    }
    if (a.protocolNumber !== null) return -1;
    if (b.protocolNumber !== null) return 1;
    return 0;
  });

  return sorted.map(([, family]) => {
    // Format group heading: "Protocol N · first_cell +M more"
    const protocolLabel =
      family.protocolNumber !== null
        ? `Protocol ${family.protocolNumber}`
        : "Protocol —";
    let cellLabel: string;
    if (family.cellNames.length === 0) {
      cellLabel = "no cells";
    } else if (family.cellNames.length === 1) {
      cellLabel = family.cellNames[0];
    } else {
      const remaining = family.cellNames.length - 1;
      cellLabel = `${family.cellNames[0]} +${remaining} more`;
    }
    return {
      group: `${protocolLabel} · ${cellLabel}`,
      items: family.items,
    };
  });
}
