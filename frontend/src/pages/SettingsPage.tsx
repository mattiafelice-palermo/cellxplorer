import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconActivityHeartbeat, IconDeviceDesktop, IconDeviceFloppy, IconDownload, IconFolderOpen, IconHistory } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { get, put, type ActivityEvent, type AppSession, type DownloadSettings, type SourceMonitoringSettings } from "../api";
import { isTauriApp } from "../downloads";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = location.pathname.endsWith("/activity")
    ? "activity"
    : location.pathname.endsWith("/monitoring")
      ? "monitoring"
    : location.pathname.endsWith("/desktop")
      ? "desktop"
      : "downloads";
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<DownloadSettings>("/api/settings"),
    enabled: activeTab === "downloads",
  });
  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: () => get<ActivityEvent[]>("/api/activity?limit=200"),
    enabled: activeTab === "activity",
  });
  const sessions = useQuery({
    queryKey: ["app-sessions"],
    queryFn: () => get<AppSession[]>("/api/sessions?limit=50"),
    enabled: activeTab === "activity",
  });
  const monitoring = useQuery({
    queryKey: ["source-monitor-settings"],
    queryFn: () => get<SourceMonitoringSettings>("/api/source-monitor/settings"),
    enabled: activeTab === "monitoring",
  });
  const [mode, setMode] = useState<DownloadSettings["download_mode"]>("ask");
  const [folder, setFolder] = useState("");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [monitorForm, setMonitorForm] = useState<SourceMonitoringSettings>({
    enabled: false,
    schedule_mode: "interval",
    interval_value: 6,
    interval_unit: "hours",
    daily_every_days: 1,
    daily_time: "02:00",
    auto_update: false,
    scan_batch_size: 100,
    stability_value: 5,
    stability_unit: "seconds",
    retry_count: 3,
    retry_delay_minutes: 5,
    next_run_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_status: null,
  });

  useEffect(() => {
    if (!settings.data) return;
    setMode(settings.data.download_mode);
    setFolder(settings.data.download_folder ?? "");
  }, [settings.data]);

  useEffect(() => {
    if (monitoring.data) setMonitorForm(monitoring.data);
  }, [monitoring.data]);

  useEffect(() => {
    if (activeTab !== "desktop" || !isTauriApp()) return;
    setAutostartLoading(true);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("is_autostart_enabled"))
      .then(setAutostartEnabled)
      .catch((error) =>
        notifications.show({
          message: error instanceof Error ? error.message : "Could not read the startup setting.",
          color: "red",
        }),
      )
      .finally(() => setAutostartLoading(false));
  }, [activeTab]);

  const changeAutostart = async (enabled: boolean) => {
    setAutostartLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const saved = await invoke<boolean>("set_autostart_enabled", { enabled });
      setAutostartEnabled(saved);
      notifications.show({
        message: saved
          ? "CellXplorer will launch in the tray when Windows starts."
          : "Launch at Windows startup disabled.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not update the startup setting.",
        color: "red",
      });
    } finally {
      setAutostartLoading(false);
    }
  };

  const saveSettings = useMutation({
    mutationFn: () =>
      put<DownloadSettings>("/api/settings", {
        download_mode: mode,
        download_folder: folder.trim() || null,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["settings"], saved);
      setFolder(saved.download_folder ?? "");
      notifications.show({ message: "Download settings saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save settings.", color: "red" }),
  });

  const saveMonitoring = useMutation({
    mutationFn: () => put<SourceMonitoringSettings>("/api/source-monitor/settings", monitorForm),
    onSuccess: (saved) => {
      queryClient.setQueryData(["source-monitor-settings"], saved);
      setMonitorForm(saved);
      notifications.show({ message: "Automatic source monitoring saved.", color: "teal" });
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message || "Could not save source monitoring.", color: "red" }),
  });

  const chooseFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose default download folder",
      });
      if (typeof selected === "string") setFolder(selected);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not open the folder picker.",
        color: "red",
      });
    }
  };

  const dirty =
    Boolean(settings.data) &&
    (settings.data?.download_mode !== mode || (settings.data?.download_folder ?? "") !== folder);
  const monitorConfig = (value: SourceMonitoringSettings) => ({
    enabled: value.enabled,
    schedule_mode: value.schedule_mode,
    interval_value: value.interval_value,
    interval_unit: value.interval_unit,
    daily_every_days: value.daily_every_days,
    daily_time: value.daily_time,
    auto_update: value.auto_update,
    scan_batch_size: value.scan_batch_size,
    stability_value: value.stability_value,
    stability_unit: value.stability_unit,
    retry_count: value.retry_count,
    retry_delay_minutes: value.retry_delay_minutes,
  });
  const monitoringDirty = Boolean(monitoring.data) &&
    JSON.stringify(monitorConfig(monitorForm)) !== JSON.stringify(monitorConfig(monitoring.data!));
  const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet";

  return (
    <Stack gap="lg" maw={980}>
      <Title order={2}>Settings</Title>

      <Tabs
        value={activeTab}
        onChange={(value) => navigate(
          value === "activity"
            ? "/settings/activity"
            : value === "monitoring"
              ? "/settings/monitoring"
              : value === "desktop"
                ? "/settings/desktop"
                : "/settings",
        )}
      >
        <Tabs.List>
          <Tabs.Tab value="downloads" leftSection={<IconDownload size={15} />}>Downloads</Tabs.Tab>
          <Tabs.Tab value="monitoring" leftSection={<IconActivityHeartbeat size={15} />}>Source monitoring</Tabs.Tab>
          <Tabs.Tab value="desktop" leftSection={<IconDeviceDesktop size={15} />}>Desktop</Tabs.Tab>
          <Tabs.Tab value="activity" leftSection={<IconHistory size={15} />}>Activity log</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="downloads" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Downloads</Title>
                <Text c="dimmed" size="sm">
                  Applies to plot images, PDF and SVG files, and CSV or Excel exports.
                </Text>
              </div>

              {settings.isError ? <Alert color="red">Could not load download settings.</Alert> : null}

              <div>
                <Text fw={600} size="sm" mb={6}>Save behavior</Text>
                <SegmentedControl
                  value={mode}
                  onChange={(value) => setMode(value as DownloadSettings["download_mode"])}
                  data={[
                    { label: "Choose each time", value: "ask" },
                    { label: "Use default folder", value: "folder" },
                  ]}
                />
              </div>

              {mode === "folder" ? (
                <div>
                  <Text fw={600} size="sm" mb={6}>Default folder</Text>
                  <Group align="end" wrap="nowrap">
                    <TextInput
                      value={folder}
                      onChange={(event) => setFolder(event.currentTarget.value)}
                      placeholder="C:\\Users\\name\\Documents\\CellXplorer exports"
                      style={{ flex: 1 }}
                      disabled={settings.isLoading}
                    />
                    {isTauriApp() ? (
                      <Button variant="default" leftSection={<IconFolderOpen size={16} />} onClick={chooseFolder}>
                        Browse
                      </Button>
                    ) : null}
                  </Group>
                  <Text c="dimmed" size="xs" mt={6}>
                    {isTauriApp()
                      ? "CellXplorer validates this folder before saving. Existing files are never overwritten."
                      : "In the browser, paste the full local folder path. CellXplorer validates it before saving."}
                  </Text>
                </div>
              ) : (
                <Text c="dimmed" size="sm">
                  {isTauriApp()
                    ? "A native Save As window will open for every export."
                    : "Your browser handles each download; whether it asks for a location follows its download settings."}
                </Text>
              )}

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={() => saveSettings.mutate()}
                  loading={saveSettings.isPending}
                  disabled={settings.isLoading || !dirty || (mode === "folder" && !folder.trim())}
                >
                  Save settings
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="monitoring" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="lg">
              <div>
                <Title order={4}>Automatic source monitoring</Title>
                <Text c="dimmed" size="sm">
                  Check active-cell source files while CellXplorer is running in the background.
                  Cells marked Complete in the Cell Database are excluded.
                </Text>
              </div>

              {monitoring.isError ? <Alert color="red">Could not load source monitoring settings.</Alert> : null}

              <Paper withBorder p="md" bg="#fbfbfc">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>Enable automatic checks</Text>
                    <Text size="sm" c="dimmed">Missed checks run once when CellXplorer is available again.</Text>
                  </div>
                  <Switch
                    checked={monitorForm.enabled}
                    disabled={monitoring.isLoading}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      enabled: event.currentTarget.checked,
                    }))}
                  />
                </Group>
              </Paper>

              <div>
                <Text fw={600} size="sm" mb={6}>Schedule</Text>
                <SegmentedControl
                  value={monitorForm.schedule_mode}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    schedule_mode: value as SourceMonitoringSettings["schedule_mode"],
                  }))}
                  data={[
                    { label: "Every interval", value: "interval" },
                    { label: "At a set time", value: "daily" },
                  ]}
                />
              </div>

              {monitorForm.schedule_mode === "interval" ? (
                <Group align="end" grow>
                  <NumberInput
                    label="Every"
                    min={1}
                    max={10000}
                    value={monitorForm.interval_value}
                    onChange={(value) => setMonitorForm((current) => ({
                      ...current,
                      interval_value: Number(value) || 1,
                    }))}
                  />
                  <Select
                    label="Unit"
                    value={monitorForm.interval_unit}
                    allowDeselect={false}
                    data={[
                      { label: "Minutes", value: "minutes" },
                      { label: "Hours", value: "hours" },
                      { label: "Days", value: "days" },
                    ]}
                    onChange={(value) => value && setMonitorForm((current) => ({
                      ...current,
                      interval_unit: value as SourceMonitoringSettings["interval_unit"],
                    }))}
                  />
                </Group>
              ) : (
                <Group align="end" grow>
                  <NumberInput
                    label="Every number of days"
                    min={1}
                    max={365}
                    value={monitorForm.daily_every_days}
                    onChange={(value) => setMonitorForm((current) => ({
                      ...current,
                      daily_every_days: Number(value) || 1,
                    }))}
                  />
                  <TextInput
                    label="Local time"
                    type="time"
                    value={monitorForm.daily_time}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      daily_time: event.currentTarget.value,
                    }))}
                  />
                </Group>
              )}

              <Paper withBorder p="md" bg="#fbfbfc">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>Update stable changed files automatically</Text>
                    <Text size="sm" c="dimmed">
                      Rebuilds changed caches one at a time after the source check completes.
                    </Text>
                  </div>
                  <Switch
                    checked={monitorForm.auto_update}
                    onChange={(event) => setMonitorForm((current) => ({
                      ...current,
                      auto_update: event.currentTarget.checked,
                    }))}
                  />
                </Group>
              </Paper>

              <Group align="end" grow>
                <NumberInput
                  label="Metadata scan batch size"
                  description="Files submitted together for the lightweight size and timestamp scan."
                  min={10}
                  max={5000}
                  value={monitorForm.scan_batch_size}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    scan_batch_size: Number(value) || 10,
                  }))}
                />
                <NumberInput
                  label="Stability window"
                  description="One shared wait before changed candidates are checked again."
                  min={1}
                  max={monitorForm.stability_unit === "minutes" ? 60 : 3600}
                  value={monitorForm.stability_value}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    stability_value: Number(value) || 1,
                  }))}
                />
                <Select
                  label="Stability unit"
                  value={monitorForm.stability_unit}
                  allowDeselect={false}
                  data={[
                    { label: "Seconds", value: "seconds" },
                    { label: "Minutes", value: "minutes" },
                  ]}
                  onChange={(value) => value && setMonitorForm((current) => ({
                    ...current,
                    stability_unit: value as SourceMonitoringSettings["stability_unit"],
                  }))}
                />
              </Group>

              <Group align="end" grow>
                <NumberInput
                  label="Retry attempts"
                  description="Additional attempts for files that are still changing."
                  min={2}
                  max={10}
                  value={monitorForm.retry_count}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    retry_count: Number(value) || 2,
                  }))}
                />
                <NumberInput
                  label="Retry every"
                  description="Retries stop before the next regular source check."
                  min={1}
                  max={1440}
                  suffix=" min"
                  value={monitorForm.retry_delay_minutes}
                  onChange={(value) => setMonitorForm((current) => ({
                    ...current,
                    retry_delay_minutes: Number(value) || 1,
                  }))}
                />
              </Group>

              <Paper withBorder p="md">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Next check</Text>
                    <Text fw={600}>{monitorForm.enabled ? formatDateTime(monitorForm.next_run_at) : "Disabled"}</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last started</Text>
                    <Text fw={600}>{formatDateTime(monitorForm.last_started_at)}</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last finished</Text>
                    <Text fw={600}>{formatDateTime(monitorForm.last_finished_at)}</Text>
                  </div>
                  <Badge variant="light" color={monitorForm.last_status === "failed" ? "red" : "teal"}>
                    {monitorForm.last_status ?? "Not scheduled"}
                  </Badge>
                </Group>
              </Paper>

              <Text size="sm" c="dimmed">
                Metadata checks use bounded threads. Only stable candidates are hashed, and automatic
                cache updates run sequentially at reduced thread priority. A growing source is marked
                Source changing and retried without rescanning the full database.
              </Text>

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={() => saveMonitoring.mutate()}
                  loading={saveMonitoring.isPending}
                  disabled={monitoring.isLoading || !monitoringDirty}
                >
                  Save settings
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="desktop" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Windows behavior</Title>
                <Text c="dimmed" size="sm">
                  Closing the main window keeps CellXplorer and its background jobs available from the tray.
                </Text>
              </div>
              {!isTauriApp() ? (
                <Alert color="gray">These controls are available in the installed Windows application.</Alert>
              ) : (
                <Paper withBorder p="md" bg="#fbfbfc">
                  <Group justify="space-between" wrap="nowrap">
                    <div>
                      <Text fw={600}>Launch when Windows starts</Text>
                      <Text size="sm" c="dimmed">
                        Starts hidden in the tray so enabled source monitoring can run in the background.
                      </Text>
                    </div>
                    <Switch
                      checked={autostartEnabled}
                      disabled={autostartLoading}
                      onChange={(event) => changeAutostart(event.currentTarget.checked)}
                    />
                  </Group>
                </Paper>
              )}
              <Text size="sm" c="dimmed">
                Right-click the tray icon to open CellXplorer, check and update active-cell sources, or quit completely.
              </Text>
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="activity" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Activity log</Title>
                <Text c="dimmed" size="sm">
                  Persistent history of imports, edits, source checks and other library changes.
                </Text>
              </div>
              <div>
                <Group justify="space-between" mb="xs">
                  <Text fw={700}>Application sessions</Text>
                  <Badge variant="light">{sessions.data?.length ?? 0}</Badge>
                </Group>
                {sessions.isError ? (
                  <Alert color="red">Could not load application sessions.</Alert>
                ) : (
                  <ScrollArea h={Math.min(220, Math.max(100, (sessions.data?.length ?? 0) * 42 + 44))} type="auto">
                    <Table striped highlightOnHover>
                      <Table.Thead>
                        <Table.Tr><Table.Th>Started</Table.Th><Table.Th>Finished</Table.Th><Table.Th>Mode</Table.Th><Table.Th>Status</Table.Th><Table.Th>Version</Table.Th></Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {(sessions.data ?? []).map((session) => (
                          <Table.Tr key={session.id}>
                            <Table.Td>{new Date(session.started_at).toLocaleString()}</Table.Td>
                            <Table.Td>{session.finished_at ? new Date(session.finished_at).toLocaleString() : "-"}</Table.Td>
                            <Table.Td>{session.startup_mode}</Table.Td>
                            <Table.Td><Badge size="sm" variant="light" color={session.status === "running" || session.status === "closed" ? "teal" : "orange"}>{session.status}</Badge></Table.Td>
                            <Table.Td>{session.app_version ?? "development"}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea>
                )}
              </div>
              {activity.isLoading ? (
                <Text c="dimmed" size="sm">Loading activity...</Text>
              ) : activity.isError ? (
                <Alert color="red">Could not load activity.</Alert>
              ) : (activity.data ?? []).length === 0 ? (
                <Text c="dimmed" size="sm">No activity recorded yet.</Text>
              ) : (
                <ScrollArea h="calc(100vh - 260px)" mih={360} type="auto">
                  <Stack gap="xs" pr="sm">
                    {(activity.data ?? []).map((event) => (
                      <Paper key={event.id} p="sm" withBorder bg="#fbfbfc">
                        <Group gap="xs" mb={4}>
                          <Badge
                            size="sm"
                            color={event.severity === "error" ? "red" : event.severity === "warning" ? "orange" : "teal"}
                            variant="light"
                          >
                            {event.category}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            Started {new Date(event.started_at).toLocaleString()}
                          </Text>
                          <Text size="xs" c="dimmed">
                            Finished {new Date(event.finished_at).toLocaleString()}
                          </Text>
                        </Group>
                        <Text fw={700}>{event.message}</Text>
                        {Object.keys(event.details ?? {}).length > 0 ? (
                          <Code block mt="xs">{JSON.stringify(event.details, null, 2)}</Code>
                        ) : null}
                      </Paper>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
