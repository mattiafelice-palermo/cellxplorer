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
  source_count?: number | null;
}

export interface MultiSourceAnalysisPolicy {
  family: ProtocolAnalysisFamily | null;
  supported: boolean;
  pending: boolean;
  unsupportedCells: SourceCountCell[];
  unresolvedCells: SourceCountCell[];
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
  const unresolvedCells = family
    ? cells.filter((cell) => cell.source_count == null)
    : [];
  const pending = unresolvedCells.length > 0;
  return {
    family,
    supported: unsupportedCells.length === 0 && !pending,
    pending,
    unsupportedCells,
    unresolvedCells,
    supportedAlternatives: ["cycles", "time_capacity"] as const,
    message:
      pending
        ? "Checking source compatibility for the current selection. CellXplorer will not compute or export this protocol plot until every selected Cell's ordered source chain is known."
        : "This plot uses source-local protocol steps. Restarted source files can renumber steps, so CellXplorer refuses to guess how a continuation chain maps across files.",
  };
}
