export const UPDATE_NOTIFIED_VERSION_KEY = "cellxplorer-update-notified-version";

export const AUTO_CHECK_INITIAL_DELAY_MS = 10_000;
export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

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
  kind: "bullet" | "text";
  text: string;
};

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

export function shouldShowUpdateUi(tauri: boolean, mock: DevUpdateMockMode | null): boolean {
  return tauri || mock !== null;
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

/** User-facing explanation for failed update checks (404, offline, etc.). */
export function explainUpdateCheckFailure(rawMessage: string): string {
  const text = rawMessage.toLowerCase();
  if (
    text.includes("404") ||
    text.includes("valid release json") ||
    text.includes("could not fetch") ||
    text.includes("not found") ||
    text.includes("no release")
  ) {
    return "CellXplorer could not find update information online. The update server may be unreachable, or no release has been published yet.";
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
    return "CellXplorer could not reach the update server. Check your internet connection and try again.";
  }
  return "CellXplorer could not check for updates right now. Try again in a moment.";
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
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        return { kind: "bullet" as const, text: bullet[1].trim() };
      }
      return { kind: "text" as const, text: line };
    });
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

export function readNotifiedVersion(storage: Pick<Storage, "getItem">): string | null {
  return storage.getItem(UPDATE_NOTIFIED_VERSION_KEY);
}

export function writeNotifiedVersion(
  storage: Pick<Storage, "setItem">,
  version: string,
): void {
  storage.setItem(UPDATE_NOTIFIED_VERSION_KEY, version);
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
