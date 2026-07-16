import { QueryClient } from "@tanstack/react-query";

const ANALYSIS_QUERY_ROOTS = new Set([
  "analysis",
  "compute",
  "time-capacity",
  "saved-plot-preview",
  "saved-time-preview",
]);

function belongsToAnalysis(queryKey: readonly unknown[], analysisId: number): boolean {
  return ANALYSIS_QUERY_ROOTS.has(String(queryKey[0])) && Number(queryKey[1]) === analysisId;
}

export async function clearAnalysisQueryCache(qc: QueryClient, analysisId: number): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    belongsToAnalysis(query.queryKey, analysisId);
  await qc.cancelQueries({ predicate });
  qc.removeQueries({ predicate });
}
