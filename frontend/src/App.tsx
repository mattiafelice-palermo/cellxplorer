import {
  Accordion,
  Alert,
  AppShell,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  NavLink,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Divider,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconActivity, IconBug, IconChartLine, IconDatabase, IconFolder, IconLoader2, IconSettings } from "@tabler/icons-react";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { get, type BackgroundJob, type SourceCheckJob } from "./api";
import { addDebugEvent, getDebugEvents } from "./debug";
import { AnalysesIndexPage } from "./pages/AnalysesIndexPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { InboxPage } from "./pages/InboxPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "./navigationEvents";

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
  const handledSourceCheckJob = useRef<number | null>(null);
  const [uiZoom, setUiZoom] = useState(() => {
    const stored = Number(window.localStorage.getItem("cellxplorer-ui-zoom"));
    return Number.isFinite(stored) && stored >= 0.7 && stored <= 1.6 ? stored : 1;
  });
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
  const backgroundJobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => get<BackgroundJob[]>("/api/background-jobs?limit=20"),
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 700 : 1200,
  });
  const sourceCheckJob = useQuery({
    queryKey: ["source-check-job"],
    queryFn: () => get<SourceCheckJob | null>("/api/source-check-jobs/latest"),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 600 : false),
  });
  useEffect(() => {
    const job = sourceCheckJob.data;
    if (!job || job.status === "running" || handledSourceCheckJob.current === job.id) return;
    handledSourceCheckJob.current = job.id;
    queryClient.invalidateQueries({ queryKey: ["cells"] });
    queryClient.invalidateQueries({ queryKey: ["cell"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["tree"] });
    queryClient.invalidateQueries({ queryKey: ["activity"] });
    if (job.status === "failed") {
      notifications.show({ message: job.error || "Source check failed.", color: "red" });
    } else {
      notifications.show({
        message: `Checked ${job.completed} source file${job.completed === 1 ? "" : "s"} (${job.changed} changed, ${job.offline} offline).`,
        color: job.changed || job.offline || job.errors ? "orange" : "teal",
      });
      if (job.skipped_complete) {
        notifications.show({
          message: `Skipped ${job.skipped_complete} completed cell${job.skipped_complete === 1 ? "" : "s"}.`,
          color: "gray",
        });
      }
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

  return (
    <AppShell
      header={{ height: 52 * uiZoom }}
      navbar={{ width: 290 * uiZoom, breakpoint: "xs" }}
      padding={0}
    >
      <AppShell.Header>
        <Group
          className="cellxplorer-scaled-surface"
          h={52}
          px="md"
          justify="space-between"
          style={{ zoom: uiZoom, width: "100%" }}
        >
          <Group gap="xs">
            <img
              src="/app-icon.png"
              alt=""
              aria-hidden="true"
              style={{ width: 24, height: 24, display: "block" }}
            />
            <Title order={4}>CellXplorer</Title>
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
              <Route path="/settings/activity" element={<SettingsPage />} />
            </Routes>
          </RouteErrorBoundary>
        </div>
      </AppShell.Main>

      <Modal opened={debugOpen} onClose={() => setDebugOpen(false)} title="Debug info" size="xl">
        <ScrollArea h={520} type="auto">
          <Code block>
            {JSON.stringify(
              {
                route: location.pathname,
                href: window.location.href,
                userAgent: navigator.userAgent,
                events: getDebugEvents(),
              },
              null,
              2
            )}
          </Code>
        </ScrollArea>
      </Modal>
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
                              color={label === "failed" || label === "offline" ? "red" : label === "changed" ? "orange" : "teal"}
                            >
                              {count} {label}
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
