export type ProtocolAnalysisFamily =
  | "steps"
  | "dcir"
  | "chargeability"
  | "rate_capability";

export type ProtocolPolicyTab =
  | ProtocolAnalysisFamily
  | "crate"
  | string;

export interface SourceCountCell {
  id: number;
  name: string;
  source_count?: number;
}

export interface MultiSourceAnalysisPolicy {
  family: ProtocolAnalysisFamily | null;
  supported: boolean;
  unsupportedCells: SourceCountCell[];
  supportedAlternatives: readonly ["cycles", "time_capacity"];
  message: string;
}

export function protocolAnalysisFamilyForTab(
  tab: ProtocolPolicyTab,
): ProtocolAnalysisFamily | null {
  if (tab === "crate") return "rate_capability";
  if (
    tab === "steps" ||
    tab === "dcir" ||
    tab === "chargeability" ||
    tab === "rate_capability"
  ) {
    return tab;
  }
  return null;
}

export function multiSourceAnalysisPolicy(
  tabOrFamily: ProtocolPolicyTab,
  cells: SourceCountCell[],
): MultiSourceAnalysisPolicy {
  const family = protocolAnalysisFamilyForTab(tabOrFamily);
  const unsupportedCells = family
    ? cells.filter((cell) => (cell.source_count ?? 0) > 1)
    : [];
  return {
    family,
    supported: unsupportedCells.length === 0,
    unsupportedCells,
    supportedAlternatives: ["cycles", "time_capacity"] as const,
    message:
      "This plot uses source-local protocol steps. Restarted source files can renumber steps, so CellXplorer refuses to guess how a continuation chain maps across files.",
  };
}
