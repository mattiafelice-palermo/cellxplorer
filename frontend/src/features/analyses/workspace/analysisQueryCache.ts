import { QueryClient } from "@tanstack/react-query";

const ANALYSIS_QUERY_ROOTS = new Set([
  "analysis",
  "compute",
  "time-capacity",
  "saved-plot-preview",
  "saved-time-preview",
  "plot-thumbnail",
  "plot-artifact",
  "steps",
  "dcir",
  "dcir-protocols",
  "chargeability",
  "rate-capability",
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

export async function invalidateAnalysisQueries(
  qc: QueryClient,
  activeAnalysisId: number | null = null,
): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    ANALYSIS_QUERY_ROOTS.has(String(query.queryKey[0]));
  await qc.invalidateQueries({ predicate, refetchType: "none" });
  if (activeAnalysisId !== null) {
    await refreshAnalysisQueries(qc, activeAnalysisId);
  }
}

export async function refreshAnalysisQueries(qc: QueryClient, analysisId: number): Promise<void> {
  await qc.refetchQueries({
    predicate: (query) => belongsToAnalysis(query.queryKey, analysisId) && query.isStale(),
    type: "active",
  });
}
