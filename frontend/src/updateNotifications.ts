import {
  UPDATE_NOTIFICATION_EVENT,
  UPDATE_NOTIFICATION_KIND,
  UPDATE_NOTIFICATION_TAG,
  isValidUpdateNotificationActivation,
  type AppUpdateRelease,
  type UpdateNotificationActivationPayload,
} from "./appUpdater";
import { isTauriApp } from "./downloads";

export type UpdateNotificationResult =
  | "shown"
  | "permission-denied"
  | "unsupported"
  | "failed";

export { UPDATE_NOTIFICATION_EVENT, UPDATE_NOTIFICATION_KIND, UPDATE_NOTIFICATION_TAG };

/** Ask Rust to display a Windows toast. Success means Windows accepted the toast. */
export async function showWindowsUpdateNotification(options: {
  release: AppUpdateRelease;
}): Promise<UpdateNotificationResult> {
  if (!isTauriApp()) {
    return "unsupported";
  }

  const version = options.release.version.trim();
  if (!version) {
    return "failed";
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_update_notification", { version });
    return "shown";
  } catch {
    return "failed";
  }
}

/**
 * Register the single AppUpdateProvider listener for Rust-owned toast activation.
 * Returns an unlisten function. Rejects malformed payloads without invoking the callback.
 */
export async function listenForUpdateNotificationActivation(
  onActivate: (payload: UpdateNotificationActivationPayload) => void | Promise<void>,
): Promise<() => void> {
  if (!isTauriApp()) {
    return () => undefined;
  }

  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<UpdateNotificationActivationPayload>(
      UPDATE_NOTIFICATION_EVENT,
      (event) => {
        if (!isValidUpdateNotificationActivation(event.payload)) {
          return;
        }
        const version = event.payload.version.trim();
        void onActivate({
          kind: UPDATE_NOTIFICATION_KIND,
          tag: UPDATE_NOTIFICATION_TAG,
          version,
        });
      },
    );
  } catch {
    return () => undefined;
  }
}
