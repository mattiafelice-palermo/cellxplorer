import type { AppChannel } from "./appChannel";
import type {
  AlphaBootstrapStatus,
  BackgroundJob,
  BetaBootstrapStatus,
} from "./api";

export type BootstrapChannel = "beta" | "alpha";
export type BootstrapStatus = BetaBootstrapStatus | AlphaBootstrapStatus;

export type DevBetaBootstrapMockMode =
  | "available"
  | "blocked"
  | "copy-error"
  | "loading"
  | "corrupt-marker"
  | "status-error"
  | "stable-blocked"
  | "beta-blocked"
  | "both-blocked";

export type BetaBootstrapSetupState =
  | "loading"
  | "choice-required"
  | "complete"
  | "blocked-error";

export function parseDevBetaBootstrapMock(
  search: string,
  dev: boolean,
  channel: BootstrapChannel = "beta",
): DevBetaBootstrapMockMode | null {
  if (!dev) return null;
  const params = new URLSearchParams(search);
  const value =
    params.get(channel === "alpha" ? "mockAlphaBootstrap" : "mockBetaBootstrap") ??
    params.get("mockBetaBootstrap");
  if (
    value === "available" ||
    value === "blocked" ||
    value === "copy-error" ||
    value === "loading" ||
    value === "corrupt-marker" ||
    value === "status-error" ||
    value === "stable-blocked" ||
    value === "beta-blocked" ||
    value === "both-blocked"
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
  if (channel !== "beta" && channel !== "alpha") {
    return false;
  }
  return tauri || mock !== null;
}

export function mockBetaBootstrapStatus(
  mode: DevBetaBootstrapMockMode,
  channel: BootstrapChannel = "beta",
): BootstrapStatus {
  if (channel === "alpha") {
    const sourceBlocked = (source: "stable" | "beta") =>
      mode === "both-blocked" ||
      (mode === "stable-blocked" && source === "stable") ||
      (mode === "beta-blocked" && source === "beta") ||
      (mode === "blocked" && source === "stable");
    const sources = (["stable", "beta"] as const).map((source) => {
      const blocked = sourceBlocked(source);
      const productName: "CellXplorer" | "CellXplorer Beta" =
        source === "stable" ? "CellXplorer" : "CellXplorer Beta";
      return {
        channel: source,
        productName,
        databasePath:
          source === "stable"
            ? "C:\\Users\\example\\.cellxplorer\\cellxplorer.db"
            : "C:\\Users\\example\\.cellxplorer-beta\\cellxplorer.db",
        exists: true,
        compatible: !blocked,
        blockingReason: blocked
          ? `The ${productName} library uses a newer schema than this Alpha build supports.`
          : null,
        schemaRevision: blocked ? "future" : "0012",
      };
    });
    return {
      channel: "alpha",
      setupState:
        mode === "corrupt-marker" || mode === "status-error"
          ? "blocked-error"
          : "choice-required",
      decision: null,
      needsChoice: mode !== "corrupt-marker" && mode !== "status-error",
      alphaPristine: true,
      alphaHasExistingLibrary: false,
      acknowledgedAppVersion: null,
      acknowledgedInstallInstanceId: null,
      sources,
      setupError:
        mode === "corrupt-marker"
          ? "CellXplorer Alpha setup metadata is corrupt. Remove alpha-bootstrap.json or contact support."
          : mode === "status-error"
            ? "Could not load CellXplorer Alpha setup status."
            : null,
      blockingReason:
        mode === "corrupt-marker"
          ? "CellXplorer Alpha setup metadata is corrupt. Remove alpha-bootstrap.json or contact support."
          : mode === "status-error"
            ? "Could not load CellXplorer Alpha setup status."
            : null,
      outstandingStageToken: null,
      applyFailureMessage: null,
    };
  }
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
  status?: BootstrapStatus;
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

export function betaBootstrapLoadingStatus(
  backendReady: boolean,
  elapsedSeconds: number,
  channel: BootstrapChannel = "beta",
): { title: string; detail: string } {
  const productName = channel === "alpha" ? "Alpha" : "Beta";
  if (!backendReady) {
    return {
      title: "Starting the local database service…",
      detail: `Setup will continue automatically as soon as the ${productName} library is available.`,
    };
  }
  if (elapsedSeconds < 3) {
    return {
      title: `Reading ${productName} setup state…`,
      detail: `Checking the installation decision and the current ${productName} library.`,
    };
  }
  if (elapsedSeconds < 8) {
    return {
      title: "Checking local library compatibility…",
      detail: `CellXplorer is validating whether the available libraries can be copied safely.`,
    };
  }
  return {
    title: "Still validating the local libraries…",
    detail: "A large database can make this one-time safety check take a little longer.",
  };
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

export function alphaSourceCopyDisabled(
  status: AlphaBootstrapStatus | undefined,
  source: "stable" | "beta",
  busy: boolean,
  mock: DevBetaBootstrapMockMode | null,
): boolean {
  if (busy) return true;
  if (mock === "both-blocked" || mock === `${source}-blocked`) return true;
  const sourceStatus = status?.sources.find((item) => item.channel === source);
  return !sourceStatus?.compatible;
}

export function alphaSourceBlockingReason(
  status: AlphaBootstrapStatus | undefined,
  source: "stable" | "beta",
  mock: DevBetaBootstrapMockMode | null,
): string | null {
  if (mock === "both-blocked" || mock === `${source}-blocked`) {
    const productName = source === "stable" ? "CellXplorer" : "CellXplorer Beta";
    return `The ${productName} library uses a newer schema than this Alpha build supports.`;
  }
  return status?.sources.find((item) => item.channel === source)?.blockingReason ?? null;
}

export function shouldRetryExistingStage(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

export function scientificPreparationResourceText(
  job: Pick<BackgroundJob, "resource_mode" | "workers" | "transition_pending"> | undefined,
): string {
  if (job?.transition_pending) {
    return "Finishing the files already in progress, then continuing one file at a time at reduced priority.";
  }
  if (job?.resource_mode === "foreground") {
    const workers = Math.max(1, job.workers ?? 1);
    return workers > 1
      ? `Preparing up to ${workers} files in parallel at normal priority.`
      : "Preparing one file at normal priority.";
  }
  return "Preparing one file at a time at reduced priority.";
}
