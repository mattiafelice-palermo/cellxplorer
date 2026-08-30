export type AppChannel = "stable" | "beta" | "alpha";

export type AppBranding = {
  channel: AppChannel;
  productName: "CellXplorer" | "CellXplorer Beta" | "CellXplorer Alpha";
  shortName: "CellXplorer" | "CellXplorer Beta" | "CellXplorer Alpha";
  headerTitle: "CellXplorer";
  badgeLabel: "BETA" | "ALPHA" | null;
  isStable: boolean;
  isBeta: boolean;
  isAlpha: boolean;
  primaryColor: "teal" | "betaBlue" | "alphaPurple";
  appIconPath: "/app-icon.png" | "/app-icon-beta.png" | "/app-icon-alpha.png";
};

const STABLE_BRANDING: AppBranding = {
  channel: "stable",
  productName: "CellXplorer",
  shortName: "CellXplorer",
  headerTitle: "CellXplorer",
  badgeLabel: null,
  isStable: true,
  isBeta: false,
  isAlpha: false,
  primaryColor: "teal",
  appIconPath: "/app-icon.png",
};

const BETA_BRANDING: AppBranding = {
  channel: "beta",
  productName: "CellXplorer Beta",
  shortName: "CellXplorer Beta",
  headerTitle: "CellXplorer",
  badgeLabel: "BETA",
  isStable: false,
  isBeta: true,
  isAlpha: false,
  primaryColor: "betaBlue",
  appIconPath: "/app-icon-beta.png",
};

const ALPHA_BRANDING: AppBranding = {
  channel: "alpha",
  productName: "CellXplorer Alpha",
  shortName: "CellXplorer Alpha",
  headerTitle: "CellXplorer",
  badgeLabel: "ALPHA",
  isStable: false,
  isBeta: false,
  isAlpha: true,
  primaryColor: "alphaPurple",
  appIconPath: "/app-icon-alpha.png",
};

const BRANDING_BY_CHANNEL: Record<AppChannel, AppBranding> = {
  stable: STABLE_BRANDING,
  beta: BETA_BRANDING,
  alpha: ALPHA_BRANDING,
};

export function parseAppChannel(raw: string | undefined): AppChannel {
  const value = raw?.trim();
  if (!value) {
    return "stable";
  }
  if (value === "stable" || value === "beta" || value === "alpha") {
    return value;
  }
  throw new Error(`Unsupported VITE_CELLXPLORER_CHANNEL: ${value}`);
}

export function brandingForChannel(channel: AppChannel): AppBranding {
  return BRANDING_BY_CHANNEL[channel];
}

export const APP_CHANNEL = parseAppChannel(import.meta.env?.VITE_CELLXPLORER_CHANNEL);
export const APP_BRANDING = brandingForChannel(APP_CHANNEL);
