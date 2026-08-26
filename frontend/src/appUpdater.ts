import type { AppChannel } from "./appChannel";

export const UPDATE_NOTIFIED_VERSION_KEY = "cellxplorer-update-notified-version";
export const UPDATE_PREFERENCES_KEY = "cellxplorer-update-preferences";
export const UPDATE_PREFERENCES_CHANGED_EVENT = "cellxplorer-update-preferences-changed";
export const UPDATE_LAST_CHECKED_AT_KEY = "cellxplorer-update-last-checked-at";
export const UPDATE_SCHEDULE_CHANGED_EVENT = "cellxplorer-update-schedule-changed";

export const AUTO_CHECK_INITIAL_DELAY_MS = 10_000;

export type AppUpdateIntervalUnit = "seconds" | "minutes" | "hours" | "days";

export type AppUpdatePreferences = {
  intervalValue: number;
  intervalUnit: AppUpdateIntervalUnit;
  notificationsEnabled: boolean;
  betaUpdatesEnabled: boolean;
};

export const DEFAULT_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  intervalValue: 12,
  intervalUnit: "hours",
  notificationsEnabled: true,
  betaUpdatesEnabled: false,
};

const UPDATE_INTERVAL_MULTIPLIERS: Record<AppUpdateIntervalUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
};

export function appUpdateIntervalMs(
  preferences: Pick<AppUpdatePreferences, "intervalValue" | "intervalUnit">,
): number {
  const value = Number.isFinite(preferences.intervalValue)
    ? Math.max(1, Math.floor(preferences.intervalValue))
    : DEFAULT_APP_UPDATE_PREFERENCES.intervalValue;
  return value * UPDATE_INTERVAL_MULTIPLIERS[preferences.intervalUnit];
}

/** Delay until the first automatic check after the schedule starts or resets. */
export function firstAutomaticCheckDelayMs(intervalMs: number): number {
  return Math.min(AUTO_CHECK_INITIAL_DELAY_MS, intervalMs);
}

export function readLastUpdateCheckedAt(
  storage: Pick<Storage, "getItem">,
): string | null {
  try {
    const raw = storage.getItem(UPDATE_LAST_CHECKED_AT_KEY);
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  } catch {
    return null;
  }
}

export function writeLastUpdateCheckedAt(
  storage: Pick<Storage, "setItem">,
  isoTimestamp: string,
): void {
  storage.setItem(UPDATE_LAST_CHECKED_AT_KEY, isoTimestamp);
}

export function loadAppUpdatePreferences(
  storage: Pick<Storage, "getItem">,
): AppUpdatePreferences {
  try {
    const raw = storage.getItem(UPDATE_PREFERENCES_KEY);
    if (!raw) return DEFAULT_APP_UPDATE_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<AppUpdatePreferences>;
    const unit = parsed.intervalUnit;
    if (
      unit !== "seconds" &&
      unit !== "minutes" &&
      unit !== "hours" &&
      unit !== "days"
    ) {
      return DEFAULT_APP_UPDATE_PREFERENCES;
    }
    const intervalValue = Number(parsed.intervalValue);
    if (!Number.isFinite(intervalValue) || intervalValue < 1) {
      return DEFAULT_APP_UPDATE_PREFERENCES;
    }
    return {
      intervalValue: Math.floor(intervalValue),
      intervalUnit: unit,
      notificationsEnabled: parsed.notificationsEnabled !== false,
      betaUpdatesEnabled: parsed.betaUpdatesEnabled === true,
    };
  } catch {
    return DEFAULT_APP_UPDATE_PREFERENCES;
  }
}

export function saveAppUpdatePreferences(
  storage: Pick<Storage, "setItem">,
  preferences: AppUpdatePreferences,
): void {
  storage.setItem(UPDATE_PREFERENCES_KEY, JSON.stringify(preferences));
}

export type UpdateCheckSource = "automatic" | "manual";
export type UpdateFailurePhase = "check" | "download" | "install";

export type AppUpdateRelease = {
  version: string;
  currentVersion: string;
  notes: string | null;
  publishedAt: string | null;
};

