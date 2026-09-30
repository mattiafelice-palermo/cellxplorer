export const NOTIFICATION_PREFERENCES_CHANGED = "cellxplorer-notification-preferences-changed";
const KEY = "cellxplorer-notification-preferences";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export interface NotificationPreferences { inAppEnabled: boolean; windowsDataUpdatesEnabled: boolean }
export function loadNotificationPreferences(storage: StorageLike): NotificationPreferences {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? "{}");
    return { inAppEnabled: value?.inAppEnabled !== false, windowsDataUpdatesEnabled: value?.windowsDataUpdatesEnabled !== false };
  } catch { return { inAppEnabled: true, windowsDataUpdatesEnabled: true }; }
}
export function saveNotificationPreferences(storage: StorageLike, value: NotificationPreferences): void {
  storage.setItem(KEY, JSON.stringify(value));
}

// Native delivery is once per durable producer batch, independently of the
// in-app read version. The first installation baselines history without toasts.
const deliveredKey = (databaseId: string) => `cellxplorer-analysis-toast:${databaseId}`;
export function readToastBaseline(storage: StorageLike, databaseId: string): number[] | null {
  try {
    const raw = storage.getItem(deliveredKey(databaseId));
    if (raw == null) return null;
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0) : null;
  } catch { return null; }
}
export function saveToastBaseline(storage: StorageLike, databaseId: string, ids: number[]): void {
  try { storage.setItem(deliveredKey(databaseId), JSON.stringify([...new Set(ids)].sort((a, b) => b - a).slice(0, 100))); }
  catch { /* Optional notification delivery state. */ }
}

export const ANALYSIS_NOTIFICATION_KIND = "cellxplorer-analysis-update";
export interface AnalysisNotificationActivation { kind: string; databaseId: string }
export function isAnalysisNotificationActivation(value: unknown): value is AnalysisNotificationActivation {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AnalysisNotificationActivation>;
  return payload.kind === ANALYSIS_NOTIFICATION_KIND && typeof payload.databaseId === "string" && payload.databaseId.trim().length > 0;
}
