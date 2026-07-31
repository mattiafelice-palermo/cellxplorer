import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconClock,
  IconDeviceDesktop,
  IconFile,
  IconFolder,
  IconHome,
  IconPin,
  IconPinnedOff,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  ImportBrowseEntry,
  ImportBrowseResult,
  ImportQuickAccessItem,
  get,
  post,
  put,
} from "../api";

export type ImportSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function ImportFilesystemPickerModal({
  opened,
  loading,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  loading: boolean;
  onClose: () => void;
  onConfirm: (selection: ImportSourceSelection) => void;
}) {
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, ImportBrowseEntry>>(new Map());
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const browseQuery = useQuery({
    queryKey: ["import-filesystem", requestedPath],
    queryFn: () => post<ImportBrowseResult>("/api/imports/browse", { path: requestedPath }),
    enabled: opened,
  });
  const pinnedMutation = useMutation({
    mutationFn: (paths: string[]) =>
      put<{ items: ImportQuickAccessItem[] }>("/api/imports/quick-access/pinned", { paths }),
    onSuccess: () => void browseQuery.refetch(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (browseQuery.data?.entries ?? []).filter(
      (entry) => !query || entry.name.toLocaleLowerCase().includes(query),
    );
  }, [browseQuery.data, search]);

  useEffect(() => {
    if (!opened) return;
    setRequestedPath(null);
    setPathInput("");
    setSearch("");
    setSelected(new Map());
    setLastSelectedPath(null);
  }, [opened]);

  useEffect(() => {
    if (browseQuery.data?.current_path) setPathInput(browseQuery.data.current_path);
  }, [browseQuery.data?.current_path]);

  const navigate = (path: string | null) => {
    setRequestedPath(path);
    setSearch("");
    setLastSelectedPath(null);
  };

  const toggleEntry = (entry: ImportBrowseEntry, shiftKey: boolean, ctrlKey: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (shiftKey && lastSelectedPath) {
        const from = visibleEntries.findIndex((item) => item.path === lastSelectedPath);
        const to = visibleEntries.findIndex((item) => item.path === entry.path);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(entry.path);
          visibleEntries.slice(start, end + 1).forEach((item) =>
            shouldSelect ? next.set(item.path, item) : next.delete(item.path),
          );
          return next;
        }
      }
      if (!ctrlKey && !shiftKey && next.has(entry.path)) next.delete(entry.path);
      else if (!next.has(entry.path)) next.set(entry.path, entry);
      else next.delete(entry.path);
      return next;
    });
    setLastSelectedPath(entry.path);
  };

  const selectedEntries = [...selected.values()];
  const fileCount = selectedEntries.filter((entry) => entry.kind === "file").length;
  const folderCount = selectedEntries.filter((entry) => entry.kind === "folder").length;
  const allVisibleSelected =
    visibleEntries.length > 0 && visibleEntries.every((entry) => selected.has(entry.path));
  const someVisibleSelected = visibleEntries.some((entry) => selected.has(entry.path));
  const quickAccess = browseQuery.data?.quick_access ?? [];
  const pinnedPaths = quickAccess.filter((item) => item.pinned).map((item) => item.path);
  const shortcutIcon = (item: ImportQuickAccessItem) => {
    if (item.label === "Home") return <IconHome size={16} />;
    if (item.label === "Desktop") return <IconDeviceDesktop size={16} />;
    if (item.label === "Downloads") return <IconFolder size={16} />;
    if (item.section === "recent") return <IconClock size={16} />;
    return <IconFolder size={16} />;
  };
  const togglePinned = (item: ImportQuickAccessItem) =>
    pinnedMutation.mutate(
      item.pinned ? pinnedPaths.filter((path) => path !== item.path) : [...pinnedPaths, item.path],
    );
  const movePinned = (path: string, direction: -1 | 1) => {
    const index = pinnedPaths.indexOf(path);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= pinnedPaths.length) return;
    const next = [...pinnedPaths];
    [next[index], next[target]] = [next[target], next[index]];
    pinnedMutation.mutate(next);
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Load cell files" size="68rem">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Select any combination of Neware files and folders. Double-click a folder to open it;
          checked folders are expanded recursively in the next step.
        </Text>
        <Group align="stretch" gap="md" wrap="nowrap">
          <Paper p="xs" w={235} withBorder>
            <ScrollArea h={590} type="auto">
              <Stack gap="md">
                {(["quick", "pinned", "recent"] as const).map((section) => {
                  const items = quickAccess.filter((item) => item.section === section);
                  if (!items.length) return null;
                  return (
                    <Stack key={section} gap={3}>
                      <Text size="xs" fw={700} c="dimmed">
                        {section === "quick" ? "Quick access" : section === "pinned" ? "Pinned" : "Recent"}
                      </Text>
                      {items.map((item) => {
                        const active = browseQuery.data?.current_path === item.path;
                        const pinIndex = pinnedPaths.indexOf(item.path);
                        return (
                          <Group key={`${section}-${item.path}`} gap={4} wrap="nowrap" px="xs" py={6} bg={active ? "var(--mantine-primary-color-0)" : undefined} style={{ borderRadius: 4, opacity: item.available ? 1 : 0.55 }}>
                            <Button variant="subtle" color={active ? "var(--mantine-primary-color-6)" : undefined} size="compact-sm" leftSection={shortcutIcon(item)} disabled={!item.available} justify="flex-start" style={{ flex: 1, minWidth: 0 }} onClick={() => navigate(item.path)}>
                              <Text size="sm" truncate title={item.label}>{item.label}</Text>
                            </Button>
                            {item.pinned && <>
                              <ActionIcon size="xs" variant="subtle" color="gray" disabled={pinIndex <= 0} aria-label={`Move ${item.label} up`} onClick={() => movePinned(item.path, -1)}><IconArrowUp size={12} /></ActionIcon>
                              <ActionIcon size="xs" variant="subtle" color="gray" disabled={pinIndex < 0 || pinIndex >= pinnedPaths.length - 1} aria-label={`Move ${item.label} down`} onClick={() => movePinned(item.path, 1)}><IconArrowDown size={12} /></ActionIcon>
                            </>}
                            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={item.pinned ? `Unpin ${item.label}` : `Pin ${item.label}`} onClick={() => togglePinned(item)}>{item.pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}</ActionIcon>
                          </Group>
                        );
                      })}
                    </Stack>
                  );
                })}
                <Stack gap={3}>
                  <Text size="xs" fw={700} c="dimmed">This PC</Text>
                  {(browseQuery.data?.roots ?? []).map((root) => <Button key={root.path} variant="subtle" color={browseQuery.data?.current_path === root.path ? "var(--mantine-primary-color-6)" : undefined} size="compact-sm" leftSection={root.name === "Home" ? <IconHome size={15} /> : <IconFolder size={15} />} justify="flex-start" onClick={() => navigate(root.path)} title={root.name}>{root.name}</Button>)}
                </Stack>
              </Stack>
            </ScrollArea>
          </Paper>
          <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <ActionIcon variant="default" size="lg" aria-label="Go to parent folder" disabled={!browseQuery.data?.parent_path} onClick={() => navigate(browseQuery.data?.parent_path ?? null)}><IconArrowUp size={18} /></ActionIcon>
              <TextInput value={pathInput} onChange={(event) => setPathInput(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && pathInput.trim()) navigate(pathInput.trim()); }} aria-label="Current folder path" style={{ flex: 1 }} />
              <ActionIcon variant="default" size="lg" aria-label="Refresh folder" onClick={() => void browseQuery.refetch()}><IconRefresh size={17} /></ActionIcon>
            </Group>
            <Group gap="xs">
              <TextInput placeholder="Search this folder" leftSection={<IconSearch size={15} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} style={{ flex: 1 }} />
              <Button variant="default" onClick={() => setSelected((current) => { const next = new Map(current); visibleEntries.forEach((entry) => allVisibleSelected ? next.delete(entry.path) : next.set(entry.path, entry)); return next; })}>{allVisibleSelected ? "Clear shown" : "Select shown"}</Button>
            </Group>
            <Paper withBorder p={0}>
              {browseQuery.isPending ? <Center h={390}><Loader /></Center> : browseQuery.isError ? <Center h={390} px="lg"><Alert color="red" w="100%">{browseQuery.error instanceof Error ? browseQuery.error.message : "This folder could not be opened."}</Alert></Center> : <ScrollArea h={390} type="auto"><Stack gap={0}>
                <Group gap="xs" wrap="nowrap" px="sm" py={8} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}><Checkbox checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected} readOnly onClick={() => setSelected((current) => { const next = new Map(current); visibleEntries.forEach((entry) => allVisibleSelected ? next.delete(entry.path) : next.set(entry.path, entry)); return next; })} /><Text size="xs" fw={700} style={{ flex: 1 }}>Name</Text><Text size="xs" fw={700} w={90} ta="right">Size</Text><Text size="xs" fw={700} w={145}>Modified</Text></Group>
                {visibleEntries.length === 0 ? <Center h={300}><Text size="sm" c="dimmed">No folders or Neware files here.</Text></Center> : visibleEntries.map((entry) => <Group key={entry.path} gap="xs" wrap="nowrap" px="sm" py={7} bg={selected.has(entry.path) ? "var(--mantine-primary-color-light)" : undefined} style={{ cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)" }} onClick={(event) => toggleEntry(entry, event.shiftKey, event.ctrlKey || event.metaKey)} onDoubleClick={() => { if (entry.kind === "folder") navigate(entry.path); }}><Checkbox checked={selected.has(entry.path)} readOnly />{entry.kind === "folder" ? <IconFolder size={17} color="var(--mantine-primary-color-6)" /> : <IconFile size={17} color="var(--mantine-color-gray-6)" />}<Text size="sm" truncate title={entry.name} style={{ flex: 1 }}>{entry.name}</Text><Text size="xs" c="dimmed" w={90} ta="right">{entry.size === null ? "" : formatBytes(entry.size)}</Text><Text size="xs" c="dimmed" w={145}>{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : ""}</Text>{entry.kind === "folder" && <ActionIcon variant="subtle" color="gray" aria-label={`Open ${entry.name}`} onClick={(event) => { event.stopPropagation(); navigate(entry.path); }}><IconChevronRight size={16} /></ActionIcon>}</Group>)}
              </Stack></ScrollArea>}
            </Paper>
            {selectedEntries.length > 0 && <Paper withBorder p="xs"><Group justify="space-between" mb={4}><Text size="xs" fw={700}>Selected sources</Text><Button size="compact-xs" variant="subtle" color="gray" onClick={() => setSelected(new Map())}>Clear all</Button></Group><ScrollArea h={Math.min(96, selectedEntries.length * 28)} type="auto"><Stack gap={2}>{selectedEntries.map((entry) => <Group key={entry.path} gap="xs" wrap="nowrap">{entry.kind === "folder" ? <IconFolder size={14} /> : <IconFile size={14} />}<Text size="xs" truncate title={entry.path} style={{ flex: 1 }}>{entry.path}</Text><ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Remove ${entry.name}`} onClick={() => setSelected((current) => { const next = new Map(current); next.delete(entry.path); return next; })}><IconX size={12} /></ActionIcon></Group>)}</Stack></ScrollArea></Paper>}
          </Stack>
        </Group>
        <Group justify="space-between"><Text size="sm" c="dimmed">{folderCount} folder{folderCount === 1 ? "" : "s"}{fileCount ? `, ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}</Text><Group gap="xs"><Button variant="default" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={selectedEntries.length === 0} onClick={() => onConfirm({ filePaths: selectedEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path), folderPaths: selectedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.path) })}>Continue</Button></Group></Group>
      </Stack>
    </Modal>
  );
}
