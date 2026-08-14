import {
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
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconFileImport,
  IconFile,
  IconFolder,
  IconEye,
  IconGripVertical,
  IconInfoCircle,
  IconPlus,
  IconRefresh,
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
  ActiveMaterialPresetSettings,
  ElectrodeAreaPresetSettings,
  ImportFolderFile,
  ImportFolderSelectionResult,
  ImportPreview,
  ImportPreviewResult,
  ImportRawDataResult,
  BackgroundJob,
  get,
  post,
  Tree,
} from "../api";
import Plot from "../components/Plot";
import { ContinuedImportEditor, type ContinuedCellDraft } from "../components/ContinuedImportEditor";
import {
  ImportFilesystemPickerModal as SharedImportFilesystemPickerModal,
  type ImportSourceSelection,
} from "../components/ImportFilesystemPickerModal";
import {
  ImportInfoHint,
  ImportModalPrimaryActions,
  ImportModalShell,
} from "../components/ImportModalShell";
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
  importRegistrationUiState,
  newImportJobToken,
  type ImportProgressStage,
} from "../importProgress";
import { recordImportTimingSample } from "../importTiming";
import { defaultImportCellName, importNameConflicts } from "../importNamePolicy";
import { useImportJobProgress } from "../useImportJobProgress";
import {
  importPreviewQueryKey,
  importPreviewRequest,
  importPreviewStateFromResult,
  importDraftWindow,
  shouldRequestImportPreview,
  type ImportPreviewDraftState,
  type ImportPreviewState,
} from "../importPreviewPolicy";
import {
  importInspectionCandidateMatchesSearch,
  importInspectionFailurePathSet,
  importSelectableInspectionPaths,
  mergeImportInspectionFailures,
  type ImportInspectionFailure,
} from "../importInspectionPolicy";

