import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  NumberInput,
  Paper,
  Popover,
  RangeSlider,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useElementSize } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconDeviceDesktop,
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  ApiError,
  ImportBrowseEntry,
  ImportBrowseResult,
  ImportQuickAccessItem,
  ImportInspectResult,
  ImportPreview,
  get,
  post,
  previewQuickNewareExcel,
  put,
} from "../api";
import { ImportModalPrimaryActions, ImportModalShell } from "./ImportModalShell";
import { IndexedSourceSearch } from "./IndexedSourceSearch";
import { mergeIndexedSelection, type IndexedFile } from "../importSearch";
import {
  DEFAULT_IMPORT_SOURCE_PREVIEW_PREFERENCES,
  ImportSourcePreview,
  type ImportSourcePreviewPreferences,
} from "./ImportSourcePreview";
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
  isImportFileSelected,
  toggleImportFolderSelection,
  IMPORT_BROWSER_LEFT_PANE_MAX,
  IMPORT_BROWSER_LEFT_PANE_MIN,
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
  importEntryExtension,
  importEntrySupplier,
  nextImportBrowserSort,
  prioritizeImportHeaderHintPaths,
  type ImportBrowserFilters,
  type ImportBrowserSort,
  type ImportBrowserSortKey,
  type ImportHeaderHint,
} from "../importFilePickerPolicy";

export type ImportSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

