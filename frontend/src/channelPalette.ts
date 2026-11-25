import type { AppChannel } from "./appChannel";

export const betaBlue = [
  "#eef7ff", "#dceeff", "#badcff", "#96c9f2", "#7db7e8",
  "#61a3dc", "#478dcd", "#3678b7", "#2d659f", "#265487",
] as const;

export const alphaPurple = [
  "#f3f0ff", "#e5dbff", "#d0bfff", "#b197fc", "#9775fa",
  "#845ef7", "#7950f2", "#7048e8", "#6741d9", "#5f3dc4",
] as const;

/** The splash paints before Mantine; resolve its accent from the same palettes. */
export function bootAccentForChannel(channel: AppChannel) {
  const palette = channel === "beta" ? betaBlue : channel === "alpha" ? alphaPurple : null;
  return palette ? { light: palette[7], dark: palette[6] } : { light: "#12b886", dark: "#12b886" };
}
