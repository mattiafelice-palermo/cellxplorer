import { isTauriApp } from "./downloads";
export const ANALYSIS_NOTIFICATION_EVENT = "analysis-update-notification-activated";
import { isAnalysisNotificationActivation, type AnalysisNotificationActivation } from "./notificationPreferences";
export async function showAnalysisUpdateNotification(databaseId: string, analyses: number, cells: number): Promise<boolean> {
  if (!isTauriApp()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_analysis_update_notification", { databaseId, analyses, cells });
    return true;
  } catch { return false; }
}
export async function listenForAnalysisUpdateNotification(onActivate: (payload: AnalysisNotificationActivation) => void): Promise<() => void> {
  if (!isTauriApp()) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<unknown>(ANALYSIS_NOTIFICATION_EVENT, (event) => {
      if (isAnalysisNotificationActivation(event.payload)) onActivate(event.payload);
    });
  } catch { return () => undefined; }
}
