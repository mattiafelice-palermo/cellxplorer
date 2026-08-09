import { useEffect } from "react";

import type {
  AnalysisFull,
  AnalysisSpec,
  CacheWarmupTask,
  CellSummary,
  ReplicateGroupSummary,
  SavedAnalysisPlot,
} from "../../../../api";
import {
  multiSourceAnalysisPolicy,
  type SourceCountCell,
} from "../policies/multiSourceAnalysisPolicy";
import {
  SavedPlotPreview,
  SavedTimeCapacityPreview,
} from "./SavedPlotPreviews";

function selectedSourceCountCells(
  analysis: AnalysisFull,
  spec: AnalysisSpec,
  availableCells: Pick<CellSummary, "id" | "name" | "n_files">[] | undefined = [],
  availableGroups: ReplicateGroupSummary[] | undefined = [],
): SourceCountCell[] {
  const direct = new Map<number, SourceCountCell>(
    analysis.selection_cells.map((cell) => [cell.id, cell]),
  );
  for (const cell of availableCells ?? []) {
    if (!direct.has(cell.id)) {
      direct.set(cell.id, { id: cell.id, name: cell.name, source_count: cell.n_files });
    }
  }
  const groups = new Map<number, { cells: SourceCountCell[] }>();
  for (const group of analysis.selection_groups) {
    for (const cell of group.cells) {
      if (!direct.has(cell.id)) direct.set(cell.id, cell);
    }
    groups.set(group.id, { cells: group.cells });
  }
  for (const group of availableGroups ?? []) {
    groups.set(group.id, {
      cells: group.cells.map((cell) => {
        const resolved = direct.get(cell.id);
        return resolved ?? { id: cell.id, name: cell.name, source_count: null };
      }),
    });
  }
  const selected = new Map<number, SourceCountCell>();
  for (const entry of spec.selection.entries ?? []) {
    if (entry.kind === "cell") {
      const cell = direct.get(entry.ref_id) ?? {
        id: entry.ref_id,
        name: `Cell #${entry.ref_id}`,
        source_count: null,
      };
      selected.set(cell.id, cell);
      continue;
    }
    if (entry.kind === "replicate_group") {
      const group = groups.get(entry.ref_id);
      if (!group) {
        selected.set(-entry.ref_id, {
          id: -entry.ref_id,
          name: `Replicate group #${entry.ref_id}`,
          source_count: null,
        });
        continue;
      }
      for (const cell of group.cells) {
        const resolved = direct.get(cell.id) ?? cell;
        selected.set(resolved.id, resolved);
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.id - right.id);
}

function BlockedWarmupNotice({ onComplete }: { onComplete: (error?: string, detail?: string) => void }) {
  useEffect(() => {
    onComplete(undefined, "Skipped: protocol mapping is required for multi-source Cells");
  }, [onComplete]);
  return null;
}

export function AnalysisCacheWarmupRenderer({
  analysis,
  plot,
  task,
  onComplete,
}: {
  analysis: AnalysisFull;
  plot: SavedAnalysisPlot;
  task: CacheWarmupTask;
  onComplete: (error?: string, detail?: string) => void;
}) {
  const policy = multiSourceAnalysisPolicy(
    plot.tab,
    selectedSourceCountCells(analysis, analysis.spec),
  );
  if (policy.family && !policy.supported) {
    return <BlockedWarmupNotice onComplete={onComplete} />;
  }
  return plot.tab === "time_capacity" ? (
    <SavedTimeCapacityPreview
      analysisId={analysis.id}
      baseSpec={analysis.spec}
      plot={plot}
      warmup
      warmupTask={task}
      onWarmupComplete={onComplete}
    />
  ) : (
    <SavedPlotPreview
      analysisId={analysis.id}
      baseSpec={analysis.spec}
      plot={plot}
      warmup
      warmupTask={task}
      onWarmupComplete={onComplete}
    />
  );
}
