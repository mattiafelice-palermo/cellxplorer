import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendPort = process.env.VITE_BACKEND_PORT ?? "8642";

export default defineConfig({
  plugins: [react()],
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
