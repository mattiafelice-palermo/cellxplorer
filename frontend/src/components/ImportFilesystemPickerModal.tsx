import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  Popover,
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
  IconFilter,
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
  type CSSProperties,
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
import { ImportModalPrimaryActions, ImportModalShell } from "./ImportModalShell";
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
import {
  EMPTY_IMPORT_BROWSER_FILTERS,
  filterAndSortImportEntries,
  importEntryFormat,
  importEntrySupplier,
  nextImportBrowserSort,
  type ImportBrowserFilters,
  type ImportBrowserSort,
  type ImportBrowserSortKey,
  type ImportHeaderHint,
} from "../importFilePickerPolicy";

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
const IMPORT_BROWSER_COLUMN_MIN_WIDTH: Record<ImportBrowserSortKey, number> = {
  name: 190,
  format: 110,
  supplier: 90,
  protocol: 95,
  cycles: 78,
  size: 82,
  modified: 140,
};
const IMPORT_BROWSER_COLUMN_LABELS: Record<ImportBrowserSortKey, string> = {
  name: "Name",
  format: "Format",
  supplier: "Supplier",
  protocol: "Protocol",
  cycles: "Cycles*",
  size: "Size",
  modified: "Modified",
};

export function ImportFilesystemPickerModal({
  opened,
  loading,
  progress,
  onClose,
  onConfirm,
  mode = "files",
  initialPath,
  initialSelection,
  selectionKey,
  onFolderConfirm,
}: {
  opened: boolean;
  loading: boolean;
  progress?: ReactNode;
  onClose: () => void;
  onConfirm?: (selection: ImportSourceSelection) => void;
  mode?: "files" | "folder";
  initialPath?: string | null;
  initialSelection?: ImportSourceSelection | null;
  selectionKey?: number;
  onFolderConfirm?: (path: string) => void;
}) {
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pendingPathEditTarget, setPendingPathEditTarget] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [fileFilters, setFileFilters] = useState<ImportBrowserFilters>(EMPTY_IMPORT_BROWSER_FILTERS);
  const [fileSort, setFileSort] = useState<ImportBrowserSort>({ key: "name", direction: "asc" });
  const [headerHints, setHeaderHints] = useState<Map<string, ImportHeaderHint>>(new Map());
  const [columnWidths, setColumnWidths] = useState<Record<ImportBrowserSortKey, number>>({
    name: 310, format: 132, supplier: 108, protocol: 112, cycles: 82, size: 90, modified: 160,
  });
  const [filtersOpened, setFiltersOpened] = useState(false);
  const [headerFilter, setHeaderFilter] = useState<ImportBrowserSortKey | null>(null);
  const tableRootRef = useRef<HTMLDivElement>(null);
  const [entryScrollTop, setEntryScrollTop] = useState(0);
  const [selected, setSelected] = useState<Map<string, ImportBrowseEntry>>(() => {
    const entries = [
      ...(initialSelection?.filePaths ?? []).map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
        kind: "file" as const,
        size: null,
        modified_at: null,
      })),
      ...(initialSelection?.folderPaths ?? []).map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
        kind: "folder" as const,
        size: null,
        modified_at: null,
      })),
    ];
    return new Map(entries.map((entry) => [entry.path, entry]));
  });
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
  const headerHintMutation = useMutation({
    mutationFn: (paths: string[]) => post<{ files: ImportHeaderHint[] }>("/api/imports/header-hints", { paths }),
    onSuccess: ({ files }) => setHeaderHints((current) => {
      const next = new Map(current);
      for (const hint of files) next.set(hint.path, hint);
      return next;
    }),
    onError: (error: Error) => notifications.show({ message: error.message, color: "orange" }),
  });
  const directoryEntries = browseQuery.data?.entries ?? [];
  const visibleEntries = useMemo(
    () => filterAndSortImportEntries(directoryEntries, headerHints, search, fileFilters, fileSort),
    [directoryEntries, fileFilters, fileSort, headerHints, search],
  );
  const filesInDirectory = directoryEntries.filter((entry) => entry.kind === "file");
  const availableForSupplier = filesInDirectory.filter((entry) =>
    (!fileFilters.formats.length || fileFilters.formats.includes(importEntryFormat(entry, headerHints.get(entry.path))))
    && (!fileFilters.protocols.length || fileFilters.protocols.includes(headerHints.get(entry.path)?.technique ?? "")),
  );
  const availableForFormat = filesInDirectory.filter((entry) =>
    (!fileFilters.suppliers.length || fileFilters.suppliers.includes(importEntrySupplier(entry, headerHints.get(entry.path))))
    && (!fileFilters.protocols.length || fileFilters.protocols.includes(headerHints.get(entry.path)?.technique ?? "")),
  );
  const availableForProtocol = filesInDirectory.filter((entry) =>
    (!fileFilters.suppliers.length || fileFilters.suppliers.includes(importEntrySupplier(entry, headerHints.get(entry.path))))
    && (!fileFilters.formats.length || fileFilters.formats.includes(importEntryFormat(entry, headerHints.get(entry.path)))),
  );
  const formatOptions = [...new Set(availableForFormat.map((entry) => importEntryFormat(entry, headerHints.get(entry.path))))]
    .sort((a, b) => a.localeCompare(b));
  const supplierOptions = [...new Set(availableForSupplier.map((entry) => importEntrySupplier(entry, headerHints.get(entry.path))))]
    .sort((a, b) => a.localeCompare(b));
  const protocolOptions = [...new Set(availableForProtocol.flatMap((entry) => {
    const technique = headerHints.get(entry.path)?.technique;
    return technique ? [technique] : [];
  }))].sort((a, b) => a.localeCompare(b));
  const activeImportFilterCount = fileFilters.suppliers.length + fileFilters.formats.length + fileFilters.protocols.length
    + Number(Boolean(fileFilters.minCycles || fileFilters.maxCycles))
    + Number(Boolean(fileFilters.minSize || fileFilters.maxSize))
    + Number(Boolean(fileFilters.modifiedAfter || fileFilters.modifiedBefore));
  const headerFilterIsActive = (key: ImportBrowserSortKey) => {
    if (key === "supplier") return fileFilters.suppliers.length > 0;
    if (key === "format") return fileFilters.formats.length > 0;
    if (key === "protocol") return fileFilters.protocols.length > 0;
    if (key === "cycles") return Boolean(fileFilters.minCycles || fileFilters.maxCycles);
    if (key === "size") return Boolean(fileFilters.minSize || fileFilters.maxSize);
    if (key === "modified") return Boolean(fileFilters.modifiedAfter || fileFilters.modifiedBefore);
    return Boolean(search);
  };

  useEffect(() => {
    if (!opened) return;
    setRequestedPath(mode === "folder" ? initialPath ?? null : null);
    setPathInput("");
    setPathEditing(false);
    setPendingPathEditTarget(null);
    setSearch("");
    setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS);
    setHeaderHints(new Map());
    setEntryScrollTop(0);
    if (selectionKey === undefined) {
      setSelected(new Map());
      setLastSelectedPath(null);
    }
    setKnownFolderImportability(new Map());
  }, [mode, opened, selectionKey]);

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
    setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS);
    setHeaderHints(new Map());
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
  const scanDirectoryHeaders = () => {
    const paths = filesInDirectory
      .filter((entry) => !headerHints.has(entry.path))
      .slice(0, 512)
      .map((entry) => entry.path);
    if (paths.length) headerHintMutation.mutate(paths);
  };
  const resizeFileColumn = (key: ImportBrowserSortKey, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const root = tableRootRef.current;
    if (!root) return;
    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const cssName = `--import-${key}-width`;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      root.style.setProperty(cssName, `${Math.max(IMPORT_BROWSER_COLUMN_MIN_WIDTH[key], startWidth + moveEvent.clientX - startX)}px`);
    };
    const onStop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onStop);
      window.removeEventListener("pointercancel", onStop);
      document.body.style.userSelect = previousUserSelect;
      const finalWidth = Number.parseFloat(root.style.getPropertyValue(cssName));
      if (Number.isFinite(finalWidth)) setColumnWidths((current) => ({ ...current, [key]: finalWidth }));
      root.style.removeProperty(cssName);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onStop);
    window.addEventListener("pointercancel", onStop);
  };
  const gridTemplateColumns = `40px ${["name", "format", "supplier", "protocol", "cycles", "size", "modified"]
    .map((key) => `var(--import-${key}-width, ${columnWidths[key as ImportBrowserSortKey]}px)`).join(" ")}`;
  const browserGridStyle = {
    gridTemplateColumns,
    "--import-name-width": `${columnWidths.name}px`,
    "--import-format-width": `${columnWidths.format}px`,
    "--import-supplier-width": `${columnWidths.supplier}px`,
    "--import-protocol-width": `${columnWidths.protocol}px`,
    "--import-cycles-width": `${columnWidths.cycles}px`,
    "--import-size-width": `${columnWidths.size}px`,
    "--import-modified-width": `${columnWidths.modified}px`,
  } as CSSProperties;
  const renderHeaderCell = (key: ImportBrowserSortKey) => (
    <Box key={key} pos="relative" style={{ minWidth: 0, display: "flex", alignItems: "center", justifyContent: key === "size" || key === "cycles" ? "flex-end" : "flex-start" }}>
      <UnstyledButton
        type="button"
        aria-label={`Sort by ${IMPORT_BROWSER_COLUMN_LABELS[key]}`}
        onClick={() => setFileSort((current) => nextImportBrowserSort(current, key))}
        style={{ fontSize: "var(--mantine-font-size-xs)", fontWeight: 700, color: "var(--mantine-color-dimmed)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {IMPORT_BROWSER_COLUMN_LABELS[key]} {fileSort.key === key ? (fileSort.direction === "asc" ? "↑" : "↓") : "↕"}
      </UnstyledButton>
      <Popover opened={headerFilter === key} onChange={(openedNow) => setHeaderFilter(openedNow ? key : null)} position="bottom-end" shadow="md" withinPortal>
        <Popover.Target>
          <ActionIcon
            size="xs"
            variant={headerFilter === key || headerFilterIsActive(key) ? "light" : "subtle"}
            color={headerFilter === key || headerFilterIsActive(key) ? "green" : "gray"}
            aria-label={`Filter ${IMPORT_BROWSER_COLUMN_LABELS[key]}`}
            onClick={(event) => { event.stopPropagation(); setHeaderFilter((current) => current === key ? null : key); }}
          ><IconFilter size={13} /></ActionIcon>
        </Popover.Target>
        <Popover.Dropdown w={key === "modified" ? 300 : 260} onClick={(event) => event.stopPropagation()}>
          <Stack gap="xs">
            {key === "name" && <TextInput label="Name contains" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />}
            {key === "supplier" && <MultiSelect label="Supplier" data={supplierOptions} value={fileFilters.suppliers} onChange={(suppliers) => setFileFilters((current) => ({ ...current, suppliers }))} searchable clearable />}
            {key === "format" && <MultiSelect label="Format" data={formatOptions} value={fileFilters.formats} onChange={(formats) => setFileFilters((current) => ({ ...current, formats }))} searchable clearable />}
            {key === "protocol" && <MultiSelect label="Protocol" data={protocolOptions} value={fileFilters.protocols} onChange={(protocols) => setFileFilters((current) => ({ ...current, protocols }))} searchable clearable disabled={protocolOptions.length === 0} />}
            {key === "cycles" && <Group grow><NumberInput label="At least" min={0} value={fileFilters.minCycles} onChange={(value) => setFileFilters((current) => ({ ...current, minCycles: String(value) }))} /><NumberInput label="At most" min={0} value={fileFilters.maxCycles} onChange={(value) => setFileFilters((current) => ({ ...current, maxCycles: String(value) }))} /></Group>}
            {key === "size" && <Group grow><NumberInput label="Bytes from" min={0} value={fileFilters.minSize} onChange={(value) => setFileFilters((current) => ({ ...current, minSize: String(value) }))} /><NumberInput label="Bytes to" min={0} value={fileFilters.maxSize} onChange={(value) => setFileFilters((current) => ({ ...current, maxSize: String(value) }))} /></Group>}
            {key === "modified" && <><TextInput type="date" label="Modified after" value={fileFilters.modifiedAfter} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedAfter: event.currentTarget.value }))} /><TextInput type="date" label="Modified before" value={fileFilters.modifiedBefore} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedBefore: event.currentTarget.value }))} /></>}
            <Button variant="subtle" size="compact-sm" onClick={() => {
              if (key === "name") setSearch("");
              if (key === "supplier") setFileFilters((current) => ({ ...current, suppliers: [] }));
              if (key === "format") setFileFilters((current) => ({ ...current, formats: [] }));
              if (key === "protocol") setFileFilters((current) => ({ ...current, protocols: [] }));
              if (key === "cycles") setFileFilters((current) => ({ ...current, minCycles: "", maxCycles: "" }));
              if (key === "size") setFileFilters((current) => ({ ...current, minSize: "", maxSize: "" }));
              if (key === "modified") setFileFilters((current) => ({ ...current, modifiedAfter: "", modifiedBefore: "" }));
            }}>Clear this filter</Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${IMPORT_BROWSER_COLUMN_LABELS[key]} column`}
        onPointerDown={(event) => resizeFileColumn(key, event)}
        style={{ position: "absolute", zIndex: 2, top: -5, bottom: -5, right: -5, width: 10, cursor: "col-resize", touchAction: "none" }}
      />
    </Box>
  );

  return (
    <ImportModalShell
      opened={opened}
      onClose={onClose}
      closeDisabled={loading}
      title={mode === "folder" ? "Choose a folder" : "Load cell files"}
      step={1}
      titleInfo={mode === "folder"
        ? "Choose the folder to monitor. The watcher checks source files directly in this folder."
        : "Select cycler files: Neware (.nda, .ndax, structured .xlsx) and BioLogic GCPL, CP, or OCV (.mpr) data, plus folders. Click a folder row to open it; use its checkbox to select the folder."}
      progress={progress ? <Paper withBorder p="xs">{progress}</Paper> : null}
      actions={
        <>
          <Text size="sm" c="dimmed">
            {mode === "folder"
              ? (browseQuery.data?.current_path ?? (pathInput || "Choose a folder"))
              : `${folderCount} folder${folderCount === 1 ? "" : "s"}${fileCount ? `, ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}`}
          </Text>
          <ImportModalPrimaryActions>
            <Button variant="default" disabled={loading} onClick={onClose}>
              Cancel
            </Button>
            {mode === "folder" ? (
              <Button
                loading={loading}
                disabled={browseQuery.isError || !browseQuery.data?.current_path}
                onClick={() => {
                  const path = browseQuery.data?.current_path ?? pathInput.trim();
                  if (path) onFolderConfirm?.(path);
                }}
              >
                Use this folder
              </Button>
            ) : (
              <Button
                loading={loading}
                disabled={selectedEntries.length === 0}
                onClick={() => onConfirm?.({
                  filePaths: selectedEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
                  folderPaths: selectedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.path),
                })}
              >
                Continue
              </Button>
            )}
          </ImportModalPrimaryActions>
        </>
      }
    >
      <Stack gap="sm">
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
            <ScrollArea h={560} type="auto">
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
                          <Group key={`${section}-${item.path}`} gap={4} wrap="nowrap" px="xs" py={6} bg={active ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined} style={{ borderRadius: 4, opacity: item.available ? 1 : 0.55 }}>
                            <Button variant="subtle" color={active ? "light-dark(var(--mantine-primary-color-6), var(--mantine-color-white))" : undefined} size="compact-sm" leftSection={shortcutIcon(item)} disabled={!item.available} justify="flex-start" style={{ flex: 1, minWidth: 0 }} onClick={() => navigate(item.path)}>
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
            <Group gap="xs" wrap="nowrap">
              <TextInput placeholder="Search this folder" leftSection={<IconSearch size={15} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} style={{ flex: 1, minWidth: 0 }} />
              <Popover opened={filtersOpened} onChange={setFiltersOpened} position="bottom-end" shadow="md" withinPortal>
                <Popover.Target>
                  <Button
                    variant="default"
                    leftSection={<IconFilter size={15} />}
                    aria-label="Filter import files"
                    onClick={() => setFiltersOpened((openedNow) => !openedNow)}
                  >
                    Filters{activeImportFilterCount > 0 ? ` (${activeImportFilterCount})` : ""}
                  </Button>
                </Popover.Target>
                <Popover.Dropdown w={560}>
                  <Stack gap="sm">
                    <Group grow align="flex-start">
                      <MultiSelect label="Supplier" data={supplierOptions} value={fileFilters.suppliers} onChange={(suppliers) => setFileFilters((current) => ({ ...current, suppliers }))} searchable clearable />
                      <MultiSelect label="Format" data={formatOptions} value={fileFilters.formats} onChange={(formats) => setFileFilters((current) => ({ ...current, formats }))} searchable clearable />
                      <MultiSelect label="Protocol" data={protocolOptions} value={fileFilters.protocols} onChange={(protocols) => setFileFilters((current) => ({ ...current, protocols }))} searchable clearable disabled={protocolOptions.length === 0} />
                    </Group>
                    <Group align="flex-end">
                      <NumberInput label="Cycles from" min={0} value={fileFilters.minCycles} onChange={(value) => setFileFilters((current) => ({ ...current, minCycles: String(value) }))} style={{ flex: 1 }} />
                      <NumberInput label="Cycles to" min={0} value={fileFilters.maxCycles} onChange={(value) => setFileFilters((current) => ({ ...current, maxCycles: String(value) }))} style={{ flex: 1 }} />
                    </Group>
                    <Group align="flex-end">
                      <NumberInput label="Size from (bytes)" min={0} value={fileFilters.minSize} onChange={(value) => setFileFilters((current) => ({ ...current, minSize: String(value) }))} style={{ flex: 1 }} />
                      <NumberInput label="Size to (bytes)" min={0} value={fileFilters.maxSize} onChange={(value) => setFileFilters((current) => ({ ...current, maxSize: String(value) }))} style={{ flex: 1 }} />
                    </Group>
                    <Group align="flex-end">
                      <TextInput type="date" label="Modified after" value={fileFilters.modifiedAfter} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedAfter: event.currentTarget.value }))} style={{ flex: 1 }} />
                      <TextInput type="date" label="Modified before" value={fileFilters.modifiedBefore} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedBefore: event.currentTarget.value }))} style={{ flex: 1 }} />
                      <Button variant="default" onClick={() => setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS)}>Clear all</Button>
                    </Group>
                    <Group justify="space-between" align="center">
                      <Text size="xs" c="dimmed">Format and supplier come from extensions. *Protocol and cycle hints require this optional scan; unavailable cycle counts stay blank.</Text>
                      <Button variant="subtle" size="compact-sm" loading={headerHintMutation.isPending} disabled={!filesInDirectory.length || headerHintMutation.isPending} onClick={scanDirectoryHeaders}>
                        {headerHintMutation.isPending ? "Scanning headers" : `Scan headers${filesInDirectory.length > 512 ? " (first 512)" : ""}`}
                      </Button>
                    </Group>
                  </Stack>
                </Popover.Dropdown>
              </Popover>
              <Button variant="default" disabled={shownSelection.disabled} onClick={toggleShownSelection}>{allVisibleSelected ? "Clear shown" : "Select shown"}</Button>
            </Group>
              <Paper withBorder p={0}>
              {browseQuery.isPending && !browseQuery.data ? <Center h={360}><Loader /></Center> : browseQuery.isError ? <Center h={360} px="lg"><Alert color="red" w="100%">{browseQuery.error instanceof Error ? browseQuery.error.message : "This folder could not be opened."}</Alert></Center> : <ScrollArea h={360} type="auto" onScrollPositionChange={({ y }) => setEntryScrollTop(y)}><Box ref={tableRootRef} style={{ minWidth: "calc(40px + var(--import-name-width) + var(--import-format-width) + var(--import-supplier-width) + var(--import-protocol-width) + var(--import-cycles-width) + var(--import-size-width) + var(--import-modified-width))", ...browserGridStyle }}><Stack gap={0}>
                <Box px="sm" py={8} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" style={{ minHeight: IMPORT_BROWSER_HEADER_HEIGHT, boxSizing: "border-box", borderBottom: "1px solid var(--mantine-color-default-border)", display: "grid", alignItems: "center", gap: 8, gridTemplateColumns, position: "sticky", top: 0, zIndex: 3 }}>
                  <Checkbox aria-label="Select all visible importable files" checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected} disabled={shownSelection.disabled} onChange={toggleShownSelection} />
                  {(["name", "format", "supplier", "protocol", "cycles", "size", "modified"] as const).map(renderHeaderCell)}
                </Box>
                {visibleEntries.length === 0 ? <Center h={300}><Text size="sm" c="dimmed">No folders or supported cycler files here.</Text></Center> : <>
                  <Box h={leadingSpacerHeight} aria-hidden="true" />
                  {renderedEntries.map((entry) => {
                  const isFolder = entry.kind === "folder";
                  const hint = headerHints.get(entry.path);
                  const folderState = isFolder ? folderSelectionState(entry, selected) : "none";
                  const rowSelected = selected.has(entry.path) || folderState !== "none";
                  const selectedForeground = "light-dark(var(--mantine-color-black), var(--mantine-color-white))";
                  const metadataColor = rowSelected ? selectedForeground : "dimmed";
                  const folderCheckboxDisabled = isFolder && isImportFolderCheckboxDisabled(entry, knownFolderImportability.get(entry.path));
                  const cellStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", alignSelf: "center" };
                  return <Box key={entry.path} px="sm" role={isFolder ? "button" : "option"} aria-label={isFolder ? `Open ${entry.name}` : entry.name} aria-selected={!isFolder ? selected.has(entry.path) : undefined} tabIndex={0} style={{ height: IMPORT_BROWSER_ENTRY_ROW_HEIGHT, boxSizing: "border-box", cursor: isFolder ? "pointer" : "default", borderBottom: "1px solid var(--mantine-color-default-border)", background: selected.has(entry.path) || folderState === "some" ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined, display: "grid", alignItems: "center", gap: 8, gridTemplateColumns }} onClick={(event) => activateRow(entry, event.shiftKey, event.ctrlKey, event.metaKey)} onKeyDown={(event) => handleRowKeyDown(entry, event)}>
                    <Checkbox
                      aria-label={isFolder ? `Select all importable files in ${entry.name}` : `Select ${entry.name}`}
                      checked={isFolder ? folderState === "all" : selected.has(entry.path)}
                      indeterminate={isFolder && folderState === "some"}
                      disabled={isFolder ? folderCheckboxDisabled : false}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        if (isFolder) {
                          activateFolderCheckbox(entry);
                          return;
                        }
                        const native = event.nativeEvent as MouseEvent;
                        toggleFile(entry, native.shiftKey, native.ctrlKey, native.metaKey);
                      }}
                    />
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      {isFolder ? <IconFolder size={17} color={rowSelected ? selectedForeground : "var(--mantine-primary-color-6)"} /> : <IconFile size={17} color={rowSelected ? "light-dark(var(--mantine-color-gray-7), var(--mantine-color-gray-1))" : "var(--mantine-color-gray-6)"} />}
                      <Text size="sm" truncate title={entry.name} style={{ flex: 1, minWidth: 0 }}>{entry.name}</Text>
                    </Group>
                    <Text size="xs" c={metadataColor} truncate title={isFolder ? undefined : importEntryFormat(entry, hint)} style={cellStyle}>{isFolder ? "" : importEntryFormat(entry, hint)}</Text>
                    <Text size="xs" c={metadataColor} truncate title={isFolder ? undefined : importEntrySupplier(entry, hint)} style={cellStyle}>{isFolder ? "" : importEntrySupplier(entry, hint)}</Text>
                    <Text size="xs" c={metadataColor} truncate title={hint?.error ?? hint?.technique ?? undefined} style={cellStyle}>{isFolder ? "" : hint?.technique ?? (headerHintMutation.isPending ? "…" : "—")}</Text>
                    <Text size="xs" c={metadataColor} ta="right" title={isFolder ? undefined : hint?.error ?? (hint?.cycle_count == null ? "Not declared in the quick file header; cycling rows are not scanned." : `${hint.cycle_count} cycles declared in the file header.`)} style={cellStyle}>{isFolder ? "" : hint?.cycle_count ?? "—"}</Text>
                    <Text size="xs" c={metadataColor} ta="right" style={cellStyle}>{entry.size === null ? "" : formatBytes(entry.size)}</Text>
                    <Text size="xs" c={metadataColor} truncate title={entry.modified_at ?? undefined} style={cellStyle}>{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : ""}</Text>
                  </Box>;
                  })}
                  <Box h={trailingSpacerHeight} aria-hidden="true" />
                </>}
              </Stack></Box></ScrollArea>}
            </Paper>
            {/* Always mounted with a fixed height: revealing it on first
                selection used to shrink the file browser above it. */}
            <Paper withBorder p="xs" style={{ flex: "none" }}>
              <Group justify="space-between" mb={4}>
                <Text size="xs" fw={700}>Selected sources</Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  disabled={selectedEntries.length === 0}
                  onClick={() => setSelected(new Map())}
                >
                  Clear all
                </Button>
              </Group>
              <ScrollArea h={96} type="auto">
                {selectedEntries.length === 0 ? (
                  <Text size="xs" c="dimmed">Nothing selected yet.</Text>
                ) : (
                  <Stack gap={2}>{selectedEntries.map((entry) => <Group key={entry.path} gap="xs" wrap="nowrap">{entry.kind === "folder" ? <IconFolder size={14} /> : <IconFile size={14} />}<Text size="xs" truncate title={entry.path} style={{ flex: 1 }}>{entry.path}</Text><ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Remove ${entry.name}`} onClick={() => setSelected((current) => { const next = new Map(current); next.delete(entry.path); return next; })}><IconX size={12} /></ActionIcon></Group>)}</Stack>
                )}
              </ScrollArea>
            </Paper>
          </Stack>
        </Group>
      </Stack>
    </ImportModalShell>
  );
}
