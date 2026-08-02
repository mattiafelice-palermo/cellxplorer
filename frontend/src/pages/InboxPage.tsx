import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconFileImport,
  IconFile,
  IconFolder,
  IconClock,
  IconDeviceDesktop,
  IconDownload,
  IconEye,
  IconHome,
  IconGripVertical,
  IconInfoCircle,
  IconPlus,
  IconPin,
  IconPinnedOff,
  IconRefresh,
  IconSearch,
  IconTable,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import {
  DragEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "react-router-dom";

import {
  ImportInspectResult,
  ImportBrowseEntry,
  ImportBrowseResult,
  ImportQuickAccessItem,
  ActiveMaterialPresetSettings,
  ElectrodeAreaPresetSettings,
  ImportFolderFile,
  ImportFolderSelectionResult,
  ImportPreview,
  ImportPreviewResult,
  ImportRawDataResult,
  get,
  post,
  put,
  Tree,
} from "../api";
import Plot from "../components/Plot";
import { ContinuedImportEditor, type ContinuedCellDraft } from "../components/ContinuedImportEditor";
import { ImportFilesystemPickerModal as SharedImportFilesystemPickerModal } from "../components/ImportFilesystemPickerModal";
import { ImportProgressPanel } from "../components/ImportProgressPanel";
import { addDebugEvent } from "../debug";
import { nominalCapacityFromMass } from "../scientificMetadata";
import {
  LARGE_IMPORT_WARNING_THRESHOLD,
  formatImportBytes,
  summarizeImportSelection,
} from "../importSelectionSummary";
import { estimateImportTiming, readImportTimingHistory } from "../importTiming";
import {
  cleanupStagedReplicateGroups,
  exactDuplicateCount,
  includedSeparateCellDrafts,
  isRegisteredExactDuplicate,
  removeAllRegisteredDuplicates,
  removeStagedDraft,
} from "../importDraftPolicy";
import {
  newImportJobToken,
  type ImportProgressStage,
} from "../importProgress";
import { recordImportTimingSample } from "../importTiming";
import { useImportJobProgress } from "../useImportJobProgress";
import {
  importPreviewQueryKey,
  importPreviewRequest,
  importPreviewStateFromResult,
  type ImportPreviewDraftState,
  type ImportPreviewState,
} from "../importPreviewPolicy";

export type ImportDraft = ImportPreview & {
  cell_name: string;
  description: string;
  metadata: Record<string, string>;
  preview_state: ImportPreviewState;
  preview_loading: boolean;
  active_mass_mg_override: number | null;
  nominal_capacity_mah_override: number | null;
  electrode_area_cm2_override: number | null;
  active_material_selection: string;
  active_material_preset_id: string | null;
  active_material_name: string | null;
  active_material_specific_capacity_mah_g: number | null;
  electrode_area_selection: string;
  electrode_area_preset_id: string | null;
  electrode_area_preset_name: string | null;
};

function useImportPreviewLoader(
  setDrafts: Dispatch<SetStateAction<ImportDraft[]>>,
) {
  const inFlight = useRef(new Map<string, Promise<ImportPreviewResult>>());
  const ready = useRef(new Map<string, ImportPreviewResult>());
  const requestVersions = useRef(new Map<string, number>());

  return useCallback((draft: ImportPreviewDraftState, retry = false) => {
    const previewKey = importPreviewQueryKey(draft.hash)[1];
    const version = (requestVersions.current.get(draft.staged_name) ?? 0) + 1;
    requestVersions.current.set(draft.staged_name, version);

    const apply = (state: ImportPreviewState) => {
      setDrafts((current) => current.map((item) => {
        if (
          item.staged_name !== draft.staged_name
          || item.hash.toLowerCase() !== draft.hash.toLowerCase()
          || requestVersions.current.get(draft.staged_name) !== version
        ) {
          return item;
        }
        return {
          ...item,
          preview_state: state,
          preview_loading: state.status === "loading",
          capacity_preview: state.status === "ready"
            ? state.preview.capacity_preview
            : state.status === "loading"
              ? null
              : item.capacity_preview,
          preview_error: state.status === "error"
            ? state.message
            : state.status === "ready"
              ? state.preview.preview_error
              : null,
        };
      }));
    };

    if (!retry) {
      const cached = ready.current.get(previewKey);
      if (cached) {
        apply(importPreviewStateFromResult(cached));
        return;
      }
    } else {
      ready.current.delete(previewKey);
    }

    apply({ status: "loading" });
    let request = inFlight.current.get(previewKey);
    if (!request) {
      addDebugEvent("import:previewRequested", {
        staged_name: draft.staged_name,
        filename: draft.filename,
        preview_key: previewKey,
      });
      request = post<ImportPreviewResult>(
        "/api/imports/preview",
        importPreviewRequest(draft),
      );
      inFlight.current.set(previewKey, request);
    }
    request
      .then((result) => {
        ready.current.set(previewKey, result);
        addDebugEvent("import:previewReady", {
          staged_name: draft.staged_name,
          points: result.capacity_preview?.x.length ?? 0,
          error: result.preview_error,
          preview_key: previewKey,
        });
        apply(importPreviewStateFromResult(result));
      })
      .catch((error: Error) => {
        addDebugEvent("import:previewFailed", {
          staged_name: draft.staged_name,
          error: error.message,
          preview_key: previewKey,
        });
        apply({ status: "error", message: error.message });
      })
      .finally(() => {
        if (inFlight.current.get(previewKey) === request) {
          inFlight.current.delete(previewKey);
        }
      });
  }, [setDrafts]);
}

type ImportReplicateDraft = {
  id: string;
  name: string;
  description: string;
  staged_names: string[];
};

type FolderImportCandidate = ImportFolderFile;

type FolderImportNode = {
  key: string;
  name: string;
  files: FolderImportCandidate[];
  children: FolderImportNode[];
};

type FolderImportTreeRow =
  | { kind: "folder"; node: FolderImportNode; depth: number }
  | { kind: "file"; candidate: FolderImportCandidate; depth: number };

const FOLDER_IMPORT_ROW_HEIGHT = 34;
const FOLDER_IMPORT_ROW_OVERSCAN = 8;

function folderCandidateKey(candidate: FolderImportCandidate) {
  return candidate.path ?? candidate.relative_path;
}

function buildImportFolderTree(rootName: string, candidates: FolderImportCandidate[]): FolderImportNode {
  const root: FolderImportNode = { key: "", name: rootName, files: [], children: [] };
  const nodes = new Map<string, FolderImportNode>([["", root]]);
  for (const candidate of candidates) {
    const selectionRoot = candidate.selection_root;
    const rootKey = selectionRoot
      ? selectionRoot.kind === "folder"
        ? `root:${selectionRoot.path.toLocaleLowerCase()}`
        : "root:loose-files"
      : "root:legacy";
    let parent = nodes.get(rootKey);
    if (!parent) {
      parent = {
        key: rootKey,
        name: selectionRoot?.label || "Selected files",
        files: [],
        children: [],
      };
      nodes.set(rootKey, parent);
      root.children.push(parent);
    }
    const parts = candidate.relative_path.replaceAll("\\", "/").split("/").filter(Boolean);
    let key = rootKey;
    for (const part of parts.slice(0, -1)) {
      key = key ? `${key}/${part}` : part;
      let node = nodes.get(key);
      if (!node) {
        node = { key, name: part, files: [], children: [] };
        nodes.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.files.push(candidate);
  }
  const sort = (node: FolderImportNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.filename.localeCompare(b.filename));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function flattenImportFolderTree(node: FolderImportNode): FolderImportCandidate[] {
  return [
    ...node.children.flatMap(flattenImportFolderTree),
    ...node.files,
  ];
}

function FolderImportSelectionModal({
  opened,
  rootName,
  candidates,
  loading,
  progress,
  onBack,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  rootName: string;
  candidates: FolderImportCandidate[];
  loading: boolean;
  progress?: ReactNode;
  onBack: () => void;
  onClose: () => void;
  onConfirm: (selected: FolderImportCandidate[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [rootsExpanded, setRootsExpanded] = useState(false);
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const tree = useMemo(() => buildImportFolderTree(rootName, candidates), [rootName, candidates]);
  const descendantKeysByNode = useMemo(() => {
    const result = new Map<string, string[]>();
    const visit = (node: FolderImportNode): string[] => {
      const keys = [
        ...node.files.map(folderCandidateKey),
        ...node.children.flatMap(visit),
      ];
      result.set(node.key, keys);
      return keys;
    };
    visit(tree);
    return result;
  }, [tree]);
  const selectedCountsByNode = useMemo(() => {
    const result = new Map<string, number>();
    const visit = (node: FolderImportNode): number => {
      const selectedFiles = node.files.reduce(
        (count, candidate) => count + (selected.has(folderCandidateKey(candidate)) ? 1 : 0),
        0,
      );
      const selectedChildren = node.children.reduce((count, child) => count + visit(child), 0);
      const count = selectedFiles + selectedChildren;
      result.set(node.key, count);
      return count;
    };
    visit(tree);
    return result;
  }, [selected, tree]);
  const focusedCandidate =
    candidates.find((candidate) => folderCandidateKey(candidate) === focusedKey) ?? null;
  const previewQuery = useQuery({
    queryKey: ["folder-import-preview", focusedCandidate?.path],
    queryFn: () =>
      post<ImportPreviewResult>("/api/imports/preview", {
        staged_name: "folder-selection-preview",
        source_path: focusedCandidate?.path,
      }),
    enabled: opened && Boolean(focusedCandidate?.path),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (opened) {
      setSelected(new Set(candidates.map(folderCandidateKey)));
      setSearch("");
      setLastSelected(null);
      setFocusedKey(candidates[0] ? folderCandidateKey(candidates[0]) : null);
      setRootsExpanded(false);
      setTreeScrollTop(0);
    }
  }, [opened, candidates]);

  useEffect(() => {
    setTreeScrollTop(0);
  }, [search]);

  const visibleCandidates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const ordered = flattenImportFolderTree(tree);
    if (!query) return ordered;
    const collect = (node: FolderImportNode, parentMatched: boolean): FolderImportCandidate[] => {
      const folderMatched = parentMatched || node.name.toLocaleLowerCase().includes(query);
      const files = folderMatched
        ? node.files
        : node.files.filter((candidate) => candidate.relative_path.toLocaleLowerCase().includes(query));
      return [
        ...node.children.flatMap((child) => collect(child, folderMatched)),
        ...files,
      ];
    };
    return collect(tree, false);
  }, [tree, search]);
  const visibleKeys = useMemo(() => visibleCandidates.map(folderCandidateKey), [visibleCandidates]);

  const toggleFile = (candidate: FolderImportCandidate, shiftKey: boolean, ctrlKey: boolean) => {
    const key = folderCandidateKey(candidate);
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelected) {
        const from = visibleKeys.indexOf(lastSelected);
        const to = visibleKeys.indexOf(key);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(key);
          visibleKeys.slice(start, end + 1).forEach((item) =>
            shouldSelect ? next.add(item) : next.delete(item)
          );
          return next;
        }
      }
      if (!ctrlKey && !shiftKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastSelected(key);
  };

  const toggleFolder = (node: FolderImportNode) => {
    const keys = descendantKeysByNode.get(node.key) ?? [];
    setSelected((current) => {
      const next = new Set(current);
      const select = keys.some((key) => !next.has(key));
      keys.forEach((key) => (select ? next.add(key) : next.delete(key)));
      return next;
    });
  };

  const visibleRows = useMemo<FolderImportTreeRow[]>(() => {
    const query = search.trim();
    const visibleKeySet = query ? new Set(visibleKeys) : null;
    const rows: FolderImportTreeRow[] = [];
    const append = (node: FolderImportNode, depth: number) => {
      const filteredFiles = visibleKeySet
        ? node.files.filter((file) => visibleKeySet.has(folderCandidateKey(file)))
        : node.files;
      const filteredChildren = visibleKeySet
        ? node.children.filter((child) =>
            (descendantKeysByNode.get(child.key) ?? []).some((key) => visibleKeySet.has(key)),
          )
        : node.children;
      if (visibleKeySet && filteredFiles.length === 0 && filteredChildren.length === 0) return;
      rows.push({ kind: "folder", node, depth });
      filteredChildren.forEach((child) => append(child, depth + 1));
      filteredFiles.forEach((candidate) => rows.push({ kind: "file", candidate, depth: depth + 1 }));
    };
    append(tree, 0);
    return rows;
  }, [descendantKeysByNode, search, tree, visibleKeys]);
  const firstRenderedRow = Math.max(
    0,
    Math.floor(treeScrollTop / FOLDER_IMPORT_ROW_HEIGHT) - FOLDER_IMPORT_ROW_OVERSCAN,
  );
  const lastRenderedRow = Math.min(
    visibleRows.length,
    firstRenderedRow + Math.ceil(500 / FOLDER_IMPORT_ROW_HEIGHT) + FOLDER_IMPORT_ROW_OVERSCAN * 2,
  );
  const renderedRows = visibleRows.slice(firstRenderedRow, lastRenderedRow);
  const leadingSpacerHeight = firstRenderedRow * FOLDER_IMPORT_ROW_HEIGHT;
  const trailingSpacerHeight = (visibleRows.length - lastRenderedRow) * FOLDER_IMPORT_ROW_HEIGHT;

  const selectedCandidates = candidates.filter((candidate) => selected.has(folderCandidateKey(candidate)));
  const selectionSummary = useMemo(
    () => summarizeImportSelection(candidates, selected),
    [candidates, selected],
  );
  const timingEstimate = useMemo(
    () => estimateImportTiming(
      selectionSummary.fileCount,
      selectionSummary.totalBytes,
      readImportTimingHistory(),
    ),
    [selectionSummary.fileCount, selectionSummary.totalBytes],
  );
  const visibleRootSummaries = rootsExpanded ? selectionSummary.roots : selectionSummary.roots.slice(0, 5);
  const modalTitle = (
    <Group gap="md" wrap="nowrap" style={{ width: "100%", minWidth: 0 }}>
      <Text size="lg" fw={500} truncate style={{ minWidth: 0, flex: 1 }}>
        Choose files to import
      </Text>
      <Group gap="xs" wrap="nowrap" ml="auto">
        <Button
          variant="default"
          leftSection={<IconArrowLeft size={15} />}
          disabled={loading}
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          loading={loading}
          disabled={selectedCandidates.length === 0}
          onClick={() => onConfirm(selectedCandidates)}
        >
          Continue with {selectedCandidates.length} file
          {selectedCandidates.length === 1 ? "" : "s"}
        </Button>
      </Group>
    </Group>
  );
  return (
    <Modal opened={opened} onClose={loading ? () => undefined : onClose} title={modalTitle} size="78rem">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Selected folders are expanded recursively. Use checkboxes to choose files and Preview to
          inspect them.
        </Text>
        {progress && <Paper withBorder p="xs">{progress}</Paper>}
        <Group justify="space-between">
          <TextInput
            placeholder="Search paths"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            onClick={() =>
              setSelected((current) => new Set([...current, ...visibleCandidates.map(folderCandidateKey)]))
            }
          >
            Select all
          </Button>
          <Button
            variant="default"
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current);
                visibleCandidates.forEach((candidate) => next.delete(folderCandidateKey(candidate)));
                return next;
              })
            }
          >
            Clear
          </Button>
        </Group>
        {selectionSummary.fileCount > 0 && (
          <Stack gap={"xs"}>
            {selectionSummary.isLarge ? (
              <Alert
                color="orange"
                icon={<IconAlertTriangle size={17} />}
                title={`Large import: ${selectionSummary.fileCount} files`}
              >
                <Text size="sm">
                  You are selecting {selectionSummary.fileCount} files ({formatImportBytes(selectionSummary.totalBytes)}) from {selectionSummary.roots.length} location{selectionSummary.roots.length === 1 ? "" : "s"}.
                  Make sure this is intentional before continuing.
                </Text>
              </Alert>
            ) : (
              <Text size="sm" c="dimmed">
                Selecting {selectionSummary.fileCount} file{selectionSummary.fileCount === 1 ? "" : "s"} ({formatImportBytes(selectionSummary.totalBytes)}) from {selectionSummary.roots.length} location{selectionSummary.roots.length === 1 ? "" : "s"}.
              </Text>
            )}
            <Group gap="xs" align="center">
              <IconInfoCircle size={15} aria-hidden="true" />
              <Text size="xs" c="dimmed">
                {timingEstimate
                  ? `Estimated time to register the cells: approximately ${timingEstimate.minimumLabel}–${timingEstimate.maximumLabel}. Scientific data preparation continues in the background afterward.`
                  : "The estimate appears after at least two successful local import samples."}
              </Text>
            </Group>
            <Stack gap={2} pl="sm">
              {visibleRootSummaries.map((root) => (
                <Group key={root.key} justify="space-between" gap="xs" wrap="nowrap">
                  <Tooltip label={root.path ?? root.label} disabled={!root.path}>
                    <Text size="xs" truncate style={{ flex: 1 }}>
                      {root.label}
                    </Text>
                  </Tooltip>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {root.fileCount} file{root.fileCount === 1 ? "" : "s"} · {formatImportBytes(root.totalBytes)}
                  </Text>
                </Group>
              ))}
              {selectionSummary.roots.length > 5 && (
                <Button
                  variant="subtle"
                  size="compact-xs"
                  onClick={() => setRootsExpanded((current) => !current)}
                  aria-expanded={rootsExpanded}
                >
                  {rootsExpanded ? "Show fewer locations" : `Show all ${selectionSummary.roots.length} locations`}
                </Button>
              )}
            </Stack>
          </Stack>
        )}
        <Group align="stretch" gap="sm" wrap="nowrap">
          <Paper withBorder p="xs" style={{ flex: 1, minWidth: 0 }}>
            <ScrollArea h={500} type="auto" onScrollPositionChange={({ y }) => setTreeScrollTop(y)}>
              <Stack gap={0}>
                <Box h={leadingSpacerHeight} aria-hidden="true" />
                {renderedRows.map((row) => {
                  if (row.kind === "folder") {
                    const nodeKeys = descendantKeysByNode.get(row.node.key) ?? [];
                    const selectedCount = selectedCountsByNode.get(row.node.key) ?? 0;
                    return (
                      <Group
                        key={`folder-${row.node.key || "root"}`}
                        gap="xs"
                        wrap="nowrap"
                        py={4}
                        px="xs"
                        ml={row.depth * 18}
                        style={{ cursor: "pointer", height: FOLDER_IMPORT_ROW_HEIGHT, boxSizing: "border-box" }}
                        onClick={() => toggleFolder(row.node)}
                      >
                        <Checkbox
                          checked={nodeKeys.length > 0 && selectedCount === nodeKeys.length}
                          indeterminate={selectedCount > 0 && selectedCount < nodeKeys.length}
                          readOnly
                          styles={{ input: { cursor: "pointer" } }}
                        />
                        <IconFolder size={17} color="var(--mantine-primary-color-6)" />
                        <Text size="sm" fw={600} truncate>
                          {row.node.name}
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                          {selectedCount}/{nodeKeys.length}
                        </Badge>
                      </Group>
                    );
                  }
                  const candidate = row.candidate;
                  const key = folderCandidateKey(candidate);
                  return (
                    <Group
                      key={key}
                      gap="xs"
                      wrap="nowrap"
                      py={4}
                      px="xs"
                      ml={row.depth * 18}
                      bg={selected.has(key) ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined}
                      style={{
                        cursor: "pointer",
                        borderRadius: 4,
                        height: FOLDER_IMPORT_ROW_HEIGHT,
                        boxSizing: "border-box",
                        outline:
                          focusedKey === key ? "1px solid var(--mantine-primary-color-4)" : undefined,
                      }}
                      onClick={(event) =>
                        toggleFile(candidate, event.shiftKey, event.ctrlKey || event.metaKey)
                      }
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        readOnly
                        styles={{ input: { cursor: "pointer" } }}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFile(candidate, event.shiftKey, event.ctrlKey || event.metaKey);
                        }}
                      />
                      <IconFile size={16} color="var(--mantine-color-dimmed)" />
                      <Text
                        size="sm"
                        truncate
                        style={{
                          flex: 1,
                          color: selected.has(key) ? "var(--mantine-color-text)" : undefined,
                        }}
                      >
                        {candidate.filename}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatBytes(candidate.size)}
                      </Text>
                      <Button
                        variant={focusedKey === key ? "light" : "default"}
                        size="compact-sm"
                        w={118}
                        leftSection={<IconEye size={15} />}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFocusedKey(key);
                        }}
                      >
                        {focusedKey === key ? "Previewing" : "Preview"}
                      </Button>
                    </Group>
                  );
                })}
                <Box h={trailingSpacerHeight} aria-hidden="true" />
              </Stack>
            </ScrollArea>
          </Paper>
          <Paper withBorder p="sm" w={360}>
            {!focusedCandidate ? (
              <Center h={476}>
                <Text size="sm" c="dimmed">
                  Select a file to preview it.
                </Text>
              </Center>
            ) : (
              <Stack gap="xs">
                <div>
                  <Text fw={700} size="sm" truncate>
                    {focusedCandidate.filename}
                  </Text>
                  <Tooltip label={focusedCandidate.path ?? focusedCandidate.relative_path}>
                    <Text size="xs" c="dimmed" truncate>
                      {focusedCandidate.path ?? focusedCandidate.relative_path}
                    </Text>
                  </Tooltip>
                  <Text size="xs" c="dimmed">
                    {formatBytes(focusedCandidate.size)}
                  </Text>
                </div>
                {previewQuery.isPending ? (
                  <Center h={390}>
                    <Stack align="center" gap="xs">
                      <Loader size="sm" />
                      <Text size="xs" c="dimmed">
                        Generating preview
                      </Text>
                    </Stack>
                  </Center>
                ) : previewQuery.isError ? (
                  <Alert color="orange">
                    {previewQuery.error instanceof Error
                      ? previewQuery.error.message
                      : "Preview could not be generated."}
                  </Alert>
                ) : previewQuery.data?.capacity_preview &&
                  previewQuery.data.capacity_preview.x.length > 0 ? (
                  <Plot
                    data={[
                      {
                        x: previewQuery.data.capacity_preview.x,
                        y: previewQuery.data.capacity_preview.y,
                        type: "scatter",
                        mode: "markers",
                        marker: { size: 4, color: "#12b886" },
                        hovertemplate: "Cycle %{x}<br>%{y:.4g} mAh<extra></extra>",
                      },
                    ]}
                    layout={{
                      height: 390,
                      margin: { l: 58, r: 12, t: 12, b: 48 },
                      xaxis: { title: { text: "Cycle" }, automargin: true },
                      yaxis: {
                        title: { text: previewQuery.data.capacity_preview.label },
                        automargin: true,
                      },
                      showlegend: false,
                      paper_bgcolor: "rgba(0,0,0,0)",
                      plot_bgcolor: "rgba(0,0,0,0)",
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: "100%" }}
                  />
                ) : (
                  <Alert color={previewQuery.data?.preview_error ? "orange" : "gray"}>
                    {previewQuery.data?.preview_error ??
                      "No capacity preview points were found in this file."}
                  </Alert>
                )}
              </Stack>
            )}
          </Paper>
        </Group>
      </Stack>
    </Modal>
  );
}

type ImportSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

function ImportFilesystemPickerModal({
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
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });
  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (browseQuery.data?.entries ?? []).filter(
      (entry) => !query || entry.name.toLocaleLowerCase().includes(query)
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

  const toggleEntry = (
    entry: ImportBrowseEntry,
    shiftKey: boolean,
    ctrlKey: boolean
  ) => {
    setSelected((current) => {
      const next = new Map(current);
      if (shiftKey && lastSelectedPath) {
        const from = visibleEntries.findIndex((item) => item.path === lastSelectedPath);
        const to = visibleEntries.findIndex((item) => item.path === entry.path);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(entry.path);
          visibleEntries.slice(start, end + 1).forEach((item) => {
            if (shouldSelect) next.set(item.path, item);
            else next.delete(item.path);
          });
          return next;
        }
      }
      if (!ctrlKey && !shiftKey) {
        if (next.has(entry.path)) next.delete(entry.path);
        else next.set(entry.path, entry);
        return next;
      }
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
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
  const setPinnedPaths = (paths: string[]) => pinnedMutation.mutate(paths);
  const togglePinned = (item: ImportQuickAccessItem) => {
    setPinnedPaths(
      item.pinned
        ? pinnedPaths.filter((path) => path !== item.path)
        : [...pinnedPaths, item.path]
    );
  };
  const movePinned = (path: string, direction: -1 | 1) => {
    const index = pinnedPaths.indexOf(path);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= pinnedPaths.length) return;
    const next = [...pinnedPaths];
    [next[index], next[target]] = [next[target], next[index]];
    setPinnedPaths(next);
  };
  const shortcutIcon = (item: ImportQuickAccessItem) => {
    if (item.label === "Home") return <IconHome size={16} />;
    if (item.label === "Desktop") return <IconDeviceDesktop size={16} />;
    if (item.label === "Downloads") return <IconDownload size={16} />;
    if (item.section === "recent") return <IconClock size={16} />;
    return <IconFolder size={16} />;
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Load cell files" size="68rem">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Select any combination of Neware files and folders. Double-click a folder to open it;
          checked folders are expanded recursively in the next step.
        </Text>
        <Group align="stretch" gap="md" wrap="nowrap">
          <Paper
            p="xs"
            w={235}
            style={{ borderRight: "1px solid var(--mantine-color-default-border)" }}
          >
            <ScrollArea h={590} type="auto">
              <Stack gap="md">
                {(["quick", "pinned", "recent"] as const).map((section) => {
                  const items = quickAccess.filter((item) => item.section === section);
                  if (items.length === 0) return null;
                  return (
                    <Stack key={section} gap={3}>
                      <Text size="xs" fw={700} c="dimmed">
                        {section === "quick"
                          ? "Quick access"
                          : section === "pinned"
                            ? "Pinned"
                            : "Recent"}
                      </Text>
                      {items.map((item) => {
                        const active = browseQuery.data?.current_path === item.path;
                        const pinIndex = pinnedPaths.indexOf(item.path);
                        return (
                          <Group
                            key={`${section}-${item.path}`}
                            gap={4}
                            wrap="nowrap"
                            px="xs"
                            py={6}
                            bg={active ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined}
                            style={{ borderRadius: 4, opacity: item.available ? 1 : 0.55 }}
                          >
                            <Button
                              variant="subtle"
                              color={active ? "var(--mantine-primary-color-6)" : undefined}
                              size="compact-sm"
                              leftSection={shortcutIcon(item)}
                              disabled={!item.available}
                              justify="flex-start"
                              style={{ flex: 1, minWidth: 0 }}
                              onClick={() => navigate(item.path)}
                            >
                              <Text size="sm" truncate>{item.label}</Text>
                            </Button>
                            {item.pinned && (
                              <>
                                <ActionIcon
                                  size="xs"
                                  variant="subtle"
                                  color="gray"
                                  disabled={pinIndex <= 0}
                                  aria-label={`Move ${item.label} up`}
                                  onClick={() => movePinned(item.path, -1)}
                                >
                                  <IconArrowUp size={12} />
                                </ActionIcon>
                                <ActionIcon
                                  size="xs"
                                  variant="subtle"
                                  color="gray"
                                  disabled={pinIndex < 0 || pinIndex >= pinnedPaths.length - 1}
                                  aria-label={`Move ${item.label} down`}
                                  onClick={() => movePinned(item.path, 1)}
                                >
                                  <IconArrowDown size={12} />
                                </ActionIcon>
                              </>
                            )}
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="gray"
                              aria-label={item.pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                              onClick={() => togglePinned(item)}
                            >
                              {item.pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
                            </ActionIcon>
                          </Group>
                        );
                      })}
                    </Stack>
                  );
                })}
                <Stack gap={3}>
                  <Text size="xs" fw={700} c="dimmed">This PC</Text>
                  {(browseQuery.data?.roots ?? []).map((root) => (
                    <Button
                      key={root.path}
                      variant="subtle"
                      color={browseQuery.data?.current_path === root.path ? "var(--mantine-primary-color-6)" : "dark"}
                      size="compact-sm"
                      leftSection={root.name === "Home" ? <IconHome size={15} /> : <IconFolder size={15} />}
                      justify="flex-start"
                      onClick={() => navigate(root.path)}
                    >
                      {root.name}
                    </Button>
                  ))}
                </Stack>
              </Stack>
            </ScrollArea>
          </Paper>
          <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <ActionIcon
            variant="default"
            size="lg"
            aria-label="Go to parent folder"
            disabled={!browseQuery.data?.parent_path}
            onClick={() => navigate(browseQuery.data?.parent_path ?? null)}
          >
            <IconArrowUp size={18} />
          </ActionIcon>
          <TextInput
            value={pathInput}
            onChange={(event) => setPathInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pathInput.trim()) navigate(pathInput.trim());
            }}
            aria-label="Current folder path"
            style={{ flex: 1 }}
          />
          <ActionIcon
            variant="default"
            size="lg"
            aria-label="Refresh folder"
            onClick={() => void browseQuery.refetch()}
          >
            <IconRefresh size={17} />
          </ActionIcon>
        </Group>
        <Group gap="xs">
          <TextInput
            placeholder="Search this folder"
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            onClick={() =>
              setSelected((current) => {
                const next = new Map(current);
                const shouldSelect = !allVisibleSelected;
                visibleEntries.forEach((entry) => {
                  if (shouldSelect) next.set(entry.path, entry);
                  else next.delete(entry.path);
                });
                return next;
              })
            }
          >
            {allVisibleSelected ? "Clear shown" : "Select shown"}
          </Button>
        </Group>
        <Paper withBorder p={0}>
          {browseQuery.isPending ? (
            <Center h={390}>
              <Loader />
            </Center>
          ) : browseQuery.isError ? (
            <Center h={390} px="lg">
              <Alert color="red" w="100%">
                {browseQuery.error instanceof Error
                  ? browseQuery.error.message
                  : "This folder could not be opened."}
              </Alert>
            </Center>
          ) : (
            <ScrollArea h={390} type="auto">
              <Stack gap={0}>
                <Group
                  gap="xs"
                  wrap="nowrap"
                  px="sm"
                  py={8}
                  bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                  style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
                >
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected && !allVisibleSelected}
                    readOnly
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Map(current);
                        visibleEntries.forEach((entry) => {
                          if (allVisibleSelected) next.delete(entry.path);
                          else next.set(entry.path, entry);
                        });
                        return next;
                      })
                    }
                  />
                  <Text size="xs" fw={700} style={{ flex: 1 }}>
                    Name
                  </Text>
                  <Text size="xs" fw={700} w={90} ta="right">
                    Size
                  </Text>
                  <Text size="xs" fw={700} w={145}>
                    Modified
                  </Text>
                </Group>
                {visibleEntries.length === 0 ? (
                  <Center h={300}>
                    <Text size="sm" c="dimmed">
                      No folders or Neware files here.
                    </Text>
                  </Center>
                ) : (
                  visibleEntries.map((entry) => (
                    <Group
                      key={entry.path}
                      gap="xs"
                      wrap="nowrap"
                      px="sm"
                      py={7}
                      bg={selected.has(entry.path) ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined}
                      style={{
                        cursor: "pointer",
                        borderBottom: "1px solid var(--mantine-color-default-border)",
                      }}
                      onClick={(event) =>
                        toggleEntry(entry, event.shiftKey, event.ctrlKey || event.metaKey)
                      }
                      onDoubleClick={() => {
                        if (entry.kind === "folder") navigate(entry.path);
                      }}
                    >
                      <Checkbox checked={selected.has(entry.path)} readOnly />
                      {entry.kind === "folder" ? (
                        <IconFolder size={17} color="var(--mantine-primary-color-6)" />
                      ) : (
                        <IconFile size={17} color="var(--mantine-color-dimmed)" />
                      )}
                      <Text size="sm" truncate style={{ flex: 1 }}>
                        {entry.name}
                      </Text>
                      <Text size="xs" c="dimmed" w={90} ta="right">
                        {entry.size === null ? "" : formatBytes(entry.size)}
                      </Text>
                      <Text size="xs" c="dimmed" w={145}>
                        {entry.modified_at
                          ? new Date(entry.modified_at).toLocaleString()
                          : ""}
                      </Text>
                      {entry.kind === "folder" && (
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Open ${entry.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(entry.path);
                          }}
                        >
                          <IconChevronRight size={16} />
                        </ActionIcon>
                      )}
                    </Group>
                  ))
                )}
              </Stack>
            </ScrollArea>
          )}
        </Paper>
        {selectedEntries.length > 0 && (
          <Paper withBorder p="xs">
            <Group justify="space-between" mb={4}>
              <Text size="xs" fw={700}>
                Selected sources
              </Text>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setSelected(new Map())}>
                Clear all
              </Button>
            </Group>
            <ScrollArea h={Math.min(96, selectedEntries.length * 28)} type="auto">
              <Stack gap={2}>
                {selectedEntries.map((entry) => (
                  <Group key={entry.path} gap="xs" wrap="nowrap">
                    {entry.kind === "folder" ? <IconFolder size={14} /> : <IconFile size={14} />}
                    <Text size="xs" truncate style={{ flex: 1 }}>
                      {entry.path}
                    </Text>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      aria-label={`Remove ${entry.name}`}
                      onClick={() =>
                        setSelected((current) => {
                          const next = new Map(current);
                          next.delete(entry.path);
                          return next;
                        })
                      }
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </Group>
                ))}
              </Stack>
            </ScrollArea>
          </Paper>
        )}
          </Stack>
        </Group>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {folderCount} folder{folderCount === 1 ? "" : "s"}
            {fileCount ? `, ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}
          </Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={loading}
              disabled={selectedEntries.length === 0}
              onClick={() =>
                onConfirm({
                  filePaths: selectedEntries
                    .filter((entry) => entry.kind === "file")
                    .map((entry) => entry.path),
                  folderPaths: selectedEntries
                    .filter((entry) => entry.kind === "folder")
                    .map((entry) => entry.path),
                })
              }
            >
              Continue
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function suggestedCellName(file: ImportPreview) {
  return file.barcode || file.remarks || file.filename.replace(/\.(nda|ndax)$/i, "");
}

function importDraft(file: ImportPreview): ImportDraft {
  return {
    ...file,
    cell_name: suggestedCellName(file),
    description: file.remarks || "",
    metadata: file.metadata,
    preview_state: { status: "idle" },
    preview_loading: false,
    active_mass_mg_override: null,
    nominal_capacity_mah_override: null,
    electrode_area_cm2_override: null,
    active_material_selection: "custom",
    active_material_preset_id: null,
    active_material_name: null,
    active_material_specific_capacity_mah_g: null,
    electrode_area_selection: "custom",
    electrode_area_preset_id: null,
    electrode_area_preset_name: null,
  };
}

function continuedCellDraftFrom(draft: ImportDraft | undefined): ContinuedCellDraft {
  return {
    cell_name: draft?.cell_name ?? "",
    description: draft?.description ?? "",
    metadata: draft?.metadata ?? {},
    active_mass_mg_override: draft?.active_mass_mg_override ?? null,
    nominal_capacity_mah_override: draft?.nominal_capacity_mah_override ?? null,
    electrode_area_cm2_override: draft?.electrode_area_cm2_override ?? null,
    active_material_selection: draft?.active_material_selection ?? "custom",
    active_material_preset_id: draft?.active_material_preset_id ?? null,
    active_material_name: draft?.active_material_name ?? null,
    active_material_specific_capacity_mah_g: draft?.active_material_specific_capacity_mah_g ?? null,
    electrode_area_selection: draft?.electrode_area_selection ?? "custom",
    electrode_area_preset_id: draft?.electrode_area_preset_id ?? null,
    electrode_area_preset_name: draft?.electrode_area_preset_name ?? null,
    source_metadata: draft ?? null,
  };
}

function appendUniqueDrafts(current: ImportDraft[], files: ImportPreview[]): ImportDraft[] {
  const hashes = new Set(current.map((draft) => draft.hash.toLowerCase()).filter(Boolean));
  const paths = new Set(
    current
      .map((draft) => draft.source_path?.trim().toLowerCase())
      .filter((path): path is string => Boolean(path))
  );
  const added: ImportDraft[] = [];
  for (const file of files) {
    const hash = file.hash.toLowerCase();
    const path = file.source_path?.trim().toLowerCase() ?? null;
    if ((hash && hashes.has(hash)) || (path && paths.has(path))) continue;
    added.push(importDraft(file));
    if (hash) hashes.add(hash);
    if (path) paths.add(path);
  }
  return added;
}

const RAW_PAGE_SIZE = 100;

function combinedMetadata(draft: ImportDraft) {
  return {
    ...draft.raw_metadata,
    ...draft.metadata,
  };
}

function findFolderName(nodes: Tree["folders"], id: number | null): string | null {
  if (id === null) return null;
  for (const node of nodes) {
    if (node.id === id) return node.name;
    const child = findFolderName(node.children, id);
    if (child) return child;
  }
  return null;
}

function folderOptions(nodes: Tree["folders"], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((node) => [
    { value: String(node.id), label: `${"  ".repeat(depth)}${node.name}` },
    ...folderOptions(node.children, depth + 1),
  ]);
}

function ImportModal({
  drafts,
  active,
  opened,
  onActive,
  onChange,
  onClose,
  onAddMoreSources,
  onRemoveSource,
  onRemoveSources,
  onPreviewRequested,
  addingMore,
  onSaved,
  targetFolderId,
  blockingInspectionSeconds,
}: {
  drafts: ImportDraft[];
  active: number;
  opened: boolean;
  onActive: (index: number) => void;
  onChange: (index: number, draft: ImportDraft) => void;
  onClose: () => void;
  onAddMoreSources: () => void;
  onRemoveSource: (stagedName: string) => void;
  onRemoveSources: (stagedNames: string[]) => void;
  onPreviewRequested: (draft: ImportPreviewDraftState, retry?: boolean) => void;
  addingMore: boolean;
  onSaved: () => void;
  targetFolderId: number | null;
  blockingInspectionSeconds: number;
}) {
  const qc = useQueryClient();
  const draft = drafts[active];
  const [rawOpen, setRawOpen] = useState(false);
  const [rawData, setRawData] = useState<ImportRawDataResult | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [destinationFolders, setDestinationFolders] = useState<string[]>(
    targetFolderId === null ? [] : [String(targetFolderId)]
  );
  const [selectedStagedNames, setSelectedStagedNames] = useState<Set<string>>(new Set());
  const [replicateGroups, setReplicateGroups] = useState<ImportReplicateDraft[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [continuedMode, setContinuedMode] = useState(false);
  const [registerToken, setRegisterToken] = useState<string | null>(null);
  const registerStartedAt = useRef<number | null>(null);
  const [continuedCellDraft, setContinuedCellDraft] = useState<ContinuedCellDraft>(() => continuedCellDraftFrom(drafts[0]));
  const treeQuery = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const areaPresetsQuery = useQuery({
    queryKey: ["electrode-area-presets"],
    queryFn: () =>
      get<ElectrodeAreaPresetSettings>("/api/settings/electrode-area-presets"),
  });
  const materialPresetsQuery = useQuery({
    queryKey: ["active-material-presets"],
    queryFn: () =>
      get<ActiveMaterialPresetSettings>("/api/settings/active-material-presets"),
  });
  const folderSelectData = useMemo(() => folderOptions(treeQuery.data?.folders ?? []), [treeQuery.data]);
  const areaPresetData = useMemo(
    () =>
      (areaPresetsQuery.data?.presets ?? []).map((preset) => ({
        value: preset.id,
        label: `${preset.name} (${preset.area_cm2} cm²)`,
      })),
    [areaPresetsQuery.data]
  );
  const materialPresetData = useMemo(
    () => [
      { value: "custom", label: "Custom nominal capacity" },
      ...(materialPresetsQuery.data?.presets ?? []).map((preset) => ({
        value: preset.id,
        label: `${preset.name} (${preset.specific_capacity_mah_g} mAh/g)`,
      })),
    ],
    [materialPresetsQuery.data]
  );

  useEffect(() => {
    if (opened) {
      setDestinationFolders(targetFolderId === null ? [] : [String(targetFolderId)]);
      setSelectedStagedNames(new Set());
      setReplicateGroups([]);
      setNewGroupName(drafts.length > 1 ? `${drafts[0]?.cell_name ?? "Imported"} replicates` : "");
      setContinuedMode(false);
      setContinuedCellDraft(continuedCellDraftFrom(drafts[0]));
    }
  }, [opened, targetFolderId]);

  useEffect(() => {
    if (
      !opened
      || continuedMode
      || !draft
      || isRegisteredExactDuplicate(draft)
      || draft.preview_state.status !== "idle"
    ) {
      return;
    }
    onPreviewRequested(draft);
  }, [opened, continuedMode, draft?.staged_name, draft?.preview_state.status, onPreviewRequested]);

  const loadRawData = (offset = 0, targetDraft = draft) => {
    if (!targetDraft) return;
    setRawOpen(true);
    setRawLoading(true);
    setRawError(null);
    addDebugEvent("import:rawDataRequested", {
      staged_name: targetDraft.staged_name,
      filename: targetDraft.filename,
      offset,
      limit: RAW_PAGE_SIZE,
    });
    post<ImportRawDataResult>("/api/imports/raw-data", {
      staged_name: targetDraft.staged_name,
      source_path: targetDraft.source_path,
      offset,
      limit: RAW_PAGE_SIZE,
    })
      .then((result) => {
        addDebugEvent("import:rawDataReady", {
          staged_name: targetDraft.staged_name,
          columns: result.columns.length,
          rows: result.rows.length,
          total_rows: result.total_rows,
          offset: result.offset,
        });
        setRawData(result);
      })
      .catch((error: Error) => {
        addDebugEvent("import:rawDataFailed", {
          staged_name: targetDraft.staged_name,
          error: error.message,
        });
        setRawError(error.message);
      })
      .finally(() => setRawLoading(false));
  };

  const handleClose = () => {
    setRawOpen(false);
    onClose();
  };

  const removeSource = (stagedName: string) => {
    const next = removeStagedDraft(drafts, replicateGroups, active, stagedName);
    setReplicateGroups(next.groups);
    onRemoveSource(stagedName);
  };

  const selectedNames = useMemo(() => Array.from(selectedStagedNames), [selectedStagedNames]);
  const stagedNameToDraft = useMemo(
    () => new Map(drafts.map((item) => [item.staged_name, item])),
    [drafts]
  );
  const stagedNameToGroups = useMemo(() => {
    const map = new Map<string, ImportReplicateDraft[]>();
    replicateGroups.forEach((group) => {
      group.staged_names.forEach((stagedName) => {
        const rows = map.get(stagedName) ?? [];
        rows.push(group);
        map.set(stagedName, rows);
      });
    });
    return map;
  }, [replicateGroups]);

  const includedDrafts = useMemo(() => includedSeparateCellDrafts(drafts), [drafts]);
  const duplicateCount = exactDuplicateCount(drafts);
  const removeAllDuplicates = () => {
    const next = removeAllRegisteredDuplicates(drafts, replicateGroups, active);
    setReplicateGroups(next.groups);
    onRemoveSources(drafts.filter(isRegisteredExactDuplicate).map((item) => item.staged_name));
  };

  const createGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    setReplicateGroups((current) => [
      ...current,
      {
        id: `rep-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        description: "",
        staged_names: [],
      },
    ]);
    setNewGroupName("");
  };

  const assignToGroup = (groupId: string, stagedNames = selectedNames) => {
    const uniqueNames = Array.from(new Set(stagedNames));
    if (!uniqueNames.length) return;
    setReplicateGroups((current) =>
      current.map((group) => ({
        ...group,
        staged_names:
          group.id === groupId
            ? Array.from(new Set([...group.staged_names.filter((name) => !uniqueNames.includes(name)), ...uniqueNames]))
            : group.staged_names.filter((name) => !uniqueNames.includes(name)),
      }))
    );
    setSelectedStagedNames(new Set());
  };

  const removeFromGroup = (groupId: string, stagedName: string) => {
    setReplicateGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? { ...group, staged_names: group.staged_names.filter((name) => name !== stagedName) }
          : group
      )
    );
  };

  const toggleSelectedStagedName = (stagedName: string) => {
    setSelectedStagedNames((current) => {
      const next = new Set(current);
      if (next.has(stagedName)) next.delete(stagedName);
      else next.add(stagedName);
      return next;
    });
  };

  const handleFileDragStart = (
    event: DragEvent<HTMLDivElement>,
    stagedName: string
  ) => {
    const names = selectedStagedNames.has(stagedName) ? selectedNames : [stagedName];
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-cellxplorer-import-files", JSON.stringify(names));
  };

  const handleDropOnGroup = (event: DragEvent<HTMLDivElement>, groupId: string) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/x-cellxplorer-import-files");
    if (!raw) return;
    assignToGroup(groupId, JSON.parse(raw) as string[]);
  };

  const updateGroup = (groupId: string, patch: Partial<ImportReplicateDraft>) => {
    setReplicateGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, ...patch } : group))
    );
  };

  const save = useMutation({
    mutationFn: (variables: {
      mode: "separate" | "continued";
      order?: string[];
      acknowledgedFindingIds?: string[];
      continuedCellDraft?: ContinuedCellDraft;
      jobToken: string;
    }) => {
      return post<{
        created: { cell_id: number; cell_name: string }[];
        replicate_group?: { id: number; name: string; cell_ids: number[] } | null;
        replicate_groups?: { id: number; name: string; cell_ids: number[] }[];
        parsing_started?: boolean;
        cache_jobs?: {
          queued: boolean;
          count: number;
          job_id: number | null;
          status: "ready" | "running" | "completed" | "failed" | string;
        } | null;
      }>("/api/imports/cells", {
        job_token: variables.jobToken,
        folder_ids: destinationFolders.map(Number),
        replicate_groups: variables.mode === "continued" ? [] : outgoingGroups
          .filter((group) => group.name.trim() && group.staged_names.length > 0)
          .map((group) => ({
            name: group.name.trim(),
            description: group.description.trim() || null,
            staged_names: group.staged_names,
          })),
        cells: variables.mode === "continued"
          ? [{
              sources: (variables.order ?? drafts.map((item) => item.staged_name))
                .map((stagedName) => drafts.find((item) => item.staged_name === stagedName))
                .filter((item): item is ImportDraft => Boolean(item))
                .map((item) => ({
                  staged_name: item.staged_name,
                  source_path: item.source_path,
                  filename: item.filename,
                  inspection: item.inspection,
                })),
              cell_name: variables.continuedCellDraft?.cell_name ?? "",
              description: variables.continuedCellDraft?.description || null,
              metadata: variables.continuedCellDraft?.metadata,
              active_mass_mg_override: variables.continuedCellDraft?.active_mass_mg_override,
              nominal_capacity_mah_override: variables.continuedCellDraft?.nominal_capacity_mah_override,
              electrode_area_cm2_override: variables.continuedCellDraft?.electrode_area_cm2_override,
              active_material_preset_id: variables.continuedCellDraft?.active_material_preset_id,
              active_material_name: variables.continuedCellDraft?.active_material_name,
              active_material_specific_capacity_mah_g:
                variables.continuedCellDraft?.active_material_specific_capacity_mah_g,
              electrode_area_preset_id: variables.continuedCellDraft?.electrode_area_preset_id,
              electrode_area_preset_name: variables.continuedCellDraft?.electrode_area_preset_name,
              acknowledged_finding_ids: variables.acknowledgedFindingIds ?? [],
            }]
          : includedDrafts.map((d) => ({
          staged_name: d.staged_name,
          source_path: d.source_path,
          filename: d.filename,
          inspection: d.inspection,
          cell_name: d.cell_name,
          description: d.description || null,
          metadata: d.metadata,
          active_mass_mg_override: d.active_mass_mg_override,
          nominal_capacity_mah_override: d.nominal_capacity_mah_override,
          electrode_area_cm2_override: d.electrode_area_cm2_override,
          active_material_preset_id: d.active_material_preset_id,
          active_material_name: d.active_material_name,
          active_material_specific_capacity_mah_g:
            d.active_material_specific_capacity_mah_g,
          electrode_area_preset_id: d.electrode_area_preset_id,
          electrode_area_preset_name: d.electrode_area_preset_name,
        })),
      });
    },
    onSuccess: (result, variables) => {
      recordImportTimingSample({
        recordedAt: new Date().toISOString(),
        fileCount: variables.mode === "continued" ? drafts.length : includedDrafts.length,
        totalBytes: drafts.reduce((total, item) => total + Math.max(0, item.size), 0),
        blockingSeconds: blockingInspectionSeconds + Math.max(
          0,
          (Date.now() - (registerStartedAt.current ?? Date.now())) / 1000,
        ),
      });
      setRegisterToken(null);
      const importedCount = result.created.length;
      const importedLabel = `${importedCount} cell${importedCount === 1 ? "" : "s"} imported`;
      notifications.show({
        message: result.cache_jobs?.queued
          ? `${importedLabel}. Cycling data are being prepared in the background.`
          : `${importedLabel} and ready.`,
        color: "teal",
      });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      onSaved();
    },
    onError: (e: Error, variables) => {
      if (variables?.mode === "continued") {
        void qc.invalidateQueries({ queryKey: ["continued-import-inspection"] });
      }
      notifications.show({ message: e.message, color: "red" });
    },
  });
  const registerProgress = useImportJobProgress(registerToken, Boolean(registerToken));

  const groupNames = replicateGroups.map((group) => group.name.trim()).filter(Boolean);
  const duplicateGroupName = new Set(groupNames).size !== groupNames.length;
  const outgoingGroups = cleanupStagedReplicateGroups(
    replicateGroups,
    new Set(includedDrafts.map((item) => item.staged_name)),
  );
  const invalidGroups = outgoingGroups.filter(
    (group) => group.name.trim() && group.staged_names.length > 0 && group.staged_names.length < 2
  );
  const canSave =
    includedDrafts.length > 0 &&
    includedDrafts.every((d) => d.cell_name.trim()) &&
    includedDrafts.every(
      (d) =>
        d.active_material_selection === "custom" ||
        Boolean(
          (d.active_mass_mg_override ?? d.active_mass_mg) &&
            d.nominal_capacity_mah_override
        )
    ) &&
    !duplicateGroupName &&
    invalidGroups.length === 0;
  const rawRangeStart = rawData && rawData.total_rows > 0 ? rawData.offset + 1 : 0;
  const rawRangeEnd = rawData
    ? Math.min(rawData.offset + rawData.rows.length, rawData.total_rows)
    : 0;
  const metadataRows = draft ? Object.entries(combinedMetadata(draft)) : [];

  return (
    <>
      <Modal opened={opened} onClose={save.isPending ? () => undefined : handleClose} title="Import cells" size="95rem">
        {registerToken && (
          <Paper withBorder mb="sm" p="xs">
            <ImportProgressPanel
              stage="register"
              job={registerProgress.data}
              error={save.isError && save.error instanceof Error ? save.error.message : null}
            />
          </Paper>
        )}
        {draft && (
          <Stack gap="md">
            {drafts.length >= 2 && (
              <SegmentedControl
                fullWidth
                value={continuedMode ? "continued" : "separate"}
                onChange={(value) => {
                  const nextMode = value === "continued";
                  setContinuedMode(nextMode);
                  if (nextMode) onActive(0);
                }}
                data={[
                  { value: "separate", label: "Separate cells" },
                  { value: "continued", label: "One continued cell" },
                ]}
              />
            )}
            {continuedMode ? (
              <ContinuedImportEditor
                opened={opened}
                drafts={drafts}
                cellDraft={continuedCellDraft}
                onCellDraftChange={setContinuedCellDraft}
                onAddMoreSources={onAddMoreSources}
                onRemoveSource={removeSource}
                onSwitchToSeparate={() => setContinuedMode(false)}
                addingMore={addingMore || save.isPending}
                destinationFolders={destinationFolders}
                onDestinationFoldersChange={setDestinationFolders}
                folderSelectData={folderSelectData}
                materialPresets={materialPresetsQuery.data?.presets ?? []}
                areaPresets={areaPresetsQuery.data?.presets ?? []}
                onImport={(order, acknowledgedFindingIds) => {
                  const jobToken = newImportJobToken();
                  registerStartedAt.current = Date.now();
                  setRegisterToken(jobToken);
                  save.mutate({
                    mode: "continued",
                    order,
                    acknowledgedFindingIds,
                    continuedCellDraft,
                    jobToken,
                  });
                }}
                onRawData={(stagedName) => {
                  const targetIndex = drafts.findIndex((item) => item.staged_name === stagedName);
                  const target = targetIndex >= 0 ? drafts[targetIndex] : undefined;
                  if (!target) return;
                  onActive(targetIndex);
                  loadRawData(0, target);
                }}
                onPreviewRequested={onPreviewRequested}
                importing={save.isPending}
              />
            ) : (
            <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                Review {drafts.length} selected file{drafts.length === 1 ? "" : "s"} before saving.
              </Text>
              <Group gap="xs">
                <Button
                  variant="subtle"
                  color="red"
                  disabled={duplicateCount === 0 || save.isPending}
                  onClick={removeAllDuplicates}
                >
                  Remove all already imported
                </Button>
                <Button
                  variant="default"
                  leftSection={<IconPlus size={16} />}
                  loading={addingMore || save.isPending}
                  disabled={save.isPending}
                  onClick={onAddMoreSources}
                >
                  Add more sources
                </Button>
                <MultiSelect
                  w={320}
                  size="xs"
                  placeholder="No folder"
                  data={folderSelectData}
                  value={destinationFolders}
                  onChange={setDestinationFolders}
                  clearable
                  searchable
                />
                <Button variant="default" disabled={save.isPending} onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  disabled={!canSave}
                  loading={save.isPending}
                  onClick={() => {
                    const jobToken = newImportJobToken();
                    registerStartedAt.current = Date.now();
                    setRegisterToken(jobToken);
                    save.mutate({ mode: "separate", jobToken });
                  }}
                >
                  Import {includedDrafts.length} cell{includedDrafts.length === 1 ? "" : "s"}
                </Button>
              </Group>
            </Group>
            {duplicateCount > 0 && (
              <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
                {duplicateCount} already imported — will be skipped. They remain visible until removed.
                {includedDrafts.length === 0 && (
                  <Text size="sm" fw={600} mt={4}>
                    All selected files are already in the Cell Database.
                  </Text>
                )}
              </Alert>
            )}
            <Group align="stretch" gap="md" wrap="nowrap">
              <Paper withBorder p="xs" w={285}>
                <Stack gap="xs" h="100%">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={700}>
                      Replicates
                    </Text>
                    <Badge size="xs" variant="light">
                      {replicateGroups.length}
                    </Badge>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <TextInput
                      size="xs"
                      placeholder="Group name"
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") createGroup();
                      }}
                      style={{ flex: 1 }}
                    />
                    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createGroup}>
                      Group
                    </Button>
                  </Group>
                  <ScrollArea h={520} type="auto">
                    <Stack gap={8}>
                      {replicateGroups.map((group) => (
                        <Paper
                          key={group.id}
                          withBorder
                          p="xs"
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => handleDropOnGroup(event, group.id)}
                          style={{
                            borderColor: draft && group.staged_names.includes(draft.staged_name)
                              ? "var(--mantine-primary-color-5)"
                              : undefined,
                          }}
                        >
                          <Stack gap={6}>
                            <Group gap={6} wrap="nowrap">
                              <IconGripVertical size={15} color="var(--mantine-color-gray-5)" />
                              <TextInput
                                size="xs"
                                value={group.name}
                                onChange={(event) =>
                                  updateGroup(group.id, { name: event.currentTarget.value })
                                }
                                style={{ flex: 1 }}
                              />
                              <Badge size="xs" variant="light">
                                {group.staged_names.length}
                              </Badge>
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                color="red"
                                onClick={() =>
                                  setReplicateGroups((current) =>
                                    current.filter((item) => item.id !== group.id)
                                  )
                                }
                              >
                                <IconX size={13} />
                              </Button>
                            </Group>
                            <Button
                              size="xs"
                              variant="default"
                              leftSection={<IconArrowLeft size={14} />}
                              disabled={selectedNames.length === 0}
                              onClick={() => assignToGroup(group.id)}
                            >
                              Assign selected
                            </Button>
                            {group.staged_names.length ? (
                              <Stack gap={4}>
                                {group.staged_names.map((stagedName) => {
                                  const item = stagedNameToDraft.get(stagedName);
                                  if (!item) return null;
                                  return (
                                    <Group key={stagedName} gap={4} wrap="nowrap">
                                      <Text size="xs" truncate style={{ flex: 1 }}>
                                        {item.cell_name || item.filename}
                                      </Text>
                                      <Button
                                        size="compact-xs"
                                        variant="subtle"
                                        color="gray"
                                        onClick={() => removeFromGroup(group.id, stagedName)}
                                      >
                                        <IconX size={12} />
                                      </Button>
                                    </Group>
                                  );
                                })}
                              </Stack>
                            ) : (
                              <Paper withBorder p="xs" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                                <Text size="xs" c="dimmed" ta="center">
                                  Drop selected cells here
                                </Text>
                              </Paper>
                            )}
                          </Stack>
                        </Paper>
                      ))}
                      {replicateGroups.length === 0 && (
                        <Paper withBorder p="sm" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                          <Text size="xs" c="dimmed" ta="center">
                            Create a group, then assign selected cells.
                          </Text>
                        </Paper>
                      )}
                    </Stack>
                  </ScrollArea>
                </Stack>
              </Paper>

              <Paper withBorder p="xs" w={360}>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={700}>
                      Loaded files
                    </Text>
                    <Badge size="xs" variant="light">
                      {selectedNames.length} selected
                    </Badge>
                  </Group>
                  <ScrollArea h={520} type="auto">
                    <Stack gap={6}>
                        {drafts.map((item, index) => {
                          const groups = stagedNameToGroups.get(item.staged_name) ?? [];
                          const checked = selectedStagedNames.has(item.staged_name);
                          const duplicate = isRegisteredExactDuplicate(item);
                          const previewError = item.preview_state.status === "error"
                            ? item.preview_state.message
                            : null;
                          const stateLabel = previewError
                            ? "Preview failed"
                            : duplicate
                              ? "Already imported"
                              : item.import_match?.kind === "possible_update"
                                ? "Possible update"
                                : item.preview_state.status === "loading"
                                  ? "Loading preview"
                                  : item.preview_state.status === "idle"
                                    ? "Preview not loaded"
                                    : "Ready";
                        return (
                          <Paper
                            key={item.staged_name}
                            withBorder
                            p="sm"
                            draggable
                            onDragStart={(event) => handleFileDragStart(event, item.staged_name)}
                            style={{
                              cursor: "pointer",
                              borderColor:
                                index === active ? "var(--mantine-primary-color-5)" : undefined,
                              background: checked ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined,
                            }}
                            onClick={() => onActive(index)}
                          >
                            <Group align="start" wrap="nowrap">
                              <Checkbox
                                mt={2}
                                checked={checked}
                                onClick={(event) => event.stopPropagation()}
                                onChange={() => toggleSelectedStagedName(item.staged_name)}
                              />
                              <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
                                <Text size="sm" fw={index === active ? 700 : 500} truncate>
                                  {item.cell_name || item.filename}
                                </Text>
                                <Text size="xs" c="dimmed" truncate>
                                  {item.filename}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  {formatBytes(item.size)}
                                </Text>
                                <Group gap={4} wrap="nowrap">
                                  {previewError || duplicate || item.import_match?.kind === "possible_update" ? (
                                    <IconAlertTriangle size={13} color="var(--mantine-color-orange-7)" aria-hidden="true" />
                                  ) : null}
                                  <Text size="xs" c={duplicate ? "red" : previewError ? "orange" : "dimmed"}>
                                    {stateLabel}
                                  </Text>
                                </Group>
                                {groups.length > 0 && (
                                  <Group gap={4}>
                                    {groups.map((group) => (
                                      <Badge key={group.id} size="xs" color="var(--mantine-primary-color-6)" variant="light">
                                        {group.name}
                                      </Badge>
                                    ))}
                                  </Group>
                                )}
                              </Stack>
                              <Button
                                variant="subtle"
                                color="red"
                                size="compact-xs"
                                aria-label={`Remove ${item.filename} from import`}
                                disabled={save.isPending}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeSource(item.staged_name);
                                }}
                              >
                                <IconX size={14} />
                              </Button>
                            </Group>
                          </Paper>
                        );
                      })}
                    </Stack>
                  </ScrollArea>
                </Stack>
              </Paper>

              <Stack style={{ flex: 1, minWidth: 0 }} gap="md">
              <Group justify="space-between" align="start">
                <div>
                  <Text fw={700}>{draft.cell_name || draft.filename}</Text>
                  <Text size="xs" c="dimmed">
                    One selected file will become one cell.
                  </Text>
                </div>
                <Group gap="xs">
                  {draft.import_match && (
                    <Badge
                      color={
                        draft.import_match.kind === "exact_duplicate" && draft.import_match.registered
                          ? "red"
                          : "orange"
                      }
                      variant="light"
                    >
                      {draft.import_match.kind === "exact_duplicate" && draft.import_match.registered
                        ? "duplicate"
                        : draft.import_match.kind === "exact_duplicate"
                          ? "indexed"
                          : "possible update"}
                    </Badge>
                  )}
                  {draft.metadata_error && (
                    <Badge color="orange" variant="light">
                      metadata warning
                    </Badge>
                  )}
                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<IconTable size={14} />}
                    onClick={() => loadRawData(0)}
                  >
                    Raw data
                  </Button>
                </Group>
              </Group>

              <Paper withBorder p="sm" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))">
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    Source file
                  </Text>
                  <Text size="sm" fw={600}>
                    {draft.filename}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {draft.source_path
                      ? `Full path: ${draft.source_path}`
                      : `Temporary import path: ${draft.staged_name}`}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(draft.size)} - .{draft.ext}
                  </Text>
                </Stack>
              </Paper>

              <TextInput
                label="Cell name"
                value={draft.cell_name}
                onChange={(e) =>
                  onChange(active, { ...draft, cell_name: e.currentTarget.value })
                }
              />
              <Textarea
                label="Cell notes"
                autosize
                minRows={3}
                value={draft.description}
                onChange={(e) =>
                  onChange(active, { ...draft, description: e.currentTarget.value })
                }
              />

              <Divider label="Scientific values" labelPosition="left" />
              <Alert color="gray">
                Neware values remain preserved as source metadata. Enter an override only when the
                source value is incorrect or missing.
              </Alert>
              <Group grow align="start">
                <NumberInput
                  label="Active material mass (mg)"
                  description={
                    draft.active_mass_mg === null
                      ? "No source value detected"
                      : `Source value: ${draft.active_mass_mg} mg`
                  }
                  min={0.000001}
                  decimalScale={6}
                  value={draft.active_mass_mg_override ?? ""}
                  placeholder={draft.active_mass_mg?.toString() ?? "Custom value"}
                  error={
                    draft.active_material_selection !== "custom" &&
                    !(draft.active_mass_mg_override ?? draft.active_mass_mg)
                      ? "Enter a mass to calculate nominal capacity"
                      : undefined
                  }
                  onChange={(value) =>
                    {
                      const mass = value === "" ? null : Number(value);
                      const specificCapacity =
                        draft.active_material_specific_capacity_mah_g;
                      onChange(active, {
                        ...draft,
                        active_mass_mg_override: mass,
                        nominal_capacity_mah_override:
                          draft.active_material_selection !== "custom" &&
                          specificCapacity
                            ? nominalCapacityFromMass(
                                mass ?? draft.active_mass_mg,
                                specificCapacity
                              )
                            : draft.nominal_capacity_mah_override,
                      });
                    }
                  }
                />
                <Select
                  label="Active material"
                  description="Preset specific capacity is used with the active material mass"
                  data={materialPresetData}
                  value={draft.active_material_selection}
                  searchable
                  onChange={(selection) => {
                    const nextSelection = selection ?? "custom";
                    if (nextSelection === "custom") {
                      onChange(active, {
                        ...draft,
                        active_material_selection: "custom",
                        active_material_preset_id: null,
                        active_material_name: null,
                        active_material_specific_capacity_mah_g: null,
                      });
                      return;
                    }
                    const preset = materialPresetsQuery.data?.presets.find(
                      (item) => item.id === nextSelection
                    );
                    if (!preset) return;
                    const mass = draft.active_mass_mg_override ?? draft.active_mass_mg;
                    onChange(active, {
                      ...draft,
                      active_material_selection: preset.id,
                      active_material_preset_id: preset.id,
                      active_material_name: preset.name,
                      active_material_specific_capacity_mah_g:
                        preset.specific_capacity_mah_g,
                      nominal_capacity_mah_override:
                        nominalCapacityFromMass(
                          mass,
                          preset.specific_capacity_mah_g
                        ),
                    });
                  }}
                />
              </Group>
              <NumberInput
                  label="Nominal capacity (mAh)"
                  description={
                    draft.active_material_selection === "custom"
                      ? draft.nominal_capacity_mah === null
                        ? "Custom value; no source value detected"
                        : `Custom value; source: ${draft.nominal_capacity_mah} mAh`
                      : "Calculated from active material mass × preset specific capacity"
                  }
                  min={0.000001}
                  decimalScale={6}
                  value={draft.nominal_capacity_mah_override ?? ""}
                  placeholder={draft.nominal_capacity_mah?.toString() ?? "Custom value"}
                  disabled={draft.active_material_selection !== "custom"}
                  onChange={(value) =>
                    onChange(active, {
                      ...draft,
                      nominal_capacity_mah_override:
                        value === "" ? null : Number(value),
                    })
                  }
                />
              <Group grow align="end">
                <Select
                  label="Electrode-area preset"
                  data={[{ value: "custom", label: "Custom" }, ...areaPresetData]}
                  value={draft.electrode_area_selection}
                  searchable
                  onChange={(presetId) => {
                    if (!presetId || presetId === "custom") {
                      onChange(active, {
                        ...draft,
                        electrode_area_selection: "custom",
                        electrode_area_preset_id: null,
                        electrode_area_preset_name: null,
                      });
                      return;
                    }
                    const preset = areaPresetsQuery.data?.presets.find(
                      (item) => item.id === presetId
                    );
                    if (preset) {
                      onChange(active, {
                        ...draft,
                        electrode_area_selection: preset.id,
                        electrode_area_preset_id: preset.id,
                        electrode_area_preset_name: preset.name,
                        electrode_area_cm2_override: preset.area_cm2,
                      });
                    }
                  }}
                />
                <NumberInput
                  label="Electrode area (cm²)"
                  description="Used for current-density calculations"
                  min={0.000001}
                  decimalScale={6}
                  value={draft.electrode_area_cm2_override ?? ""}
                  placeholder="Custom value"
                  disabled={draft.electrode_area_selection !== "custom"}
                  onChange={(value) =>
                    onChange(active, {
                      ...draft,
                      electrode_area_cm2_override:
                        value === "" ? null : Number(value),
                    })
                  }
                />
              </Group>

              {draft.import_match && (
                <Alert
                  color={
                    draft.import_match.kind === "exact_duplicate" && draft.import_match.registered
                      ? "red"
                      : "orange"
                  }
                  icon={<IconAlertTriangle size={16} />}
                >
                  {draft.import_match.kind === "exact_duplicate" ? (
                    <>
                      This file has the same checksum as{" "}
                      <strong>{draft.import_match.cell_name || draft.import_match.filename}</strong>
                      {draft.import_match.registered
                        ? " and is already registered in the library."
                        : " and already exists in the file index, but it is not registered to an active cell. Import can reuse it."}
                    </>
                  ) : (
                    <>
                      This file has a new checksum, but it resembles{" "}
                      <strong>{draft.import_match.cell_name || draft.import_match.filename}</strong>{" "}
                      by {draft.import_match.matched_on.join(", ")}. It may be an updated or
                      extended cycling file.
                    </>
                  )}
                </Alert>
              )}

              <Divider label="Quick preview" labelPosition="left" />
              {draft.preview_state.status === "loading" ? (
                <Paper withBorder p="xs" h={250}>
                  <Center h="100%">
                    <Stack align="center" gap="xs">
                      <Loader />
                      <Text size="sm" c="dimmed">
                        Generating capacity preview
                      </Text>
                    </Stack>
                  </Center>
                </Paper>
              ) : draft.preview_state.status === "error" ? (
                <Alert color="orange" title="Preview could not be generated">
                  <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
                    <Text size="sm">{draft.preview_state.message}</Text>
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconRefresh size={14} />}
                      onClick={() => onPreviewRequested(draft, true)}
                    >
                      Retry
                    </Button>
                  </Group>
                </Alert>
              ) : draft.preview_state.status === "ready" && draft.capacity_preview && draft.capacity_preview.x.length > 0 ? (
                <Paper withBorder p="xs">
                  <Plot
                    data={[
                      {
                        x: draft.capacity_preview.x,
                        y: draft.capacity_preview.y,
                        type: "scatter",
                        mode: "markers",
                        marker: { size: 5, color: "#12b886" },
                        name: draft.capacity_preview.label,
                      },
                    ]}
                    layout={{
                      height: 250,
                      margin: { l: 54, r: 16, t: 12, b: 42 },
                      xaxis: { title: { text: "Cycle" } },
                      yaxis: { title: { text: draft.capacity_preview.label } },
                      showlegend: false,
                      paper_bgcolor: "rgba(0,0,0,0)",
                      plot_bgcolor: "rgba(0,0,0,0)",
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: "100%" }}
                  />
                </Paper>
              ) : (
                <Alert color="gray">
                  {draft.preview_state.status === "idle"
                    ? "Preview is available when this source is active."
                    : "No capacity preview points were found in this file."}
                </Alert>
              )}

              <Divider label="File metadata" labelPosition="left" />
              <Button
                variant="subtle"
                size="xs"
                leftSection={
                  metadataOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
                }
                onClick={() => setMetadataOpen((current) => !current)}
              >
                {metadataOpen ? "Hide metadata" : `Show metadata (${metadataRows.length})`}
              </Button>
              <Collapse in={metadataOpen}>
                <Stack gap="xs">
                  <Text size="xs" c="dimmed">
                    Metadata detected in the Neware file is read-only in this import step.
                  </Text>
                  {metadataRows.length > 0 ? (
                    <Table withTableBorder>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th w="38%">Field</Table.Th>
                          <Table.Th>Value</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {metadataRows.map(([key, value]) => (
                          <Table.Tr key={key}>
                            <Table.Td>
                              <Text size="xs" c="dimmed">
                                {key}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs">{value}</Text>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  ) : (
                    <Alert color="gray">No metadata fields were detected.</Alert>
                  )}
                </Stack>
              </Collapse>
            </Stack>
            </Group>
            </Stack>
            )}
          </Stack>
        )}
      </Modal>

      <Modal
        opened={rawOpen}
        onClose={() => setRawOpen(false)}
        title={draft ? `Raw cycling data: ${draft.filename}` : "Raw cycling data"}
        size="95rem"
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {rawData
                ? `Rows ${rawRangeStart}-${rawRangeEnd} of ${rawData.total_rows} · ${rawData.columns.length} columns`
                : "Loading parsed cycling rows from the original file."}
            </Text>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                disabled={!rawData || rawData.offset <= 0 || rawLoading}
                onClick={() => rawData && loadRawData(Math.max(0, rawData.offset - rawData.limit))}
              >
                Previous
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={
                  !rawData ||
                  rawLoading ||
                  rawData.offset + rawData.limit >= rawData.total_rows
                }
                onClick={() => rawData && loadRawData(rawData.offset + rawData.limit)}
              >
                Next
              </Button>
            </Group>
          </Group>

          {rawLoading && !rawData ? (
            <Paper withBorder h={420}>
              <Center h="100%">
                <Stack align="center" gap="xs">
                  <Loader />
                  <Text size="sm" c="dimmed">
                    Loading raw data table
                  </Text>
                </Stack>
              </Center>
            </Paper>
          ) : rawError ? (
            <Alert color="red">{rawError}</Alert>
          ) : rawData ? (
            <Paper withBorder>
              <ScrollArea h={520} type="auto">
                <Table withColumnBorders striped highlightOnHover fz="xs">
                  <Table.Thead>
                    <Table.Tr>
                      {rawData.columns.map((column) => (
                        <Table.Th key={column} style={{ whiteSpace: "nowrap" }}>
                          {column}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rawData.rows.map((row, rowIndex) => (
                      <Table.Tr key={`${rawData.offset}-${rowIndex}`}>
                        {rawData.columns.map((column) => (
                          <Table.Td key={column} style={{ whiteSpace: "nowrap" }}>
                            {row[column] === null || row[column] === undefined
                              ? ""
                              : String(row[column])}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </Paper>
          ) : null}
        </Stack>
      </Modal>
    </>
  );
}

export function ImportCellsLauncher({
  targetFolderId,
  onSaved,
  children,
}: {
  targetFolderId: number | null;
  onSaved?: () => void;
  children: (state: {
    open: () => void;
    loading: boolean;
    selectedCount: number;
  }) => ReactNode;
}) {
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [active, setActive] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceAppend, setSourceAppend] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderRootName, setFolderRootName] = useState("Selected folder");
  const [folderCandidates, setFolderCandidates] = useState<FolderImportCandidate[]>([]);
  const [progressStage, setProgressStage] = useState<ImportProgressStage | null>(null);
  const [progressToken, setProgressToken] = useState<string | null>(null);
  const [blockingInspectionSeconds, setBlockingInspectionSeconds] = useState(0);
  const inspectionStartedAt = useRef<number | null>(null);
  const progressQuery = useImportJobProgress(progressToken, Boolean(progressStage));
  const loadPreview = useImportPreviewLoader(setDrafts);

  const hydrateInspection = (result: ImportInspectResult, append: boolean) => {
    const added = appendUniqueDrafts(append ? drafts : [], result.files);
    if (append && added.length === 0) {
      notifications.show({ message: "Those files are already loaded in this import.", color: "gray" });
      return;
    }
    setDrafts((current) => (append ? [...current, ...added] : added));
    if (!append) setActive(0);
    setModalOpen(added.length > 0 || (append && drafts.length > 0));
  };

  const inspectPaths = useMutation({
    mutationFn: ({ paths, append, jobToken }: { paths: string[]; append: boolean; jobToken: string }) =>
      post<ImportInspectResult>("/api/imports/inspect-paths", { paths, job_token: jobToken }).then((result) => ({
        result,
        append,
      })),
    onSuccess: ({ result, append }) => {
      setBlockingInspectionSeconds((current) => current + Math.max(
        0,
        (Date.now() - (inspectionStartedAt.current ?? Date.now())) / 1000,
      ));
      setProgressStage(null);
      setProgressToken(null);
      setFolderModalOpen(false);
      hydrateInspection(result, append);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const listSources = useMutation({
    mutationFn: ({
      filePaths,
      folderPaths,
      append,
      jobToken,
    }: {
      filePaths: string[];
      folderPaths: string[];
      append: boolean;
      jobToken: string;
    }) =>
      post<ImportFolderSelectionResult>("/api/imports/list-sources", {
        file_paths: filePaths,
        folder_paths: folderPaths,
        job_token: jobToken,
      }).then((result) => ({ result, append })),
    onSuccess: ({ result, append }) => {
      setProgressStage(null);
      setProgressToken(null);
      const candidates = result.files;
      if (candidates.length === 0) {
        notifications.show({ message: "No .nda or .ndax files were found.", color: "gray" });
        return;
      }
      setSourceAppend(append);
      setFolderRootName("Selected sources");
      setFolderCandidates(candidates);
      setSourcePickerOpen(false);
      setFolderModalOpen(true);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const startSourceSelection = (append: boolean) => {
    setSourceAppend(append);
    setProgressStage(null);
    setProgressToken(null);
    if (!append) {
      setBlockingInspectionSeconds(0);
    }
    setSourcePickerOpen(true);
  };

  const continueSourceSelection = ({ filePaths, folderPaths }: ImportSourceSelection) => {
    const jobToken = newImportJobToken();
    setProgressStage("scan");
    setProgressToken(jobToken);
    listSources.mutate({ filePaths, folderPaths, append: sourceAppend, jobToken });
  };

  const confirmFolderSelection = (selected: FolderImportCandidate[]) => {
    const jobToken = newImportJobToken();
    inspectionStartedAt.current = Date.now();
    setProgressStage("inspect");
    setProgressToken(jobToken);
    inspectPaths.mutate({
      paths: selected.map((candidate) => candidate.path).filter(Boolean) as string[],
      append: sourceAppend,
      jobToken,
    });
  };

  return (
    <>
      {children({
        open: () => startSourceSelection(false),
        loading: inspectPaths.isPending || listSources.isPending,
        selectedCount: drafts.length,
      })}
      <SharedImportFilesystemPickerModal
        opened={sourcePickerOpen}
        loading={listSources.isPending || inspectPaths.isPending}
        progress={progressStage === "scan" ? (
          <ImportProgressPanel
            stage="scan"
            job={progressQuery.data}
            error={listSources.isError && listSources.error instanceof Error ? listSources.error.message : null}
          />
        ) : undefined}
        onClose={() => setSourcePickerOpen(false)}
        onConfirm={continueSourceSelection}
      />
      <FolderImportSelectionModal
        opened={folderModalOpen}
        rootName={folderRootName}
        candidates={folderCandidates}
        loading={inspectPaths.isPending}
        progress={progressStage === "inspect" ? (
          <ImportProgressPanel
            stage="inspect"
            job={progressQuery.data}
            error={inspectPaths.isError && inspectPaths.error instanceof Error ? inspectPaths.error.message : null}
          />
        ) : undefined}
        onBack={() => {
          setFolderModalOpen(false);
          setSourcePickerOpen(true);
        }}
        onClose={() => setFolderModalOpen(false)}
        onConfirm={confirmFolderSelection}
      />
      <ImportModal
        drafts={drafts}
        active={active}
        opened={modalOpen}
        targetFolderId={targetFolderId}
        blockingInspectionSeconds={blockingInspectionSeconds}
        onActive={setActive}
        onPreviewRequested={loadPreview}
        onChange={(index, draft) =>
          setDrafts((current) => current.map((item, i) => (i === index ? draft : item)))
        }
        onAddMoreSources={() => startSourceSelection(true)}
        onRemoveSource={(stagedName) => {
          const next = removeStagedDraft(drafts, [], active, stagedName);
          setDrafts(next.drafts);
          setActive(next.activeIndex ?? 0);
        }}
        onRemoveSources={(stagedNames) => {
          const names = new Set(stagedNames);
          setDrafts((current) => {
            const activeName = current[active]?.staged_name;
            const next = current.filter((item) => !names.has(item.staged_name));
            setActive((currentActive) => {
              if (!next.length) return 0;
              if (activeName) {
                const preservedIndex = next.findIndex((item) => item.staged_name === activeName);
                if (preservedIndex >= 0) return preservedIndex;
              }
              return Math.min(currentActive, next.length - 1);
            });
            return next;
          });
        }}
        addingMore={inspectPaths.isPending || listSources.isPending}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          setDrafts([]);
          onSaved?.();
        }}
      />
    </>
  );
}

export function InboxPage() {
  const [searchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [active, setActive] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceAppend, setSourceAppend] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderRootName, setFolderRootName] = useState("Selected folder");
  const [folderCandidates, setFolderCandidates] = useState<FolderImportCandidate[]>([]);
  const [progressStage, setProgressStage] = useState<ImportProgressStage | null>(null);
  const [progressToken, setProgressToken] = useState<string | null>(null);
  const [blockingInspectionSeconds, setBlockingInspectionSeconds] = useState(0);
  const inspectionStartedAt = useRef<number | null>(null);
  const progressQuery = useImportJobProgress(progressToken, Boolean(progressStage));
  const targetFolderId = searchParams.get("folder_id") ? Number(searchParams.get("folder_id")) : null;
  const treeQuery = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
    enabled: targetFolderId !== null,
  });

  const selectedCount = drafts.length;
  const detectedFields = useMemo(
    () => Array.from(new Set(drafts.flatMap((draft) => Object.keys(draft.metadata)))),
    [drafts]
  );
  const targetFolderName = findFolderName(treeQuery.data?.folders ?? [], targetFolderId);
  const loadPreview = useImportPreviewLoader(setDrafts);

  const hydrateInspection = (result: ImportInspectResult, append: boolean) => {
    const added = appendUniqueDrafts(append ? drafts : [], result.files);
    if (append && added.length === 0) {
      notifications.show({ message: "Those files are already loaded in this import.", color: "gray" });
      return;
    }
    setDrafts((current) => (append ? [...current, ...added] : added));
    if (!append) setActive(0);
    setModalOpen(added.length > 0 || (append && drafts.length > 0));
  };

  const inspectPaths = useMutation({
    mutationFn: ({ paths, append, jobToken }: { paths: string[]; append: boolean; jobToken: string }) =>
      post<ImportInspectResult>("/api/imports/inspect-paths", { paths, job_token: jobToken }).then((result) => ({
        result,
        append,
      })),
    onSuccess: ({ result, append }) => {
      setBlockingInspectionSeconds((current) => current + Math.max(
        0,
        (Date.now() - (inspectionStartedAt.current ?? Date.now())) / 1000,
      ));
      setProgressStage(null);
      setProgressToken(null);
      setFolderModalOpen(false);
      hydrateInspection(result, append);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const listSources = useMutation({
    mutationFn: ({
      filePaths,
      folderPaths,
      append,
      jobToken,
    }: {
      filePaths: string[];
      folderPaths: string[];
      append: boolean;
      jobToken: string;
    }) =>
      post<ImportFolderSelectionResult>("/api/imports/list-sources", {
        file_paths: filePaths,
        folder_paths: folderPaths,
        job_token: jobToken,
      }).then((result) => ({ result, append })),
    onSuccess: ({ result, append }) => {
      setProgressStage(null);
      setProgressToken(null);
      const candidates = result.files;
      if (candidates.length === 0) {
        notifications.show({ message: "No .nda or .ndax files were found.", color: "gray" });
        return;
      }
      setSourceAppend(append);
      setFolderRootName("Selected sources");
      setFolderCandidates(candidates);
      setSourcePickerOpen(false);
      setFolderModalOpen(true);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const startSourceSelection = (append: boolean) => {
    setSourceAppend(append);
    setProgressStage(null);
    setProgressToken(null);
    if (!append) {
      setBlockingInspectionSeconds(0);
    }
    setSourcePickerOpen(true);
  };

  const continueSourceSelection = ({ filePaths, folderPaths }: ImportSourceSelection) => {
    const jobToken = newImportJobToken();
    setProgressStage("scan");
    setProgressToken(jobToken);
    listSources.mutate({ filePaths, folderPaths, append: sourceAppend, jobToken });
  };

  const confirmFolderSelection = (selected: FolderImportCandidate[]) => {
    const jobToken = newImportJobToken();
    inspectionStartedAt.current = Date.now();
    setProgressStage("inspect");
    setProgressToken(jobToken);
    inspectPaths.mutate({
      paths: selected.map((candidate) => candidate.path).filter(Boolean) as string[],
      append: sourceAppend,
      jobToken,
    });
  };

  return (
    <Stack>
      <Group justify="space-between" align="end">
        <div>
          <Title order={3}>Import</Title>
          <Text size="sm" c="dimmed">
            Load Neware files and choose separate or continued-cell import.
          </Text>
        </div>
        <Button
          leftSection={<IconUpload size={16} />}
          loading={inspectPaths.isPending || listSources.isPending}
          onClick={() => startSourceSelection(false)}
        >
          Load cells
        </Button>
      </Group>

      <SharedImportFilesystemPickerModal
        opened={sourcePickerOpen}
        loading={listSources.isPending || inspectPaths.isPending}
        progress={progressStage === "scan" ? (
          <ImportProgressPanel
            stage="scan"
            job={progressQuery.data}
            error={listSources.isError && listSources.error instanceof Error ? listSources.error.message : null}
          />
        ) : undefined}
        onClose={() => setSourcePickerOpen(false)}
        onConfirm={continueSourceSelection}
      />
      <FolderImportSelectionModal
        opened={folderModalOpen}
        rootName={folderRootName}
        candidates={folderCandidates}
        loading={inspectPaths.isPending}
        progress={progressStage === "inspect" ? (
          <ImportProgressPanel
            stage="inspect"
            job={progressQuery.data}
            error={inspectPaths.isError && inspectPaths.error instanceof Error ? inspectPaths.error.message : null}
          />
        ) : undefined}
        onBack={() => {
          setFolderModalOpen(false);
          setSourcePickerOpen(true);
        }}
        onClose={() => setFolderModalOpen(false)}
        onConfirm={confirmFolderSelection}
      />

      {targetFolderId !== null && (
        <Alert color="var(--mantine-primary-color-6)">
          Import target: {targetFolderName ?? `folder #${targetFolderId}`}. Imported cells will be
          filed in this folder.
        </Alert>
      )}

      <Paper withBorder p="lg">
        <Group gap="lg" align="start">
          <IconFileImport size={34} color="var(--mantine-primary-color-6)" />
          <Stack gap={6}>
            <Text fw={700}>Start from Neware files</Text>
            <Text size="sm" c="dimmed" maw={720}>
              Select a single file or a batch. The next step lets you review detected metadata and
              choose whether the sources become separate cells or one ordered continued cell.
            </Text>
            {selectedCount > 0 && (
              <Text size="xs" c="dimmed">
                Last loaded batch: {selectedCount} file{selectedCount === 1 ? "" : "s"}
                {detectedFields.length ? ` · metadata: ${detectedFields.join(", ")}` : ""}
              </Text>
            )}
          </Stack>
        </Group>
      </Paper>

      <ImportModal
        drafts={drafts}
        active={active}
        opened={modalOpen}
        targetFolderId={targetFolderId}
        blockingInspectionSeconds={blockingInspectionSeconds}
        onActive={setActive}
        onPreviewRequested={loadPreview}
        onChange={(index, draft) =>
          setDrafts((current) => current.map((item, i) => (i === index ? draft : item)))
        }
        onAddMoreSources={() => startSourceSelection(true)}
        onRemoveSource={(stagedName) => {
          const next = removeStagedDraft(drafts, [], active, stagedName);
          setDrafts(next.drafts);
          setActive(next.activeIndex ?? 0);
        }}
        onRemoveSources={(stagedNames) => {
          const names = new Set(stagedNames);
          setDrafts((current) => {
            const activeName = current[active]?.staged_name;
            const next = current.filter((item) => !names.has(item.staged_name));
            setActive((currentActive) => {
              if (!next.length) return 0;
              if (activeName) {
                const preservedIndex = next.findIndex((item) => item.staged_name === activeName);
                if (preservedIndex >= 0) return preservedIndex;
              }
              return Math.min(currentActive, next.length - 1);
            });
            return next;
          });
        }}
        addingMore={inspectPaths.isPending || listSources.isPending}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          setDrafts([]);
        }}
      />
    </Stack>
  );
}
