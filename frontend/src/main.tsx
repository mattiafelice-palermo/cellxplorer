import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app.css";

import { ColorSchemeScript, MantineProvider, createTheme } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { APP_BRANDING } from "./appChannel";
import { AppUpdateProvider } from "./components/AppUpdateCoordinator";
import { BetaInstallProvider } from "./components/BetaInstallCoordinator";
import { isTransientApiError } from "./apiRetryPolicy";
import {
  configureStartupQueryDefaults,
  startupQueryPersistence,
} from "./startupQueryPersistence";

const betaBlue = [
  "#eef7ff",
  "#dceeff",
  "#badcff",
  "#96c9f2",
  "#7db7e8",
  "#61a3dc",
  "#478dcd",
  "#3678b7",
  "#2d659f",
  "#265487",
] as const;

const theme = createTheme({
  primaryColor: APP_BRANDING.primaryColor,
  ...(APP_BRANDING.isBeta
    ? {
        colors: { betaBlue: [...betaBlue] },
        primaryShade: { light: 7, dark: 6 },
      }
    : {}),
  defaultRadius: "md",
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The desktop window is intentionally displayed before its Python
      // sidecar is ready. Retry connectivity and transient server failures,
      // but surface permanent client/application errors immediately.
      retry: (failureCount, error) =>
        isTransientApiError(error) && failureCount < 30,
      retryDelay: 250,
      refetchOnWindowFocus: false,
    },
  },
});

configureStartupQueryDefaults(queryClient);
startupQueryPersistence.restore(queryClient);
startupQueryPersistence.start(queryClient);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ColorSchemeScript defaultColorScheme="auto" />
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <ModalsProvider>
          <Notifications position="bottom-right" />
          <BrowserRouter>
            <AppUpdateProvider>
              <BetaInstallProvider>
                <App />
              </BetaInstallProvider>
            </AppUpdateProvider>
          </BrowserRouter>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
