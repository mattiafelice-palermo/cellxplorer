import type { AnalysisUpdateNotice } from "./api";

export const ANALYSIS_UPDATES_VIEWED = "cellxplorer-analysis-updates-viewed";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type SeenVersions = Record<string, string>;
const keyFor = (databaseId: string) => `cellxplorer-analysis-updates:${databaseId}`;
export const noticeVersion = (notice: AnalysisUpdateNotice) => notice.finished_at;

export function readSeenUpdates(storage: StorageLike, databaseId: string): SeenVersions {
  try {
    const value: unknown = JSON.parse(storage.getItem(keyFor(databaseId)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, value]) => /^\d+$/.test(key) && typeof value === "string"));
  } catch { return {}; }
}

export function unreadUpdates(notices: AnalysisUpdateNotice[], seen: SeenVersions): AnalysisUpdateNotice[] {
  return notices.filter((notice) => seen[String(notice.id)] !== noticeVersion(notice));
}

export function updateSummary(notices: AnalysisUpdateNotice[]) {
  return {
    analyses: new Set(notices.flatMap((notice) => notice.analyses.map((analysis) => analysis.id))).size,
    cells: new Set(notices.flatMap((notice) => notice.analyses.flatMap((analysis) => analysis.cell_ids))).size,
  };
}

export function acknowledgeUpdates(storage: StorageLike, databaseId: string, notices: AnalysisUpdateNotice[]): void {
  const seen = readSeenUpdates(storage, databaseId);
  for (const notice of notices) seen[String(notice.id)] = noticeVersion(notice);
  // Bound persistent acknowledgement state. Notices are a newest-first limited
  // feed; unrelated database identities never inherit another profile's reads.
  const bounded = Object.fromEntries(Object.entries(seen).sort(([a], [b]) => Number(b) - Number(a)).slice(0, 100));
  try { storage.setItem(keyFor(databaseId), JSON.stringify(bounded)); } catch { /* Read state remains optional. */ }
}
