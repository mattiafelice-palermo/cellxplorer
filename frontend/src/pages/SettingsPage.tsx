import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDeviceFloppy, IconDownload, IconFolderOpen, IconHistory } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { get, put, type ActivityEvent, type DownloadSettings } from "../api";
import { isTauriApp } from "../downloads";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = location.pathname.endsWith("/activity") ? "activity" : "downloads";
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
  const [mode, setMode] = useState<DownloadSettings["download_mode"]>("ask");
  const [folder, setFolder] = useState("");

  useEffect(() => {
    if (!settings.data) return;
    setMode(settings.data.download_mode);
    setFolder(settings.data.download_folder ?? "");
  }, [settings.data]);

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

  return (
    <Stack gap="lg" maw={980}>
      <Title order={2}>Settings</Title>

      <Tabs
        value={activeTab}
        onChange={(value) => navigate(value === "activity" ? "/settings/activity" : "/settings")}
      >
        <Tabs.List>
          <Tabs.Tab value="downloads" leftSection={<IconDownload size={15} />}>Downloads</Tabs.Tab>
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

        <Tabs.Panel value="activity" pt="lg">
          <Paper withBorder p="lg">
            <Stack gap="md">
              <div>
                <Title order={4}>Activity log</Title>
                <Text c="dimmed" size="sm">
                  Persistent history of imports, edits, source checks and other library changes.
                </Text>
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
