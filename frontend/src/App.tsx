import {
  Accordion,
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Code,
  Group,
  Kbd,
  Modal,
  NavLink,
  Paper,
  Progress,
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
  IconActivity,
  IconAlertTriangle,
  IconBug,
  IconChartLine,
  IconDatabase,
  IconFolder,
  IconFolderOpen,
  IconLayoutSidebar,
  IconLoader2,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import {
  get,
  post,
  type BackgroundJob,
  type DatabaseStatus,
  type SourceCheckJob,
} from "./api";
import { CommandPalette } from "./components/CommandPalette";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { DownloadsButton } from "./components/DownloadsButton";
import { CacheWarmupCoordinator } from "./components/CacheWarmupCoordinator";
import { addDebugEvent, getDebugEvents } from "./debug";
import { isTauriApp } from "./downloads";
import { AnalysesIndexPage } from "./pages/AnalysesIndexPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { InboxPage } from "./pages/InboxPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "./navigationEvents";
import { startupQueryPersistence } from "./startupQueryPersistence";

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

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [debugOpen, setDebugOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);
  const handledSourceCheckJob = useRef<number | null>(null);
  const handledSourceChangingState = useRef("");
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
    document.documentElement.style.removeProperty("zoom");
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
  const backgroundJobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => get<BackgroundJob[]>("/api/background-jobs?limit=20"),
    enabled: databaseStatus.data?.compatible === true,
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 700 : 5000,
  });
  const sourceCheckJob = useQuery({
    queryKey: ["source-check-job"],
    queryFn: () => get<SourceCheckJob | null>("/api/source-check-jobs/latest"),
    enabled: databaseStatus.data?.compatible === true,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 600 : false),
  });
  useEffect(() => {
    const job = sourceCheckJob.data;
    if (!job) return;
    if (job.status === "running") {
      const state = `${job.id}:${job.deferred ?? 0}`;
      if (handledSourceChangingState.current !== state) {
        handledSourceChangingState.current = state;
        queryClient.invalidateQueries({ queryKey: ["cells"] });
        queryClient.invalidateQueries({ queryKey: ["cell"] });
      }
      return;
    }
    if (handledSourceCheckJob.current === job.id) return;
    handledSourceCheckJob.current = job.id;
    queryClient.invalidateQueries({ queryKey: ["cells"] });
    queryClient.invalidateQueries({ queryKey: ["cell"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["tree"] });
    queryClient.invalidateQueries({ queryKey: ["activity"] });
    queryClient.invalidateQueries({ queryKey: ["analysis"] });
    queryClient.invalidateQueries({ queryKey: ["compute"] });
    queryClient.invalidateQueries({ queryKey: ["time-capacity"] });
    queryClient.invalidateQueries({ queryKey: ["plot-thumbnail"] });
    queryClient.invalidateQueries({ queryKey: ["plot-artifact"] });
    queryClient.invalidateQueries({ queryKey: ["saved-plot-preview"] });
    queryClient.invalidateQueries({ queryKey: ["saved-time-preview"] });
    if (job.status === "failed") {
      notifications.show({ message: job.error || "Source check failed.", color: "red" });
    } else {
      const updateWarnings = Boolean(job.offline || job.errors || job.deferred || job.update_errors?.length);
      const deferredSuffix = job.deferred ? ` ${job.deferred} deferred because the source was still changing.` : "";
      notifications.show({
        message: job.update_after_check
          ? `Checked ${job.completed} sources and updated ${job.updated ?? 0} changed file${job.updated === 1 ? "" : "s"}.${deferredSuffix}`
          : `Checked ${job.completed} source file${job.completed === 1 ? "" : "s"} (${job.changed} changed, ${job.offline} offline).${deferredSuffix}`,
        color: job.update_after_check
          ? (updateWarnings ? "orange" : "teal")
          : (job.changed || job.offline || job.errors ? "orange" : "teal"),
      });
      if (job.skipped_complete) {
        notifications.show({
          message: `Skipped ${job.skipped_complete} completed cell${job.skipped_complete === 1 ? "" : "s"}.`,
          color: "gray",
        });
      }
    }
    if (isTauriApp()) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("set_tray_status", { message: null }),
      );
    }
  }, [queryClient, sourceCheckJob.data]);
  const guardedNavigate = (path: string) => {
    const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
      cancelable: true,
      detail: { proceed: () => navigate(path) },
    });
    if (window.dispatchEvent(event)) navigate(path);
  };
  const activeJob = backgroundJobs.data?.find((job) => job.status === "running") ?? null;
  const activityProgress = activeJob?.total
    ? (activeJob.completed / activeJob.total) * 100
    : activeJob
      ? 100
      : 0;

  if (databaseStatus.isError || (!databaseStatus.isLoading && !databaseStatus.data)) {
    return (
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
      <Group h="100vh" justify="center" p="xl" bg="gray.0">
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
            <Paper withBorder p="md" bg="gray.0">
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
      <CacheWarmupCoordinator enabled={databaseStatus.data?.compatible === true} />
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
              src="/app-icon.png"
              alt=""
              aria-hidden="true"
              style={{ width: 24, height: 24, display: "block" }}
            />
            <Title order={4}>CellXplorer</Title>
            <Button
              size="compact-sm"
              variant="default"
              ml="md"
              leftSection={<IconSearch size={14} />}
              rightSection={<Kbd size="xs">Ctrl+K</Kbd>}
              onClick={() => setPaletteOpen(true)}
            >
              Search
            </Button>
          </Group>
          <Group gap="xs">
            <Button
              className="background-activity-button"
              size="compact-sm"
              variant="subtle"
              color={backgroundJobs.data?.some((job) => job.status === "failed") ? "red" : "teal"}
              leftSection={
                activeJob ? (
                  <IconLoader2 size={14} className="source-check-spin" />
                ) : (
                  <IconActivity size={14} />
                )
              }
              onClick={() => setActivityOpen(true)}
            >
              {activeJob ? (
                <Stack gap={2} className="background-activity-content">
                  <Group gap="xs" justify="space-between" wrap="nowrap">
                    <Text size="xs" fw={600} truncate maw={210}>
                      {activeJob.description}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {activeJob.completed}/{activeJob.total}
                    </Text>
                  </Group>
                  <Progress value={activityProgress} size={3} animated color="teal" />
                </Stack>
              ) : (
                "Activity"
              )}
            </Button>
            <DownloadsButton />
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconBug size={14} />}
              onClick={() => setDebugOpen(true)}
            >
              Debug
            </Button>
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
            label="Cell Database"
            leftSection={<IconDatabase size={16} />}
            active={location.pathname === "/"}
            onClick={() => guardedNavigate("/")}
          />
          <NavLink
            label="Analysis Database"
            leftSection={<IconChartLine size={16} />}
            active={location.pathname === "/analyses"}
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
          <RouteErrorBoundary routeKey={location.pathname}>
            <Routes>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/analyses" element={<AnalysesIndexPage />} />
              <Route path="/analyses/:analysisId" element={<AnalysisPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/monitoring" element={<SettingsPage />} />
              <Route path="/settings/metadata" element={<SettingsPage />} />
              <Route path="/settings/plots" element={<SettingsPage />} />
              <Route path="/settings/desktop" element={<SettingsPage />} />
              <Route path="/settings/cache" element={<SettingsPage />} />
              <Route path="/settings/activity" element={<SettingsPage />} />
            </Routes>
          </RouteErrorBoundary>
        </div>
      </AppShell.Main>

      <CommandPalette opened={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
      <Modal
        opened={activityOpen}
        onClose={() => setActivityOpen(false)}
        title="Background activity"
        size="lg"
      >
        {backgroundJobs.isLoading ? (
          <Text c="dimmed" size="sm">Loading background activity...</Text>
        ) : backgroundJobs.isError ? (
          <Alert color="red">Could not load background activity.</Alert>
        ) : (backgroundJobs.data ?? []).length === 0 ? (
          <Text c="dimmed" size="sm">No background work has run in this session.</Text>
        ) : (
          <Accordion
            variant="separated"
            defaultValue={
              activeJob
                ? String(activeJob.id)
                : backgroundJobs.data?.[0]
                  ? String(backgroundJobs.data[0].id)
                  : null
            }
          >
            {(backgroundJobs.data ?? []).map((job) => {
              const progress = job.total ? (job.completed / job.total) * 100 : 100;
              const jobColor = job.status === "failed" ? "red" : job.status === "running" ? "teal" : "gray";
              return (
                <Accordion.Item key={job.id} value={String(job.id)}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap" pr="sm">
                      <div>
                        <Group gap="xs">
                          <Text fw={700}>{job.title}</Text>
                          <Badge size="sm" variant="light" color={jobColor}>{job.status}</Badge>
                        </Group>
                        <Text size="sm" c="dimmed" mt={2}>{job.description}</Text>
                      </div>
                      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                        {job.completed} / {job.total}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Progress
                        value={progress}
                        animated={job.status === "running"}
                        color={jobColor}
                      />
                      <Group gap="xl">
                        <Text size="xs" c="dimmed">
                          Started {new Date(job.started_at).toLocaleString()}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {job.completed_at
                            ? `Finished ${new Date(job.completed_at).toLocaleString()}`
                            : "Still running"}
                        </Text>
                      </Group>
                      {Object.keys(job.counters).length ? (
                        <Group gap={6}>
                          {Object.entries(job.counters).map(([label, count]) => (
                            <Badge
                              key={label}
                              size="sm"
                              variant="light"
                              color={label === "failed" || label === "offline" ? "red" : label === "changed" || label === "reparsed" ? "orange" : label === "cached" ? "gray" : "teal"}
                            >
                              {count} {label === "reparsed" ? "re-parsed" : label === "cached" ? "from cache" : label}
                            </Badge>
                          ))}
                        </Group>
                      ) : null}
                      {job.error ? <Alert color="red">{job.error}</Alert> : null}
                      {job.items.length ? (
                        <ScrollArea h={Math.min(300, Math.max(90, job.items.length * 43))} type="auto">
                          <Stack gap={6}>
                            {job.items.map((item) => (
                              <Paper key={item.id} withBorder px="sm" py={8} bg="#fbfbfc">
                                <Group justify="space-between" wrap="nowrap">
                                  <div style={{ minWidth: 0 }}>
                                    <Text size="sm" truncate title={item.label}>{item.label}</Text>
                                    {item.detail ? <Text size="xs" c="dimmed">{item.detail}</Text> : null}
                                    {item.error ? <Text size="xs" c="red">{item.error}</Text> : null}
                                  </div>
                                  <Badge
                                    size="sm"
                                    variant="light"
                                    color={
                                      item.status === "ready"
                                        ? "teal"
                                        : item.status === "changed"
                                          ? "orange"
                                          : item.status === "failed" || item.status === "offline"
                                            ? "red"
                                            : "gray"
                                    }
                                  >
                                    {item.status}
                                  </Badge>
                                </Group>
                              </Paper>
                            ))}
                          </Stack>
                        </ScrollArea>
                      ) : null}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}
      </Modal>
    </AppShell>
  );
}