function formatMegabytes(bytes: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / (1024 * 1024))} MB`;
}

function moveRangeHandleOnTrack(
  event: ReactPointerEvent<HTMLDivElement>,
  min: number,
  max: number,
  step: number,
  value: [number, number],
  onChange: (next: [number, number]) => void,
) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('[role="slider"]')) return;
  const root = event.currentTarget;
  const track = root.querySelector<HTMLElement>('[class*="trackContainer"]') ?? root;
  const bounds = track.getBoundingClientRect();
  if (bounds.width <= 0) return;
  event.preventDefault();
  event.stopPropagation();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const stepped = min + Math.round(((min + ratio * (max - min)) - min) / step) * step;
  const point = Math.max(min, Math.min(max, Number(stepped.toFixed(6))));
  const handleIndex = Math.abs(point - value[0]) <= Math.abs(point - value[1]) ? 0 : 1;
  onChange(handleIndex === 0
    ? [Math.min(point, value[1]), value[1]]
    : [value[0], Math.max(point, value[0])]);
}

const IMPORT_BROWSER_HEADER_HEIGHT = 38;
const IMPORT_BROWSER_ENTRY_ROW_HEIGHT = 38;
const IMPORT_BROWSER_SCROLLBAR_SIZE = 12;
const IMPORT_BROWSER_VISIBLE_ROWS = 8;
const IMPORT_BROWSER_VIEWPORT_HEIGHT = IMPORT_BROWSER_HEADER_HEIGHT
  + IMPORT_BROWSER_ENTRY_ROW_HEIGHT * IMPORT_BROWSER_VISIBLE_ROWS
  + IMPORT_BROWSER_SCROLLBAR_SIZE;
const IMPORT_BROWSER_ROW_OVERSCAN = 8;
const IMPORT_LAST_FOLDER_STORAGE_KEY = "cellxplorer-import-last-folder";
const IMPORT_BROWSER_COLUMN_MIN_WIDTH: Record<ImportBrowserSortKey, number> = {
  name: 190,
  extension: 112,
  supplier: 90,
  protocol: 95,
  size: 90,
  modified: 140,
};
const IMPORT_BROWSER_COLUMN_LABELS: Record<ImportBrowserSortKey, string> = {
  name: "Name",
  extension: "Extension",
  supplier: "Supplier",
  protocol: "Protocol",
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
  const queryClient = useQueryClient();
  const [indexedScope, setIndexedScope] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [indexedPreviewEntry, setIndexedPreviewEntry] = useState<IndexedFile | null>(null);
  const [requestedPath, setRequestedPath] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(IMPORT_LAST_FOLDER_STORAGE_KEY),
  );
  const [pathInput, setPathInput] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pendingPathEditTarget, setPendingPathEditTarget] = useState<string | null>(null);
  const [pathEditError, setPathEditError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const lastValidPathRef = useRef<string | null>(null);
  const lastSuccessfulBrowseRef = useRef<ImportBrowseResult | null>(null);
  const [search, setSearch] = useState("");
  const [fileFilters, setFileFilters] = useState<ImportBrowserFilters>(EMPTY_IMPORT_BROWSER_FILTERS);
  const [fileSort, setFileSort] = useState<ImportBrowserSort>({ key: "name", direction: "asc" });
  const [headerHints, setHeaderHints] = useState<Map<string, ImportHeaderHint>>(new Map());
  const [columnWidths, setColumnWidths] = useState<Record<ImportBrowserSortKey, number>>({
    name: 360, extension: 120, supplier: 115, protocol: 125, size: 100, modified: 165,
  });
  const [showFolders, setShowFolders] = useState(true);
  const [hideUnavailable, setHideUnavailable] = useState(false);
  const [headerFilter, setHeaderFilter] = useState<ImportBrowserSortKey | null>(null);
  const [headerFilterSearch, setHeaderFilterSearch] = useState("");
  const headerHintInFlight = useRef(new Set<string>());
  const headerHintFailed = useRef(new Set<string>());
  const headerHintDirectory = useRef<string | null>(null);
  const headerHintGeneration = useRef(0);
  const tableRootRef = useRef<HTMLDivElement>(null);
  const entryViewportRef = useRef<HTMLDivElement>(null);
  const [entryScrollTop, setEntryScrollTop] = useState(0);
  const [selected, setRawSelected] = useState<Map<string, ImportBrowseEntry>>(() => {
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
  const setSelected = useCallback((update: SetStateAction<Map<string, ImportBrowseEntry>>) => {
    setRawSelected((current) => mergeIndexedSelection(new Map(), typeof update === "function" ? update(current) : update));
  }, []);
  const [selectedSearch, setSelectedSearch] = useState("");
  const [selectedPreviewPath, setSelectedPreviewPath] = useState<string | null>(null);
  const xlsxHoverPrefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xlsxPreviewPrefetchBusy = useRef(false);
  const [focusedEntryPath, setFocusedEntryPath] = useState<string | null>(null);
  const [quickPreviewCompletedPath, setQuickPreviewCompletedPath] = useState<string | null>(null);
  const [quickPreviewFallbackKey, setQuickPreviewFallbackKey] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) {
      setQuickPreviewCompletedPath(null);
      setQuickPreviewFallbackKey(null);
    }
  }, [opened]);
  const markQuickPreviewSettled = useCallback((path: string, version: string | undefined, requiresFullInspection: boolean) => {
    setQuickPreviewCompletedPath(path);
    const fallbackKey = `${path}\u0000${version ?? "unknown"}`;
    setQuickPreviewFallbackKey((current) => requiresFullInspection
      ? fallbackKey
      : current === fallbackKey ? null : current);
  }, []);
  useEffect(() => () => {
    if (xlsxHoverPrefetchTimer.current !== null) {
      clearTimeout(xlsxHoverPrefetchTimer.current);
    }
  }, []);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewPreferences, setPreviewPreferences] = useState<ImportSourcePreviewPreferences>(DEFAULT_IMPORT_SOURCE_PREVIEW_PREFERENCES);
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [knownFolderImportability, setKnownFolderImportability] = useState<Map<string, boolean>>(new Map());
  const [leftPaneWidth, setLeftPaneWidth] = useState(235);
  const [resizeActive, setResizeActive] = useState(false);
  const [dividerHovered, setDividerHovered] = useState(false);
  const [dividerFocused, setDividerFocused] = useState(false);
  const resizeContainerRef = useRef<HTMLDivElement>(null);
  const { ref: previewScrollRef, height: previewScrollHeight } = useElementSize();
  const resizeCleanup = useRef<(() => void) | null>(null);
  const browseQuery = useQuery({
    queryKey: ["import-filesystem", requestedPath],
    queryFn: () => post<ImportBrowseResult>("/api/imports/browse", { path: requestedPath }),
    enabled: opened,
    placeholderData: (previous) => previous,
  });
  // React Query can drop placeholder data after an error; keep the last usable listing visible for path recovery.
  const browseData = browseQuery.isError
    ? lastSuccessfulBrowseRef.current ?? browseQuery.data
    : browseQuery.data ?? lastSuccessfulBrowseRef.current;
  const selectedPreviewEntry = selectedPreviewPath
    ? selected.get(selectedPreviewPath)
      ?? (indexedPreviewEntry?.path === selectedPreviewPath ? indexedPreviewEntry : null)
      ?? browseData?.entries.find((entry) => entry.path === selectedPreviewPath)
      ?? null
    : null;
  const selectedPreviewVersion = selectedPreviewEntry
    ? `${selectedPreviewEntry.size ?? "unknown"}:${selectedPreviewEntry.modified_at ?? "unknown"}`
    : undefined;
  const selectedPreviewFallbackKey = selectedPreviewEntry?.path
    ? `${selectedPreviewEntry.path}\u0000${selectedPreviewVersion ?? "unknown"}`
    : null;
  const quickPreviewGateReleased = Boolean(
    selectedPreviewEntry?.path
    && (
      quickPreviewCompletedPath === selectedPreviewEntry.path
      // These formats have a quick voltage preview, but no quick cycle
      // preview. When Cycles is already selected, start inspection directly
      // instead of waiting for a voltage request that will never run.
      || (previewPreferences.view === "cycles" && /\.(?:ndax|xlsx)$/i.test(selectedPreviewEntry.path))
    ),
  );
  const prefetchHoveredExcelPreview = (entry: ImportBrowseEntry) => {
    if (xlsxHoverPrefetchTimer.current !== null) {
      clearTimeout(xlsxHoverPrefetchTimer.current);
      xlsxHoverPrefetchTimer.current = null;
    }
    if (
      entry.kind !== "file"
      || !/\.xlsx$/i.test(entry.path)
      || headerHints.get(entry.path)?.compatible === false
      || selectedPreviewPath === entry.path
      || previewCollapsed
    ) return;

    const sourceVersion = `${entry.size ?? "unknown"}:${entry.modified_at ?? "unknown"}`;
    const queryKey = [
      "import-quick-voltage", "neware-excel", entry.path, sourceVersion, "time", undefined, undefined,
    ] as const;
    xlsxHoverPrefetchTimer.current = setTimeout(() => {
      xlsxHoverPrefetchTimer.current = null;
      if (!opened || xlsxPreviewPrefetchBusy.current || queryClient.getQueryData(queryKey)) return;
      xlsxPreviewPrefetchBusy.current = true;
      void queryClient.prefetchQuery({
        queryKey,
        queryFn: ({ signal }) => previewQuickNewareExcel({
          source_path: entry.path,
          quantity: "voltage",
          voltage_x_axis: "time",
        }, { signal }),
        staleTime: Infinity,
      }).catch(() => undefined).finally(() => {
        xlsxPreviewPrefetchBusy.current = false;
      });
    }, 180);
  };
  const selectedPreviewQuery = useQuery<ImportPreview>({
    queryKey: ["import-picker-selected-preview", selectedPreviewEntry?.path],
    queryFn: async ({ signal }) => {
      const path = selectedPreviewEntry?.path;
      if (!path) throw new Error("Select a file to preview it.");
      const result = await post<ImportInspectResult>("/api/imports/inspect-paths", {
        paths: [path],
      }, { signal });
      const preview = result.files[0];
      if (!preview) {
        throw new Error(result.failures[0]?.error ?? "This file could not be inspected for preview.");
      }
      return preview;
    },
    enabled: opened && mode === "files" && !previewCollapsed && selectedPreviewEntry?.kind === "file"
      && (!/\.(ndax|xlsx)$/i.test(selectedPreviewEntry.path) || quickPreviewGateReleased)
      // Excel's quick preview is display-only; defer the full inspection until
      // the user includes the file. An explicitly previewed workbook whose
      // quick plot failed also gets a full check, rather than spinning forever.
      && (!/\.xlsx$/i.test(selectedPreviewEntry.path)
        || selected.has(selectedPreviewEntry.path)
        || quickPreviewFallbackKey === selectedPreviewFallbackKey),
    staleTime: Infinity,
    retry: false,
  });
  const previewMatchesSelection = Boolean(
    selectedPreviewEntry?.kind === "file"
    && selectedPreviewQuery.data?.source_path
    && importPathsEqual(selectedPreviewQuery.data.source_path, selectedPreviewEntry.path),
  );
  const pinnedMutation = useMutation({
    mutationFn: (paths: string[]) =>
      put<{ items: ImportQuickAccessItem[] }>("/api/imports/quick-access/pinned", { paths }),
    onSuccess: () => void browseQuery.refetch(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const headerHintMutation = useMutation({
    mutationFn: ({ paths }: { paths: string[]; generation: number }) => post<{ files: ImportHeaderHint[] }>("/api/imports/header-hints", { paths }),
    onSuccess: ({ files }) => {
      setHeaderHints((current) => {
      const next = new Map(current);
      for (const hint of files) next.set(hint.path, hint);
      return next;
      });
      const unavailable = new Set(files.filter((hint) => hint.registered || hint.compatible === false).map((hint) => hint.path));
      if (unavailable.size) setSelected((current) => {
        const next = new Map(current);
        unavailable.forEach((path) => next.delete(path));
        return next;
      });
    },
    onError: (error: Error, variables) => {
      if (variables.generation === headerHintGeneration.current) {
        notifications.show({ message: `Some file headers could not be scanned: ${error.message}. Use Refresh to retry.`, color: "orange" });
      }
    },
  });
  const headerHintsPending = headerHintMutation.isPending;
  const submitHeaderHints = headerHintMutation.mutate;
  const directoryEntries = browseData?.entries ?? [];
  const visibleEntries = useMemo(
    () => filterAndSortImportEntries(directoryEntries, headerHints, search, fileFilters, fileSort, showFolders),
    [directoryEntries, fileFilters, fileSort, headerHints, search, showFolders],
  );
  const headerScanPending = (entry: ImportBrowseEntry) => {
    if (entry.kind !== "file") return false;
    return headerHintInFlight.current.has(entry.path)
      || (!headerHints.has(entry.path) && !headerHintFailed.current.has(entry.path));
  };
  const unavailableFile = (entry: ImportBrowseEntry) => {
    if (entry.kind !== "file") return false;
    const hint = headerHints.get(entry.path);
    return headerScanPending(entry)
      || hint?.registered === true
      || hint?.compatible === false;
  };
  const isRegisteredFile = (entry: ImportBrowseEntry) =>
    entry.kind === "file" && headerHints.get(entry.path)?.registered === true;
  const canPreviewFile = (entry: ImportBrowseEntry) =>
    entry.kind === "file" && (headerScanPending(entry) || !unavailableFile(entry) || isRegisteredFile(entry));
  const displayedEntries = useMemo(() => hideUnavailable
    ? visibleEntries.filter((entry) => {
        const hint = headerHints.get(entry.path);
        return entry.kind === "folder" || !(hint?.registered === true || hint?.compatible === false);
      })
    : visibleEntries, [headerHints, hideUnavailable, visibleEntries]);
  const selectableVisibleEntries = displayedEntries.filter((entry) => entry.kind === "folder" || !unavailableFile(entry));
  const filesInDirectory = useMemo(() => directoryEntries.filter((entry) =>
    entry.kind === "file" && headerHints.get(entry.path)?.compatible !== false,
  ), [directoryEntries, headerHints]);
  const availableForSupplier = filesInDirectory.filter((entry) =>
    (!fileFilters.extensions.length || fileFilters.extensions.includes(importEntryExtension(entry)))
    && (!fileFilters.protocols.length || fileFilters.protocols.includes(headerHints.get(entry.path)?.technique ?? "")),
  );
  const availableForProtocol = filesInDirectory.filter((entry) =>
    (!fileFilters.suppliers.length || fileFilters.suppliers.includes(importEntrySupplier(entry, headerHints.get(entry.path))))
    && (!fileFilters.extensions.length || fileFilters.extensions.includes(importEntryExtension(entry))),
  );
  const availableForExtension = filesInDirectory.filter((entry) =>
    (!fileFilters.suppliers.length || fileFilters.suppliers.includes(importEntrySupplier(entry, headerHints.get(entry.path))))
    && (!fileFilters.protocols.length || fileFilters.protocols.includes(headerHints.get(entry.path)?.technique ?? "")),
  );
  const supplierOptions = [...new Set(availableForSupplier.map((entry) => importEntrySupplier(entry, headerHints.get(entry.path))))]
    .sort((a, b) => a.localeCompare(b));
  const protocolOptions = [...new Set(availableForProtocol.flatMap((entry) => {
    const technique = headerHints.get(entry.path)?.technique;
    return technique ? [technique] : [];
  }))].sort((a, b) => a.localeCompare(b));
  const extensionOptions = [...new Set(availableForExtension.map(importEntryExtension))]
    .filter(Boolean).sort((a, b) => a.localeCompare(b));
  const sizeValuesMb = filesInDirectory.flatMap((entry) => entry.size === null ? [] : [entry.size / (1024 * 1024)]);
  const sizeDomain = sizeValuesMb.reduce<[number, number]>(
    ([minimum, maximum], value) => [Math.min(minimum, value), Math.max(maximum, value)],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  );
  const sizeDomainMin = sizeValuesMb.length ? sizeDomain[0] : 0;
  const sizeDomainMax = sizeValuesMb.length ? sizeDomain[1] : 1;
  const sizeSliderMax = sizeDomainMax > sizeDomainMin ? sizeDomainMax : sizeDomainMin + 1;
  const sizeSliderValue: [number, number] = [
    fileFilters.minSize ? Math.max(sizeDomainMin, Math.min(sizeSliderMax, Number(fileFilters.minSize))) : sizeDomainMin,
    fileFilters.maxSize ? Math.max(sizeDomainMin, Math.min(sizeSliderMax, Number(fileFilters.maxSize))) : sizeSliderMax,
  ];
  const headerFilterIsActive = (key: ImportBrowserSortKey) => {
    if (key === "supplier") return fileFilters.suppliers.length > 0;
    if (key === "extension") return fileFilters.extensions.length > 0;
    if (key === "protocol") return fileFilters.protocols.length > 0;
    if (key === "size") return Boolean(fileFilters.minSize || fileFilters.maxSize);
    if (key === "modified") return Boolean(fileFilters.modifiedAfter || fileFilters.modifiedBefore);
    return Boolean(search);
  };
  const categoricalOptions = (key: ImportBrowserSortKey) => {
    if (key === "supplier") return supplierOptions;
    if (key === "extension") return extensionOptions;
    if (key === "protocol") return protocolOptions;
    return [];
  };
  const categoricalSelectionKey = (key: ImportBrowserSortKey) => {
    if (key === "supplier") return "suppliers" as const;
    if (key === "extension") return "extensions" as const;
    return "protocols" as const;
  };
  const categoricalFilter = ["extension", "supplier", "protocol"].includes(headerFilter ?? "");
  const visibleFilterOptions = categoricalFilter
    ? categoricalOptions(headerFilter!).filter((option) => option.toLocaleLowerCase().includes(headerFilterSearch.trim().toLocaleLowerCase()))
    : [];
  const categoricalKey = categoricalFilter ? categoricalSelectionKey(headerFilter!) : null;
  const selectedCategoricalValues = categoricalKey ? fileFilters[categoricalKey] : [];
  const selectedVisibleOptionCount = visibleFilterOptions.filter((option) => selectedCategoricalValues.includes(option)).length;
  const allVisibleOptionsSelected = visibleFilterOptions.length > 0 && selectedVisibleOptionCount === visibleFilterOptions.length;
  const someVisibleOptionsSelected = selectedVisibleOptionCount > 0 && !allVisibleOptionsSelected;

  useEffect(() => {
    if (!opened) return;
    entryViewportRef.current?.scrollTo({ top: 0, left: 0 });
    headerHintInFlight.current.clear();
    headerHintFailed.current.clear();
    headerHintGeneration.current += 1;
    headerHintDirectory.current = null;
    const lastFolder = typeof window === "undefined"
      ? null
      : window.localStorage.getItem(IMPORT_LAST_FOLDER_STORAGE_KEY);
    setRequestedPath(mode === "folder" ? initialPath ?? null : initialPath ?? lastFolder);
    setPathInput("");
    setPathEditing(false);
    setPendingPathEditTarget(null);
    setPathEditError(null);
    setSearch("");
    setIndexedScope(false);
    setIndexedPreviewEntry(null);
    setShowFolders(true);
    setHideUnavailable(false);
    setHeaderFilter(null);
    setHeaderFilterSearch("");
    setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS);
    setHeaderHints(new Map());
    setEntryScrollTop(0);
    if (selectionKey === undefined) {
      setSelected(new Map());
      setLastSelectedPath(null);
      setSelectedPreviewPath(null);
    }
    setFocusedEntryPath(null);
    setSelectedSearch("");
    setPreviewCollapsed(false);
    setKnownFolderImportability(new Map());
  }, [mode, opened, selectionKey]);

  useEffect(() => () => resizeCleanup.current?.(), []);

  useEffect(() => {
    if (browseData?.current_path) setPathInput(browseData.current_path);
  }, [browseData?.current_path]);

  useEffect(() => {
    const path = browseData?.current_path;
    if (mode === "files" && path) window.localStorage.setItem(IMPORT_LAST_FOLDER_STORAGE_KEY, path);
  }, [browseData?.current_path, mode]);

  useEffect(() => {
    const data = browseQuery.data;
    const path = data?.current_path;
    if (data && path && !browseQuery.isError && !browseQuery.isPlaceholderData) {
      lastValidPathRef.current = path;
      lastSuccessfulBrowseRef.current = data;
    }
  }, [browseQuery.data, browseQuery.isError, browseQuery.isPlaceholderData]);

  useEffect(() => {
    entryViewportRef.current?.scrollTo({ top: 0 });
    setEntryScrollTop(0);
  }, [fileFilters, fileSort, search, showFolders]);

  useEffect(() => {
    const path = browseData?.current_path ?? null;
    if (headerHintDirectory.current === path) return;
    headerHintDirectory.current = path;
    headerHintGeneration.current += 1;
    headerHintInFlight.current.clear();
    headerHintFailed.current.clear();
  }, [browseData?.current_path]);

  useEffect(() => {
    const data = browseData;
    if (!data?.current_path) return;
    const hasVisibleFile = data.entries.some((entry) => entry.kind === "file");
    const hasSubfolder = data.entries.some((entry) => entry.kind === "folder");
    setKnownFolderImportability((current) => {
      const next = new Map(current);
      if (hasVisibleFile || hasSubfolder) next.delete(data.current_path);
      else next.set(data.current_path, false);
      return next;
    });
  }, [browseData]);

  useEffect(() => {
    if (!pathEditing) return;
    const input = pathInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [pathEditing]);

  useEffect(() => {
    const data = browseData;
    if (!pendingPathEditTarget || !browseQuery.isError) return;
    const pathError = browseQuery.error instanceof ApiError && browseQuery.error.status === 404
      ? "That path doesn't exist. Enter a valid path or press Esc to return to the current folder."
      : "That location couldn't be opened. Check the path or press Esc to return to the current folder.";
    setPathEditError(pathError);
    setPendingPathEditTarget(null);
    setRequestedPath(data?.current_path ?? lastValidPathRef.current);
    pathInputRef.current?.focus();
  }, [browseData?.current_path, browseQuery.error, browseQuery.isError, pendingPathEditTarget]);

  useEffect(() => {
    const data = browseQuery.data;
    if (
      !pendingPathEditTarget
      || browseQuery.isError
      || browseQuery.isFetching
      || browseQuery.isPlaceholderData
      || !data?.current_path
    ) return;
    if (!importPathsEqual(data.current_path, pendingPathEditTarget)) return;
    setPathEditing(false);
    setPendingPathEditTarget(null);
    setPathEditError(null);
    entryViewportRef.current?.scrollTo({ top: 0, left: 0 });
    setSearch("");
    setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS);
    setHeaderFilter(null);
    setHeaderFilterSearch("");
    setEntryScrollTop(0);
    setLastSelectedPath(null);
    setFocusedEntryPath(null);
    setSelectedPreviewPath((current) => current && selected.has(current) ? current : null);
  }, [browseQuery.data, browseQuery.isError, browseQuery.isFetching, browseQuery.isPlaceholderData, pendingPathEditTarget, selected]);

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
      setPathEditError(null);
      setPathEditing(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [opened]);

  const navigate = (path: string | null) => {
    setIndexedScope(false);
    headerHintGeneration.current += 1;
    headerHintInFlight.current.clear();
    entryViewportRef.current?.scrollTo({ top: 0, left: 0 });
    setRequestedPath(path);
    setPathEditError(null);
    const reset = resetImportBrowserNavigation();
    setSearch(reset.search);
    setFileFilters(EMPTY_IMPORT_BROWSER_FILTERS);
    // Keep resolved hints for already-selected files in other folders. Their
    // paths are stable identities, and Continue requires each selected file
    // to have a completed compatibility result before submission.
    setEntryScrollTop(0);
    setLastSelectedPath(reset.lastSelectedPath);
    setFocusedEntryPath(null);
    setSelectedPreviewPath((current) => current && selected.has(current) ? current : null);
    setPathEditing(false);
    setPendingPathEditTarget(null);
  };

  const refreshFolder = () => {
    headerHintGeneration.current += 1;
    headerHintInFlight.current.clear();
    headerHintFailed.current.clear();
    const paths = new Set(directoryEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    setHeaderHints((current) => new Map([...current].filter(([path]) => !paths.has(path))));
    void browseQuery.refetch();
  };

  const enterPathEdit = () => {
    setPendingPathEditTarget(null);
    setPathEditError(null);
    setPathEditing(true);
  };

  const cancelPathEdit = () => {
    setPendingPathEditTarget(null);
    setPathEditError(null);
    setPathEditing(false);
    const currentPath = browseData?.current_path ?? lastValidPathRef.current;
    setRequestedPath(currentPath);
    setPathInput(currentPath ?? "");
  };

  const handlePathEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = importPathEditAction(event.key, pathInput);
    if (!action) return;
    event.preventDefault();
    if (action === "cancel") {
      // Escape belongs to the inline path editor first; don't let the modal
      // also receive it and close while the user is discarding a bad path.
      event.stopPropagation();
      cancelPathEdit();
    } else {
      const targetPath = pathInput.trim();
      setPathEditError(null);
      setPendingPathEditTarget(targetPath);
      setRequestedPath(targetPath);
    }
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
    if (unavailableFile(entry)) return;
    const normalized = new Map(selected);
    const alias = [...normalized.keys()].find((path) => importPathsEqual(path, entry.path));
    if (alias && alias !== entry.path) { normalized.delete(alias); normalized.set(entry.path, entry); }
    const update = toggleImportFileSelection(entry, selectableVisibleEntries, normalized, lastSelectedPath, {
      shiftKey,
      ctrlKey,
      metaKey,
    });
    const safeSelection = new Map(update.selected);
    for (const candidate of safeSelection.values()) if (unavailableFile(candidate)) safeSelection.delete(candidate.path);
    setSelected(safeSelection);
    setLastSelectedPath(update.lastSelectedPath);
  };

  const includeFile = (entry: ImportBrowseEntry) => {
    if (unavailableFile(entry)) return;
    setSelected((current) => new Map(current).set(entry.path, entry));
    setLastSelectedPath(entry.path);
    setSelectedPreviewPath(entry.path);
  };

  const activateRow = (entry: ImportBrowseEntry, shiftKey = false, ctrlKey = false, metaKey = false) => {
    const action = importRowAction(entry);
    if (action === "navigate") {
      navigate(entry.path);
      return;
    }
    if (entry.kind === "folder") {
      if (ctrlKey || metaKey) activateFolderCheckbox(entry);
      return;
    }
    if (unavailableFile(entry)) {
      if (canPreviewFile(entry)) setSelectedPreviewPath(entry.path);
      return;
    }
    setSelectedPreviewPath(entry.path);
    setLastSelectedPath(entry.path);
    if (shiftKey || ctrlKey || metaKey) toggleFile(entry, shiftKey, ctrlKey, metaKey);
  };

  const activateFolderCheckbox = (entry: ImportBrowseEntry) => {
    setSelected((current) => toggleImportFolderSelection(current, entry));
    setLastSelectedPath(null);
  };

  const handleRowKeyDown = (entry: ImportBrowseEntry, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (!allVisibleSelected) toggleShownSelection();
      return;
    }
    const action = importKeyboardAction(entry, event.key);
    if (!action) return;
    event.preventDefault();
    if (action === "navigate") navigate(entry.path);
    else if (action === "preview") {
      if (canPreviewFile(entry)) setSelectedPreviewPath(entry.path);
    } else if (entry.kind === "folder") activateFolderCheckbox(entry);
    else toggleFile(entry);
  };

  const selectedEntries = [...selected.values()];
  const visibleSelectedEntries = selectedEntries.filter((entry) =>
    `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(selectedSearch.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    if (!selectedPreviewPath || selected.has(selectedPreviewPath)) return;
    if (indexedPreviewEntry?.path === selectedPreviewPath) return;
    if (browseData?.entries.some((entry) => entry.path === selectedPreviewPath)) return;
    setSelectedPreviewPath(null);
  }, [browseData?.entries, indexedPreviewEntry, selected, selectedPreviewPath]);
  const selectedFileResolutionPending = selectedEntries.some((entry) =>
    entry.kind === "file"
    && !headerHints.has(entry.path)
    && !headerHintFailed.current.has(entry.path),
  );
  const fileCount = selectedEntries.filter((entry) => entry.kind === "file").length;
  const folderCount = selectedEntries.filter((entry) => entry.kind === "folder").length;
  const isFolderSelectable = (entry: ImportBrowseEntry) =>
    !isImportFolderCheckboxDisabled(entry, knownFolderImportability.get(entry.path));
  const shownSelection = importShownSelectionState(selectableVisibleEntries, selected, isFolderSelectable);
  const allVisibleSelected = shownSelection.allSelected;
  const someVisibleSelected = shownSelection.someSelected;
  const firstRenderedEntry = Math.max(
    0,
    Math.floor(Math.max(0, entryScrollTop - IMPORT_BROWSER_HEADER_HEIGHT) / IMPORT_BROWSER_ENTRY_ROW_HEIGHT) -
      IMPORT_BROWSER_ROW_OVERSCAN,
  );
  const lastRenderedEntry = Math.min(
    displayedEntries.length,
    firstRenderedEntry +
      Math.ceil(390 / IMPORT_BROWSER_ENTRY_ROW_HEIGHT) + IMPORT_BROWSER_ROW_OVERSCAN * 2,
  );
  const renderedEntries = displayedEntries.slice(firstRenderedEntry, lastRenderedEntry);
  const leadingSpacerHeight = firstRenderedEntry * IMPORT_BROWSER_ENTRY_ROW_HEIGHT;
  const trailingSpacerHeight =
    (displayedEntries.length - lastRenderedEntry) * IMPORT_BROWSER_ENTRY_ROW_HEIGHT;

  useEffect(() => {
    const directory = browseData?.current_path;
    if (!opened || mode !== "files" || headerHintsPending) return;
    const unresolvedSelection = selectedEntries.filter((entry) => entry.kind === "file" && !headerHints.has(entry.path)
      && !headerHintInFlight.current.has(entry.path) && !headerHintFailed.current.has(entry.path)).map((entry) => entry.path);
    const canScanDirectory = !indexedScope && directory && !browseQuery.isPlaceholderData && !browseQuery.isFetching
      && headerHintDirectory.current === directory;
    if (!unresolvedSelection.length && !canScanDirectory) return;

    // Start with rows currently mounted around the viewport, then continue in
    // the active filter/sort order. Unshown directory files remain the tail of
    // the queue so they are eventually scanned without delaying visible rows.
    const directoryBatch = canScanDirectory ? prioritizeImportHeaderHintPaths(
      renderedEntries,
      displayedEntries,
      filesInDirectory,
      new Set(headerHints.keys()),
      headerHintInFlight.current,
      headerHintFailed.current,
    ) : [];
    // Returning from review can retain sources outside the current folder.
    // Resolve those staged paths independently so Continue never waits on an unrelated listing.
    const batch = [...new Set([...unresolvedSelection, ...directoryBatch])].slice(0, 24);
    if (!batch.length) return;
    batch.forEach((path) => headerHintInFlight.current.add(path));
    const generation = headerHintGeneration.current;
      submitHeaderHints({ paths: batch, generation }, {
      onSettled: (_result, error) => {
        batch.forEach((path) => {
          headerHintInFlight.current.delete(path);
          if (error) headerHintFailed.current.add(path);
        });
      },
    });
  }, [
    browseData?.current_path,
    browseQuery.isFetching,
    browseQuery.isPlaceholderData,
    filesInDirectory,
    headerHintsPending,
    headerHints,
    mode,
    opened,
    indexedScope,
    renderedEntries,
    submitHeaderHints,
    displayedEntries,
    selectedEntries,
  ]);
  const quickAccess = browseData?.quick_access ?? [];
  const breadcrumbs = parseImportPathBreadcrumbs(
    browseData?.current_path ?? pathInput,
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
    setSelected((current) => toggleImportShownSelection(current, selectableVisibleEntries, isFolderSelectable));
    setLastSelectedPath(null);
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
  const gridTemplateColumns = `40px ${["name", "extension", "supplier", "protocol", "size", "modified"]
    .map((key) => `var(--import-${key}-width, ${columnWidths[key as ImportBrowserSortKey]}px)`).join(" ")}`;
  const browserGridStyle = {
    gridTemplateColumns,
    "--import-name-width": `${columnWidths.name}px`,
    "--import-extension-width": `${columnWidths.extension}px`,
    "--import-supplier-width": `${columnWidths.supplier}px`,
    "--import-protocol-width": `${columnWidths.protocol}px`,
    "--import-size-width": `${columnWidths.size}px`,
    "--import-modified-width": `${columnWidths.modified}px`,
  } as CSSProperties;
  const renderHeaderCell = (key: ImportBrowserSortKey) => {
    const isCategorical = key === "extension" || key === "supplier" || key === "protocol";
    const selectionKey = isCategorical ? categoricalSelectionKey(key) : null;
    const selectedValues = selectionKey ? fileFilters[selectionKey] : [];
    const options = isCategorical ? categoricalOptions(key) : [];
    const filteredOptions = options.filter((option) => option.toLocaleLowerCase().includes(headerFilterSearch.trim().toLocaleLowerCase()));
    const selectedCount = filteredOptions.filter((option) => selectedValues.includes(option)).length;
    const allSelected = filteredOptions.length > 0 && selectedCount === filteredOptions.length;
    const partiallySelected = selectedCount > 0 && !allSelected;
    const updateSelectedValues = (nextValues: string[]) => {
      if (!selectionKey) return;
      setFileFilters((current) => ({ ...current, [selectionKey]: nextValues }));
    };
    const clearFilter = () => {
      if (key === "name") setSearch("");
      if (selectionKey) updateSelectedValues([]);
      if (key === "size") setFileFilters((current) => ({ ...current, minSize: "", maxSize: "" }));
      if (key === "modified") setFileFilters((current) => ({ ...current, modifiedAfter: "", modifiedBefore: "" }));
    };
    return (
        <Box key={key} style={{ position: "relative", minWidth: 0, display: "flex", alignItems: "center", justifyContent: key === "size" ? "flex-end" : "flex-start", gap: 3, borderLeft: key === "name" ? undefined : "1px solid color-mix(in srgb, var(--mantine-color-default-border) 55%, transparent)", paddingLeft: key === "name" ? 0 : 8, boxSizing: "border-box", ...(key === "name" ? { position: "sticky", left: "calc(var(--mantine-spacing-sm) + 48px)", width: "var(--import-name-width)", zIndex: 5, background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" } : {}) }}>
        <UnstyledButton
          type="button"
          aria-label={`Sort by ${IMPORT_BROWSER_COLUMN_LABELS[key]}`}
          onClick={() => setFileSort((current) => nextImportBrowserSort(current, key))}
          style={{ fontSize: "var(--mantine-font-size-sm)", fontWeight: 700, color: "var(--mantine-color-dimmed)", minWidth: 0, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
        >
          {IMPORT_BROWSER_COLUMN_LABELS[key]} {fileSort.key === key ? (fileSort.direction === "asc" ? "↑" : "↓") : "↕"}
        </UnstyledButton>
        <Popover
          opened={headerFilter === key}
          onChange={(openedNow) => { setHeaderFilter(openedNow ? key : null); if (!openedNow) setHeaderFilterSearch(""); }}
          position="bottom-end"
          shadow="md"
          withinPortal
        >
          <Popover.Target>
            <ActionIcon
              size="xs"
              style={{ flex: "none" }}
              variant={headerFilter === key || headerFilterIsActive(key) ? "light" : "subtle"}
              color={headerFilter === key || headerFilterIsActive(key) ? "green" : "gray"}
              aria-label={`Filter ${IMPORT_BROWSER_COLUMN_LABELS[key]}`}
              onClick={(event) => {
                event.stopPropagation();
                setHeaderFilter((current) => current === key ? null : key);
                setHeaderFilterSearch("");
              }}
            ><IconFilter size={13} /></ActionIcon>
          </Popover.Target>
          <Popover.Dropdown w={isCategorical ? 260 : key === "modified" ? 300 : 310} onClick={(event) => event.stopPropagation()}>
            <Stack gap="xs">
              <Group justify="space-between" align="center" gap="md">
                <Text size="sm" fw={600}>{IMPORT_BROWSER_COLUMN_LABELS[key]} filter</Text>
                <ActionIcon aria-label={`Close ${IMPORT_BROWSER_COLUMN_LABELS[key]} filter`} variant="subtle" size="sm" onClick={() => { setHeaderFilter(null); setHeaderFilterSearch(""); }}><IconX size={15} /></ActionIcon>
              </Group>
              {key === "name" && <TextInput label="Name contains" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />}
              {isCategorical && <>
                <TextInput aria-label={`Search ${IMPORT_BROWSER_COLUMN_LABELS[key]} options`} placeholder={`Search ${IMPORT_BROWSER_COLUMN_LABELS[key].toLocaleLowerCase()}`} value={headerFilterSearch} onChange={(event) => setHeaderFilterSearch(event.currentTarget.value)} />
                <Checkbox
                  label={allSelected ? "Deselect all shown" : "Select all shown"}
                  checked={allSelected}
                  indeterminate={partiallySelected}
                  disabled={filteredOptions.length === 0}
                  onChange={() => {
                    const shown = new Set(filteredOptions);
                    updateSelectedValues(allSelected
                      ? selectedValues.filter((value) => !shown.has(value))
                      : [...new Set([...selectedValues, ...filteredOptions])]);
                  }}
                />
                <ScrollArea h={180} type="auto" offsetScrollbars="y">
                  {filteredOptions.length ? <Stack gap={4}>{filteredOptions.map((option) => (
                    <Checkbox key={option} label={option} checked={selectedValues.includes(option)} onChange={() => updateSelectedValues(
                      selectedValues.includes(option)
                        ? selectedValues.filter((value) => value !== option)
                        : [...selectedValues, option],
                    )} />
                  ))}</Stack> : <Text size="sm" c="dimmed">{key === "protocol" ? "Protocol hints are still being scanned." : "No options in this folder."}</Text>}
                </ScrollArea>
              </>}
              {key === "size" && <>
                <Box onPointerDownCapture={(event) => moveRangeHandleOnTrack(event, sizeDomainMin, sizeSliderMax, 0.0001, sizeSliderValue, ([minSize, maxSize]) => setFileFilters((current) => ({ ...current, minSize: String(minSize), maxSize: String(maxSize) })))}>
                  <RangeSlider aria-label="File size range in megabytes" min={sizeDomainMin} max={sizeSliderMax} minRange={0} step={0.0001} value={sizeSliderValue} onChange={([minSize, maxSize]) => setFileFilters((current) => ({ ...current, minSize: String(minSize), maxSize: String(maxSize) }))} />
                </Box>
                <Group grow>
                  <NumberInput label="Size from (MB)" min={0} step={0.0001} decimalScale={4} value={fileFilters.minSize} onChange={(value) => setFileFilters((current) => ({ ...current, minSize: value === "" ? "" : String(value) }))} />
                  <NumberInput label="Size to (MB)" min={0} step={0.0001} decimalScale={4} value={fileFilters.maxSize} onChange={(value) => setFileFilters((current) => ({ ...current, maxSize: value === "" ? "" : String(value) }))} />
                </Group>
              </>}
              {key === "modified" && <><TextInput type="date" label="Modified after" value={fileFilters.modifiedAfter} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedAfter: event.currentTarget.value }))} /><TextInput type="date" label="Modified before" value={fileFilters.modifiedBefore} onChange={(event) => setFileFilters((current) => ({ ...current, modifiedBefore: event.currentTarget.value }))} /></>}
              <Button variant="subtle" size="compact-sm" leftSection={key === "size" ? <IconRefresh size={13} /> : undefined} onClick={clearFilter}>
                {key === "size" ? "Reset range" : "Clear this filter"}
              </Button>
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${IMPORT_BROWSER_COLUMN_LABELS[key]} column`}
          onPointerDown={(event) => resizeFileColumn(key, event)}
          style={{ position: "absolute", zIndex: 4, top: -5, bottom: -5, right: 0, width: 8, transform: "translateX(50%)", cursor: "col-resize", touchAction: "none" }}
        />
      </Box>
    );
  };

  const selectedSourcesPanel = (
    <Paper withBorder p="xs" style={{ flex: "0 0 clamp(112px, 13vh, 140px)", minHeight: 112, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Group justify="space-between" mb={4}>
        <Group gap="xs">
          <Text size="sm" fw={700}>Selected sources</Text>
          <Text size="xs" c="dimmed">{selectedEntries.length}</Text>
        </Group>
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          disabled={selectedEntries.length === 0}
          onClick={() => { setSelected(new Map()); setSelectedPreviewPath(null); }}
        >
          Clear all
        </Button>
      </Group>
      <TextInput
        size="xs"
        placeholder="Search selected sources"
        aria-label="Search selected sources"
        leftSection={<IconSearch size={14} />}
        value={selectedSearch}
        onChange={(event) => setSelectedSearch(event.currentTarget.value)}
        mb={4}
      />
      <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollbarSize={10} offsetScrollbars="y" type="auto" styles={{ viewport: { paddingRight: 10 } }}>
        {selectedEntries.length === 0 ? (
          <Text size="sm" c="dimmed">Nothing selected yet.</Text>
        ) : visibleSelectedEntries.length === 0 ? (
          <Text size="sm" c="dimmed">No selected sources match this search.</Text>
        ) : (
          <Box style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 390px), 1fr))", gap: "4px 12px", paddingRight: 6 }}>
            {visibleSelectedEntries.map((entry) => (
              <Group
                key={entry.path}
                gap="xs"
                wrap="nowrap"
                pr="xs"
                bg={entry.path === selectedPreviewPath ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined}
                style={{ minWidth: 0, cursor: entry.kind === "file" ? "pointer" : undefined, borderRadius: 4 }}
                onClick={() => { if (entry.kind === "file") setSelectedPreviewPath(entry.path); }}
              >
                {entry.kind === "folder" ? <IconFolder size={14} /> : <IconFile size={14} />}
                <Text size="sm" truncate title={entry.path} style={{ flex: 1, minWidth: 0 }}>{entry.path}</Text>
                <ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Remove ${entry.name}`} onClick={(event) => { event.stopPropagation(); setSelected((current) => { const next = new Map(current); next.delete(entry.path); return next; }); }}><IconX size={12} /></ActionIcon>
              </Group>
            ))}
          </Box>
        )}
      </ScrollArea>
    </Paper>
  );

  return (
    <ImportModalShell
      opened={opened}
      onClose={onClose}
      closeDisabled={loading || searchDialogOpen}
      title={mode === "folder" ? "Choose a folder" : "Load cell files"}
      step={1}
      titleInfo={mode === "folder"
        ? "Choose the folder to monitor. The watcher checks source files directly in this folder."
        : "Select cycler files: Neware (.nda, .ndax, structured .xlsx) and BioLogic GCPL, CP, or OCV (.mpr) data, plus folders. Click a folder row to open it; use its checkbox to select the folder."}
      progress={progress ? <Paper withBorder p="xs">{progress}</Paper> : null}
      fill={mode === "files"}
      actions={
        <>
          <Text size="sm" c="dimmed">
            {mode === "folder"
              ? (browseData?.current_path ?? (pathInput || "Choose a folder"))
              : `${folderCount} folder${folderCount === 1 ? "" : "s"}${fileCount ? `, ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}`}
          </Text>
          <ImportModalPrimaryActions>
            <Button variant="default" disabled={loading} onClick={onClose}>
              Cancel
            </Button>
            {mode === "folder" ? (
              <Button
                loading={loading}
                disabled={!browseData?.current_path}
                onClick={() => {
                  const path = browseData?.current_path ?? pathInput.trim();
                  if (path) onFolderConfirm?.(path);
                }}
              >
                Use this folder
              </Button>
            ) : (
              <Button
                loading={loading}
                disabled={selectedEntries.length === 0 || selectedFileResolutionPending}
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
      <Stack gap="sm" style={mode === "files" ? { flex: "1 1 0", minHeight: 0, minWidth: 0 } : undefined}>
        <Group ref={resizeContainerRef} align="stretch" gap={0} wrap="nowrap" style={mode === "files" ? { flex: "1 1 0", minHeight: 0, minWidth: 0 } : undefined}>
          <Paper
            p="xs"
            withBorder
            style={{
              width: leftPaneWidth,
              minWidth: IMPORT_BROWSER_LEFT_PANE_MIN,
              maxWidth: IMPORT_BROWSER_LEFT_PANE_MAX,
              flexShrink: 0,
              ...(mode === "files" ? { display: "flex", flexDirection: "column", minHeight: 0 } : {}),
            }}
          >
            <ScrollArea h={mode === "files" ? "100%" : 560} style={mode === "files" ? { flex: 1, minHeight: 0 } : undefined} type="auto">
              <Box pr={8}>
                <Stack gap="md">
                {(["quick", "pinned", "recent"] as const).map((section) => {
                  const items = quickAccess.filter((item) => item.section === section);
                  if (!items.length) return null;
                  return (
                    <Stack key={section} gap={3}>
                      <Text size="sm" fw={700} c="dimmed">
                        {section === "quick" ? "Quick access" : section === "pinned" ? "Pinned" : "Recent"}
                      </Text>
                      {items.map((item) => {
                        const active = browseData?.current_path === item.path;
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
                  <Text size="sm" fw={700} c="dimmed">This PC</Text>
                  {(browseData?.roots ?? []).map((root) => <Button key={root.path} variant="subtle" color={browseData?.current_path === root.path ? "var(--mantine-primary-color-6)" : undefined} size="compact-sm" leftSection={root.name === "Home" ? <IconHome size={15} /> : <IconFolder size={15} />} justify="flex-start" onClick={() => navigate(root.path)} title={root.name}>{root.name}</Button>)}
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
          <Stack gap="sm" style={{ flex: "1 1 0", minWidth: 0, minHeight: mode === "files" ? 0 : undefined, overflow: "hidden" }}>
            {mode === "files" && <SegmentedControl aria-label="File search scope" value={indexedScope ? "indexed" : "folder"} onChange={(value) => setIndexedScope(value === "indexed")} data={[{ value: "folder", label: "This folder" }, { value: "indexed", label: "Search indexed locations" }]} />}
            {!indexedScope && <>
            <Group gap="xs" wrap="nowrap">
              <ActionIcon variant="default" size="lg" aria-label="Go to parent folder" disabled={!browseData?.parent_path} onClick={() => navigate(browseData?.parent_path ?? null)}><IconArrowUp size={18} /></ActionIcon>
              <Paper
                withBorder
                radius="md"
                px="xs"
                style={{ flex: 1, minWidth: 0, minHeight: 40, display: "flex", alignItems: "center", cursor: pathEditing ? "text" : "text" }}
                onClick={(event) => {
                  if (pathEditing || (event.target instanceof HTMLElement && event.target.closest("button"))) return;
                  enterPathEdit();
                }}
              >
                {pathEditing ? (
                  <Popover
                    opened={Boolean(pathEditError)}
                    onClose={() => setPathEditError(null)}
                    position="bottom-start"
                    withArrow
                    shadow="md"
                    withinPortal
                  >
                    <Popover.Target>
                      <TextInput
                        ref={pathInputRef}
                        variant="unstyled"
                        value={pathInput}
                        onChange={(event) => {
                          setPathInput(event.currentTarget.value);
                          setPathEditError(null);
                        }}
                        onKeyDown={handlePathEditKeyDown}
                        onBlur={() => { if (!pendingPathEditTarget) cancelPathEdit(); }}
                        aria-label="Current folder path"
                        aria-invalid={Boolean(pathEditError)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    </Popover.Target>
                    <Popover.Dropdown maw={360}>
                      <Group align="flex-start" gap="xs" wrap="nowrap">
                        <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" />
                        <Stack gap={2}>
                          <Text size="sm" fw={600}>Couldn't open this folder</Text>
                          <Text size="xs" c="dimmed" role="alert">{pathEditError}</Text>
                        </Stack>
                      </Group>
                    </Popover.Dropdown>
                  </Popover>
                ) : (
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
                )}
              </Paper>
              <ActionIcon variant="default" size="lg" aria-label="Refresh folder" onClick={refreshFolder}><IconRefresh size={17} /></ActionIcon>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <TextInput size="md" placeholder="Search this folder" leftSection={<IconSearch size={15} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} style={{ flex: 1, minWidth: 0 }} />
              {mode === "files" && <Button variant={showFolders ? "default" : "light"} aria-pressed={!showFolders} onClick={() => setShowFolders((current) => !current)}>
                {showFolders ? "Hide folders" : "Show folders"}
              </Button>}
              {mode === "files" && <Button variant={hideUnavailable ? "light" : "default"} aria-pressed={hideUnavailable} onClick={() => setHideUnavailable((current) => !current)}>
                {hideUnavailable ? "Show unavailable" : "Hide unavailable"}
              </Button>}
              <Button variant="default" disabled={shownSelection.disabled} onClick={toggleShownSelection}>{allVisibleSelected ? "Clear shown" : "Select shown"}</Button>
            </Group>
            {browseQuery.isError && browseData && !pendingPathEditTarget && !pathEditError && (
              <Alert color="orange" p="xs" icon={<IconAlertTriangle size={16} />}>
                Couldn’t refresh this folder. Showing the last successful listing; use Refresh to try again.
              </Alert>
            )}
            {mode === "files" && (
              <Text size="xs" c="dimmed">
                Click a file to preview or a folder to focus it. Grey registered files remain previewable but cannot be imported again. Press Space or Ctrl-click to include; Shift-click selects a file range. Double-click includes a file or opens a folder. Ctrl+A selects all shown.
              </Text>
            )}
            </>}
            <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: mode === "files" ? 1 : undefined, minHeight: mode === "files" ? 0 : undefined, minWidth: 0 }}>
            <Stack gap="sm" style={{ flex: "1 1 0", minWidth: 0, minHeight: mode === "files" ? 0 : undefined }}>
            <Paper withBorder p={0} style={{ flex: "1 1 0", minWidth: 0, minHeight: mode === "files" ? 0 : undefined, display: mode === "files" ? "flex" : undefined, flexDirection: mode === "files" ? "column" : undefined }}>
              {indexedScope ? <Box p="xs" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><IndexedSourceSearch onDialogChange={setSearchDialogOpen} selected={selected} currentPath={browseData?.current_path} onPreview={(file) => { setIndexedPreviewEntry(file); setSelectedPreviewPath(file.path); }} onSelection={(next, files) => {
                setHeaderHints((current) => { const hints = new Map(current); for (const file of files) if (next.has(file.path) && file.recognition === "recognized") hints.set(file.path, { path: file.path, supplier: file.supplier, technique: file.metadata.technique ?? null, source_format: file.extension, cycle_count: null, registered: file.registered, compatible: file.recognition === "recognized", error: null }); return hints; });
                setSelected(next);
              }} /></Box> : browseQuery.isPending && !browseData ? <Center style={{ height: mode === "files" ? "100%" : IMPORT_BROWSER_VIEWPORT_HEIGHT }}><Loader /></Center> : browseQuery.isError && !browseData ? <Center style={{ height: mode === "files" ? "100%" : IMPORT_BROWSER_VIEWPORT_HEIGHT }} px="lg"><Alert color="red" w="100%">{browseQuery.error instanceof Error ? browseQuery.error.message : "This folder could not be opened."}</Alert></Center> : <ScrollArea viewportRef={entryViewportRef} viewportProps={{ style: { boxSizing: "border-box" } }} h={mode === "files" ? "100%" : IMPORT_BROWSER_VIEWPORT_HEIGHT} style={mode === "files" ? { height: "100%" } : undefined} scrollbarSize={IMPORT_BROWSER_SCROLLBAR_SIZE} type="auto" offsetScrollbars onScrollPositionChange={({ y }) => setEntryScrollTop(y)}><Box ref={tableRootRef} style={{ minWidth: "calc(40px + 64px + var(--import-name-width) + var(--import-extension-width) + var(--import-supplier-width) + var(--import-protocol-width) + var(--import-size-width) + var(--import-modified-width))", boxSizing: "border-box", paddingBottom: IMPORT_BROWSER_SCROLLBAR_SIZE + 8, ...browserGridStyle }}><Stack gap={0}>
                <Box px="sm" py={8} bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" style={{ minHeight: IMPORT_BROWSER_HEADER_HEIGHT, boxSizing: "border-box", borderBottom: "1px solid var(--mantine-color-default-border)", display: "grid", alignItems: "center", gap: 8, gridTemplateColumns, position: "sticky", top: 0, zIndex: 3 }}>
                  <Checkbox aria-label="Select all visible importable files" checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected} disabled={shownSelection.disabled} onChange={toggleShownSelection} style={{ position: "sticky", left: "var(--mantine-spacing-sm)", zIndex: 5, background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))" }} />
                  {(["name", "extension", "supplier", "protocol", "size", "modified"] as const).map(renderHeaderCell)}
                </Box>
                {displayedEntries.length === 0 ? <Center h={300}><Text size="sm" c="dimmed">No folders or supported cycler files here.</Text></Center> : <>
                  <Box h={leadingSpacerHeight} aria-hidden="true" />
                  {renderedEntries.map((entry) => {
                  const isFolder = entry.kind === "folder";
                  const hint = headerHints.get(entry.path);
                  const folderState = isFolder ? folderSelectionState(entry, selected) : "none";
                  const rowSelected = isImportFileSelected(selected, entry.path) || folderState !== "none";
                  const previewActive = selectedPreviewPath === entry.path;
                  const rowFocused = focusedEntryPath === entry.path;
                  const selectedForeground = "light-dark(var(--mantine-color-black), var(--mantine-color-white))";
                  const rowBackground = isImportFileSelected(selected, entry.path) || folderState === "some"
                    ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
                    : previewActive || rowFocused
                      ? "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))"
                      : "var(--mantine-color-body)";
                  const disabledFile = unavailableFile(entry);
                  const registeredFile = isRegisteredFile(entry);
                  const metadataColor = rowSelected ? selectedForeground : "dimmed";
                  const folderCheckboxDisabled = isFolder && isImportFolderCheckboxDisabled(entry, knownFolderImportability.get(entry.path));
                  const cellStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", alignSelf: "center" };
                  const scanPending = headerScanPending(entry);
                  const disabledReason = registeredFile
                    ? "Already registered in CellXplorer. Click to preview; this file cannot be imported again."
                    : hint?.compatible === false
                      ? importEntryExtension(entry) === ".mpr"
                        ? "The protocol is not supported by CellXplorer."
                        : "This workbook is not supported by the Neware Excel parser."
                      : hint?.error
                        ? `Header scan unavailable: ${hint.error}. Select to try importing, or use Refresh to retry the scan.`
                        : scanPending ? "Checking whether this file can be imported. Click to preview while the check finishes." : null;
                  const rowInstructions = isFolder
                    ? `Double-click or press Enter to open ${entry.name}. Press Space or Ctrl-click to include its files.`
                    : registeredFile
                      ? `Already registered. Click or press Enter to preview ${entry.name}; it cannot be imported again.`
                      : scanPending
                        ? `Import eligibility is being checked. Click or press Enter to preview ${entry.name}; selection will be available if the file can be imported.`
                        : `Click to preview ${entry.name}. Press Space or Ctrl-click to include it; Shift-click selects a range; double-click includes it.`;
                  return <Box
                    key={entry.path}
                    px="sm"
                    role={isFolder ? "button" : "option"}
                    aria-label={rowInstructions}
                    aria-disabled={!isFolder && hint?.compatible === false}
                    aria-selected={!isFolder ? isImportFileSelected(selected, entry.path) : undefined}
                    aria-current={previewActive ? "true" : undefined}
                    tabIndex={0}
                    title={disabledFile ? disabledReason ?? undefined : hint?.error ? disabledReason ?? undefined : rowInstructions}
                    style={{ height: IMPORT_BROWSER_ENTRY_ROW_HEIGHT, boxSizing: "border-box", cursor: hint?.compatible === false ? "not-allowed" : "pointer", opacity: disabledFile && !scanPending ? 0.52 : 1, borderBottom: "1px solid var(--mantine-color-default-border)", background: rowBackground, display: "grid", alignItems: "center", gap: 8, gridTemplateColumns, userSelect: "none" }}
                    onMouseEnter={() => prefetchHoveredExcelPreview(entry)}
                    onMouseLeave={() => {
                      if (xlsxHoverPrefetchTimer.current !== null) {
                        clearTimeout(xlsxHoverPrefetchTimer.current);
                        xlsxHoverPrefetchTimer.current = null;
                      }
                    }}
                    onClick={(event) => activateRow(entry, event.shiftKey, event.ctrlKey, event.metaKey)}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      const target = event.target;
                      if (target instanceof Element && target.closest("input, label, [role='checkbox'], button")) return;
                      if (isFolder) navigate(entry.path);
                      else includeFile(entry);
                    }}
                    onFocus={() => {
                      setFocusedEntryPath(entry.path);
                      if (canPreviewFile(entry)) setSelectedPreviewPath(entry.path);
                    }}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setFocusedEntryPath(null);
                      }
                    }}
                    onKeyDown={(event) => handleRowKeyDown(entry, event)}
                  >
                    <Checkbox
                      aria-label={isFolder ? `Select all importable files in ${entry.name}` : `Select ${entry.name}`}
                      checked={isFolder ? folderState === "all" : isImportFileSelected(selected, entry.path)}
                      indeterminate={isFolder && folderState === "some"}
                      disabled={isFolder ? folderCheckboxDisabled : disabledFile}
                      style={{ position: "sticky", left: "var(--mantine-spacing-sm)", zIndex: 2, background: rowBackground }}
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
                    <Group gap="xs" wrap="nowrap" style={{ position: "sticky", left: "calc(var(--mantine-spacing-sm) + 48px)", zIndex: 2, width: "var(--import-name-width)", minWidth: 0, boxSizing: "border-box", overflow: "hidden", background: rowBackground }}>
                      {isFolder ? <IconFolder size={17} color={rowSelected ? selectedForeground : "var(--mantine-primary-color-6)"} /> : <IconFile size={17} color={rowSelected ? "light-dark(var(--mantine-color-gray-7), var(--mantine-color-gray-1))" : "var(--mantine-color-gray-6)"} />}
                      {!isFolder && hint?.compatible === false && <Tooltip label={disabledReason ?? "The protocol is not supported by CellXplorer."} withArrow><IconAlertTriangle size={16} color="var(--mantine-color-red-6)" aria-label={disabledReason ?? "Unsupported file"} style={{ opacity: 0.8, flex: "none" }} /></Tooltip>}
                      <Text size="md" truncate title={entry.name} style={{ flex: 1, minWidth: 0 }}>{entry.name}</Text>
                    </Group>
                    <Text size="sm" c={metadataColor} truncate title={isFolder ? undefined : importEntryExtension(entry)} style={cellStyle}>{isFolder ? "" : importEntryExtension(entry)}</Text>
                    <Text size="sm" c={metadataColor} truncate title={isFolder ? undefined : importEntrySupplier(entry, hint)} style={cellStyle}>{isFolder ? "" : importEntrySupplier(entry, hint)}</Text>
                    <Text size="sm" c={metadataColor} truncate title={hint?.error ?? hint?.technique ?? undefined} style={cellStyle}>{isFolder ? "" : hint?.technique ?? (headerHintsPending ? "…" : "—")}</Text>
                    <Text size="sm" c={metadataColor} ta="right" style={cellStyle}>{entry.size === null ? "" : formatMegabytes(entry.size)}</Text>
                    <Text size="sm" c={metadataColor} truncate title={entry.modified_at ?? undefined} style={cellStyle}>{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : ""}</Text>
                  </Box>;
                  })}
                  <Box h={trailingSpacerHeight} aria-hidden="true" />
                </>}
              </Stack></Box></ScrollArea>}
            </Paper>
            {mode === "files" && selectedSourcesPanel}
            </Stack>
            {mode === "files" && (
              <Paper withBorder p="xs" style={{ width: previewCollapsed ? 44 : "clamp(280px, 28vw, 390px)", flex: "0 0 auto", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <Group justify={previewCollapsed ? "center" : "space-between"} wrap="nowrap" mb={previewCollapsed ? 0 : "xs"}>
                  {!previewCollapsed && (
                    <Tooltip label={selectedPreviewEntry?.path ?? "Select a source file to preview it."} withArrow>
                      <Text size="sm" fw={700} truncate style={{ minWidth: 0 }}>
                        {selectedPreviewEntry ? `Preview · ${selectedPreviewEntry.name}` : "Preview"}
                      </Text>
                    </Tooltip>
                  )}
                  <ActionIcon
                    size="sm"
                    variant="default"
                    aria-label={previewCollapsed ? "Expand selected source preview" : "Collapse selected source preview"}
                    title={previewCollapsed ? "Expand preview" : "Collapse preview"}
                    onClick={() => setPreviewCollapsed((current) => !current)}
                  >{previewCollapsed ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}</ActionIcon>
                </Group>
                {!previewCollapsed && (
                  <Stack ref={previewScrollRef} gap="xs" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", scrollbarGutter: "stable" }}>
                    {selectedPreviewEntry ? (
                      <>
                        {previewMatchesSelection || /\.(ndax|xlsx)$/i.test(selectedPreviewEntry.path) ? (
                          <ImportSourcePreview
                            source={previewMatchesSelection ? selectedPreviewQuery.data! : null}
                            quickSourcePath={selectedPreviewEntry.path}
                            quickSourceVersion={selectedPreviewVersion}
                            onQuickPreviewSettled={markQuickPreviewSettled}
                            validateQuickExcel={selected.has(selectedPreviewEntry.path)}
                            sourceInspectionLoading={Boolean(
                              (selectedPreviewFallbackKey && quickPreviewFallbackKey === selectedPreviewFallbackKey
                                && !selectedPreviewQuery.isError && !previewMatchesSelection)
                              || (selectedPreviewQuery.isFetching && !previewMatchesSelection),
                            )}
                            availableHeight={previewScrollHeight}
                            inspectionError={selectedPreviewQuery.isError
                              ? selectedPreviewQuery.error instanceof Error
                                ? selectedPreviewQuery.error.message
                                : "This file could not be inspected for preview."
                              : undefined}
                            preferences={previewPreferences}
                            onPreferencesChange={(update) => setPreviewPreferences((current) => ({ ...current, ...update }))}
                          />
                        ) : selectedPreviewQuery.isError ? (
                          <Alert color="orange">{selectedPreviewQuery.error instanceof Error ? selectedPreviewQuery.error.message : "Preview could not be generated."}</Alert>
                        ) : (
                          <Center style={{ flex: 1, minHeight: 240 }}>
                            <Stack gap="xs" align="center">
                              <Loader size="sm" />
                              <Text size="xs" c="dimmed">Preparing preview for this file…</Text>
                            </Stack>
                          </Center>
                        )}
                      </>
                    ) : (
                      <Center style={{ flex: 1, minHeight: 240 }} px="sm">
                        <Text size="sm" c="dimmed" ta="center">Select a supported file to preview voltage, capacity, and cycles.</Text>
                      </Center>
                    )}
                  </Stack>
                )}
              </Paper>
            )}
            </Group>
            {mode !== "files" && selectedSourcesPanel}
          </Stack>
        </Group>
      </Stack>
    </ImportModalShell>
  );
}
