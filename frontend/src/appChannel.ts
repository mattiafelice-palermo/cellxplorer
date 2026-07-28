export type AppChannel = "stable" | "beta";

export type AppBranding = {
  channel: AppChannel;
  productName: "CellXplorer" | "CellXplorer Beta";
  shortName: "CellXplorer" | "CellXplorer Beta";
  headerTitle: "CellXplorer";
  isBeta: boolean;
  primaryColor: "teal" | "betaBlue";
  appIconPath: "/app-icon.png" | "/app-icon-beta.png";
};

const STABLE_BRANDING: AppBranding = {
  channel: "stable",
  productName: "CellXplorer",
  shortName: "CellXplorer",
  headerTitle: "CellXplorer",
  isBeta: false,
  primaryColor: "teal",
  appIconPath: "/app-icon.png",
};

const BETA_BRANDING: AppBranding = {
  channel: "beta",
  productName: "CellXplorer Beta",
  shortName: "CellXplorer Beta",
  headerTitle: "CellXplorer",
  isBeta: true,
  primaryColor: "betaBlue",
  appIconPath: "/app-icon-beta.png",
};

export function parseAppChannel(raw: string | undefined): AppChannel {
  const value = raw?.trim();
  if (!value) {
    return "stable";
  }
  if (value === "stable" || value === "beta") {
    return value;
  }
  throw new Error(`Unsupported VITE_CELLXPLORER_CHANNEL: ${value}`);
}

export function brandingForChannel(channel: AppChannel): AppBranding {
  return channel === "beta" ? BETA_BRANDING : STABLE_BRANDING;
}

export const APP_CHANNEL = parseAppChannel(import.meta.env?.VITE_CELLXPLORER_CHANNEL);
export const APP_BRANDING = brandingForChannel(APP_CHANNEL);
