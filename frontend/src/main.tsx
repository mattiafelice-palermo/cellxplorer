import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app.css";

import { MantineProvider, createTheme } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { ApiError } from "./api";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "md",
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The desktop window is intentionally displayed before its Python
      // sidecar is ready. Keep page queries alive during that short boot
      // window, but do not retry real HTTP/application errors.
      retry: (failureCount, error) =>
        !(error instanceof ApiError) && failureCount < 30,
      retryDelay: 250,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <ModalsProvider>
          <Notifications position="bottom-right" />
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
