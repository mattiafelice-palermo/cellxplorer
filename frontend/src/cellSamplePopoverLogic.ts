import type { AnalysisSummary, CellSummary, ComputeResult } from "./api";

/**
 * Facts worth showing about one cell without waiting for anything.
 *
 * Two sources, deliberately in this order: the computed analysis when it is
 * loaded, because those numbers are the ones the plot is drawn from, and the
 * cell record otherwise, whose totals are filled in at import time. A cell that
 * has never been part of a computed analysis therefore still has something to
 * show.
 */
export interface CellFacts {
  label: string;
  value: string;
  fromAnalysis: boolean;
}

function format(value: number | null | undefined, digits: number, unit: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value.toFixed(digits)} ${unit}`;
}

export function cellFacts(
  cell: Pick<CellSummary, "id" | "name"> & Partial<CellSummary>,
  result: ComputeResult | undefined
): CellFacts[] {
  const series = result?.cell_series?.find((s) => s.cell_id === cell.id && !s.excluded);
  const facts: CellFacts[] = [];
  const push = (label: string, value: string | null, fromAnalysis: boolean) => {
    if (value !== null) facts.push({ label, value, fromAnalysis });
  };

  if (series) {
    const mass = series.active_mass_mg;
    const metrics = series.metrics ?? {};
    const maxCapacity = metrics.max_discharge_capacity_mah as number | null | undefined;
    push("Cycles", metrics.n_cycles != null ? String(metrics.n_cycles) : null, true);
    if (mass && maxCapacity != null && Number.isFinite(maxCapacity)) {
      push("Max specific capacity", format(maxCapacity / (mass / 1000), 1, "mAh/g"), true);
    }
    push("Max discharge", format(maxCapacity ?? null, 2, "mAh"), true);
    push(
      "Retention (last)",
      format(metrics.retention_last_pct as number | null, 1, "%"),
      true
    );
    push(
      "Cycles to 80%",
      metrics.cycles_to_80_pct != null ? String(metrics.cycles_to_80_pct) : null,
      true
    );
    push("Mean CE", format(metrics.mean_ce_pct as number | null, 2, "%"), true);
  } else {
    push("Cycles", cell.total_cycles != null ? String(cell.total_cycles) : null, false);
    push("Total discharge", format(cell.total_discharge_capacity_mah, 2, "mAh"), false);
    const mass = cell.scientific_metadata?.active_mass_mg?.effective_value ?? null;
    push("Active mass", format(mass, 2, "mg"), false);
    push(
      "Files",
      cell.n_files != null ? `${cell.n_files} in ${cell.n_tests ?? 0} test(s)` : null,
      false
    );
  }
  return facts;
}

export interface RelatedAnalysis {
  id: number;
  title: string;
  entries: {
    kind: "cell" | "replicate_group";
    ref_id: number;
    name: string;
    cells: { id: number; name: string }[];
    alreadyHere: boolean;
  }[];
}

/**
 * Find the other analyses that contain a cell.
 *
 * Resolved entirely from caches the app already holds: analysis summaries carry
 * compact `entry_refs`, and cell and replicate-group lists are kept from
 * startup. No request is made, so this stays instant inside a popover.
 */
export function relatedAnalysesForCell(
  cellId: number,
  currentAnalysisId: number,
  analyses: AnalysisSummary[],
  cellsById: Map<number, { id: number; name: string }>,
  groupsById: Map<number, { id: number; name: string; cell_ids: number[] }>,
  presentRefs: { kind: string; ref_id: number }[]
): RelatedAnalysis[] {
  const here = new Set(presentRefs.map((r) => `${r.kind}:${r.ref_id}`));
  const out: RelatedAnalysis[] = [];

  for (const analysis of analyses) {
    if (analysis.id === currentAnalysisId) continue;
    const refs = analysis.entry_refs ?? [];
    const containsCell = refs.some((ref) =>
      ref.kind === "cell"
        ? ref.ref_id === cellId
        : (groupsById.get(ref.ref_id)?.cell_ids ?? []).includes(cellId)
    );
    if (!containsCell) continue;

    const entries: RelatedAnalysis["entries"] = [];
    for (const ref of refs) {
      if (ref.kind === "cell") {
        const cell = cellsById.get(ref.ref_id);
        if (!cell) continue;
        entries.push({
          kind: "cell",
          ref_id: ref.ref_id,
          name: cell.name,
          cells: [cell],
          alreadyHere: here.has(`cell:${ref.ref_id}`),
        });
      } else {
        const group = groupsById.get(ref.ref_id);
        if (!group) continue;
        entries.push({
          kind: "replicate_group",
          ref_id: ref.ref_id,
          name: group.name,
          cells: group.cell_ids
            .map((id) => cellsById.get(id))
            .filter((c): c is { id: number; name: string } => Boolean(c)),
          alreadyHere: here.has(`replicate_group:${ref.ref_id}`),
        });
      }
    }
    out.push({ id: analysis.id, title: analysis.title, entries });
  }
  return out;
}
