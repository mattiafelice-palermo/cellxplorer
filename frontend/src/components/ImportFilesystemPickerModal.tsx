import {
  ActionIcon,
  Alert,
  Box,
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
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconArrowDown,
  IconArrowUp,
  IconClock,
  IconDeviceDesktop,
  IconEdit,
  IconFile,
  IconFolder,
  IconHome,
  IconPin,
  IconPinnedOff,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  ImportBrowseEntry,
  ImportBrowseResult,
  ImportQuickAccessItem,
  get,
  post,
  put,
} from "../api";
import {
  folderSelectionState,
  clampImportBrowserLeftPaneWidth,
  importShownSelectionState,
  importKeyboardAction,
  importRowAction,
  isImportFolderCheckboxDisabled,
  resetImportBrowserNavigation,
  toggleImportShownSelection,
  toggleImportFileSelection,
  toggleImportFolderSelection,
  IMPORT_BROWSER_LEFT_PANE_MAX,
  IMPORT_BROWSER_LEFT_PANE_MIN,
  IMPORT_BROWSER_RIGHT_PANE_MIN,
} from "../importBrowserSelection";
import {
  importPathEditAction,
  importPathsEqual,
  parseImportPathBreadcrumbs,
  shouldEnterImportPathEdit,
} from "../importPathBreadcrumbs";

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

const IMPORT_BROWSER_HEADER_HEIGHT = 38;
const IMPORT_BROWSER_ENTRY_ROW_HEIGHT = 38;
const IMPORT_BROWSER_ROW_OVERSCAN = 8;