export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking"; source: UpdateCheckSource }
  | { status: "available"; release: AppUpdateRelease }
  | {
      status: "downloading";
      release: AppUpdateRelease;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { status: "launching"; release: AppUpdateRelease }
  | {
      status: "error";
      phase: UpdateFailurePhase;
      message: string;
      release?: AppUpdateRelease;
      lifecycleMayNeedRestart?: boolean;
    };

export type AppUpdateDownloadEvent =
  | { event: "started"; data: { contentLength: number | null } }
  | { event: "progress"; data: { chunkLength: number } }
  | { event: "finished" };

export type ReleaseNoteLine = {
  kind: "bullet" | "text" | "heading";
  text: string;
  level?: number;
};

export type ReleaseNoteBlock =
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string; level: number }
  | { kind: "bullets"; items: string[] };

export type AppUpdateMenuState = {
  label: string;
  disabled: boolean;
  loading: boolean;
  hidden: boolean;
  onClick: () => void;
};

export type DevUpdateMockMode =
  | "available"
  | "download"
  | "unknown-size"
  | "download-error"
  | "install-error";

const DEFAULT_RELEASE_NOTES =
  "This release includes improvements and bug fixes.";

export function parseDevUpdateMock(
  search: string,
  dev: boolean,
): DevUpdateMockMode | null {
  if (!dev) return null;
  const value = new URLSearchParams(search).get("mockUpdate");
  if (
    value === "available" ||
    value === "download" ||
    value === "unknown-size" ||
    value === "download-error" ||
    value === "install-error"
  ) {
    return value;
  }
  return null;
}

export function shouldShowUpdateUi(
  tauri: boolean,
  mock: DevUpdateMockMode | null,
  channel: AppChannel = "stable",
): boolean {
  return channel !== "alpha" && (tauri || mock !== null);
}

export function failurePhaseForLocalUpdatePhase(
  phase: "download" | "install",
): "download" | "install" {
  return phase;
}

export function normalizeUpdaterError(error: unknown, fallback: string): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || fallback;
  }
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    return trimmed || fallback;
  }
  return fallback;
}

export type UpdateCheckFailureExplanation = {
  kind:
    | "incompatible-release"
    | "release-information"
    | "network"
    | "secure-connection"
    | "server-busy"
    | "unexpected";
  title: string;
  message: string;
  canRetry: boolean;
};

/** User-facing explanation for failed update checks (404, offline, etc.). */
export function describeUpdateCheckFailure(
  rawMessage: string,
): UpdateCheckFailureExplanation {
  const text = rawMessage.toLowerCase();

  if (
    text.includes("accepts only major.minor.patch") ||
    (text.includes("update version") &&
      (text.includes("not exact semver") ||
        text.includes("must not contain build metadata"))) ||
    text.includes("unsupported cellxplorer application identifier")
  ) {
    return {
      kind: "incompatible-release",
      title: "Manual update required",
      message:
        "A newer release was found, but this installed version cannot read its version format. Download and run the latest official CellXplorer installer from GitHub Releases. Automatic updates will work again afterward.",
      canRetry: false,
    };
  }

  if (
    text.includes("certificate") ||
    text.includes("cert ") ||
    text.includes("tls") ||
    text.includes("ssl") ||
    text.includes("secure connection")
  ) {
    return {
      kind: "secure-connection",
      title: "Secure connection failed",
      message:
        "CellXplorer could not establish a trusted connection to the update server. Check that Windows has the correct date and time, then try again. Nothing was downloaded.",
      canRetry: true,
    };
  }

  if (
    text.includes("403") ||
    text.includes("429") ||
    text.includes("forbidden") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("service unavailable") ||
    text.includes("503")
  ) {
    return {
      kind: "server-busy",
      title: "Update server is temporarily unavailable",
      message:
        "The update server is busy or temporarily refusing requests. Wait a few minutes and try again.",
      canRetry: true,
    };
  }

  if (
    text.includes("404") ||
    text.includes("valid release json") ||
    text.includes("could not fetch") ||
    text.includes("invalid json") ||
    text.includes("release json") ||
    text.includes("manifest") ||
    text.includes("missing platform") ||
    text.includes("not found") ||
    text.includes("no release")
  ) {
    return {
      kind: "release-information",
      title: "Update information is unavailable",
      message:
        "CellXplorer reached the update service, but its release information is missing or incomplete. The release may still be publishing; wait a few minutes and try again.",
      canRetry: true,
    };
  }

  if (
    text.includes("network") ||
    text.includes("offline") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("dns") ||
    text.includes("connection") ||
    text.includes("unreachable")
  ) {
    return {
      kind: "network",
      title: "Could not reach the update server",
      message:
        "Check your internet connection, VPN, or proxy settings, then try again.",
      canRetry: true,
    };
  }

  return {
    kind: "unexpected",
    title: "Update check failed",
    message:
      "CellXplorer encountered an unexpected updater error. Restart CellXplorer and try again. If it continues, install the latest official release manually.",
    canRetry: true,
  };
}

