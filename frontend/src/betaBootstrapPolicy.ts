import type { AppChannel } from "./appChannel";
import type { BetaBootstrapStatus } from "./api";

export type DevBetaBootstrapMockMode = "available" | "blocked" | "copy-error";

export function parseDevBetaBootstrapMock(
  search: string,
  dev: boolean,
): DevBetaBootstrapMockMode | null {
  if (!dev) return null;
  const value = new URLSearchParams(search).get("mockBetaBootstrap");
  if (value === "available" || value === "blocked" || value === "copy-error") {
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
  if (mode === "blocked") {
    return {
      channel: "beta",
      decision: null,
      needsChoice: true,
      betaPristine: true,
      stableDatabaseExists: true,
      stableDatabaseCompatible: false,
      stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
      blockingReason: "The Stable library uses a newer schema than this Beta build supports.",
    };
  }
  return {
    channel: "beta",
    decision: null,
    needsChoice: true,
    betaPristine: true,
    stableDatabaseExists: true,
    stableDatabaseCompatible: true,
    stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
    blockingReason: null,
  };
}

export function betaBootstrapModalOpen(
  status: BetaBootstrapStatus | undefined,
  mock: DevBetaBootstrapMockMode | null,
): boolean {
  if (mock) {
    return true;
  }
  return status?.needsChoice === true;
}

export function copyStableLibraryDisabled(
  status: BetaBootstrapStatus | undefined,
  staging: boolean,
  mock: DevBetaBootstrapMockMode | null,
): boolean {
  if (staging) return true;
  if (mock === "blocked") return true;
  if (!status) return true;
  return !status.stableDatabaseCompatible;
}