export function ImportFilesystemPickerModal({
  opened,
  loading,
  progress,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  loading: boolean;
  progress?: ReactNode;
  onClose: () => void;
  onConfirm: (selection: ImportSourceSelection) => void;
}) {
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pendingPathEditTarget, setPendingPathEditTarget] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [entryScrollTop, setEntryScrollTop] = useState(0);
  const [selected, setSelected] = useState<Map<string, ImportBrowseEntry>>(new Map());
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [knownFolderImportability, setKnownFolderImportability] = useState<Map<string, boolean>>(new Map());
  const [leftPaneWidth, setLeftPaneWidth] = useState(235);
  const [resizeActive, setResizeActive] = useState(false);
  const [dividerHovered, setDividerHovered] = useState(false);
  const [dividerFocused, setDividerFocused] = useState(false);
  const resizeContainerRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const browseQuery = useQuery({
    queryKey: ["import-filesystem", requestedPath],
    queryFn: () => post<ImportBrowseResult>("/api/imports/browse", { path: requestedPath }),
    enabled: opened,
    placeholderData: (previous) => previous,
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
    setPathEditing(false);
    setPendingPathEditTarget(null);
    setSearch("");
    setEntryScrollTop(0);
    setSelected(new Map());
    setLastSelectedPath(null);
    setKnownFolderImportability(new Map());
  }, [opened]);

  useEffect(() => () => resizeCleanup.current?.(), []);

  useEffect(() => {
    if (browseQuery.data?.current_path) setPathInput(browseQuery.data.current_path);
  }, [browseQuery.data?.current_path]);

  useEffect(() => {
    const data = browseQuery.data;
    if (!data?.current_path) return;
    const hasVisibleFile = data.entries.some((entry) => entry.kind === "file");
    const hasSubfolder = data.entries.some((entry) => entry.kind === "folder");
    setKnownFolderImportability((current) => {
      const next = new Map(current);
      if (hasVisibleFile || hasSubfolder) next.delete(data.current_path);
      else next.set(data.current_path, false);
      return next;
    });
  }, [browseQuery.data]);

  useEffect(() => {
    if (!pathEditing) return;
    const input = pathInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [pathEditing]);

  useEffect(() => {
    const data = browseQuery.data;
    if (!pendingPathEditTarget || browseQuery.isError || !data?.current_path) return;
    if (!importPathsEqual(data.current_path, pendingPathEditTarget)) return;
    setPathEditing(false);
    setPendingPathEditTarget(null);
  }, [browseQuery.data, browseQuery.isError, pendingPathEditTarget]);

  useEffect(() => {
    if (!opened) return;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const focusedInTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (!shouldEnterImportPathEdit(event.key, event.ctrlKey, focusedInTextInput)) return;
      event.preventDefault();
      setPathEditing(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [opened]);

  const navigate = (path: string | null, options: { keepPathEditor?: boolean } = {}) => {
    setRequestedPath(path);
    const reset = resetImportBrowserNavigation();
    setSearch(reset.search);
    setEntryScrollTop(0);
    setLastSelectedPath(reset.lastSelectedPath);
    if (options.keepPathEditor) {
      setPathEditing(true);
      setPendingPathEditTarget(path);
    } else {
      setPathEditing(false);
      setPendingPathEditTarget(null);
    }
  };

  const enterPathEdit = () => {
    setPendingPathEditTarget(null);
    setPathEditing(true);
  };

  const cancelPathEdit = () => {
    setPendingPathEditTarget(null);
    setPathEditing(false);
    if (browseQuery.data?.current_path) setPathInput(browseQuery.data.current_path);
  };

  const handlePathEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = importPathEditAction(event.key, pathInput);
    if (!action) return;
    event.preventDefault();
    if (action === "cancel") cancelPathEdit();
    else navigate(pathInput.trim(), { keepPathEditor: true });
  };

  const constrainPaneWidth = (width: number) =>
    clampImportBrowserLeftPaneWidth(width, resizeContainerRef.current?.clientWidth);

  const beginPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = leftPaneWidth;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setResizeActive(true);
    const move = (moveEvent: globalThis.PointerEvent) => {
      setLeftPaneWidth(constrainPaneWidth(startWidth + moveEvent.clientX - startX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = previousUserSelect;
      setResizeActive(false);
      if (resizeCleanup.current === stop) resizeCleanup.current = null;
    };
    resizeCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const adjustPaneWidth = (delta: number) => {
    setLeftPaneWidth((current) => constrainPaneWidth(current + delta));
  };

  const toggleFile = (entry: ImportBrowseEntry, shiftKey = false, ctrlKey = false, metaKey = false) => {
    const update = toggleImportFileSelection(entry, visibleEntries, selected, lastSelectedPath, {
      shiftKey,
      ctrlKey,
      metaKey,
    });
    setSelected(update.selected);
    setLastSelectedPath(update.lastSelectedPath);
  };

  const activateRow = (entry: ImportBrowseEntry, shiftKey = false, ctrlKey = false, metaKey = false) => {
    if (importRowAction(entry) === "navigate") {
      navigate(entry.path);
      return;
    }
    toggleFile(entry, shiftKey, ctrlKey, metaKey);
  };

  const activateFolderCheckbox = (entry: ImportBrowseEntry) => {
    setSelected((current) => toggleImportFolderSelection(current, entry));
    setLastSelectedPath(null);
  };

  const handleRowKeyDown = (entry: ImportBrowseEntry, event: KeyboardEvent<HTMLDivElement>) => {
    const action = importKeyboardAction(entry, event.key);
    if (!action) return;
    event.preventDefault();
    if (action === "navigate") navigate(entry.path);
    else toggleFile(entry);
  };

  const selectedEntries = [...selected.values()];
  const fileCount = selectedEntries.filter((entry) => entry.kind === "file").length;
  const folderCount = selectedEntries.filter((entry) => entry.kind === "folder").length;
  const isFolderSelectable = (entry: ImportBrowseEntry) =>
    !isImportFolderCheckboxDisabled(entry, knownFolderImportability.get(entry.path));
  const shownSelection = importShownSelectionState(visibleEntries, selected, isFolderSelectable);
  const allVisibleSelected = shownSelection.allSelected;
  const someVisibleSelected = shownSelection.someSelected;
  const firstRenderedEntry = Math.max(
    0,
    Math.floor(Math.max(0, entryScrollTop - IMPORT_BROWSER_HEADER_HEIGHT) / IMPORT_BROWSER_ENTRY_ROW_HEIGHT) -
      IMPORT_BROWSER_ROW_OVERSCAN,
  );
  const lastRenderedEntry = Math.min(
    visibleEntries.length,
    firstRenderedEntry +
      Math.ceil(390 / IMPORT_BROWSER_ENTRY_ROW_HEIGHT) + IMPORT_BROWSER_ROW_OVERSCAN * 2,
  );
  const renderedEntries = visibleEntries.slice(firstRenderedEntry, lastRenderedEntry);
  const leadingSpacerHeight = firstRenderedEntry * IMPORT_BROWSER_ENTRY_ROW_HEIGHT;
  const trailingSpacerHeight =
    (visibleEntries.length - lastRenderedEntry) * IMPORT_BROWSER_ENTRY_ROW_HEIGHT;
  const quickAccess = browseQuery.data?.quick_access ?? [];
  const breadcrumbs = parseImportPathBreadcrumbs(
    browseQuery.data?.current_path ?? pathInput,
  );
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
  const toggleShownSelection = () => {
    setSelected((current) => toggleImportShownSelection(current, visibleEntries, isFolderSelectable));
    setLastSelectedPath(null);
  };

  return (
    <Modal opened={opened} onClose={loading ? () => undefined : onClose} title="Load cell files" size="68rem">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Select any combination of Neware files and folders. Click a folder row to open it;
          use its checkbox to select the folder recursively.
        </Text>
        {progress && <Paper withBorder p="xs">{progress}</Paper>}
        <Group ref={resizeContainerRef} align="stretch" gap={0} wrap="nowrap">
          <Paper
            p="xs"
            withBorder
            style={{
              width: leftPaneWidth,
              minWidth: IMPORT_BROWSER_LEFT_PANE_MIN,
              maxWidth: IMPORT_BROWSER_LEFT_PANE_MAX,
              flexShrink: 0,
            }}
          >
            <ScrollArea h={590} type="auto">
              <Box pr={8}>
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
              </Box>
            </ScrollArea>
          </Paper>
          <Box
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize quick-access panel"
            aria-valuemin={IMPORT_BROWSER_LEFT_PANE_MIN}
            aria-valuemax={IMPORT_BROWSER_LEFT_PANE_MAX}
            aria-valuenow={leftPaneWidth}
            tabIndex={0}
            onPointerDown={beginPaneResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              adjustPaneWidth(event.key === "ArrowLeft" ? -16 : 16);
            }}
            onMouseEnter={() => setDividerHovered(true)}
            onMouseLeave={() => setDividerHovered(false)}
            onFocus={() => setDividerFocused(true)}
            onBlur={() => setDividerFocused(false)}
            style={{
              width: 12,
              minWidth: 12,
              flexShrink: 0,
              cursor: "col-resize",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              userSelect: "none",
              outline: dividerFocused ? "2px solid var(--mantine-primary-color-6)" : undefined,
              outlineOffset: -1,
            }}
          >
            <Group gap={2} wrap="nowrap" aria-hidden="true">
              {[0, 1, 2].map((line) => (
                <Box
                  key={line}
                  w={2}
                  h={32}
                  bg={resizeActive || dividerHovered || dividerFocused
                    ? "var(--mantine-primary-color-6)"
                    : "var(--mantine-color-default-border)"}
                  style={{ borderRadius: 2 }}
                />
              ))}
            </Group>
          </Box>
          <Stack gap="sm" style={{ flex: "1 1 0", minWidth: IMPORT_BROWSER_RIGHT_PANE_MIN, overflow: "hidden" }}>
            <Group gap="xs" wrap="nowrap">
              <ActionIcon variant="default" size="lg" aria-label="Go to parent folder" disabled={!browseQuery.data?.parent_path} onClick={() => navigate(browseQuery.data?.parent_path ?? null)}><IconArrowUp size={18} /></ActionIcon>
              {pathEditing ? <TextInput ref={pathInputRef} value={pathInput} onChange={(event) => setPathInput(event.currentTarget.value)} onKeyDown={handlePathEditKeyDown} onBlur={() => { if (!pendingPathEditTarget) cancelPathEdit(); }} aria-label="Current folder path" style={{ flex: 1 }} /> : <>
                <Box component="nav" aria-label="Current folder path" style={{ flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden", whiteSpace: "nowrap" }}>
                  <Group gap={3} wrap="nowrap" style={{ minWidth: "max-content", minHeight: 36 }}>
                    {breadcrumbs.map((breadcrumb, index) => <Group key={breadcrumb.targetPath} gap={3} wrap="nowrap">
                      {index > 0 && <Text size="sm" c="dimmed" aria-hidden="true">›</Text>}
                      <Tooltip label={breadcrumb.targetPath} withArrow>
                        <UnstyledButton type="button" onClick={() => navigate(breadcrumb.targetPath)} aria-current={index === breadcrumbs.length - 1 ? "location" : undefined} style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderRadius: 4, padding: "5px 6px", color: index === breadcrumbs.length - 1 ? "var(--mantine-color-text)" : "var(--mantine-primary-color-7)" }}>{breadcrumb.label}</UnstyledButton>
                      </Tooltip>
                    </Group>)}
                  </Group>
                </Box>
                <Button variant="subtle" color="gray" size="compact-sm" leftSection={<IconEdit size={15} />} aria-label="Edit path" onClick={enterPathEdit}>Edit path</Button>
              </>}
              <ActionIcon variant="default" size="lg" aria-label="Refresh folder" onClick={() => void browseQuery.refetch()}><IconRefresh size={17} /></ActionIcon>
            </Group>
            <Group gap="xs">
              <TextInput placeholder="Search this folder" leftSection={<IconSearch size={15} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} style={{ flex: 1 }} />
              <Button variant="default" disabled={shownSelection.disabled} onClick={toggleShownSelection}>{allVisibleSelected ? "Clear shown" : "Select shown"}</Button>
            </Group>
            <Paper withBorder p={0}>
              {browseQuery.isPending && !browseQuery.data ? <Center h={390}><Loader /></Center> : browseQuery.isError ? <Center h={390} px="lg"><Alert color="red" w="100%">{browseQuery.error instanceof Error ? browseQuery.error.message : "This folder could not be opened."}</Alert></Center> : <ScrollArea h={390} type="auto" onScrollPositionChange={({ y }) => setEntryScrollTop(y)}><Stack gap={0}>
                <Group gap="xs" wrap="nowrap" px="sm" py={8} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" style={{ minHeight: IMPORT_BROWSER_HEADER_HEIGHT, boxSizing: "border-box", borderBottom: "1px solid var(--mantine-color-default-border)" }}><Checkbox aria-label="Select all visible importable files" checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected} disabled={shownSelection.disabled} onChange={toggleShownSelection} /><Text size="xs" fw={700} style={{ flex: 1 }}>Name</Text><Text size="xs" fw={700} w={90} ta="right">Size</Text><Text size="xs" fw={700} w={145}>Modified</Text></Group>
                {visibleEntries.length === 0 ? <Center h={300}><Text size="sm" c="dimmed">No folders or Neware files here.</Text></Center> : <>
                  <Box h={leadingSpacerHeight} aria-hidden="true" />
                  {renderedEntries.map((entry) => {
                  const isFolder = entry.kind === "folder";
                  const folderState = isFolder ? folderSelectionState(entry, selected) : "none";
                  const folderCheckboxDisabled = isFolder && isImportFolderCheckboxDisabled(entry, knownFolderImportability.get(entry.path));
                  return <Group key={entry.path} gap="xs" wrap="nowrap" px="sm" py={7} bg={selected.has(entry.path) || folderState === "some" ? "var(--mantine-primary-color-light)" : undefined} role={isFolder ? "button" : "option"} aria-label={isFolder ? `Open ${entry.name}` : entry.name} aria-selected={!isFolder ? selected.has(entry.path) : undefined} tabIndex={0} style={{ height: IMPORT_BROWSER_ENTRY_ROW_HEIGHT, boxSizing: "border-box", cursor: isFolder ? "pointer" : "default", borderBottom: "1px solid var(--mantine-color-default-border)" }} onClick={(event) => activateRow(entry, event.shiftKey, event.ctrlKey, event.metaKey)} onKeyDown={(event) => handleRowKeyDown(entry, event)}>
                    <Checkbox aria-label={isFolder ? `Select all importable files in ${entry.name}` : `Select ${entry.name}`} checked={isFolder ? folderState === "all" : selected.has(entry.path)} indeterminate={isFolder && folderState === "some"} disabled={isFolder ? folderCheckboxDisabled : false} onClick={(event) => event.stopPropagation()} onChange={() => isFolder ? activateFolderCheckbox(entry) : toggleFile(entry)} />
                    {isFolder ? <IconFolder size={17} color="var(--mantine-primary-color-6)" /> : <IconFile size={17} color="var(--mantine-color-gray-6)" />}<Text size="sm" truncate title={entry.name} style={{ flex: 1 }}>{entry.name}</Text><Text size="xs" c="dimmed" w={90} ta="right">{entry.size === null ? "" : formatBytes(entry.size)}</Text><Text size="xs" c="dimmed" w={145}>{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : ""}</Text>
                  </Group>;
                  })}
                  <Box h={trailingSpacerHeight} aria-hidden="true" />
                </>}
              </Stack></ScrollArea>}
            </Paper>
            {selectedEntries.length > 0 && <Paper withBorder p="xs"><Group justify="space-between" mb={4}><Text size="xs" fw={700}>Selected sources</Text><Button size="compact-xs" variant="subtle" color="gray" onClick={() => setSelected(new Map())}>Clear all</Button></Group><ScrollArea h={Math.min(96, selectedEntries.length * 28)} type="auto"><Stack gap={2}>{selectedEntries.map((entry) => <Group key={entry.path} gap="xs" wrap="nowrap">{entry.kind === "folder" ? <IconFolder size={14} /> : <IconFile size={14} />}<Text size="xs" truncate title={entry.path} style={{ flex: 1 }}>{entry.path}</Text><ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Remove ${entry.name}`} onClick={() => setSelected((current) => { const next = new Map(current); next.delete(entry.path); return next; })}><IconX size={12} /></ActionIcon></Group>)}</Stack></ScrollArea></Paper>}
          </Stack>
        </Group>
            <Group justify="space-between"><Text size="sm" c="dimmed">{folderCount} folder{folderCount === 1 ? "" : "s"}{fileCount ? `, ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}</Text><Group gap="xs"><Button variant="default" disabled={loading} onClick={onClose}>Cancel</Button><Button loading={loading} disabled={selectedEntries.length === 0} onClick={() => onConfirm({ filePaths: selectedEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path), folderPaths: selectedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.path) })}>Continue</Button></Group></Group>
      </Stack>
    </Modal>
  );
}