export function explainUpdateCheckFailure(rawMessage: string): string {
  return describeUpdateCheckFailure(rawMessage).message;
}

export function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

export function computeDownloadProgress(
  downloadedBytes: number,
  totalBytes: number | null,
): { percent: number | null; label: string } {
  const downloadedLabel = formatUpdateBytes(downloadedBytes);
  if (totalBytes === null || totalBytes <= 0) {
    return {
      percent: null,
      label: `${downloadedLabel} downloaded`,
    };
  }
  const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  return {
    percent,
    label: `${percent}% · ${downloadedLabel} / ${formatUpdateBytes(totalBytes)}`,
  };
}

export function accumulateDownloadProgress(
  current: Pick<AppUpdateState & { status: "downloading" }, "downloadedBytes" | "totalBytes">,
  event: AppUpdateDownloadEvent,
): Pick<AppUpdateState & { status: "downloading" }, "downloadedBytes" | "totalBytes"> {
  if (event.event === "started") {
    return {
      downloadedBytes: 0,
      totalBytes: event.data.contentLength ?? current.totalBytes,
    };
  }
  if (event.event === "progress") {
    return {
      downloadedBytes: current.downloadedBytes + event.data.chunkLength,
      totalBytes: current.totalBytes,
    };
  }
  return current;
}

export function parseReleaseNoteLines(notes: string | null | undefined): ReleaseNoteLine[] {
  const trimmed = (notes ?? "").trim();
  if (!trimmed) {
    return [{ kind: "text", text: DEFAULT_RELEASE_NOTES }];
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        return {
          kind: "heading" as const,
          text: heading[2].trim(),
          level: heading[1].length,
        };
      }
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        return { kind: "bullet" as const, text: bullet[1].trim() };
      }
      return { kind: "text" as const, text: line };
    });
}

export function buildReleaseNoteBlocks(
  notes: string | null | undefined,
): ReleaseNoteBlock[] {
  const lines = parseReleaseNoteLines(notes);
  const blocks: ReleaseNoteBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind === "heading") {
      blocks.push({
        kind: "heading",
        text: line.text,
        level: line.level ?? 2,
      });
      continue;
    }
    if (line.kind === "text") {
      blocks.push({ kind: "text", text: line.text });
      continue;
    }
    const items: string[] = [line.text];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].kind === "bullet") {
      items.push(lines[cursor].text);
      cursor += 1;
    }
    blocks.push({ kind: "bullets", items });
    index = cursor - 1;
  }

  return blocks;
}

/** @deprecated Prefer parseReleaseNoteLines; kept for transitional call sites. */
export function renderReleaseNotes(notes: string | null | undefined): string[] {
  return parseReleaseNoteLines(notes).map((line) => line.text);
}

export function releaseNotesAreBulleted(notes: string | null | undefined): boolean {
  const lines = parseReleaseNoteLines(notes);
  return lines.length > 0 && lines.every((line) => line.kind === "bullet");
}

export function shouldPersistUpdateBadge(state: AppUpdateState): boolean {
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" &&
      state.phase !== "check" &&
      Boolean(state.release))
  );
}

