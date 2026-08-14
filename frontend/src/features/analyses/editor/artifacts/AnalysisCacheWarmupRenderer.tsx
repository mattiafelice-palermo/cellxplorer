import { useEffect } from "react";

import type {
  AnalysisFull,
  CacheWarmupTask,
  SavedAnalysisPlot,
} from "../../../../api";
import {
  hasMetadataOnlySources,
  multiSourceAnalysisPolicy,
  selectedSourceCountCellsForSpec,
} from "../policies/multiSourceAnalysisPolicy";
import {
  SavedPlotPreview,
  SavedTimeCapacityPreview,
} from "./SavedPlotPreviews";

function BlockedWarmupNotice({
  onComplete,
  detail,
}: {
  onComplete: (error?: string, detail?: string) => void;
  detail: string;
}) {
  useEffect(() => {
    onComplete(undefined, detail);
  }, [detail, onComplete]);
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
  const selectedCells = selectedSourceCountCellsForSpec(analysis, analysis.spec);
  if (hasMetadataOnlySources(selectedCells)) {
    return (
      <BlockedWarmupNotice
        onComplete={onComplete}
        detail="Skipped: canonical cycling data is unavailable for a metadata-only source"
      />
    );
  }
  const policy = multiSourceAnalysisPolicy(plot.tab, selectedCells);
  if (policy.family && !policy.supported) {
    return (
      <BlockedWarmupNotice
        onComplete={onComplete}
        detail="Skipped: protocol mapping is required for multi-source Cells"
      />
    );
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
