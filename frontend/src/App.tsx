import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Code,
  Group,
  Loader,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Divider,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconChartLine,
  IconDatabase,
  IconFolder,
  IconFolderOpen,
  IconLayoutSidebar,
  IconSettings,
  IconPlus,
  IconUpload,
} from "@tabler/icons-react";
import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import {
  get,
  post,
  type AutomationPauseState,
  type DatabaseStatus,
  type SourceCheckJob,
} from "./api";
import { BackgroundActivityController } from "./components/BackgroundActivityController";
import { CommandPalette } from "./components/CommandPalette";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { DownloadsButton } from "./components/DownloadsButton";
import { NavigationWarmupDebugButton } from "./components/NavigationWarmupDebugButton";
import { CacheWarmupCoordinator } from "./features/analyses/editor/artifacts/CacheWarmupCoordinator";
import { BetaBootstrapCoordinator } from "./components/BetaBootstrapCoordinator";
import { QuickSettingsMenu, PAUSE_QUERY_KEY } from "./components/QuickSettingsMenu";
import { WhatsNewCoordinator } from "./components/WhatsNewCoordinator";
import { AnalysisWorkspaceTabs } from "./features/analyses/workspace/AnalysisWorkspaceTabs";
import { addDebugEvent, getDebugEvents } from "./debug";
import { isTauriApp } from "./downloads";
import { LibraryPage } from "./pages/LibraryPage";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "./navigationEvents";
import { startupQueryPersistence } from "./startupQueryPersistence";
import { APP_BRANDING } from "./appChannel";

const AnalysisWorkspaceContent = lazy(() =>
  import("./features/analyses/workspace/AnalysisWorkspaceContent").then((module) => ({
    default: module.AnalysisWorkspaceContent,
  })),
);
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then((module) => ({ default: module.InboxPage })),
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

function RouteLoadingFallback() {
  return (
    <Center h={320}>
      <Loader />
    </Center>
  );
}

let analysisEditorPrefetchStarted = false;
function prefetchAnalysisEditor(): void {
  if (analysisEditorPrefetchStarted) return;
  analysisEditorPrefetchStarted = true;
  void import("./features/analyses/workspace/AnalysisWorkspaceContent");
  void import("./features/analyses/editor/AnalysisEditor");
}

class RouteErrorBoundary extends Component<{ children: ReactNode; routeKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    addDebugEvent("route:error", { message: error.message, stack: error.stack });
  }

  componentDidUpdate(previous: { routeKey: string }) {
    if (previous.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Alert color="red" title="Page failed to render">
          <Code block>{this.state.error.stack ?? this.state.error.message}</Code>
        </Alert>
      );
    }
    return this.props.children;
  }
}