export type ImportDraft = ImportPreview & {
  cell_name: string;
  description: string;
  metadata: Record<string, string>;
  preview_state: ImportPreviewState;
  preview_loading: boolean;
  metadata_only_acknowledged: boolean;
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
  const controllers = useRef(new Map<string, AbortController>());
  const ready = useRef(new Map<string, ImportPreviewResult>());
  const requestVersions = useRef(new Map<string, number>());
  const sessionVersion = useRef(0);

  const cancel = useCallback(() => {
    sessionVersion.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    inFlight.current.clear();
    ready.current.clear();
    requestVersions.current.clear();
  }, []);

  const load = useCallback((draft: ImportPreviewDraftState, retry = false) => {
    if (draft.metadata_only) return;
    const currentSession = sessionVersion.current;
    const previewKey = importPreviewQueryKey(draft.hash)[1];
    const version = (requestVersions.current.get(draft.staged_name) ?? 0) + 1;
    requestVersions.current.set(draft.staged_name, version);

    const apply = (state: ImportPreviewState) => {
      setDrafts((current) => current.map((item) => {
        if (
          currentSession !== sessionVersion.current
          ||
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
      const controller = new AbortController();
      addDebugEvent("import:previewRequested", {
        staged_name: draft.staged_name,
        filename: draft.filename,
        preview_key: previewKey,
      });
      request = post<ImportPreviewResult>(
        "/api/imports/preview",
        importPreviewRequest(draft),
        { signal: controller.signal },
      );
      controllers.current.set(previewKey, controller);
      inFlight.current.set(previewKey, request);
    }
    request
      .then((result) => {
        if (currentSession !== sessionVersion.current) return;
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
        if (currentSession !== sessionVersion.current) return;
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
          controllers.current.delete(previewKey);
        }
      });
  }, [setDrafts]);

  useEffect(() => cancel, [cancel]);
  return { load, cancel };
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
const IMPORT_DRAFT_ROW_HEIGHT = 104;
const IMPORT_DRAFT_ROW_OVERSCAN = 6;

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
  failures,
  loading,
  progress,
  onBack,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  rootName: string;
  candidates: FolderImportCandidate[];
  failures: ImportInspectionFailure[];
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
  const selectionSession = useRef<{
    opened: boolean;
    candidates: FolderImportCandidate[] | null;
  }>({ opened: false, candidates: null });
  const failedPathSet = useMemo(
    () => importInspectionFailurePathSet(failures),
    [failures],
  );
  const failureByPath = useMemo(
    () => new Map(failures.map((failure) => [failure.path.toLocaleLowerCase(), failure])),
    [failures],
  );
  const isFailed = useCallback(
    (candidate: FolderImportCandidate) => failedPathSet.has((candidate.path ?? "").toLocaleLowerCase()),
    [failedPathSet],
  );
  const tree = useMemo(() => buildImportFolderTree(rootName, candidates), [rootName, candidates]);
  const allDescendantKeysByNode = useMemo(() => {
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
  const descendantKeysByNode = useMemo(() => {
    const result = new Map<string, string[]>();
    const visit = (node: FolderImportNode): string[] => {
      const keys = [
        ...node.files.filter((candidate) => !isFailed(candidate)).map(folderCandidateKey),
        ...node.children.flatMap(visit),
      ];
      result.set(node.key, keys);
      return keys;
    };
    visit(tree);
    return result;
  }, [isFailed, tree]);
  const selectedCountsByNode = useMemo(() => {
    const result = new Map<string, number>();
    const visit = (node: FolderImportNode): number => {
      const selectedFiles = node.files.reduce(
        (count, candidate) => count + (!isFailed(candidate) && selected.has(folderCandidateKey(candidate)) ? 1 : 0),
        0,
      );
      const selectedChildren = node.children.reduce((count, child) => count + visit(child), 0);
      const count = selectedFiles + selectedChildren;
      result.set(node.key, count);
      return count;
    };
    visit(tree);
    return result;
  }, [isFailed, selected, tree]);
  const focusedCandidate =
    candidates.find((candidate) => folderCandidateKey(candidate) === focusedKey) ?? null;
  const previewQuery = useQuery({
    queryKey: ["folder-import-preview", focusedCandidate?.path],
    queryFn: ({ signal }) =>
      post<ImportPreviewResult>("/api/imports/preview", {
        staged_name: "folder-selection-preview",
        source_path: focusedCandidate?.path,
      }, { signal }),
    enabled: opened && Boolean(focusedCandidate?.path),
    staleTime: Infinity,
  });

  useEffect(() => {
    const newSelectionSession = opened && (
      !selectionSession.current.opened
      || selectionSession.current.candidates !== candidates
    );
    selectionSession.current = {
      opened,
      candidates: opened ? candidates : null,
    };
    if (!newSelectionSession) return;
    setSelected(new Set(candidates.filter((candidate) => !isFailed(candidate)).map(folderCandidateKey)));
    setSearch("");
    setLastSelected(null);
    setFocusedKey(null);
    setRootsExpanded(false);
    setTreeScrollTop(0);
  }, [candidates, isFailed, opened]);

  useEffect(() => {
    if (failures.length === 0) return;
    setSelected((current) => {
      const next = new Set(importSelectableInspectionPaths([...current], failures));
      return next.size === current.size ? current : next;
    });
  }, [failures]);

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
        : node.files.filter((candidate) =>
          importInspectionCandidateMatchesSearch(candidate.filename, candidate.relative_path, query),
        );
      return [
        ...node.children.flatMap((child) => collect(child, folderMatched)),
        ...files,
      ];
    };
    return collect(tree, false);
  }, [tree, search]);
  const visibleAllKeys = useMemo(
    () => visibleCandidates.map(folderCandidateKey),
    [visibleCandidates],
  );
  const visibleSelectableKeys = useMemo(
    () => visibleCandidates.filter((candidate) => !isFailed(candidate)).map(folderCandidateKey),
    [isFailed, visibleCandidates],
  );

  const toggleFile = (candidate: FolderImportCandidate, shiftKey: boolean, ctrlKey: boolean) => {
    const key = folderCandidateKey(candidate);
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelected) {
        const from = visibleSelectableKeys.indexOf(lastSelected);
        const to = visibleSelectableKeys.indexOf(key);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(key);
          visibleSelectableKeys.slice(start, end + 1).forEach((item) =>
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
    const visibleKeySet = query ? new Set(visibleAllKeys) : null;
    const rows: FolderImportTreeRow[] = [];
    const append = (node: FolderImportNode, depth: number) => {
      const filteredFiles = visibleKeySet
        ? node.files.filter((file) => visibleKeySet.has(folderCandidateKey(file)))
        : node.files;
      const filteredChildren = visibleKeySet
        ? node.children.filter((child) =>
            (allDescendantKeysByNode.get(child.key) ?? []).some((key) => visibleKeySet.has(key)),
          )
        : node.children;
      if (visibleKeySet && filteredFiles.length === 0 && filteredChildren.length === 0) return;
      rows.push({ kind: "folder", node, depth });
      filteredChildren.forEach((child) => append(child, depth + 1));
      filteredFiles.forEach((candidate) => rows.push({ kind: "file", candidate, depth: depth + 1 }));
    };
    append(tree, 0);
    return rows;
  }, [allDescendantKeysByNode, descendantKeysByNode, search, tree, visibleAllKeys]);
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

  const selectedCandidates = candidates.filter(
    (candidate) => !isFailed(candidate) && selected.has(folderCandidateKey(candidate)),
  );
  const selectionSummary = useMemo(
    () => summarizeImportSelection(candidates.filter((candidate) => !isFailed(candidate)), selected),
    [candidates, isFailed, selected],
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
  return (
    <ImportModalShell
      opened={opened}
      onClose={onClose}
      closeDisabled={loading}
      title="Choose files to import"
      step={2}
      titleInfo="Selected folders are expanded recursively. Use checkboxes to choose files and Preview to inspect them."
      notice={failures.length > 0 ? (
        <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Some files were excluded">
          <Text size="sm">
            {failures.length} file{failures.length === 1 ? " was" : "s were"} not readable and {failures.length === 1 ? "has" : "have"} been deselected. You can continue with the remaining {selectedCandidates.length} file{selectedCandidates.length === 1 ? "" : "s"}.
          </Text>
        </Alert>
      ) : null}
      progress={progress ? <Paper withBorder p="xs">{progress}</Paper> : null}
      actions={
        <>
          <Button variant="default" disabled={loading} onClick={onClose}>
            Cancel
          </Button>
          <ImportModalPrimaryActions>
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
          </ImportModalPrimaryActions>
        </>
      }
    >
      <Stack gap="sm">
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
              setSelected((current) => new Set([
                ...current,
                ...visibleCandidates.filter((candidate) => !isFailed(candidate)).map(folderCandidateKey),
              ]))
            }
          >
            Select all
          </Button>
          <Button
            variant="default"
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current);
                visibleCandidates
                  .filter((candidate) => !isFailed(candidate))
                  .forEach((candidate) => next.delete(folderCandidateKey(candidate)));
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
                  const failed = isFailed(candidate);
                  const failure = failureByPath.get((candidate.path ?? "").toLocaleLowerCase());
                  return (
                    <Group
                      key={key}
                      gap="xs"
                      wrap="nowrap"
                      py={4}
                      px="xs"
                      ml={row.depth * 18}
                      bg={failed ? "light-dark(var(--mantine-color-orange-0), var(--mantine-color-dark-6))" : selected.has(key) ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined}
                      style={{
                        cursor: failed ? "not-allowed" : "pointer",
                        borderRadius: 4,
                        height: FOLDER_IMPORT_ROW_HEIGHT,
                        boxSizing: "border-box",
                        outline:
                          focusedKey === key ? "1px solid var(--mantine-primary-color-4)" : undefined,
                      }}
                      onClick={(event) => {
                        if (!failed) toggleFile(candidate, event.shiftKey, event.ctrlKey || event.metaKey);
                      }}
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        disabled={failed}
                        readOnly
                        styles={{ input: { cursor: "pointer" } }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!failed) toggleFile(candidate, event.shiftKey, event.ctrlKey || event.metaKey);
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
                      {failed && (
                        <Tooltip label={failure?.error ?? "This file could not be inspected."} multiline w={320} withArrow>
                          <Badge color="red" variant="light" size="sm">Excluded</Badge>
                        </Tooltip>
                      )}
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
                        disabled={failed}
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
    </ImportModalShell>
  );
}

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function suggestedCellName(file: ImportPreview) {
  return defaultImportCellName(file);
}

function importDraft(file: ImportPreview): ImportDraft {
  return {
    ...file,
    cell_name: suggestedCellName(file),
    description: file.remarks || "",
    metadata: file.metadata,
    preview_state: { status: "idle" },
    preview_loading: false,
    metadata_only_acknowledged: false,
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
const AUTO_CLOSE_SECONDS = 3;

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
  onSaved: () => void | Promise<void>;
  targetFolderId: number | null;
  blockingInspectionSeconds: number;
}) {
  const qc = useQueryClient();
  const draft = drafts[active];
  const [rawOpen, setRawOpen] = useState(false);
  const [rawData, setRawData] = useState<ImportRawDataResult | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawRequestVersion = useRef(0);
  const rawController = useRef<AbortController | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [destinationFolders, setDestinationFolders] = useState<string[]>(
    targetFolderId === null ? [] : [String(targetFolderId)]
  );
  const [selectedStagedNames, setSelectedStagedNames] = useState<Set<string>>(new Set());
  const [replicateGroups, setReplicateGroups] = useState<ImportReplicateDraft[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [continuedMode, setContinuedMode] = useState(false);
  const [registerToken, setRegisterToken] = useState<string | null>(null);
  const [registrationAccepted, setRegistrationAccepted] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [closingBranch, setClosingBranch] = useState<"done" | "continue" | null>(null);
  const [doneCountdown, setDoneCountdown] = useState<number | null>(null);
  const autoCloseFired = useRef(false);
  const [loadedFilesScrollTop, setLoadedFilesScrollTop] = useState(0);
  const loadedFilesViewportRef = useRef<HTMLDivElement | null>(null);
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
  const backgroundJobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => get<BackgroundJob[]>("/api/background-jobs?limit=20"),
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
      setRegistrationAccepted(false);
      setRegisterToken(null);
      setContinuedCellDraft(continuedCellDraftFrom(drafts[0]));
      setDoneCountdown(null);
      autoCloseFired.current = false;
      setClosingBranch(null);
    } else {
      rawRequestVersion.current += 1;
      rawController.current?.abort();
      rawController.current = null;
      setRawOpen(false);
      setRawData(null);
      setRawLoading(false);
      setRawError(null);
      setRegistrationAccepted(false);
      setRegisterToken(null);
      setDoneCountdown(null);
      autoCloseFired.current = false;
      setClosingBranch(null);
    }
  }, [opened, targetFolderId]);

  const loadRawData = (offset = 0, targetDraft = draft) => {
    if (!targetDraft) return;
    rawRequestVersion.current += 1;
    const requestVersion = rawRequestVersion.current;
    rawController.current?.abort();
    const controller = new AbortController();
    rawController.current = controller;
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
    }, { signal: controller.signal })
      .then((result) => {
        if (rawRequestVersion.current !== requestVersion) return;
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
        if (rawRequestVersion.current !== requestVersion) return;
        addDebugEvent("import:rawDataFailed", {
          staged_name: targetDraft.staged_name,
          error: error.message,
        });
        setRawError(error.message);
      })
      .finally(() => {
        if (rawRequestVersion.current === requestVersion) {
          rawController.current = null;
          setRawLoading(false);
        }
      });
  };

  const handleClose = () => {
    rawRequestVersion.current += 1;
    rawController.current?.abort();
    rawController.current = null;
    setRawOpen(false);
    setRawData(null);
    setRawError(null);
    onClose();
  };

  const activateDraft = (index: number) => {
    const target = drafts[index];
    onActive(index);
    if (
      !continuedMode
      && target
      && !isRegisteredExactDuplicate(target)
      && shouldRequestImportPreview(target, true)
    ) {
      onPreviewRequested(target);
    }
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
  const cellNameConflicts = useMemo(
    () => importNameConflicts(includedDrafts),
    [includedDrafts],
  );
  const conflictingCellNames = useMemo(
    () => new Set(cellNameConflicts.map((conflict) => conflict.name)),
    [cellNameConflicts],
  );
  const hasCellNameConflicts = cellNameConflicts.length > 0;
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
        accepted: boolean;
        job_id: number;
        job_token: string | null;
        submitted_cells: number;
        submitted_sources: number;
        status: string;
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
                  allow_metadata_only: item.metadata_only && item.metadata_only_acknowledged,
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
          allow_metadata_only: d.metadata_only && d.metadata_only_acknowledged,
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
      const submittedCells = result.submitted_cells
        ?? (variables.mode === "continued" ? 1 : includedDrafts.length);
      recordImportTimingSample({
        recordedAt: new Date().toISOString(),
        fileCount: variables.mode === "continued" ? drafts.length : submittedCells,
        totalBytes: drafts.reduce((total, item) => total + Math.max(0, item.size), 0),
        blockingSeconds: blockingInspectionSeconds + Math.max(
          0,
          (Date.now() - (registerStartedAt.current ?? Date.now())) / 1000,
        ),
      });
      setRegistrationAccepted(true);
      const importedLabel = `${submittedCells} cell${submittedCells === 1 ? "" : "s"}`;
      notifications.show({
        message: `${importedLabel} accepted. Registration is being committed; cycling data preparation continues in the background.`,
        color: "teal",
      });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (e: Error, variables) => {
      if (variables?.mode === "continued") {
        void qc.invalidateQueries({ queryKey: ["continued-import-inspection"] });
      }
      notifications.show({ message: e.message, color: "red" });
    },
  });
  const registerProgress = useImportJobProgress(registerToken, Boolean(registerToken));

  const registrationStatus = registerProgress.data?.status;
  const cachePreparationActive = (backgroundJobs.data ?? []).some(
    (job) => job.kind === "import_cache" && (job.status === "running" || job.status === "paused"),
  );
  const registrationUi = importRegistrationUiState(
    registrationAccepted,
    registrationStatus,
    save.isPending,
    Boolean(registerProgress.data?.registration_committed),
    cachePreparationActive,
  );

  const continueInBackground = useCallback(() => {
    if (handoffPending) return;
    setClosingBranch(registrationUi.showDone ? "done" : "continue");
    setHandoffPending(true);
    // The registration job exposes its commit boundary before the modal can
    // be detached. Start the active-library refreshes after that boundary, but
    // do not make the modal wait for them: the query cache remains available
    // after this editor unmounts and can finish refreshing in the background.
    void Promise.all([
      qc.refetchQueries({ queryKey: ["cells"], type: "active" }),
      qc.refetchQueries({ queryKey: ["files"], type: "active" }),
      qc.refetchQueries({ queryKey: ["tree"], type: "active" }),
      qc.refetchQueries({ queryKey: ["replicate-groups"], type: "active" }),
    ]).catch((error: unknown) => {
      addDebugEvent("import:handoffRefreshFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // Schedule the close separately so a slow or failed refresh can never keep
    // the user on Step 3. Promise.resolve().then() also captures a synchronous
    // exception from an onSaved implementation without an unhandled rejection.
    void Promise.resolve()
      .then(() => onSaved())
      .catch((error: unknown) => {
        addDebugEvent("import:handoffCloseFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [handoffPending, qc, onSaved, registrationUi.showDone]);

  useEffect(() => {
    if (!registrationAccepted || !registerProgress.data) return;
    if (registerProgress.data.status === "completed") {
      void qc.invalidateQueries({ queryKey: ["cells"] });
      void qc.invalidateQueries({ queryKey: ["files"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      void qc.invalidateQueries({ queryKey: ["background-jobs"] });
      void qc.invalidateQueries({ queryKey: ["activity"] });
    }
  }, [qc, registerProgress.data, registrationAccepted]);

  // onSaved() resets the draft state while the modal is still mounted, so without latching
  // the footer and button would flash the pre-save review state for a moment before closing.
  const shouldShowDone = registrationUi.showDone || closingBranch === "done";
  const shouldShowContinue =
    !shouldShowDone && (registrationUi.showContinue || closingBranch === "continue");

  // Start/cancel the countdown purely from the policy flag (registrationUi.showDone).
  useEffect(() => {
    if (!registrationUi.showDone) {
      setDoneCountdown(null);
      autoCloseFired.current = false;
      return;
    }
    setDoneCountdown(AUTO_CLOSE_SECONDS);
    const id = setInterval(() => {
      setDoneCountdown((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [registrationUi.showDone]);

  // Fire the handoff exactly once, when the countdown reaches zero.
  useEffect(() => {
    if (doneCountdown !== 0 || autoCloseFired.current) return;
    autoCloseFired.current = true;
    void continueInBackground();
  }, [doneCountdown, continueInBackground]);

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
    includedDrafts.every((d) => !d.metadata_only || d.metadata_only_acknowledged) &&
    includedDrafts.every(
      (d) =>
        d.active_material_selection === "custom" ||
        Boolean(
          (d.active_mass_mg_override ?? d.active_mass_mg) &&
            d.nominal_capacity_mah_override
        )
    ) &&
    !hasCellNameConflicts &&
    !duplicateGroupName &&
    invalidGroups.length === 0;
  const rawRangeStart = rawData && rawData.total_rows > 0 ? rawData.offset + 1 : 0;
  const rawRangeEnd = rawData
    ? Math.min(rawData.offset + rawData.rows.length, rawData.total_rows)
    : 0;
  const metadataRows = draft ? Object.entries(combinedMetadata(draft)) : [];
  const loadedFilesWindow = importDraftWindow(
    drafts.length,
    loadedFilesScrollTop,
    520,
    IMPORT_DRAFT_ROW_HEIGHT,
    IMPORT_DRAFT_ROW_OVERSCAN,
  );
  const loadedFilesStart = loadedFilesWindow.start;
  const loadedFilesEnd = loadedFilesWindow.end;
  const visibleDrafts = drafts.slice(loadedFilesStart, loadedFilesEnd);

  useEffect(() => {
    const viewport = loadedFilesViewportRef.current;
    if (!viewport || drafts.length === 0) return;
    const top = active * IMPORT_DRAFT_ROW_HEIGHT;
    const bottom = top + IMPORT_DRAFT_ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
  }, [active, drafts.length]);

  return (
    <>
      <ImportModalShell
        opened={opened}
        onClose={handleClose}
        closeDisabled={registrationUi.closeLocked}
        title="Import cells"
        step={3}
        fill
        notice={
          duplicateCount > 0 || hasCellNameConflicts ? (
            <Stack gap="xs">
              {duplicateCount > 0 && (
                <Alert color="orange" icon={<IconAlertTriangle size={16} />} p="xs">
                  {duplicateCount} already imported — will be skipped. They remain visible until removed.
                  {includedDrafts.length === 0 && (
                    <Text size="sm" fw={600} mt={4}>
                      All selected files are already in the Cell Database.
                    </Text>
                  )}
                </Alert>
              )}
              {hasCellNameConflicts && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} p="xs">
                  <Text size="sm" fw={600}>
                    Rename the conflicting Cell names before importing.
                  </Text>
                  <Text size="sm" mt={4}>
                    {cellNameConflicts.map((conflict) => (
                      <span key={conflict.name}>
                        {conflict.name}: {conflict.drafts.map((item) => item.filename).join(", ")}
                        <br />
                      </span>
                    ))}
                  </Text>
                </Alert>
              )}
            </Stack>
          ) : null
        }
        progress={
          registerToken ? (
            <Paper withBorder p="xs">
              <ImportProgressPanel
                stage="register"
                job={registerProgress.data}
                error={save.isError && save.error instanceof Error ? save.error.message : null}
              />
            </Paper>
          ) : null
        }
        actions={
          <>
            <Text size="sm" c="dimmed">
              {shouldShowDone
                ? "Import complete. Cells are ready."
                : shouldShowContinue
                  ? "Registration is committed. Scientific data preparation continues in the background."
                  : `Review ${drafts.length} selected file${drafts.length === 1 ? "" : "s"} before saving.`}
            </Text>
            <ImportModalPrimaryActions>
              {shouldShowDone ? (
                <Button
                  loading={handoffPending || closingBranch !== null}
                  disabled={handoffPending || closingBranch !== null}
                  onClick={() => void continueInBackground()}
                >
                  Done{doneCountdown !== null && doneCountdown > 0 ? ` (${doneCountdown})` : ""}
                </Button>
              ) : shouldShowContinue ? (
                <Button
                  loading={handoffPending || closingBranch !== null}
                  disabled={handoffPending || closingBranch !== null}
                  onClick={() => void continueInBackground()}
                >
                  Continue in background
                </Button>
              ) : (
                <>
                  <Button variant="default" disabled={save.isPending} onClick={handleClose}>
                    Cancel
                  </Button>
                  {!continuedMode && (
                    <Button
                      leftSection={<IconDeviceFloppy size={16} />}
                      disabled={!canSave}
                      loading={save.isPending}
                      onClick={() => {
                        const jobToken = newImportJobToken();
                        registerStartedAt.current = Date.now();
                        setRegistrationAccepted(false);
                        setRegisterToken(jobToken);
                        save.mutate({ mode: "separate", jobToken });
                      }}
                    >
                      Import {includedDrafts.length} cell{includedDrafts.length === 1 ? "" : "s"}
                    </Button>
                  )}
                </>
              )}
            </ImportModalPrimaryActions>
          </>
        }
      >
        {draft && (
          <fieldset
            disabled={registrationUi.editingLocked}
            style={{
              border: 0,
              margin: 0,
              minWidth: 0,
              padding: 0,
              // The step owns its scrolling from here down: this column fills
              // the work area and only the panes at the bottom scroll.
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              flex: 1,
            }}
          >
          <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
            {drafts.length >= 2 && (
              <SegmentedControl
                fullWidth
                style={{ flex: "none" }}
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
                  setRegistrationAccepted(false);
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
            <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
            {/* Step-specific commands only. Cancel/Import live in the footer
                with the other step navigation. Stays put while the panes scroll. */}
            <Group
              justify="flex-end"
              align="center"
              gap="xs"
              wrap="wrap"
              style={{ minWidth: 0, flex: "none" }}
            >
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
                w={280}
                size="xs"
                placeholder="No folder"
                data={folderSelectData}
                value={destinationFolders}
                onChange={setDestinationFolders}
                clearable
                searchable
              />
            </Group>
            <Group
              align="stretch"
              gap="md"
              wrap="nowrap"
              style={{ minWidth: 0, flex: 1, minHeight: 0 }}
            >
              <Paper
                withBorder
                p="xs"
                w={250}
                style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}
              >
                <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
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
                  <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
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

              <Paper
                withBorder
                p="xs"
                w={330}
                style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}
              >
                <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
                  <Group justify="space-between" wrap="nowrap" style={{ flex: "none" }}>
                    <Text size="sm" fw={700}>
                      Loaded files
                    </Text>
                   <Badge size="xs" variant="light">
                     {selectedNames.length} selected
                   </Badge>
                 </Group>
                   <Box
                     ref={loadedFilesViewportRef}
                     onScroll={(event) => setLoadedFilesScrollTop(event.currentTarget.scrollTop)}
                     style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
                   >
                     <Box style={{ position: "relative", height: drafts.length * IMPORT_DRAFT_ROW_HEIGHT }}>
                       <Box
                         style={{
                           position: "absolute",
                           top: loadedFilesStart * IMPORT_DRAFT_ROW_HEIGHT,
                           left: 0,
                           right: 0,
                         }}
                       >
                         {visibleDrafts.map((item, visibleIndex) => {
                           const index = loadedFilesStart + visibleIndex;
                           const groups = stagedNameToGroups.get(item.staged_name) ?? [];
                           const checked = selectedStagedNames.has(item.staged_name);
                           const duplicate = isRegisteredExactDuplicate(item);
                           const previewError = item.preview_state.status === "error"
                             ? item.preview_state.message
                             : null;
                           const stateLabel = item.metadata_only
                             ? "Metadata only"
                             : previewError
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
                             <Box key={item.staged_name} style={{ height: IMPORT_DRAFT_ROW_HEIGHT, paddingBottom: 6 }}>
                               <Paper
                                 withBorder
                                 p="xs"
                                 draggable
                                 onDragStart={(event) => handleFileDragStart(event, item.staged_name)}
                                 style={{
                                   cursor: "pointer",
                                   borderColor: index === active ? "var(--mantine-primary-color-5)" : undefined,
                                   background: conflictingCellNames.has(item.cell_name.trim())
                                     ? "light-dark(var(--mantine-color-red-0), var(--mantine-color-dark-8))"
                                     : checked
                                       ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
                                       : undefined,
                                   boxShadow: conflictingCellNames.has(item.cell_name.trim())
                                     ? "inset 3px 0 0 var(--mantine-color-red-6)"
                                     : undefined,
                                 }}
                                 tabIndex={0}
                                 onClick={() => activateDraft(index)}
                                 onKeyDown={(event) => {
                                   if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                     event.preventDefault();
                                     const offset = event.key === "ArrowDown" ? 1 : -1;
                                     const nextIndex = Math.max(0, Math.min(drafts.length - 1, index + offset));
                                     activateDraft(nextIndex);
                                   }
                                 }}
                               >
                                 <Group align="start" wrap="nowrap">
                                   <Checkbox
                                     mt={2}
                                     checked={checked}
                                     onClick={(event) => event.stopPropagation()}
                                     onChange={() => toggleSelectedStagedName(item.staged_name)}
                                   />
                                   <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                                     <Text size="sm" fw={index === active ? 700 : 500} truncate>
                                       {item.cell_name || item.filename}
                                     </Text>
                                     <Text size="xs" c="dimmed" truncate>
                                       {item.filename}
                                     </Text>
                                     {/* Size and state share a line: two separate
                                         rows made the card taller than its content. */}
                                     <Group gap={4} wrap="nowrap">
                                       <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                                         {formatBytes(item.size)}
                                       </Text>
                                       <Text size="xs" c="dimmed" style={{ flex: "none" }} aria-hidden="true">
                                         ·
                                       </Text>
                                       {item.metadata_only || previewError || duplicate || item.import_match?.kind === "possible_update" ? (
                                         <IconAlertTriangle size={13} color="var(--mantine-color-orange-7)" aria-hidden="true" style={{ flex: "none" }} />
                                       ) : null}
                                       <Text size="xs" truncate c={duplicate ? "red" : item.metadata_only || previewError ? "orange" : "dimmed"}>
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
                             </Box>
                           );
                         })}
                       </Box>
                     </Box>
                   </Box>
                </Stack>
              </Paper>

              {/* The detail panel is the tall one. It scrolls inside its own
                  column so it cannot drag the toolbar and column headers with it. */}
              <Paper
                withBorder
                p="xs"
                style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
              >
              <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="md" pr="xs">
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
                  {!draft.metadata_only && (
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={<IconTable size={14} />}
                      onClick={() => loadRawData(0)}
                    >
                      Raw data
                    </Button>
                  )}
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

              {draft.metadata_only && (
                <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>
                      BioLogic metadata-only source
                    </Text>
                    <Text size="sm">
                      {draft.capability_warning ||
                        "This file can be registered with its header metadata, but it cannot be used for canonical cycling analysis yet."}
                    </Text>
                    <Checkbox
                      label="Register this source explicitly as metadata-only"
                      checked={draft.metadata_only_acknowledged}
                      onChange={(event) =>
                        onChange(active, {
                          ...draft,
                          metadata_only_acknowledged: event.currentTarget.checked,
                        })
                      }
                    />
                  </Stack>
                </Alert>
              )}

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

              <Divider
                label={
                  <Group gap={6} wrap="nowrap">
                    <span>Scientific values</span>
                    <ImportInfoHint label="Cycler values remain preserved as source metadata. Enter an override only when the source value is incorrect or missing." />
                  </Group>
                }
                labelPosition="left"
              />
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
              {draft.metadata_only ? (
                <Alert color="gray" title="Capacity preview unavailable">
                  Canonical cycling preview and cache preparation are unavailable for this
                  source until its full-cycle identity is independently resolved. Retry will
                  not change that limitation.
                </Alert>
              ) : draft.preview_state.status === "loading" ? (
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
              <ImportInfoHint label="Metadata detected in the source file is read-only in this import step." />
              <Collapse in={metadataOpen}>
                <Stack gap="xs">
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
            </ScrollArea>
            </Paper>
            </Group>
            </Stack>
            )}
          </Stack>
          </fieldset>
        )}
      </ImportModalShell>

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
  onSaved?: () => void | Promise<void>;
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
  const [inspectionFailures, setInspectionFailures] = useState<ImportInspectionFailure[]>([]);
  const [progressStage, setProgressStage] = useState<ImportProgressStage | null>(null);
  const [progressToken, setProgressToken] = useState<string | null>(null);
  const [blockingInspectionSeconds, setBlockingInspectionSeconds] = useState(0);
  const inspectionStartedAt = useRef<number | null>(null);
  const progressQuery = useImportJobProgress(progressToken, Boolean(progressStage));
  const previewLoader = useImportPreviewLoader(setDrafts);

  const closeImportSession = () => {
    previewLoader.cancel();
    setModalOpen(false);
    setDrafts([]);
    setActive(0);
    setInspectionFailures([]);
  };

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
      const accumulatedFailures = mergeImportInspectionFailures(
        inspectionFailures,
        result.failures,
      );
      setInspectionFailures(accumulatedFailures);
      if (result.failures.length > 0) {
        setFolderModalOpen(true);
      } else {
        setFolderModalOpen(false);
        hydrateInspection(result, append);
      }
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
        notifications.show({ message: "No supported cycler files were found.", color: "gray" });
        return;
      }
      setSourceAppend(append);
      setInspectionFailures([]);
      setFolderRootName("Selected sources");
      setFolderCandidates(candidates);
      setSourcePickerOpen(false);
      setFolderModalOpen(true);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const startSourceSelection = (append: boolean) => {
    setSourceAppend(append);
    setInspectionFailures([]);
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
        failures={inspectionFailures}
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
          setInspectionFailures([]);
          setSourcePickerOpen(true);
        }}
        onClose={() => {
          setFolderModalOpen(false);
          setInspectionFailures([]);
        }}
        onConfirm={confirmFolderSelection}
      />
      <ImportModal
        drafts={drafts}
        active={active}
        opened={modalOpen}
        targetFolderId={targetFolderId}
        blockingInspectionSeconds={blockingInspectionSeconds}
        onActive={setActive}
        onPreviewRequested={previewLoader.load}
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
        onClose={closeImportSession}
        onSaved={async () => {
          closeImportSession();
          await onSaved?.();
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
  const [inspectionFailures, setInspectionFailures] = useState<ImportInspectionFailure[]>([]);
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
  const previewLoader = useImportPreviewLoader(setDrafts);

  const closeImportSession = () => {
    previewLoader.cancel();
    setModalOpen(false);
    setDrafts([]);
    setActive(0);
    setInspectionFailures([]);
  };

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
      const accumulatedFailures = mergeImportInspectionFailures(
        inspectionFailures,
        result.failures,
      );
      setInspectionFailures(accumulatedFailures);
      if (result.failures.length > 0) {
        setFolderModalOpen(true);
      } else {
        setFolderModalOpen(false);
        hydrateInspection(result, append);
      }
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
        notifications.show({ message: "No supported cycler files were found.", color: "gray" });
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
    setInspectionFailures([]);
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
            Load Neware (.nda, .ndax, structured .xlsx) or BioLogic GCPL-family (.mpr) files and choose separate or continued-cell import. BioLogic metadata can be reviewed even when canonical cycling is not yet verified for a source.
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
        failures={inspectionFailures}
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
          setInspectionFailures([]);
          setSourcePickerOpen(true);
        }}
        onClose={() => {
          setFolderModalOpen(false);
          setInspectionFailures([]);
        }}
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
            <Text fw={700}>Start from cycler sources</Text>
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
        onPreviewRequested={previewLoader.load}
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
        onClose={closeImportSession}
        onSaved={() => {
          closeImportSession();
        }}
      />
    </Stack>
  );
}
