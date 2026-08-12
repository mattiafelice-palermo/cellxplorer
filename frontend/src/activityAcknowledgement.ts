// Pure helpers for activity acknowledgement state, unit-testable without DOM.
// Stores highest acknowledged failed job ID in localStorage to persist across app restarts.

const ACKNOWLEDGED_FAILED_JOB_ID_KEY = "cellxplorer-acknowledged-failed-job-id";

/**
 * Read the highest acknowledged failed job ID from storage.
 * Returns null if not set or if the stored value is not a valid number.
 */
export function readAcknowledgedFailedJobId(storage: Pick<Storage, "getItem">): number | null {
  const stored = storage.getItem(ACKNOWLEDGED_FAILED_JOB_ID_KEY);
  if (!stored) return null;
  const parsed = Number(stored);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Write the highest acknowledged failed job ID to storage.
 */
export function writeAcknowledgedFailedJobId(
  storage: Pick<Storage, "setItem">,
  jobId: number,
): void {
  storage.setItem(ACKNOWLEDGED_FAILED_JOB_ID_KEY, String(jobId));
}

/**
 * Determine if the Activity button should show the failed state (red).
 * Returns true if there exists a failed job with ID > the acknowledged mark.
 *
 * @param failedJobIds Array of job IDs that have status "failed"
 * @param acknowledgedFailedJobId The highest acknowledged failed job ID (or null if none acknowledged)
 * @returns true if button should be red
 */
export function shouldShowActivityFailed(
  failedJobIds: number[],
  acknowledgedFailedJobId: number | null,
): boolean {
  if (failedJobIds.length === 0) return false;
  const maxFailedId = Math.max(...failedJobIds);
  return maxFailedId > (acknowledgedFailedJobId ?? -1);
}
