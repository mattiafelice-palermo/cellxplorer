/**
 * Terminal-state resolution for a background cache-warmup task.
 *
 * Kept pure and free of React/JSX so node --test can exercise it under type
 * stripping, and so the two preview components cannot drift apart — the queue
 * deadlock this fixes existed precisely because the logic was duplicated.
 *
 * The contract that matters: every reachable combination of query states must
 * resolve to `done`, except the genuinely-still-working one. A state that
 * resolves to `pending` forever leaves `CacheWarmupCoordinator` with
 * `busy.current === true`, which stalls the whole queue for the session.
 */

export interface WarmupSignals {
  /** Thumbnail rendering was attempted and failed. */
  generationFailed: boolean;
  /** Both the saved-row and hover thumbnails exist — the success case. */
  thumbnailPairReady: boolean;
  /** The thumbnail lookup request itself failed (404 is not a failure). */
  thumbnailErrored: boolean;
  thumbnailError?: unknown;
  /** The artifact lookup request itself failed (404 is not a failure). */
  artifactErrored: boolean;
  artifactError?: unknown;
  /** The compute request failed. */
  previewErrored: boolean;
  previewError?: unknown;
  /** The compute request succeeded. */
  previewSucceeded: boolean;
  traceCount: number;
  /** This pass computed the data and rendered the thumbnail. */
  renderedFresh: boolean;
  /** This pass rebuilt a thumbnail from an already-cached plot. */
  rebuiltThumbnail: boolean;
}

export type WarmupResolution =
  | { status: "pending" }
  | { status: "done"; error?: string; detail?: string; disposition?: "ready" | "skipped" };

const PENDING: WarmupResolution = { status: "pending" };

export function warmupErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/**
 * Resolve a warmup task's outcome. Order is significant: a genuine success
 * outranks a stale error, and the lookup failures are checked before the
 * compute states because a failed lookup leaves the compute query disabled —
 * so `previewErrored`/`previewSucceeded` both stay false and would otherwise
 * fall through to `pending` forever.
 */
export function resolveWarmup(signals: WarmupSignals): WarmupResolution {
  if (signals.generationFailed) {
    return { status: "done", error: "Thumbnail generation failed" };
  }
  if (signals.thumbnailPairReady) {
    return {
      status: "done",
      detail: signals.renderedFresh
        ? "Computed data and rendered thumbnail"
        : signals.rebuiltThumbnail
          ? "Thumbnail rebuilt from cached plot"
          : "Already cached",
    };
  }
  if (signals.thumbnailErrored) {
    return {
      status: "done",
      error: warmupErrorMessage(signals.thumbnailError, "Thumbnail lookup failed"),
    };
  }
  if (signals.artifactErrored) {
    return {
      status: "done",
      error: warmupErrorMessage(signals.artifactError, "Plot artifact lookup failed"),
    };
  }
  if (signals.previewErrored) {
    return {
      status: "done",
      error: warmupErrorMessage(signals.previewError, "Plot computation failed"),
    };
  }
  if (signals.previewSucceeded && signals.traceCount === 0) {
    return {
      status: "done",
      disposition: "skipped",
      detail: "No plottable data is available for this saved plot",
    };
  }
  return PENDING;
}
