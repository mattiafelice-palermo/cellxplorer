import {
  accumulateDownloadProgress,
  compareSemver,
  explainUpdateCheckFailure,
  mapTauriRelease,
  normalizeUpdaterError,
  UPDATE_SCHEDULE_CHANGED_EVENT,
  type AppUpdateDownloadEvent,
  type AppUpdateRelease,
  type TauriUpdateReleaseResponse,
  type UpdateCheckSource,
} from "./appUpdater.ts";
import type { AppChannel } from "./appChannel";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const BETA_NOTIFIED_VERSION_KEY = "cellxplorer-beta-notified-version";
export const BETA_INSTALL_NOTIFICATION_EVENT = "beta-install-notification-activated";
export const BETA_INSTALL_NOTIFICATION_KIND = "cellxplorer-beta-install";
export const BETA_INSTALL_NOTIFICATION_TAG = "cellxplorer-beta-install";

export type BetaInstallationInfo = {
  installed: boolean;
  installedVersion: string | null;
  executablePath: string | null;
};

export type BetaInstallState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "unavailable" }
  | { status: "available"; release: AppUpdateRelease }
  | {
      status: "downloading";
      release: AppUpdateRelease;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { status: "launching"; release: AppUpdateRelease }
  | { status: "installed"; installedVersion: string; executablePath: string }
  | {
      status: "error";
      phase: "check" | "download" | "install";
      message: string;
      release?: AppUpdateRelease;
    };

export type BetaInstallNotificationActivationPayload = {
  kind: typeof BETA_INSTALL_NOTIFICATION_KIND;
  tag: typeof BETA_INSTALL_NOTIFICATION_TAG;
  version: string;
};

export function readBetaNotifiedVersion(storage: Pick<Storage, "getItem">): string | null {
  return storage.getItem(BETA_NOTIFIED_VERSION_KEY);
}

export function writeBetaNotifiedVersion(storage: Pick<Storage, "setItem">, version: string): void {
  storage.setItem(BETA_NOTIFIED_VERSION_KEY, version);
}

export function clearBetaNotifiedVersion(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(BETA_NOTIFIED_VERSION_KEY);
}

export function shouldNotifyForBetaVersion(
  version: string,
  notifiedVersion: string | null,
): boolean {
  return notifiedVersion !== version;
}

export function isValidBetaInstallNotificationActivation(payload: {
  kind?: unknown;
  tag?: unknown;
  version?: unknown;
}): payload is BetaInstallNotificationActivationPayload {
  if (payload.kind !== BETA_INSTALL_NOTIFICATION_KIND) return false;
  if (payload.tag !== BETA_INSTALL_NOTIFICATION_TAG) return false;
  if (typeof payload.version !== "string") return false;
  const version = payload.version.trim();
  return version.length > 0 && version === payload.version;
}

export function shouldRunBetaAvailabilityCheck(options: {
  betaUpdatesEnabled: boolean;
  betaInstalled: boolean;
}): boolean {
  return options.betaUpdatesEnabled && !options.betaInstalled;
}

export function shouldShowBetaInstallUi(channel: AppChannel, tauri: boolean): boolean {
  return tauri && channel === "stable";
}

export function getBetaInstallRelease(state: BetaInstallState): AppUpdateRelease | null {
  if (state.status === "available" || state.status === "downloading" || state.status === "launching") {
    return state.release;
  }
  if (state.status === "error" && state.release) {
    return state.release;
  }
  return null;
}

export function isProtectedBetaInstallFlow(state: BetaInstallState): boolean {
  return (
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" && state.phase !== "check" && Boolean(state.release))
  );
}

export function mergeBetaCheckResult(
  current: BetaInstallState,
  release: AppUpdateRelease | null,
): AppUpdateRelease | null {
  const existing = getBetaInstallRelease(current);
  if (
    current.status === "downloading" ||
    current.status === "launching" ||
    (current.status === "error" && current.phase !== "check" && current.release)
  ) {
    return existing;
  }
  if (!release) return null;
  if (!existing) return release;
  if (compareSemver(release.version, existing.version) <= 0) {
    return existing;
  }
  return release;
}

export type BetaInstallAction =
  | { type: "check_started" }
  | { type: "check_success"; release: AppUpdateRelease | null }
  | { type: "manual_no_release" }
  | { type: "check_error"; message: string }
  | { type: "download_started"; release: AppUpdateRelease }
  | { type: "download_event"; release: AppUpdateRelease; event: AppUpdateDownloadEvent }
  | { type: "launching"; release: AppUpdateRelease }
  | { type: "download_error"; release: AppUpdateRelease; message: string }
  | { type: "install_error"; release: AppUpdateRelease; message: string }
  | { type: "installed"; installedVersion: string; executablePath: string }
  | { type: "reset_available"; release: AppUpdateRelease }
  | { type: "preference_disabled" }
  | { type: "dismiss_check_error" };

export function betaInstallReducer(state: BetaInstallState, action: BetaInstallAction): BetaInstallState {
  switch (action.type) {
    case "check_started":
      if (
        state.status === "downloading" ||
        state.status === "launching" ||
        (state.status === "error" && state.phase !== "check" && state.release)
      ) {
        return state;
      }
      return { status: "checking" };
    case "check_success":
      if (
        state.status === "downloading" ||
        state.status === "launching" ||
        (state.status === "error" && state.phase !== "check" && state.release)
      ) {
        return state;
      }
      if (!action.release) return { status: "idle" };
      return { status: "available", release: action.release };
    case "manual_no_release":
      if (isProtectedBetaInstallFlow(state)) {
        return state;
      }
      return { status: "unavailable" };
    case "check_error":
      if (
        state.status === "downloading" ||
        state.status === "launching" ||
        (state.status === "error" && state.phase !== "check" && state.release)
      ) {
        return state;
      }
      return { status: "error", phase: "check", message: action.message };
    case "download_started":
      return {
        status: "downloading",
        release: action.release,
        downloadedBytes: 0,
        totalBytes: null,
      };
    case "download_event": {
      if (state.status !== "downloading") return state;
      if (state.release.version !== action.release.version) return state;
      const next = accumulateDownloadProgress(state, action.event);
      return {
        status: "downloading",
        release: state.release,
        downloadedBytes: next.downloadedBytes,
        totalBytes: next.totalBytes,
      };
    }
    case "launching":
      return { status: "launching", release: action.release };
    case "download_error":
      return {
        status: "error",
        phase: "download",
        message: action.message,
        release: action.release,
      };
    case "install_error":
      return {
        status: "error",
        phase: "install",
        message: action.message,
        release: action.release,
      };
    case "installed":
      return {
        status: "installed",
        installedVersion: action.installedVersion,
        executablePath: action.executablePath,
      };
    case "reset_available":
      return { status: "available", release: action.release };
    case "preference_disabled":
      if (isProtectedBetaInstallFlow(state)) {
        return state;
      }
      return { status: "idle" };
    case "dismiss_check_error":
      if (state.status === "error" && state.phase === "check") {
        return { status: "idle" };
      }
      return state;
    default:
      return state;
  }
}

export function canDismissBetaInstallModal(state: BetaInstallState): boolean {
  if (state.status === "available" || state.status === "unavailable") return true;
  if (state.status === "error") {
    return state.phase === "check";
  }
  return false;
}

type BetaScheduleHost = {
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
  addEventListener: typeof window.addEventListener;
  removeEventListener: typeof window.removeEventListener;
};

export function startBetaCheckSchedule(options: {
  host: BetaScheduleHost;
  intervalMs: number;
  initialDelayMs: number;
  runCheck: () => void;
  now?: () => number;
}): () => void {
  const now = options.now ?? Date.now;
  let timeout: number | undefined;
  let nextDueAt = now() + options.initialDelayMs;

  const cancel = () => {
    if (timeout !== undefined) options.host.clearTimeout(timeout);
    timeout = undefined;
  };
  const schedule = (): void => {
    cancel();
    timeout = options.host.setTimeout(() => {
      options.runCheck();
      nextDueAt = now() + options.intervalMs;
      schedule();
    }, Math.max(0, nextDueAt - now()));
  };
  // The Standard updater emits this event while recalculating its own schedule. Recreate our
  // timer without moving Beta's due time, so equal-cadence Standard events cannot starve Beta.
  const onScheduleChanged = () => schedule();

  options.host.addEventListener(UPDATE_SCHEDULE_CHANGED_EVENT, onScheduleChanged);
  schedule();

  return () => {
    cancel();
    options.host.removeEventListener(UPDATE_SCHEDULE_CHANGED_EVENT, onScheduleChanged);
  };
}

export async function finishSessionAndInstallBeta(options: {
  finishSession: () => Promise<void>;
  install: () => Promise<void>;
  onSessionFinishError: (error: unknown) => void;
}): Promise<void> {
  try {
    await options.finishSession();
  } catch (error) {
    options.onSessionFinishError(error);
  }
  await options.install();
}

export async function detectBetaInstallationTauri(): Promise<BetaInstallationInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BetaInstallationInfo>("detect_beta_installation");
}

