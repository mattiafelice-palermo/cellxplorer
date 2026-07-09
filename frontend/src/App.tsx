import {
  Alert,
  AppShell,
  Button,
  Code,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  Title,
} from "@mantine/core";
import { IconBug, IconChartLine, IconDatabase, IconFolder } from "@tabler/icons-react";
import { Component, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

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
            <IconDatabase size={22} color="var(--mantine-color-teal-6)" />
            <Title order={4}>CellXplorer</Title>
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconBug size={14} />}
            onClick={() => setDebugOpen(true)}
          >
            Debug
          </Button>
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
    </AppShell>
  );
}
