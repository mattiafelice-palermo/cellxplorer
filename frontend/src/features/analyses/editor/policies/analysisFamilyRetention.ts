import type { AnalysisSpec, AnalysisTabKey, SavedAnalysisPlot } from "../../../../api";
import { plotViewSignature } from "./analysisPlotPolicy.ts";

export const MAX_SPECULATIVE_FAMILY_VIEWS = 2;
export const FAMILY_PRELOAD_IDLE_MS = 2000;

export function familyPreloadAdmissionAllowed(args: {
  idleMs: number;
  speculativeCount: number;
  foregroundFetching: number;
  documentVisible: boolean;
}) {
  return args.documentVisible && args.idleMs >= FAMILY_PRELOAD_IDLE_MS &&
    args.speculativeCount < MAX_SPECULATIVE_FAMILY_VIEWS && args.foregroundFetching === 0;
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
