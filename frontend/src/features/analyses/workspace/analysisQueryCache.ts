import { QueryClient } from "@tanstack/react-query";

const ANALYSIS_QUERY_ROOTS = new Set([
  "analysis",
  "compute",
  "time-capacity",
  "saved-plot-preview",
  "saved-time-preview",
  "plot-thumbnail",
  "plot-artifact",
  "analysis-database-thumbnail",
  "steps",
  "dcir",
  "dcir-protocols",
  "chargeability",
  "rate-capability",
]);

const SOURCE_SCIENTIFIC_QUERY_ROOTS = new Set([
  "cell-protocol",
  "cell-source-header",
  "cell-cycles",
]);

export interface SourceScientificInvalidationScope {
  cellIds?: Iterable<number>;
  replicateGroupIds?: Iterable<number>;
}

function belongsToAnalysis(queryKey: readonly unknown[], analysisId: number): boolean {
  return ANALYSIS_QUERY_ROOTS.has(String(queryKey[0])) && Number(queryKey[1]) === analysisId;
}

/** The server response is authoritative even if the library selection moved. */
export function sourceUpdateCellId(response: { cell_id?: number | null }): number | null {
  return response.cell_id ?? null;
}

export async function clearAnalysisQueryCache(qc: QueryClient, analysisId: number): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    belongsToAnalysis(query.queryKey, analysisId);
  await qc.cancelQueries({ predicate });
  qc.removeQueries({ predicate });
}

/**
 * Apply a persisted Analysis response without treating the editor save as a
 * source/scientific-data mutation. The detail response is already available,
 * so replacing it directly avoids a second GET; the compact index is still
 * invalidated so its title/modified-time/plot summary can refresh.
 */
export async function refreshPersistedAnalysisQueries<T>(
  qc: QueryClient,
  analysisId: number,
  saved: T,
): Promise<void> {
  qc.setQueryData(["analysis", analysisId], saved);
  await qc.invalidateQueries({ queryKey: ["analyses"] });
}

export async function invalidateAnalysisQueries(
  qc: QueryClient,
  activeAnalysisId?: number | null,
): Promise<void> {
  const scoped = typeof activeAnalysisId === "number";
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    scoped
      ? belongsToAnalysis(query.queryKey, activeAnalysisId)
      : ANALYSIS_QUERY_ROOTS.has(String(query.queryKey[0]));
  // A late result from an older source generation must not repopulate a
  // scientific query after it has been invalidated.
  await qc.cancelQueries({ predicate });
  // A scoped editor save refreshes only its own active queries. A global
  // source/cell mutation refreshes every mounted analysis consumer so a
  // keep-mounted hidden tab cannot stay stale indefinitely.
  await qc.invalidateQueries({
    predicate,
    refetchType: scoped ? "none" : "active",
  });
  if (scoped) {
    await refreshAnalysisQueries(qc, activeAnalysisId);
  }
}

/**
 * Invalidate source-derived queries after a source version or source-chain
 * mutation. The broad replicate-preview invalidation is intentional: a cell
 * may belong to a group that is not available in the mutation response, and
 * the preview payload is a group-level scientific snapshot.
 */
export async function invalidateSourceScientificQueries(
  qc: QueryClient,
  scope: SourceScientificInvalidationScope = {},
): Promise<void> {
  const cellIds = scope.cellIds === undefined ? null : new Set(scope.cellIds);
  const replicateGroupIds =
    scope.replicateGroupIds === undefined ? null : new Set(scope.replicateGroupIds);
  const predicate = (query: { queryKey: readonly unknown[] }) => {
    const root = String(query.queryKey[0]);
    if (SOURCE_SCIENTIFIC_QUERY_ROOTS.has(root)) {
      return cellIds === null || cellIds.has(Number(query.queryKey[1]));
    }
    if (root === "replicate-preview") {
      return (
        replicateGroupIds === null ||
        replicateGroupIds.has(Number(query.queryKey[1]))
      );
    }
    return false;
  };
  // Abort superseded source reads first. Otherwise a late protocol/header
  // response can overwrite the newly adopted source while the query is
  // already marked stale.
  await qc.cancelQueries({ predicate });
  // Active consumers must see the new source immediately. Inactive consumers
  // remain stale and will refetch on their next mount.
  await qc.invalidateQueries({ predicate, refetchType: "active" });
}

export async function refreshAnalysisQueries(qc: QueryClient, analysisId: number): Promise<void> {
  await qc.refetchQueries({
    predicate: (query) => belongsToAnalysis(query.queryKey, analysisId) && query.isStale(),
    type: "active",
  });
}
