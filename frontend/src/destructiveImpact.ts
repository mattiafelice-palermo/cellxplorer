export type DestructiveImpactConfirmOptions = {
  deleteEmptyAnalyses: boolean;
  /** Preflight empty-after ids; backend rechecks before deleting. */
  emptyAfterCandidateIds: number[];
};

/**
 * Mantine confirm modals outlive the component state that opened them. Capture
 * the current mutation callback before the parent impact modal closes so the
 * later confirmation cannot observe a cleared request.
 */
export function deferredDestructiveConfirm(
  onConfirm: (options: DestructiveImpactConfirmOptions) => void,
  options: DestructiveImpactConfirmOptions,
): () => void {
  return () => onConfirm(options);
}
