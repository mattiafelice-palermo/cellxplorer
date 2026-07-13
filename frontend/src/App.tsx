import {
  Alert,
  AppShell,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconBug, IconChartLine, IconDatabase, IconFolder, IconHistory } from "@tabler/icons-react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { get, type ActivityEvent } from "./api";
import { addDebugEvent, getDebugEvents } from "./debug";
import { AnalysesIndexPage } from "./pages/AnalysesIndexPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { InboxPage } from "./pages/InboxPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProjectsPage } from "./pages/ProjectsPage";
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
  const [debugOpen, setDebugOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [uiZoom, setUiZoom] = useState(() => {
    const stored = Number(window.localStorage.getItem("cellxplorer-ui-zoom"));
    return Number.isFinite(stored) && stored >= 0.7 && stored <= 1.6 ? stored : 1;
  });
  useEffect(() => {
    document.documentElement.style.zoom = String(uiZoom);
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
  const activity = useQuery({
    queryKey: ["activity", activityOpen],
    queryFn: () => get<ActivityEvent[]>("/api/activity?limit=80"),
    enabled: activityOpen,
  });
  const guardedNavigate = (path: string) => {
    const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
      cancelable: true,
      detail: { proceed: () => navigate(path) },
    });
    if (window.dispatchEvent(event)) navigate(path);
  };

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: 290, breakpoint: "xs" }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
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
              size="compact-xs"
              variant="subtle"
              leftSection={<IconHistory size={14} />}
              onClick={() => setActivityOpen(true)}
            >
              Activity
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconBug size={14} />}
              onClick={() => setDebugOpen(true)}
            >
              Debug
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
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
      </AppShell.Navbar>

      <AppShell.Main>
        <RouteErrorBoundary routeKey={location.pathname}>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/analyses" element={<AnalysesIndexPage />} />
            <Route path="/analyses/:analysisId" element={<AnalysisPage />} />
          </Routes>
        </RouteErrorBoundary>
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
      <Modal opened={activityOpen} onClose={() => setActivityOpen(false)} title="Activity log" size="lg">
        <ScrollArea h={520} type="auto">
          {activity.isLoading ? (
            <Text c="dimmed" size="sm">
              Loading activity...
            </Text>
          ) : activity.isError ? (
            <Alert color="red">Could not load activity.</Alert>
          ) : (activity.data ?? []).length === 0 ? (
            <Text c="dimmed" size="sm">
              No activity recorded yet.
            </Text>
          ) : (
            <Stack gap="xs">
              {(activity.data ?? []).map((event) => (
                <Paper key={event.id} p="sm" withBorder bg="#fbfbfc">
                  <Group justify="space-between" align="start" wrap="nowrap">
                    <div>
                      <Group gap="xs" mb={4}>
                        <Badge
                          size="sm"
                          color={
                            event.severity === "error"
                              ? "red"
                              : event.severity === "warning"
                                ? "orange"
                                : "teal"
                          }
                          variant="light"
                        >
                          {event.category}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {new Date(event.created_at).toLocaleString()}
                        </Text>
                      </Group>
                      <Text fw={700}>{event.message}</Text>
                      {Object.keys(event.details ?? {}).length > 0 && (
                        <Code block mt="xs">
                          {JSON.stringify(event.details, null, 2)}
                        </Code>
                      )}
                    </div>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Modal>
    </AppShell>
  );
}
