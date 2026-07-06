import {
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
import { useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { getDebugEvents } from "./debug";
import { AnalysesIndexPage } from "./pages/AnalysesIndexPage";
import { InboxPage } from "./pages/InboxPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProjectsPage } from "./pages/ProjectsPage";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [debugOpen, setDebugOpen] = useState(false);

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: 290, breakpoint: "xs" }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Group gap="xs">
            <IconDatabase size={22} color="var(--mantine-color-teal-6)" />
            <Title order={4}>Cellxplorer</Title>
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
            onClick={() => navigate("/")}
          />
          <NavLink
            label="Analysis Database"
            leftSection={<IconChartLine size={16} />}
            active={location.pathname === "/analyses"}
            onClick={() => navigate("/analyses")}
          />
          <NavLink
            label="Projects"
            leftSection={<IconFolder size={16} />}
            active={location.pathname === "/projects"}
            onClick={() => navigate("/projects")}
          />
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/analyses" element={<AnalysesIndexPage />} />
          <Route path="/analyses/:analysisId" element={<AnalysesIndexPage />} />
        </Routes>
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
