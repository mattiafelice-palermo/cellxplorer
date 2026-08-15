import type { AnalysisFull, CacheWarmupTask } from "../../../../api";

/** Query identity for one server-owned warmup generation. */
export function warmupAnalysisQueryKey(
  task: CacheWarmupTask | null,
): readonly unknown[] {
  return [
    "analysis-cache-warmup",
    task?.analysis_id,
    task?.id,
    task?.expected_data_signature,
    task?.analysis_modified_at,
    task?.plot_modified_at,
  ];
}

/** Do not render an AnalysisFull response from a superseded warmup task. */
export function warmupAnalysisRevisionsMatch(
  task: CacheWarmupTask | null,
  analysis: Pick<AnalysisFull, "modified_at"> | undefined,
  plotModifiedAt: string | null | undefined,
): boolean {
  return Boolean(
    task &&
      analysis &&
      analysis.modified_at === task.analysis_modified_at &&
      plotModifiedAt === task.plot_modified_at,
  );
}
