import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import {
  IconClipboard,
  IconCpu,
  IconDatabase,
  IconFileExport,
  IconFolderOpen,
  IconHeartbeat,
  IconLogs,
} from "@tabler/icons-react";

import {
  get,
  type DiagnosticsHealth,
  type DiagnosticsLogs,
  type DiagnosticsResources,
} from "../api";
import { saveDownload } from "../downloads";

interface DiagnosticsModalProps {
  opened: boolean;
  onClose: () => void;
  debugContext: Record<string, unknown>;
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function HealthBadge({ ok, label }: { ok: boolean | undefined; label: string }) {
  return <Badge variant="light" color={ok === undefined ? "gray" : ok ? "teal" : "red"}>{label}</Badge>;
}

export function DiagnosticsModal({ opened, onClose, debugContext }: DiagnosticsModalProps) {
  const health = useQuery({
    queryKey: ["diagnostics-health"],
    queryFn: () => get<DiagnosticsHealth>("/api/diagnostics/health"),
    enabled: opened,
    staleTime: 15_000,
    refetchInterval: opened ? 5000 : false,
  });
  const resources = useQuery({
    queryKey: ["diagnostics-resources"],
    queryFn: () => get<DiagnosticsResources>("/api/diagnostics/resources"),
    enabled: opened,
    refetchInterval: opened ? 1500 : false,
  });
  const logs = useQuery({
    queryKey: ["diagnostics-logs"],
    queryFn: () => get<DiagnosticsLogs>("/api/diagnostics/logs?limit=300"),
    enabled: opened,
    refetchInterval: opened ? 5000 : false,
  });

  const report = {
    generated_at: new Date().toISOString(),
    context: debugContext,
    health: health.data,
    resources: resources.data,
    logs: logs.data,
  };

  const redactDiagnostics = (value: string) => {
    const dataPath = health.data?.storage.data_path;
    const logPath = health.data?.storage.log_path;
    let redacted = value;
    if (logPath) redacted = redacted.replaceAll(logPath, "<log-dir>");
    if (dataPath) redacted = redacted.replaceAll(dataPath, "<data-dir>");
    return redacted;
  };

  const copyReport = async () => {
    await navigator.clipboard.writeText(redactDiagnostics(JSON.stringify(report, null, 2)));
    notifications.show({ message: "Diagnostic report copied.", color: "teal" });
  };

  const exportLogs = async () => {
    const text = redactDiagnostics([
      "CellXplorer backend log",
      ...(logs.data?.backend ?? []),
      "",
      "CellXplorer crash log",
      ...(logs.data?.crash ?? []),
    ].join("\n"));
    await saveDownload(new Blob([text], { type: "text/plain;charset=utf-8" }), "cellxplorer-diagnostics.log");
  };

  const openFolder = async (kind: "data" | "logs") => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_app_folder", { kind });
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not open the folder.",
        color: "red",
      });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Diagnostics" size="xl">
      <Tabs defaultValue="health">
        <Tabs.List>
          <Tabs.Tab value="health" leftSection={<IconHeartbeat size={15} />}>Health</Tabs.Tab>
          <Tabs.Tab value="resources" leftSection={<IconCpu size={15} />}>Resources</Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconLogs size={15} />}>Logs</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="health" pt="md">
          {health.isError ? <Alert color="red">Could not load backend diagnostics.</Alert> : null}
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Paper withBorder p="md">
                <Group justify="space-between" mb="sm">
                  <Title order={5}>Services</Title>
                  <IconHeartbeat size={18} color="var(--mantine-primary-color-6)" />
                </Group>
                <Group gap="xs">
                  <HealthBadge ok={health.data ? health.data.backend.status === "ok" : undefined} label="Backend" />
                  <HealthBadge ok={health.data?.backend.database_ok} label="Database" />
                  <HealthBadge ok={health.data ? !health.data.jobs.failed : undefined} label="Jobs" />
                  {health.data?.database ? (
                    <Badge variant="light" color={health.data.database.compatible ? "teal" : "orange"}>
                      Schema {health.data.database.schema_revision ?? "unversioned"}
                    </Badge>
                  ) : null}
                </Group>
                <Text size="sm" c="dimmed" mt="sm">
                  {health.data ? `${health.data.jobs.running} background jobs running` : "Checking background jobs..."}
                </Text>
                {health.data?.database ? (
                  <Text size="xs" c="dimmed" mt={4}>
                    Supports schema {health.data.database.supported_revision}. {health.data.database.message}
                  </Text>
                ) : null}
              </Paper>
              <Paper withBorder p="md">
                <Group justify="space-between" mb="sm">
                  <Title order={5}>Storage</Title>
                  <IconDatabase size={18} color="var(--mantine-primary-color-6)" />
                </Group>
                <Group gap="xs">
                  <HealthBadge ok={health.data?.storage.data_writable} label="Data writable" />
                  <HealthBadge ok={health.data?.storage.cache_writable} label="Cache writable" />
                  <HealthBadge ok={health.data?.storage.logs_writable} label="Logs writable" />
                </Group>
                <Text size="sm" mt="sm">
                  {health.data
                    ? `${bytes(health.data.storage.free_bytes)} free of ${bytes(health.data.storage.total_bytes)}`
                    : "Checking storage..."}
                </Text>
              </Paper>
            </SimpleGrid>
            <Paper withBorder p="md">
              <Title order={5} mb="sm">Current session</Title>
              {health.data?.session ? (
                <Group gap="xl">
                  <Text size="sm">Started {new Date(health.data.session.started_at).toLocaleString()}</Text>
                  <Badge variant="light">{health.data.session.startup_mode}</Badge>
                  <Text size="sm" c="dimmed">Version {health.data.session.app_version ?? "development"}</Text>
                </Group>
              ) : <Text size="sm" c="dimmed">No active session record.</Text>}
            </Paper>
            <Group>
              <Button variant="default" leftSection={<IconClipboard size={16} />} onClick={copyReport}>Copy report</Button>
              <Button variant="default" leftSection={<IconFolderOpen size={16} />} onClick={() => openFolder("data")}>Data folder</Button>
              <Button variant="default" leftSection={<IconFolderOpen size={16} />} onClick={() => openFolder("logs")}>Log folder</Button>
            </Group>
            <Code block>{JSON.stringify(debugContext, null, 2)}</Code>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="resources" pt="md">
          <Stack gap="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Paper withBorder p="md"><Text size="xs" c="dimmed">CPU</Text><Text fw={700} size="xl">{resources.data ? `${resources.data.cpu_percent.toFixed(1)}%` : "-"}</Text></Paper>
              <Paper withBorder p="md"><Text size="xs" c="dimmed">Memory</Text><Text fw={700} size="xl">{resources.data ? bytes(resources.data.memory_bytes) : "-"}</Text></Paper>
              <Paper withBorder p="md"><Text size="xs" c="dimmed">Read I/O</Text><Text fw={700} size="xl">{resources.data ? bytes(resources.data.read_bytes) : "-"}</Text></Paper>
              <Paper withBorder p="md"><Text size="xs" c="dimmed">Written I/O</Text><Text fw={700} size="xl">{resources.data ? bytes(resources.data.written_bytes) : "-"}</Text></Paper>
            </SimpleGrid>
            <Paper withBorder p="md">
              <Group justify="space-between" mb={6}>
                <Text fw={600}>CPU utilization</Text>
                <Text size="sm" c="dimmed">{resources.data ? `Uptime ${duration(resources.data.uptime_seconds)}` : "Sampling..."}</Text>
              </Group>
              <Progress value={resources.data?.cpu_percent ?? 0} />
            </Paper>
            <Paper withBorder p="md">
              <Group justify="space-between" mb="sm">
                <Title order={5}>CellXplorer processes</Title>
                <Badge variant="light">{resources.data?.process_count ?? "-"}</Badge>
              </Group>
              <ScrollArea h={230} type="auto">
                <Table striped highlightOnHover>
                  <Table.Thead><Table.Tr><Table.Th>Process</Table.Th><Table.Th>PID</Table.Th><Table.Th>RAM</Table.Th><Table.Th>Read</Table.Th><Table.Th>Written</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {(resources.data?.processes ?? []).map((process) => (
                      <Table.Tr key={process.pid}>
                        <Table.Td>{process.name}</Table.Td><Table.Td>{process.pid}</Table.Td><Table.Td>{bytes(process.memory_bytes)}</Table.Td><Table.Td>{bytes(process.read_bytes)}</Table.Td><Table.Td>{bytes(process.written_bytes)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
              <Text size="xs" c="dimmed" mt="sm">Windows reports total process I/O, including non-disk operations.</Text>
            </Paper>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="logs" pt="md">
          <Group justify="flex-end" mb="sm">
            <Button variant="default" leftSection={<IconFileExport size={16} />} onClick={exportLogs}>Export logs</Button>
          </Group>
          <ScrollArea h={470} type="auto">
            <Stack gap="md">
              <div><Text fw={700} mb={6}>Backend</Text><Code block>{(logs.data?.backend ?? ["No backend log entries."]).join("\n")}</Code></div>
              {(logs.data?.crash ?? []).length ? <div><Text fw={700} mb={6}>Crash log</Text><Code block>{logs.data?.crash.join("\n")}</Code></div> : null}
            </Stack>
          </ScrollArea>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