export function getUpdateMenuLabel(state: AppUpdateState): string {
  switch (state.status) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update to v${state.release.version}`;
    case "downloading":
    case "launching":
      return `Updating to v${state.release.version}…`;
    case "error":
      if (state.release && state.phase !== "check") {
        return `Updating to v${state.release.version}…`;
      }
      return "Check for updates";
    default:
      return "Check for updates";
  }
}

export function isUpdateMenuDisabled(state: AppUpdateState): boolean {
  return (
    state.status === "checking" ||
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" &&
      Boolean(state.release) &&
      state.phase !== "check")
  );
}

export function isUpdateMenuLoading(state: AppUpdateState): boolean {
  return state.status === "checking";
}

export function canDismissUpdateModal(state: AppUpdateState): boolean {
  if (state.status === "available") return true;
  if (state.status === "error") {
    return state.phase === "check" || (state.phase === "download" && !state.lifecycleMayNeedRestart);
  }
  return false;
}

export function isProtectedUpdateFlow(state: AppUpdateState): boolean {
  return (
    state.status === "downloading" ||
    state.status === "launching" ||
    (state.status === "error" &&
      (state.phase === "download" || state.phase === "install") &&
      Boolean(state.release))
  );
}

export function shouldSkipAutomaticCheck(
  state: AppUpdateState,
  modalOpen: boolean,
): boolean {
  if (modalOpen) return true;
  return isProtectedUpdateFlow(state);
}

export function getCurrentRelease(state: AppUpdateState): AppUpdateRelease | null {
  if (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "launching"
  ) {
    return state.release;
  }
  if (state.status === "error" && state.release) {
    return state.release;
  }
  return null;
}

export function compareSemver(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const normalized = value.trim().replace(/^v/i, "");
    const core = normalized.split("-")[0] ?? normalized;
    return core.split(".").map((part) => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function shouldNotifyForVersion(
  version: string,
  notifiedVersion: string | null,
): boolean {
  return notifiedVersion !== version;
}

/** True when the advertised update version is a beta/prerelease labeled with beta. */
export function isBetaUpdateVersion(version: string): boolean {
  return /beta/i.test(version.trim());
}

/**
 * Drop beta updates unless the user opted in. Stable releases always pass through.
 */
export function acceptUpdateReleaseForPreferences(
  release: AppUpdateRelease | null,
  preferences: Pick<AppUpdatePreferences, "betaUpdatesEnabled">,
): AppUpdateRelease | null {
  if (!release) return null;
  if (isBetaUpdateVersion(release.version) && !preferences.betaUpdatesEnabled) {
    return null;
  }
  return release;
}

export const UPDATE_NOTIFICATION_TAG = "cellxplorer-app-update";
export const UPDATE_NOTIFICATION_KIND = "cellxplorer-app-update";
export const UPDATE_NOTIFICATION_EVENT = "app-update-notification-activated";

export type UpdateDiscoveryFeedback =
  | "open-modal"
  | "native-notification"
  | "badge-only"
  | "silent";

export type UpdateNotificationActivationPayload = {
  kind: typeof UPDATE_NOTIFICATION_KIND;
  tag: typeof UPDATE_NOTIFICATION_TAG;
  version: string;
};

/**
 * Choose update-discovery feedback from the effective check source.
 * Manual results always open the modal; automatic results never do.
 */
export function resolveUpdateDiscoveryFeedback(options: {
  source: UpdateCheckSource;
  release: AppUpdateRelease | null;
  notificationsEnabled: boolean;
  notifiedVersion: string | null;
}): UpdateDiscoveryFeedback {
  if (!options.release) {
    return options.source === "manual" ? "open-modal" : "silent";
  }
  if (options.source === "manual") {
    return "open-modal";
  }
  if (
    options.notificationsEnabled &&
    shouldNotifyForVersion(options.release.version, options.notifiedVersion)
  ) {
    return "native-notification";
  }
  return "badge-only";
}

/** When a manual check joins an in-flight automatic check, the result is manual. */
export function resolveEffectiveCheckSource(
  startedSource: UpdateCheckSource,
  feedbackSource: UpdateCheckSource,
): UpdateCheckSource {
  return feedbackSource === "manual" || startedSource === "manual" ? "manual" : "automatic";
}

export function isValidUpdateNotificationActivation(payload: {
  tag?: unknown;
  kind?: unknown;
  version?: unknown;
}): payload is UpdateNotificationActivationPayload {
  if (payload.kind !== UPDATE_NOTIFICATION_KIND) return false;
  if (payload.tag !== UPDATE_NOTIFICATION_TAG) return false;
  if (typeof payload.version !== "string") return false;
  const version = payload.version.trim();
  return version.length > 0 && version === payload.version;
}

/** Notification activation never starts download/install; it only opens the modal. */
export function notificationActivationAction(): "open-modal" {
  return "open-modal";
}

export function readNotifiedVersion(storage: Pick<Storage, "getItem">): string | null {
  return storage.getItem(UPDATE_NOTIFIED_VERSION_KEY);
}

export function writeNotifiedVersion(
  storage: Pick<Storage, "setItem">,
  version: string,
): void {
  storage.setItem(UPDATE_NOTIFIED_VERSION_KEY, version);
}

export async function showMainWindowForUpdateTauri(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("show_main_window_for_update");
}

export function mergeCheckResult(
  current: AppUpdateState,
  release: AppUpdateRelease | null,
): AppUpdateRelease | null {
  const existing = getCurrentRelease(current);
  if (isProtectedUpdateFlow(current)) {
    return existing;
  }
  if (!release) return null;
  if (!existing) return release;
  if (compareSemver(release.version, existing.version) <= 0) {
    return existing;
  }
  return release;
}

export type AppUpdateAction =
  | { type: "check_started"; source: UpdateCheckSource }
  | { type: "check_success"; source: UpdateCheckSource; release: AppUpdateRelease | null }
  | { type: "check_error"; source: UpdateCheckSource; message: string }
  | { type: "download_started"; release: AppUpdateRelease }
  | {
      type: "download_event";
      release: AppUpdateRelease;
      event: AppUpdateDownloadEvent;
    }
  | { type: "launching"; release: AppUpdateRelease }
  | { type: "download_error"; release: AppUpdateRelease; message: string }
  | {
      type: "install_error";
      release: AppUpdateRelease;
      message: string;
      lifecycleMayNeedRestart?: boolean;
    }
  | { type: "reset_available"; release: AppUpdateRelease }
  | { type: "dismiss_check_error" };

export function appUpdateReducer(
  state: AppUpdateState,
  action: AppUpdateAction,
): AppUpdateState {
  switch (action.type) {
    case "check_started":
      if (action.source === "automatic") {
        if (isProtectedUpdateFlow(state) || state.status === "available") {
          return state;
        }
      }
      return { status: "checking", source: action.source };
    case "check_success": {
      if (isProtectedUpdateFlow(state)) {
        return state;
      }
      if (state.status === "available" && !action.release) {
        return { status: "idle" };
      }
      if (!action.release) return { status: "idle" };
      return { status: "available", release: action.release };
    }
    case "check_error":
      if (action.source === "automatic") {
        if (
          state.status === "available" ||
          isProtectedUpdateFlow(state) ||
          state.status !== "checking"
        ) {
          return state;
        }
        return { status: "idle" };
      }
      if (isProtectedUpdateFlow(state) || state.status === "available") {
        return state;
      }
      return {
        status: "error",
        phase: "check",
        message: action.message,
      };
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
        lifecycleMayNeedRestart: action.lifecycleMayNeedRestart ?? true,
      };
    case "reset_available":
      return { status: "available", release: action.release };
    case "dismiss_check_error":
      if (state.status === "error" && state.phase === "check") {
        return { status: "idle" };
      }
      return state;
    default:
      return state;
  }
}

export type TauriUpdateReleaseResponse = {
  version: string;
  currentVersion: string;
  notes?: string | null;
  publishedAt?: string | null;
};

export function mapTauriRelease(response: TauriUpdateReleaseResponse): AppUpdateRelease {
  return {
    version: response.version,
    currentVersion: response.currentVersion,
    notes: response.notes ?? null,
    publishedAt: response.publishedAt ?? null,
  };
}

export function mockRelease(version = "0.16.0"): AppUpdateRelease {
  return {
    version,
    currentVersion: "0.15.0",
    notes: "- Improved cycle plotting\n- Fixed library filters\n- Updater foundation",
    publishedAt: "2026-07-27T00:00:00Z",
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runDevUpdateMock(
  mode: DevUpdateMockMode,
  onProgress: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  const chunks = mode === "unknown-size" ? [120_000, 180_000, 95_000] : [250_000, 400_000, 350_000];
  const total = mode === "unknown-size" ? null : chunks.reduce((sum, chunk) => sum + chunk, 0);
  onProgress({
    event: "started",
    data: { contentLength: total },
  });
  for (const chunk of chunks) {
    await sleep(120);
    onProgress({ event: "progress", data: { chunkLength: chunk } });
  }
  onProgress({ event: "finished" });
  if (mode === "download-error") {
    throw new Error("Mock download failed before verification completed.");
  }
}

export async function checkAppUpdateTauri(): Promise<AppUpdateRelease | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<TauriUpdateReleaseResponse | null>("check_app_update");
  return response ? mapTauriRelease(response) : null;
}

export async function downloadAppUpdateTauri(
  expectedVersion: string,
  onProgress: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const channel = new Channel<AppUpdateDownloadEvent>();
  channel.onmessage = (message) => onProgress(message);
  await invoke("download_app_update", {
    expectedVersion,
    onProgress: channel,
  });
}

export async function installAppUpdateTauri(expectedVersion: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_app_update", { expectedVersion });
}

export async function restartAppTauri(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_app");
}
