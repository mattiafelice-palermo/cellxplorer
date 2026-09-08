import type { AnalysisSpec, AnalysisTabKey, SavedAnalysisPlot } from "../../../../api";
import { plotViewSignature } from "./analysisPlotPolicy.ts";

export const FAMILY_PRELOAD_MEMORY_BUDGET_BYTES = 100 * 1024 * 1024;
const MAX_PRELOAD_RESULT_BYTES = 2 * 1024 * 1024;
const PRELOAD_VIEW_OVERHEAD_BYTES = 8 * 1024 * 1024;
// Account conservatively for parsed data, trace/calc arrays and view scaffolding.
// This is an admission estimate, not exact browser/GPU memory accounting.
const PRELOAD_RESULT_MEMORY_MULTIPLIER = 16;
export const FAMILY_PRELOAD_RESERVATION_BYTES = PRELOAD_VIEW_OVERHEAD_BYTES +
  MAX_PRELOAD_RESULT_BYTES * PRELOAD_RESULT_MEMORY_MULTIPLIER;
export const FAMILY_PRELOAD_IDLE_MS = 2000;

export function estimatedPreloadedViewMemoryBytes(data: unknown): number {
  if (data === undefined) return PRELOAD_VIEW_OVERHEAD_BYTES;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    // The backend already caps cache-only response bodies at 2 MiB. Small
    // response annotations must not exceed the reservation used for admission.
    return PRELOAD_VIEW_OVERHEAD_BYTES +
      Math.min(bytes, MAX_PRELOAD_RESULT_BYTES) * PRELOAD_RESULT_MEMORY_MULTIPLIER;
  } catch {
    return FAMILY_PRELOAD_RESERVATION_BYTES;
  }
}

export function familyPreloadAdmissionAllowed(args: {
  idleMs: number;
  speculativeBytes: number;
  foregroundFetching: number;
  documentVisible: boolean;
}) {
  return args.documentVisible && args.idleMs >= FAMILY_PRELOAD_IDLE_MS &&
    args.speculativeBytes + FAMILY_PRELOAD_RESERVATION_BYTES <= FAMILY_PRELOAD_MEMORY_BUDGET_BYTES &&
    args.foregroundFetching === 0;
}

const PRIORITY: AnalysisTabKey[] = ["time_capacity", "cycles", "dcir", "steps", "chargeability", "crate"];

/** Preload one saved view per unvisited family, never drafts or every saved card. */
export function familyPreloadCandidates(
  plots: readonly SavedAnalysisPlot[],
  activeTab: AnalysisTabKey,
  visited: ReadonlySet<AnalysisTabKey>,
  attempted: ReadonlySet<string>,
  preferred: Partial<Record<AnalysisTabKey, string>>,
): SavedAnalysisPlot[] {
  return PRIORITY.flatMap((tab) => {
    if (tab === activeTab || visited.has(tab)) return [];
    const family = plots.filter((plot) => plot.tab === tab);
    const plot = family.find((item) => item.id === preferred[tab]) ?? family[0];
    return plot && !attempted.has(familyPreloadIdentity(plot)) ? [plot] : [];
  });
}

export function familyPreloadIdentity(plot: Pick<SavedAnalysisPlot, "id" | "modified_at">) {
  return `${plot.id}:${plot.modified_at}`;
}

/** Equivalent restored specs must not rebuild traces solely because they were cloned. */
export function familyPlotViewSignature(spec: AnalysisSpec) {
  return JSON.stringify({
    view: plotViewSignature(spec),
    entries: spec.selection.entries,
    protocol_segments: spec.protocol_segments ?? [],
  });
}
