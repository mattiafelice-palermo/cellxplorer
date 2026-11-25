import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { brandingForChannel, parseAppChannel } from "./src/appChannel";
import { bootAccentForChannel } from "./src/channelPalette";

const backendPort = process.env.VITE_BACKEND_PORT ?? "8642";

let bootBranding = brandingForChannel("stable");
const bootSplashBranding: Plugin = {
  name: "cellxplorer-boot-branding",
  configResolved(config) {
    bootBranding = brandingForChannel(parseAppChannel(config.env.VITE_CELLXPLORER_CHANNEL));
  },
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      const accent = bootAccentForChannel(bootBranding.channel);
      return html
        .replaceAll("__CX_BOOT_NAME__", bootBranding.productName)
        .replaceAll("__CX_BOOT_ICON__", bootBranding.appIconPath)
        .replaceAll("__CX_BOOT_ACCENT_LIGHT__", accent.light)
        .replaceAll("__CX_BOOT_ACCENT_DARK__", accent.dark);
    },
  },
};

export default defineConfig({
  plugins: [react(), bootSplashBranding],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
    emptyOutDir: process.env.CELLXPLORER_PREFLIGHT_BUILD !== "1",
  },
});
