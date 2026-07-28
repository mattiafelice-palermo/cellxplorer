import type { AppChannel } from "./appChannel";
import type { BetaBootstrapStatus } from "./api";

export type DevBetaBootstrapMockMode =
  | "available"
  | "blocked"
  | "copy-error"
  | "loading"
  | "corrupt-marker"
  | "status-error";

export type BetaBootstrapSetupState =
  | "loading"
  | "choice-required"
  | "complete"
  | "blocked-error";

export function parseDevBetaBootstrapMock(
  search: string,
  dev: boolean,
): DevBetaBootstrapMockMode | null {
  if (!dev) return null;
  const value = new URLSearchParams(search).get("mockBetaBootstrap");
  if (
    value === "available" ||
    value === "blocked" ||
    value === "copy-error" ||
    value === "loading" ||
    value === "corrupt-marker" ||
    value === "status-error"
  ) {
    return value;
  }
  return null;
}

export function shouldShowBetaBootstrapUi(
  channel: AppChannel,
  tauri: boolean,
  mock: DevBetaBootstrapMockMode | null,
): boolean {
  if (channel !== "beta") {
    return false;
  }
  return tauri || mock !== null;
}

export function mockBetaBootstrapStatus(mode: DevBetaBootstrapMockMode): BetaBootstrapStatus {
  if (mode === "corrupt-marker" || mode === "status-error") {
    return {
      channel: "beta",
      setupState: "blocked-error",
      decision: null,
      needsChoice: false,
      betaPristine: false,
      betaHasExistingLibrary: true,
      acknowledgedAppVersion: null,
      stableDatabaseExists: true,
      stableDatabaseCompatible: false,
      stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
      copyBlockingReason: null,
      setupError:
        mode === "corrupt-marker"
          ? "Beta setup metadata is corrupt. Remove beta-bootstrap.json or contact support."
          : "Could not load Beta setup status.",
      blockingReason:
        mode === "corrupt-marker"
          ? "Beta setup metadata is corrupt. Remove beta-bootstrap.json or contact support."
          : "Could not load Beta setup status.",
      outstandingStageToken: null,
      applyFailureMessage: null,
    };
  }
  if (mode === "blocked") {
    return {
      channel: "beta",
      setupState: "choice-required",
      decision: null,
      needsChoice: true,
      betaPristine: true,
      betaHasExistingLibrary: false,
      acknowledgedAppVersion: null,
      stableDatabaseExists: true,
      stableDatabaseCompatible: false,
      stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
      copyBlockingReason: "The Stable library uses a newer schema than this Beta build supports.",
      setupError: null,
      blockingReason: "The Stable library uses a newer schema than this Beta build supports.",
      outstandingStageToken: null,
      applyFailureMessage: null,
    };
  }
  return {
    channel: "beta",
    setupState: "choice-required",
    decision: null,
    needsChoice: true,
    betaPristine: true,
    betaHasExistingLibrary: false,
    acknowledgedAppVersion: null,
    stableDatabaseExists: true,
    stableDatabaseCompatible: true,
    stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
    copyBlockingReason: null,
    setupError: null,
    blockingReason: null,
    outstandingStageToken: null,
    applyFailureMessage: null,
  };
}

export function resolveBetaBootstrapSetupState(args: {
  enabled: boolean;
  mock: DevBetaBootstrapMockMode | null;
  status?: BetaBootstrapStatus;
  statusLoading: boolean;
  statusError: boolean;
}): BetaBootstrapSetupState | "inactive" {
  if (!args.enabled) return "inactive";
  if (args.mock === "loading") return "loading";
  if (args.mock === "corrupt-marker" || args.mock === "status-error") return "blocked-error";
  if (args.mock) return "choice-required";
  if (args.statusLoading && !args.status) return "loading";
  if (args.statusError && !args.status) return "blocked-error";
  if (!args.status) return "loading";
  if (args.status.setupState) return args.status.setupState;
  if (args.status.setupError) return "blocked-error";
  if (args.status.decision) return "complete";
  if (args.status.needsChoice) return "choice-required";
  return "complete";
}

export function betaBootstrapGateOpen(
  state: BetaBootstrapSetupState | "inactive",
  showLoadingPreview = false,
): boolean {
  return (
    state === "choice-required" ||
    state === "blocked-error" ||
    (showLoadingPreview && state === "loading")
  );
}

export function copyStableLibraryDisabled(
  status: BetaBootstrapStatus | undefined,
  busy: boolean,
  mock: DevBetaBootstrapMockMode | null,
): boolean {
  if (busy) return true;
  if (mock === "blocked") return true;
  if (!status) return true;
  return !status.stableDatabaseCompatible;
}

export function shouldRetryExistingStage(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}
