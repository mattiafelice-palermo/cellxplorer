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
  metadata_only?: boolean;
}

interface SelectionCapabilityCell {
  id: number;
  name: string;
  source_count?: number | null;
  n_files?: number;
  metadata_only?: boolean;
  has_metadata_only?: boolean;
}

interface SelectionCapabilityGroup {
  id: number;
  cells: SelectionCapabilityCell[];
}

interface SelectionCapabilityData {
  selection_cells?: SelectionCapabilityCell[];
  selection_groups?: SelectionCapabilityGroup[];
}

interface SelectionCapabilitySpec {
  selection?: {
    entries?: { kind: "cell" | "replicate_group"; ref_id: number }[];
  };
}

function normalizeSelectionCapabilityCell(
  cell: SelectionCapabilityCell,
  sourceCountFallback?: number | null,
): SourceCountCell {
  return {
    id: cell.id,
    name: cell.name,
    source_count:
      cell.source_count !== undefined
        ? cell.source_count
        : cell.n_files !== undefined
          ? cell.n_files
          : sourceCountFallback ?? null,
    metadata_only: cell.metadata_only ?? cell.has_metadata_only ?? false,
  };
}

/**
 * Resolve the current draft selection to source capabilities.
 *
 * The persisted AnalysisFull selection is only a fallback: the candidate spec
 * is the live draft, and current cell/group summaries are preferred whenever
 * they are available. Keeping this resolver shared prevents analysis cards,
 * warmup, and portable export from disagreeing about metadata-only sources.
 */
export function selectedSourceCountCellsForSpec(
  data: SelectionCapabilityData | null | undefined,
  spec: SelectionCapabilitySpec | null | undefined,
  availableCells: SelectionCapabilityCell[] = [],
  availableGroups: SelectionCapabilityGroup[] = [],
): SourceCountCell[] {
  const direct = new Map<number, SourceCountCell>();
  for (const cell of data?.selection_cells ?? []) {
    direct.set(cell.id, normalizeSelectionCapabilityCell(cell));
  }
  for (const group of data?.selection_groups ?? []) {
    for (const cell of group.cells) {
      if (!direct.has(cell.id)) {
        direct.set(cell.id, normalizeSelectionCapabilityCell(cell));
      }
    }
  }
  for (const cell of availableCells) {
    direct.set(cell.id, normalizeSelectionCapabilityCell(cell));
  }

  const groups = new Map<number, SourceCountCell[]>();
  for (const group of data?.selection_groups ?? []) {
    groups.set(
      group.id,
      group.cells.map((cell) => {
        const current = direct.get(cell.id);
        return current ?? normalizeSelectionCapabilityCell(cell);
      }),
    );
  }
  for (const group of availableGroups) {
    groups.set(
      group.id,
      group.cells.map((cell) => direct.get(cell.id) ?? normalizeSelectionCapabilityCell(cell)),
    );
  }

  const selected = new Map<number, SourceCountCell>();
  for (const entry of spec?.selection?.entries ?? []) {
    if (entry.kind === "cell") {
      selected.set(
        entry.ref_id,
        direct.get(entry.ref_id) ?? {
          id: entry.ref_id,
          name: `Cell #${entry.ref_id}`,
          source_count: null,
          metadata_only: false,
        },
      );
      continue;
    }
    const group = groups.get(entry.ref_id);
    if (!group) {
      selected.set(-entry.ref_id, {
        id: -entry.ref_id,
        name: `Replicate group #${entry.ref_id}`,
        source_count: null,
        metadata_only: false,
      });
      continue;
    }
    for (const cell of group) selected.set(cell.id, cell);
  }
  return [...selected.values()].sort((left, right) => left.id - right.id);
}

export function hasMetadataOnlySources(cells: SourceCountCell[]): boolean {
  return cells.some((cell) => cell.metadata_only === true);
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
