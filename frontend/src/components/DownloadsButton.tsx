import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconCopy,
  IconDownload,
  IconFile,
  IconFileSpreadsheet,
  IconFileText,
  IconFolderOpen,
  IconPhoto,
  IconReport,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { del, get, type DownloadEntry } from "../api";
import { DOWNLOAD_EVENT } from "../downloads";
import { isTauriApp } from "../downloads";

function formatBytes(value: number | null): string {
  if (value === null || value === undefined) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function KindIcon({ kind }: { kind: string }) {
  const size = 18;
  const color = "var(--mantine-color-teal-6)";
  if (kind === "image") return <IconPhoto size={size} color={color} />;
  if (kind === "document") return <IconFileText size={size} color={color} />;
  if (kind === "data") return <IconFileSpreadsheet size={size} color={color} />;
  if (kind === "report") return <IconReport size={size} color={color} />;
  return <IconFile size={size} color={color} />;
}

async function tauriInvoke(command: string, path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(command, { path });
}

function DownloadRow({
  entry,
  highlight,
  onOpen,
  onReveal,
  onCopy,
  onDelete,
  desktop,
}: {
  entry: DownloadEntry;
  highlight: boolean;
  onOpen: (entry: DownloadEntry) => void;
  onReveal: (entry: DownloadEntry) => void;
  onCopy: (entry: DownloadEntry) => void;
  onDelete: (entry: DownloadEntry) => void;
  desktop: boolean;
}) {
  const actionable = desktop && entry.exists && Boolean(entry.path);
  return (
    <Group
      wrap="nowrap"
      gap="xs"
      p="xs"
      onDoubleClick={() => actionable && onOpen(entry)}
      style={{
        borderRadius: 8,
        background: highlight ? "var(--mantine-color-teal-0)" : undefined,
        transition: "background 400ms",
        cursor: actionable ? "pointer" : "default",
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      <KindIcon kind={entry.kind} />
      <Tooltip
        label={actionable ? `${entry.filename} — double-click to open` : entry.filename}
        multiline
        maw={340}
        withArrow
        openDelay={400}
        position="top-start"
      >
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={600} truncate="end">
            {entry.filename}
          </Text>
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {new Date(entry.created_at).toLocaleString()}
            </Text>
            {entry.bytes ? (
              <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                · {formatBytes(entry.bytes)}
              </Text>
            ) : null}
            {desktop && entry.path && !entry.exists ? (
              <Text size="xs" c="orange" style={{ whiteSpace: "nowrap" }}>
                · moved or deleted
              </Text>
            ) : null}
          </Group>
        </Box>
      </Tooltip>
      <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
        {desktop && (
          <>
            <Tooltip label="Copy path" withArrow>
              <ActionIcon
                variant="subtle"
                color="teal"
                disabled={!entry.path}
                onClick={(event) => {
                  event.stopPropagation();
                  onCopy(entry);
                }}
                aria-label={`Copy path of ${entry.filename}`}
              >
                <IconCopy size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Show in folder" withArrow>
              <ActionIcon
                variant="subtle"
                color="teal"
                disabled={!actionable}
                onClick={(event) => {
                  event.stopPropagation();
                  onReveal(entry);
                }}
                aria-label={`Show ${entry.filename} in folder`}
              >
                <IconFolderOpen size={16} />
              </ActionIcon>
            </Tooltip>
          </>
        )}
        <Tooltip label={desktop && entry.exists ? "Delete file" : "Remove from list"} withArrow>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(entry);
            }}
            aria-label={`Delete ${entry.filename}`}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}

export function DownloadsButton() {
  const queryClient = useQueryClient();
  const desktop = isTauriApp();
  const [opened, setOpened] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const autoCloseTimer = useRef<number | null>(null);

  const history = useQuery({
    queryKey: ["downloads-history"],
    queryFn: () => get<DownloadEntry[]>("/api/downloads/history"),
    staleTime: 30_000,
  });

  const removeEntry = useMutation({
    mutationFn: ({ entry, deleteFile }: { entry: DownloadEntry; deleteFile: boolean }) =>
      del(`/api/downloads/history/${entry.id}?delete_file=${deleteFile}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["downloads-history"] }),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  useEffect(() => {
    const onDownload = () => {
      queryClient.invalidateQueries({ queryKey: ["downloads-history"] });
      queryClient.refetchQueries({ queryKey: ["downloads-history"] }).then(() => {
        const latest = queryClient.getQueryData<DownloadEntry[]>(["downloads-history"]);
        if (latest && latest[0]) setHighlightId(latest[0].id);
      });
      setOpened(true);
      if (autoCloseTimer.current) window.clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = window.setTimeout(() => {
        setOpened(false);
        setHighlightId(null);
      }, 6000);
    };
    window.addEventListener(DOWNLOAD_EVENT, onDownload);
    return () => {
      window.removeEventListener(DOWNLOAD_EVENT, onDownload);
      if (autoCloseTimer.current) window.clearTimeout(autoCloseTimer.current);
    };
  }, [queryClient]);

  const openFile = async (entry: DownloadEntry) => {
    try {
      await tauriInvoke("open_download", entry.path);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not open the file.",
        color: "red",
      });
      queryClient.invalidateQueries({ queryKey: ["downloads-history"] });
    }
  };
  const revealFile = async (entry: DownloadEntry) => {
    try {
      await tauriInvoke("reveal_download", entry.path);
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not show the file.",
        color: "red",
      });
      queryClient.invalidateQueries({ queryKey: ["downloads-history"] });
    }
  };
  const copyPath = async (entry: DownloadEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      notifications.show({ message: "Path copied to clipboard.", color: "teal" });
    } catch {
      notifications.show({ message: "Could not copy the path.", color: "red" });
    }
  };
  const deleteFile = (entry: DownloadEntry) => {
    const deleteFile = desktop && entry.exists && Boolean(entry.path);
    removeEntry.mutate({ entry, deleteFile });
  };

  const entries = history.data ?? [];
  const recentCount = entries.length;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={380}
      shadow="md"
      withArrow
      trapFocus={false}
      closeOnClickOutside
    >
      <Popover.Target>
        <Button
          size="compact-sm"
          variant="subtle"
          color="teal"
          leftSection={<IconDownload size={14} />}
          onClick={() => {
            setOpened((value) => !value);
            if (autoCloseTimer.current) window.clearTimeout(autoCloseTimer.current);
          }}
        >
          Downloads
          {recentCount > 0 && (
            <Badge size="xs" variant="light" color="teal" ml={6}>
              {recentCount}
            </Badge>
          )}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Group justify="space-between" mb={4} px="xs">
          <Text fw={700} size="sm">
            Downloads
          </Text>
          {entries.length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() =>
                del("/api/downloads/history").then(() =>
                  queryClient.invalidateQueries({ queryKey: ["downloads-history"] }),
                )
              }
            >
              Clear list
            </Button>
          )}
        </Group>
        {!desktop && (
          <Text size="xs" c="dimmed" px="xs" mb={4}>
            Open, show-in-folder, and delete are available in the desktop app.
          </Text>
        )}
        {entries.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            No downloads yet.
          </Text>
        ) : (
          <ScrollArea.Autosize
            mah={336}
            type="auto"
            scrollbars="y"
            scrollbarSize={8}
            styles={{
              thumb: { backgroundColor: "var(--mantine-color-teal-4)" },
            }}
          >
            <Stack gap={2} style={{ maxWidth: "100%" }}>
              {entries.map((entry) => (
                <DownloadRow
                  key={entry.id}
                  entry={entry}
                  highlight={entry.id === highlightId}
                  desktop={desktop}
                  onOpen={openFile}
                  onReveal={revealFile}
                  onCopy={copyPath}
                  onDelete={deleteFile}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
