import {
  UPDATE_NOTIFICATION_KIND,
  UPDATE_NOTIFICATION_TAG,
  isValidUpdateNotificationActivation,
  type AppUpdateRelease,
} from "./appUpdater";
import { isTauriApp } from "./downloads";

export type UpdateNotificationResult =
  | "shown"
  | "permission-denied"
  | "unsupported"
  | "failed";

type NotificationPermissionApi = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission | "prompt">;
};

let activeUpdateNotification: Notification | null = null;

function readNotificationVersion(notification: Notification, fallback: string): string {
  const data = notification.data as { version?: unknown } | null | undefined;
  if (typeof data?.version === "string" && data.version.trim()) {
    return data.version.trim();
  }
  return fallback;
}

export async function showWindowsUpdateNotification(options: {
  release: AppUpdateRelease;
  onActivate: (version: string) => void | Promise<void>;
}): Promise<UpdateNotificationResult> {
  if (!isTauriApp()) {
    return "unsupported";
  }
  if (typeof Notification === "undefined") {
    return "unsupported";
  }

  try {
    const { isPermissionGranted, requestPermission } =
      (await import("@tauri-apps/plugin-notification")) as NotificationPermissionApi;

    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    if (!granted) {
      return "permission-denied";
    }

    if (activeUpdateNotification) {
      activeUpdateNotification.close();
      activeUpdateNotification = null;
    }

    const version = options.release.version.trim();
    if (!version) {
      return "failed";
    }

    const notification = new Notification("CellXplorer update available", {
      body: `Version ${version} is ready. Click to view the update.`,
      tag: UPDATE_NOTIFICATION_TAG,
      data: {
        kind: UPDATE_NOTIFICATION_KIND,
        version,
      },
    });

    activeUpdateNotification = notification;

    notification.onclick = (event) => {
      event.preventDefault();
      const activatedVersion = readNotificationVersion(notification, version);
      if (
        !isValidUpdateNotificationActivation({
          tag: notification.tag,
          kind: UPDATE_NOTIFICATION_KIND,
          version: activatedVersion,
        })
      ) {
        notification.close();
        if (activeUpdateNotification === notification) {
          activeUpdateNotification = null;
        }
        return;
      }
      notification.close();
      if (activeUpdateNotification === notification) {
        activeUpdateNotification = null;
      }
      void options.onActivate(activatedVersion);
    };

    notification.onclose = () => {
      if (activeUpdateNotification === notification) {
        activeUpdateNotification = null;
      }
    };

    notification.onerror = () => {
      if (activeUpdateNotification === notification) {
        activeUpdateNotification = null;
      }
    };

    return "shown";
  } catch {
    return "failed";
  }
}