export async function checkBetaInstallTauri(): Promise<AppUpdateRelease | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<TauriUpdateReleaseResponse | null>("check_beta_install");
  return response ? mapTauriRelease(response) : null;
}

export async function downloadBetaInstallTauri(
  expectedVersion: string,
  onProgress: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const channel = new Channel<AppUpdateDownloadEvent>();
  channel.onmessage = (message) => onProgress(message);
  await invoke("download_beta_install", {
    expectedVersion,
    onProgress: channel,
  });
}

export async function installBetaTauri(expectedVersion: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_beta", { expectedVersion });
}

export async function openBetaApplicationTauri(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_beta_application");
}

export async function showBetaInstallNotificationTauri(version: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_beta_install_notification", { version });
    return true;
  } catch {
    return false;
  }
}

export async function listenForBetaInstallNotificationActivation(
  onActivate: (payload: BetaInstallNotificationActivationPayload) => void | Promise<void>,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<BetaInstallNotificationActivationPayload>(
      BETA_INSTALL_NOTIFICATION_EVENT,
      (event) => {
        if (!isValidBetaInstallNotificationActivation(event.payload)) {
          return;
        }
        void onActivate({
          kind: BETA_INSTALL_NOTIFICATION_KIND,
          tag: BETA_INSTALL_NOTIFICATION_TAG,
          version: event.payload.version.trim(),
        });
      },
    );
  } catch {
    return () => undefined;
  }
}

export function explainBetaCheckFailure(error: unknown): string {
  const raw = normalizeUpdaterError(error, "Could not check for CellXplorer Beta.");
  return explainUpdateCheckFailure(raw);
}

export function resolveBetaDiscoveryFeedback(options: {
  source: UpdateCheckSource;
  release: AppUpdateRelease | null;
  notificationsEnabled: boolean;
  notifiedVersion: string | null;
}): "open-modal" | "native-notification" | "silent" {
  if (!options.release) {
    return options.source === "manual" ? "open-modal" : "silent";
  }
  if (options.source === "manual") {
    return "open-modal";
  }
  if (
    options.notificationsEnabled &&
    shouldNotifyForBetaVersion(options.release.version, options.notifiedVersion)
  ) {
    return "native-notification";
  }
  return "silent";
}