export default function App({
  betaBootstrapGateRequired,
}: {
  betaBootstrapGateRequired: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [debugOpen, setDebugOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [bootstrapBlocking, setBootstrapBlocking] = useState(true);
  const openWhatsNew = useCallback(() => setWhatsNewOpen(true), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);
  const [uiZoom, setUiZoom] = useState(() => {
    const stored = Number(window.localStorage.getItem("cellxplorer-ui-zoom"));
    return Number.isFinite(stored) && stored >= 0.7 && stored <= 1.6 ? stored : 1;
  });
  const databaseStatus = useQuery({
    queryKey: ["database-status"],
    queryFn: () => get<DatabaseStatus>("/api/database/status"),
    // The desktop backend needs a few seconds to boot before it can answer.
    // Poll quickly so the app opens the moment it is reachable; the
    // unreachable screen only appears after sustained failure (~18s).
    retry: 60,
    retryDelay: 300,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (databaseStatus.data) {
      startupQueryPersistence.reconcile(queryClient, databaseStatus.data);
      if (databaseStatus.data.compatible) {
        // Populate every compact startup view, even when the user does not
        // visit it during this session. React Query deduplicates the request
        // for whichever page is already active.
        void Promise.allSettled([
          queryClient.prefetchQuery({
            queryKey: ["cells", ""],
            queryFn: () => get<unknown[]>("/api/cells"),
          }),
          queryClient.prefetchQuery({
            queryKey: ["analyses", ""],
            queryFn: () => get<unknown[]>("/api/analyses"),
          }),
          queryClient.prefetchQuery({
            queryKey: ["replicate-groups"],
            queryFn: () => get<unknown[]>("/api/replicate-groups"),
          }),
          queryClient.prefetchQuery({
            queryKey: ["tree"],
            queryFn: () => get<unknown>("/api/tree"),
          }),
        ]).then(() => startupQueryPersistence.flush(queryClient));
      }
    }
  }, [databaseStatus.data, queryClient]);
  useEffect(() => {
    if (databaseStatus.data?.compatible !== true || bootstrapBlocking) return;
    let idleId: number | null = null;
    const timerId = window.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(prefetchAnalysisEditor, { timeout: 4000 });
      } else {
        prefetchAnalysisEditor();
      }
    }, 2000);
    return () => {
      window.clearTimeout(timerId);
      if (idleId !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [databaseStatus.data?.compatible, bootstrapBlocking]);
  useEffect(() => {
    document.documentElement.style.removeProperty("zoom");
    document.documentElement.style.setProperty("--cellxplorer-ui-zoom", String(uiZoom));
    window.localStorage.setItem("cellxplorer-ui-zoom", String(uiZoom));
    const timer = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    return () => window.clearTimeout(timer);
  }, [uiZoom]);
  useEffect(() => {
    const adjust = (delta: number) =>
      setUiZoom((current) => Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 10) / 10)));
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      // Ctrl+K opens global search, Ctrl+B toggles the sidebar. Both are safe
      // to capture while typing; Ctrl+A is deliberately left to "select all".
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setNavbarCollapsed((collapsed) => !collapsed);
        return;
      }
      if (!event.ctrlKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        adjust(0.1);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        adjust(-0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        setUiZoom(1);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      adjust(event.deltaY < 0 ? 0.1 : -0.1);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, []);
  useEffect(() => {
    if (!isTauriApp()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const openPortableImport = (deepLink?: string) => {
        const params = new URLSearchParams({ portableImport: "1" });
        if (deepLink) {
          try {
            const source = new URL(deepLink).searchParams.get("source");
            if (source) params.set("portableSource", source);
          } catch {
            // Older links intentionally open the empty import modal.
          }
        }
        navigate(`/analyses?${params.toString()}`);
      };
      const unlistenPortableImport = await listen<string>(
        "portable-import-requested",
        (event) => openPortableImport(event.payload)
      );
      const unlistenCheck = await listen("tray-check-update", async () => {
        try {
          const job = await post<SourceCheckJob>("/api/cells/check-update-sources/jobs");
          queryClient.setQueryData(["source-check-job"], job);
          queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
        } catch (error) {
          notifications.show({
            message: error instanceof Error ? error.message : "Could not start source maintenance.",
            color: "red",
          });
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("set_tray_status", { message: null });
        }
      });
      const unlistenQuit = await listen("tray-quit-requested", async () => {
        try {
          await post("/api/session/finish");
        } finally {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("quit_app");
        }
      });
      if (disposed) {
        unlistenPortableImport();
        unlistenCheck();
        unlistenQuit();
      } else {
        cleanups.push(unlistenPortableImport, unlistenCheck, unlistenQuit);
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const pending = await invoke<string | null>("take_pending_deep_link");
      if (pending && !disposed) openPortableImport(pending);
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [navigate, queryClient]);
  const automationPause = useQuery({
    queryKey: PAUSE_QUERY_KEY,
    queryFn: () => get<AutomationPauseState>("/api/automation/pause"),
    enabled: databaseStatus.data?.compatible === true,
    refetchInterval: 60_000,
  });
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (import.meta.env.DEV) return;
      const el = event.target as HTMLElement | null;
      if (
        el?.closest(
          "input, textarea, [contenteditable=''], [contenteditable='true'], [data-native-menu='true']",
        )
      ) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
  const guardedNavigate = useCallback((path: string) => {
    const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
      cancelable: true,
      detail: { proceed: () => navigate(path), reason: "navigate" },
    });
    if (window.dispatchEvent(event)) navigate(path);
  }, [navigate]);

  if (databaseStatus.isError || (!databaseStatus.isLoading && !databaseStatus.data)) {
    return (
      <>
        <BetaBootstrapCoordinator
          backendReady={false}
          gateRequiredOnLaunch={betaBootstrapGateRequired}
          onBlockingChange={setBootstrapBlocking}
        />
        <Group h="100vh" justify="center" p="xl">
          <Alert
            color="red"
            title="Could not contact the CellXplorer backend"
            maw={680}
          >
            The application could not determine whether the database is compatible.
            Check the backend log or restart CellXplorer.
          </Alert>
        </Group>
      </>
    );
  }

  if (databaseStatus.data && !databaseStatus.data.compatible) {
    const status = databaseStatus.data;
    const title =
      status.status === "database_too_new"
        ? "This database needs a newer CellXplorer"
        : status.status === "database_corrupt"
          ? "The database may be damaged"
          : status.status === "database_unrecognized"
            ? "This database is not recognized"
            : "The database could not be upgraded";
    const openFolder = async (kind: "data" | "logs") => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_app_folder", { kind });
      } catch {
        notifications.show({
          message: "Folder opening is available in the Windows application.",
          color: "orange",
        });
      }
    };
    return (
      <Group h="100vh" justify="center" p="xl" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
        <Paper withBorder p="xl" maw={760} w="100%">
          <Stack gap="lg">
            <Group gap="sm">
              <IconAlertTriangle
                size={30}
                color="var(--mantine-color-orange-6)"
              />
              <div>
                <Title order={2}>{title}</Title>
                <Text c="dimmed">
                  Your database has not been modified further.
                </Text>
              </div>
            </Group>
            <Alert color="orange">{status.message}</Alert>
            <Paper withBorder p="md" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Application version</Text>
                  <Code>{status.app_version}</Code>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Database schema</Text>
                  <Code>{status.schema_revision ?? "Unversioned"}</Code>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Supported schema</Text>
                  <Code>{status.supported_revision}</Code>
                </Group>
                {status.backup_path ? (
                  <Stack gap={4} mt="xs">
                    <Text size="sm" c="dimmed">Pre-migration backup</Text>
                    <Code block>{status.backup_path}</Code>
                  </Stack>
                ) : null}
              </Stack>
            </Paper>
            <Text size="sm">
              CellXplorer has disabled normal database operations to avoid
              damaging user data. Updating the application may be required for
              a newer schema; migration failures can be investigated from the
              logs.
            </Text>
            <Group>
              <Button
                variant="default"
                leftSection={<IconFolderOpen size={16} />}
                onClick={() => openFolder("data")}
              >
                Data folder
              </Button>
              <Button
                variant="default"
                leftSection={<IconFolderOpen size={16} />}
                onClick={() => openFolder("logs")}
              >
                Log folder
              </Button>
              <Button variant="light" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Group>
    );
  }

  return (
    <AppShell
      header={{ height: 52 * uiZoom }}
      navbar={{
        width: 290 * uiZoom,
        breakpoint: "xs",
        collapsed: { desktop: navbarCollapsed, mobile: navbarCollapsed },
      }}
      padding={0}
    >
      <CacheWarmupCoordinator
        enabled={
          databaseStatus.data?.compatible === true && !automationPause.data?.paused
        }
      />
      <BetaBootstrapCoordinator
        backendReady={databaseStatus.data?.compatible === true}
        gateRequiredOnLaunch={betaBootstrapGateRequired}
        onBlockingChange={setBootstrapBlocking}
      />
      <WhatsNewCoordinator opened={whatsNewOpen} onOpen={openWhatsNew} onClose={() => setWhatsNewOpen(false)}
        bootstrapBlocking={bootstrapBlocking}
        ready={databaseStatus.data?.compatible === true} version={databaseStatus.data?.app_version ?? null}
        onTrySearch={() => guardedNavigate("/settings/file-search")} />
      <AppShell.Header>
        <Group
          className="cellxplorer-scaled-surface"
          h={52}
          px="md"
          justify="space-between"
          style={{ zoom: uiZoom, width: "100%" }}
        >
          <Group gap="xs">
            <Tooltip label="Toggle sidebar (Ctrl+B)" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Toggle sidebar"
                onClick={() => setNavbarCollapsed((collapsed) => !collapsed)}
              >
                <IconLayoutSidebar size={18} />
              </ActionIcon>
            </Tooltip>
            <img
              src={APP_BRANDING.appIconPath}
              alt=""
              aria-hidden="true"
              style={{ width: 24, height: 24, display: "block" }}
            />
            <Group gap={6} wrap="nowrap" align="center">
              <Title order={4}>{APP_BRANDING.headerTitle}</Title>
              {APP_BRANDING.badgeLabel ? (
                <Badge size="xs" color={APP_BRANDING.primaryColor} variant="filled" radius="sm">
                  {APP_BRANDING.badgeLabel}
                </Badge>
              ) : null}
            </Group>
          </Group>
          <Group gap="xs">
            <BackgroundActivityController
              enabled={databaseStatus.data?.compatible === true}
              databaseId={databaseStatus.data?.compatible ? databaseStatus.data.database_instance_id : null}
              onNavigate={guardedNavigate}
            />
            <NavigationWarmupDebugButton />
            <DownloadsButton />
            <QuickSettingsMenu
              onOpenDebug={() => setDebugOpen(true)}
              onOpenWhatsNew={openWhatsNew}
              onOpenUpdateSettings={() => guardedNavigate("/settings/updates")}
              suppressUpdateBubble={bootstrapBlocking || whatsNewOpen}
            />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p={0}>
        <div
          className="cellxplorer-scaled-surface"
          style={{
            zoom: uiZoom,
            width: "100%",
            height: `${100 / uiZoom}%`,
            padding: "var(--mantine-spacing-xs)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ScrollArea type="auto" style={{ flex: 1 }}>
          <NavLink
            className="database-nav-link"
            label="Cell Database"
            leftSection={<IconDatabase size={16} />}
            rightSection={(
              <Tooltip label="Load cells" withArrow openDelay={0} closeDelay={0}>
                <ActionIcon
                  size="sm"
                  className="database-nav-action"
                  variant="light"
                  color="teal"
                  aria-label="Load cells"
                  tabIndex={0}
                  style={{ border: "1px solid color-mix(in srgb, var(--mantine-primary-color-6) 50%, transparent)" }}
                  onClick={(event) => { event.stopPropagation(); guardedNavigate("/?loadCells=1"); }}
                ><IconUpload size={15} /></ActionIcon>
              </Tooltip>
            )}
            active={location.pathname === "/"}
            onClick={() => guardedNavigate("/")}
          />
          <NavLink
            className="database-nav-link"
            label="Analysis Database"
            leftSection={<IconChartLine size={16} />}
            rightSection={(
              <Tooltip label="Create analysis" withArrow openDelay={0} closeDelay={0}>
                <ActionIcon
                  size="sm"
                  className="database-nav-action"
                  variant="light"
                  color="teal"
                  aria-label="Create analysis"
                  tabIndex={0}
                  style={{ border: "1px solid color-mix(in srgb, var(--mantine-primary-color-6) 50%, transparent)" }}
                  onClick={(event) => { event.stopPropagation(); guardedNavigate("/analyses?new=1"); }}
                ><IconPlus size={15} /></ActionIcon>
              </Tooltip>
            )}
            active={location.pathname === "/analyses"}
            onMouseEnter={prefetchAnalysisEditor}
            onFocus={prefetchAnalysisEditor}
            onClick={() => guardedNavigate("/analyses")}
          />
          <NavLink
            label="Projects"
            leftSection={<IconFolder size={16} />}
            active={location.pathname === "/projects"}
            onClick={() => guardedNavigate("/projects")}
          />
          </ScrollArea>
          <Divider my="xs" />
          <NavLink
            label="Settings"
            leftSection={<IconSettings size={16} />}
            active={location.pathname.startsWith("/settings")}
            onClick={() => guardedNavigate("/settings")}
          />
        </div>
      </AppShell.Navbar>

      <AppShell.Main>
        <div
          className="cellxplorer-scaled-surface"
          style={{
            zoom: uiZoom,
            width: "100%",
            padding: "var(--mantine-spacing-md)",
          }}
        >
          {location.pathname.startsWith("/analyses") ? <AnalysisWorkspaceTabs /> : null}
          <RouteErrorBoundary routeKey={location.pathname}>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Routes>
                <Route path="/" element={<LibraryPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/analyses/*" element={<AnalysisWorkspaceContent />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/file-search" element={<SettingsPage />} />
                <Route path="/settings/monitoring" element={<SettingsPage />} />
                <Route path="/settings/metadata" element={<SettingsPage />} />
                <Route path="/settings/plots" element={<SettingsPage />} />
                <Route path="/settings/desktop" element={<SettingsPage />} />
                <Route path="/settings/updates" element={<SettingsPage />} />
                <Route path="/settings/notifications" element={<SettingsPage />} />
                <Route path="/settings/performance" element={<SettingsPage />} />
                <Route path="/settings/cache" element={<SettingsPage />} />
                <Route path="/settings/activity" element={<SettingsPage />} />
              </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </div>
      </AppShell.Main>

      {paletteOpen ? (
        <CommandPalette opened={paletteOpen} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {debugOpen ? (
        <DiagnosticsModal
          opened={debugOpen}
          onClose={() => setDebugOpen(false)}
          debugContext={{
            route: location.pathname,
            href: window.location.href,
            userAgent: navigator.userAgent,
            events: getDebugEvents(),
          }}
        />
      ) : null}
    </AppShell>
  );
}
