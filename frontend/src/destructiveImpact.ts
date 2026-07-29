export type DestructiveImpactConfirmOptions = {
  deleteEmptyAnalyses: boolean;
  /** Preflight empty-after ids; backend rechecks before deleting. */
  emptyAfterCandidateIds: number[];
};

/** Do not flash a placeholder modal while the usage preflight is in flight. */
export function destructiveImpactModalVisible(
  requestedOpen: boolean,
  fetchingUsage: boolean,
): boolean {
  return requestedOpen && !fetchingUsage;
}
