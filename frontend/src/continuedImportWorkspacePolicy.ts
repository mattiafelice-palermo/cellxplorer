import type { ContinuationInspectResult, ContinuationInspectSource } from "./api";
import {
  acknowledgedMetadataOnlySourceKeys,
  continuedImportCanSubmit,
  continuedInspectionStatus,
  continuationFindingAction,
  scientificDraftIsValid,
  type ContinuationFindingAction,
  type ContinuedInspectionStatus,
  type ContinuedScientificDraft,
} from "./continuationPolicy.ts";

export type SourceColorAssignments = Record<string, string>;

/** Format a source timestamp without changing its source-local wall-clock value. */
export function formatContinuationTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/.exec(trimmed);
  if (!match) return trimmed;

  const [, year, month, day, hour, minute] = match;
  const date = `${day!.padStart(2, "0")}/${month!.padStart(2, "0")}/${year}`;
  return hour === undefined ? date : `${date} ${hour.padStart(2, "0")}:${minute}`;
}

/** Compact, labelled source facts for the continued-import source chain. */
export function compactContinuationMetaLine(
  source: Pick<ContinuationInspectSource, "local_cycle_count" | "start_time" | "end_time">,
): string | null {
  const parts: string[] = [];
  if (source.local_cycle_count !== null && source.local_cycle_count !== undefined) {
    parts.push(`${source.local_cycle_count} cycle${source.local_cycle_count === 1 ? "" : "s"}`);
  }
  const start = formatContinuationTimestamp(source.start_time);
  const end = formatContinuationTimestamp(source.end_time);
  if (start && end) {
    parts.push(`[S] ${start}`, `[E] ${end}`);
  } else if (start) {
    parts.push(`Started: ${start}`);
  } else if (end) {
    parts.push(`[E] ${end}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Reorder source keys by the stable indices reported by a sortable drag. */
export function reorderContinuationSourceKeys(keys: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= keys.length || to >= keys.length) return keys;
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return keys;
  next.splice(to, 0, moved);
  return next;
}

/**
 * Assign each ordered source a stable session-only display color.
 *
 * Color belongs to source identity, not list position: an existing key keeps
 * its previously assigned color regardless of where it now sits in
 * `orderedKeys`, so reordering never recolors a source. A new key receives
 * the next palette slot that is not already in use by a surviving key. Once
 * every slot is in use, later new keys repeat the palette from the start
 * (the same repeat behavior the plot style system uses for palette overflow)
 * rather than generating new colors. Keys no longer present in `orderedKeys`
 * are dropped from the returned mapping.
 */
export function assignContinuationSourceColors(
  previous: SourceColorAssignments,
  orderedKeys: string[],
  palette: readonly string[],
): SourceColorAssignments {
  if (palette.length === 0) return {};

  const next: SourceColorAssignments = {};
  const usedIndices = new Set<number>();

  for (const key of orderedKeys) {
    const color = previous[key];
    if (color === undefined) continue;
    next[key] = color;
    const index = palette.indexOf(color);
    if (index >= 0) usedIndices.add(index);
  }

  let cursor = 0;
  for (const key of orderedKeys) {
    if (next[key] !== undefined) continue;
    while (usedIndices.has(cursor % palette.length) && usedIndices.size < palette.length) {
      cursor += 1;
    }
    const index = cursor % palette.length;
    next[key] = palette[index]!;
    usedIndices.add(index);
    cursor += 1;
  }

  return next;
}

/**
 * Pick the source that should remain/become selected for preview after the
 * visible source list changes (reorder, add, or remove).
 *
 * A still-present selection is kept as-is (reordering never moves the
 * selection to a different source). A removed selection falls back to the
 * source now occupying its old position — the nearest surviving neighbour —
 * clamped to the new list length. An invalid or absent selection falls back
 * to the first visible source. An empty list has no valid selection.
 */
export function nextSelectedSourceKey(
  currentKey: string | null,
  previousOrderedKeys: string[],
  nextOrderedKeys: string[],
): string | null {
  if (currentKey !== null && nextOrderedKeys.includes(currentKey)) return currentKey;
  if (nextOrderedKeys.length === 0) return null;

  const previousIndex = currentKey !== null ? previousOrderedKeys.indexOf(currentKey) : -1;
  if (previousIndex < 0) return nextOrderedKeys[0]!;

  const clamped = Math.min(previousIndex, nextOrderedKeys.length - 1);
  return nextOrderedKeys[clamped]!;
}

export type ContinuedImportSubmissionState = {
  canSubmit: boolean;
  order: string[];
  acknowledgedFindingIds: string[];
  metadataOnlySourceKeys: string[];
  inspectionStatus: ContinuedInspectionStatus;
  findingAction: ContinuationFindingAction;
  trackingEnabled: boolean;
};

/**
 * The immutable projection `ImportModal`'s footer needs to submit a
 * continued-cell import, computed from state the workspace editor owns.
 *
 * A continued Cell always needs at least two ordered sources; beyond that,
 * submission safety is exactly the existing continuation policy: a valid
 * scientific draft, a complete/submittable inspection result, and every
 * current confirmation finding acknowledged.
 */
export function buildContinuedImportSubmissionState(
  order: string[],
  cellDraft: ContinuedScientificDraft,
  cellName: string,
  result: ContinuationInspectResult | null | undefined,
  acknowledged: Iterable<string>,
  requestFailed = false,
  trackingEnabled = false,
): ContinuedImportSubmissionState {
  const acknowledgedFindingIds = Array.from(acknowledged);
  const inspectionStatus = continuedInspectionStatus(result, requestFailed);
  return {
    canSubmit:
      (order.length >= 2 || (order.length === 1 && trackingEnabled))
      && scientificDraftIsValid(cellDraft)
      && continuedImportCanSubmit(result, cellName, acknowledgedFindingIds),
    order,
    acknowledgedFindingIds,
    metadataOnlySourceKeys: acknowledgedMetadataOnlySourceKeys(result, acknowledgedFindingIds, order),
    inspectionStatus,
    findingAction: continuationFindingAction(result, acknowledgedFindingIds),
    trackingEnabled,
  };
}
