import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChartLine,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDatabase,
  IconDatabaseImport,
  IconDotsVertical,
  IconFolder,
  IconFolderPlus,
  IconLayersIntersect,
  IconSearch,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { DragEvent, MouseEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  AnalysisFull,
  CellDetail,
  CellSummary,
  del,
  FolderNode,
  get,
  patch,
  post,
  put,
  ReplicateGroupPreview,
  ReplicateGroupSummary,
  Tree,
} from "../api";
import { clearAnalysisQueryCache, invalidateAnalysisQueries } from "../analysisQueryCache";
import { CellDetailTabs } from "../components/CellDetailTabs";
import {
  deleteEmptyAnalysesIfRequested,
  DestructiveImpactModal,
  type DestructiveImpactConfirmOptions,
} from "../components/DestructiveImpactModal";
import { PlaceInFoldersModal } from "../components/PlaceInFoldersModal";
import { ReplicatePreviewPanel } from "../components/ReplicatePreviewPanel";
import { ImportCellsLauncher } from "./InboxPage";

type ProjectImpactRequest = {
  title: string;
  confirmLabel: string;
  plainMessage: string;
  cellIds: number[];
  groupIds: number[];
  run: (options: DestructiveImpactConfirmOptions) => Promise<void>;
};

type PreviewSelection =
  | { kind: "cell"; id: number }
  | { kind: "replicate_group"; id: number; title: string }
  | { kind: "analysis"; id: number; title: string }
  | null;

type TreeItem =
  | { key: string; kind: "folder"; id: number; folderId: number; label: string }
  | { key: string; kind: "cell"; id: number; folderId: number; label: string }
  | { key: string; kind: "replicate_group"; id: number; folderId: number; label: string }
  | { key: string; kind: "analysis"; id: number; folderId: number; label: string };

type ContextMenuState = {
  x: number;
  y: number;
  item: TreeItem;
} | null;

function folderKey(id: number) {
  return `folder:${id}`;
}

function cellKey(folderId: number, id: number) {
  return `cell:${folderId}:${id}`;
}

function analysisKey(folderId: number, id: number) {
  return `analysis:${folderId}:${id}`;
}

function replicateGroupKey(folderId: number, id: number) {
  return `replicate:${folderId}:${id}`;
}

function formatCapacity(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${value.toFixed(1)} mAh`;
}

function flattenFolders(nodes: FolderNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((node) => [
    { value: String(node.id), label: `${"  ".repeat(depth)}${node.name}` },
    ...flattenFolders(node.children, depth + 1),
  ]);
}

function findFolder(nodes: FolderNode[], id: number | null): FolderNode | null {
  if (id === null) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findFolder(node.children, id);
    if (child) return child;
  }
  return null;
}

function collectFolderIds(nodes: FolderNode[]): number[] {
  return nodes.flatMap((node) => [node.id, ...collectFolderIds(node.children)]);
}

function collectFiledReferences(nodes: FolderNode[], cellIds: Set<number>, groupIds: Set<number>) {
  nodes.forEach((node) => {
    node.cells.forEach((cell) => cellIds.add(cell.id));
    node.replicate_groups.forEach((group) => groupIds.add(group.id));
    collectFiledReferences(node.children, cellIds, groupIds);
  });
}

function visibleTreeItems(nodes: FolderNode[], expanded: Set<number>): TreeItem[] {
  return nodes.flatMap((folder) => {
    const folderItem: TreeItem = {
      key: folderKey(folder.id),
      kind: "folder",
      id: folder.id,
      folderId: folder.id,
      label: folder.name,
    };
    if (!expanded.has(folder.id)) return [folderItem];
    return [
      folderItem,
      ...visibleTreeItems(folder.children, expanded),
      ...folder.cells.map(
        (cell): TreeItem => ({
          key: cellKey(folder.id, cell.id),
          kind: "cell",
          id: cell.id,
          folderId: folder.id,
          label: cell.name,
        })
      ),
      ...folder.replicate_groups.map(
        (group): TreeItem => ({
          key: replicateGroupKey(folder.id, group.id),
          kind: "replicate_group",
          id: group.id,
          folderId: folder.id,
          label: group.name,
        })
      ),
      ...folder.analyses.map(
        (analysis): TreeItem => ({
          key: analysisKey(folder.id, analysis.id),
          kind: "analysis",
          id: analysis.id,
          folderId: folder.id,
          label: analysis.title,
        })
      ),
    ];
  });
}

function AddReferencesModal({
  folder,
  existingCells,
  existingGroups,
  opened,
  onClose,
}: {
  folder: FolderNode | null;
  existingCells: number[];
  existingGroups: number[];
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"cells" | "replicate_groups">("cells");
  const [branchOnly, setBranchOnly] = useState(true);
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<number[]>([]);
  const cells = useQuery({
    queryKey: ["cells", "project-picker"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
    enabled: opened && mode === "cells",
  });
  const replicateGroups = useQuery({
    queryKey: ["replicate-groups", "project-picker"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
    enabled: opened && mode === "replicate_groups",
  });
  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree"), enabled: opened });
  const add = useMutation({
    mutationFn: async () => {
      if (selectedCells.length) {
        await post(`/api/folders/${folder!.id}/cells`, { cell_ids: selectedCells });
      }
      if (selectedGroups.length) {
        await post(`/api/folders/${folder!.id}/replicate-groups`, { group_ids: selectedGroups });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["cells", "folder", folder?.id] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      setSelectedCells([]);
      setSelectedGroups([]);
      onClose();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const needle = search.trim().toLowerCase();
  const matches = (value: string) => !needle || value.toLowerCase().includes(needle);
  const visibleFolders = branchOnly && folder ? [folder] : tree.data?.folders ?? [];
  const filedCellIds = new Set<number>();
  const filedGroupIds = new Set<number>();
  collectFiledReferences(tree.data?.folders ?? [], filedCellIds, filedGroupIds);
  const unfiledCells = (cells.data ?? []).filter(
    (cell) => !filedCellIds.has(cell.id) && !existingCells.includes(cell.id) && matches(cell.name)
  );
  const unfiledGroups = (replicateGroups.data ?? []).filter(
    (group) => !filedGroupIds.has(group.id) && !existingGroups.includes(group.id) && matches(group.name)
  );
  const selectedCount = mode === "cells" ? selectedCells.length : selectedGroups.length;
  const renderFolderRows = (node: FolderNode, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [
      <Table.Tr key={`folder-${node.id}`}>
        <Table.Td colSpan={2}>
          <Group gap={6} pl={depth * 16}>
            <IconFolder size={14} color="var(--mantine-color-teal-6)" />
            <Text size="xs" fw={700} c="dimmed">
              {node.name}
            </Text>
          </Group>
        </Table.Td>
      </Table.Tr>,
    ];
    if (mode === "cells") {
      node.cells
        .filter((cell) => !existingCells.includes(cell.id) && matches(cell.name))
        .forEach((cell) =>
          rows.push(
            <Table.Tr
              key={`cell-${node.id}-${cell.id}`}
              bg={selectedCells.includes(cell.id) ? "teal.0" : undefined}
              style={{ cursor: "pointer" }}
              onClick={() =>
                setSelectedCells((current) =>
                  current.includes(cell.id)
                    ? current.filter((id) => id !== cell.id)
                    : [...current, cell.id]
                )
              }
            >
              <Table.Td>
                <Group gap={6} pl={(depth + 1) * 16}>
                  <IconDatabase size={14} color="var(--mantine-color-gray-6)" />
                  <Text size="sm" fw={600} truncate>
                    {cell.name}
                  </Text>
                </Group>
              </Table.Td>
              <Table.Td w={34}>
                <Checkbox checked={selectedCells.includes(cell.id)} readOnly />
              </Table.Td>
            </Table.Tr>
          )
        );
    } else {
      node.replicate_groups
        .filter((group) => !existingGroups.includes(group.id) && matches(group.name))
        .forEach((group) =>
          rows.push(
            <Table.Tr
              key={`group-${node.id}-${group.id}`}
              bg={selectedGroups.includes(group.id) ? "teal.0" : undefined}
              style={{ cursor: "pointer" }}
              onClick={() =>
                setSelectedGroups((current) =>
                  current.includes(group.id)
                    ? current.filter((id) => id !== group.id)
                    : [...current, group.id]
                )
              }
            >
              <Table.Td>
                <Group gap={6} pl={(depth + 1) * 16}>
                  <IconLayersIntersect size={14} color="var(--mantine-color-teal-6)" />
                  <Text size="sm" fw={600} truncate>
                    {group.name}
                  </Text>
                </Group>
              </Table.Td>
              <Table.Td w={34}>
                <Checkbox checked={selectedGroups.includes(group.id)} readOnly />
              </Table.Td>
            </Table.Tr>
          )
        );
    }
    node.children.forEach((child) => rows.push(...renderFolderRows(child, depth + 1)));
    return rows;
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add cell/replicate" size="lg">
      <Stack>
        <Text size="xs" c="dimmed">
          Cells and replicate groups stay in the database. This adds references to {folder?.name}.
        </Text>
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(value) => {
            setMode(value as "cells" | "replicate_groups");
            setSearch("");
          }}
          data={[
            { value: "cells", label: "Cells" },
            { value: "replicate_groups", label: "Replicates" },
          ]}
        />
        <Switch
          size="sm"
          label="Current branch only"
          checked={branchOnly}
          disabled={!folder}
          onChange={(event) => setBranchOnly(event.currentTarget.checked)}
        />
        <TextInput
          leftSection={<IconSearch size={15} />}
          placeholder={mode === "cells" ? "Search cells" : "Search replicate groups"}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <ScrollArea h={360} type="auto">
          <Table highlightOnHover>
            <Table.Tbody>
              {visibleFolders.flatMap((node) => renderFolderRows(node, 0))}
              {!branchOnly && (
                <Table.Tr>
                  <Table.Td colSpan={2}>
                    <Group gap={6}>
                      <IconFolder size={14} color="var(--mantine-color-gray-6)" />
                      <Text size="xs" fw={700} c="dimmed">
                        Outside folders
                      </Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              )}
              {!branchOnly && mode === "cells" && unfiledCells.map((cell) => (
                <Table.Tr
                  key={cell.id}
                  bg={selectedCells.includes(cell.id) ? "teal.0" : undefined}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    setSelectedCells((current) =>
                      current.includes(cell.id)
                        ? current.filter((id) => id !== cell.id)
                        : [...current, cell.id]
                    )
                  }
                >
                  <Table.Td w={34}>
                    <Checkbox checked={selectedCells.includes(cell.id)} readOnly />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {cell.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {cell.total_cycles} cycles
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!branchOnly && mode === "replicate_groups" && unfiledGroups.map((group) => (
                <Table.Tr
                  key={group.id}
                  bg={selectedGroups.includes(group.id) ? "teal.0" : undefined}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    setSelectedGroups((current) =>
                      current.includes(group.id)
                        ? current.filter((id) => id !== group.id)
                        : [...current, group.id]
                    )
                  }
                >
                  <Table.Td w={34}>
                    <Checkbox checked={selectedGroups.includes(group.id)} readOnly />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      <IconLayersIntersect size={15} color="var(--mantine-color-teal-6)" />
                      <div>
                        <Text size="sm" fw={600}>
                          {group.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {group.cells.map((cell) => cell.name).join(", ")}
                        </Text>
                      </div>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Button disabled={!folder || selectedCount === 0} loading={add.isPending} onClick={() => add.mutate()}>
          Add {selectedCount} {mode === "cells" ? "cell" : "replicate"}{selectedCount === 1 ? "" : "s"}
        </Button>
      </Stack>
    </Modal>
  );
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [editingAnalysisId, setEditingAnalysisId] = useState<number | null>(null);
  const [editingAnalysisTitle, setEditingAnalysisTitle] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [addReferencesOpen, setAddReferencesOpen] = useState(false);
  const [placeItemsOpen, setPlaceItemsOpen] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(390);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [preview, setPreview] = useState<PreviewSelection>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<number | null>(null);
  const [impactRequest, setImpactRequest] = useState<ProjectImpactRequest | null>(null);

  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const folders = tree.data?.folders ?? [];
  const selectedFolder = findFolder(folders, selectedFolderId);
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);
  const folderIds = useMemo(() => collectFolderIds(folders), [folders]);
  const visibleItems = useMemo(() => visibleTreeItems(folders, expandedFolders), [folders, expandedFolders]);
  const itemsByKey = useMemo(() => new Map(visibleItems.map((item) => [item.key, item])), [visibleItems]);

  // Deep link from the command palette: ?folder=<id> selects the folder and
  // expands every ancestor so it is visible in the tree. Consumed once.
  const folderDeepLinkApplied = useRef(false);
  useEffect(() => {
    if (folderDeepLinkApplied.current || !tree.data) return;
    const folderParam = searchParams.get("folder");
    if (!folderParam) return;
    const targetId = Number(folderParam);
    if (!Number.isFinite(targetId)) return;
    folderDeepLinkApplied.current = true;

    const ancestors: number[] = [];
    const walk = (nodes: FolderNode[], trail: number[]): boolean => {
      for (const node of nodes) {
        if (node.id === targetId) {
          ancestors.push(...trail);
          return true;
        }
        if (walk(node.children, [...trail, node.id])) return true;
      }
      return false;
    };
    if (walk(tree.data.folders, [])) {
      setExpandedFolders((current) => new Set([...current, ...ancestors, targetId]));
      setSelectedFolderId(targetId);
      setSelectedKeys(new Set([folderKey(targetId)]));
    }
    const next = new URLSearchParams(searchParams);
    next.delete("folder");
    setSearchParams(next, { replace: true });
  }, [tree.data, searchParams, setSearchParams]);

  useEffect(() => {
    if (!tree.data) return;
    if (searchParams.get("folder")) return;
    if (selectedFolderId !== null && findFolder(tree.data.folders, selectedFolderId)) return;
    const firstFolder = tree.data.folders[0]?.id ?? null;
    setSelectedFolderId(firstFolder);
    if (firstFolder !== null) setSelectedKeys(new Set([folderKey(firstFolder)]));
  }, [tree.data, selectedFolderId, searchParams]);

  useEffect(() => {
    if (folderIds.length > 0 && expandedFolders.size === 0) {
      setExpandedFolders(new Set(folderIds));
    }
  }, [expandedFolders.size, folderIds]);

  const selectedCellDetail = useQuery({
    queryKey: ["cell", preview?.kind === "cell" ? preview.id : null],
    queryFn: () => get<CellDetail>(`/api/cells/${preview!.id}`),
    enabled: preview?.kind === "cell",
  });
  const selectedReplicatePreview = useQuery({
    queryKey: ["replicate-preview", preview?.kind === "replicate_group" ? preview.id : null],
    queryFn: () => get<ReplicateGroupPreview>(`/api/replicate-groups/${preview!.id}/preview`),
    enabled: preview?.kind === "replicate_group",
  });

  const selectedItems = useMemo(
    () => Array.from(selectedKeys).map((key) => itemsByKey.get(key)).filter((item): item is TreeItem => Boolean(item)),
    [itemsByKey, selectedKeys]
  );

  const invalidateTree = () => qc.invalidateQueries({ queryKey: ["tree"] });

  const createFolder = useMutation({
    mutationFn: (body: { name: string; parent_id: number | null }) => post("/api/folders", body),
    onSuccess: () => invalidateTree(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const renameFolder = useMutation({
    mutationFn: (body: { id: number; name: string }) =>
      patch(`/api/folders/${body.id}`, { name: body.name }),
    onSuccess: () => {
      setEditingFolderId(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const moveFolder = useMutation({
    mutationFn: (body: { id: number; parent_id: number | null }) =>
      patch(
        `/api/folders/${body.id}`,
        body.parent_id === null ? { move_to_root: true } : { parent_id: body.parent_id }
      ),
    onSuccess: () => invalidateTree(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const copyFolder = useMutation({
    mutationFn: (body: { id: number; parent_id: number | null }) =>
      post(`/api/folders/${body.id}/copy`, { parent_id: body.parent_id }),
    onSuccess: () => invalidateTree(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const deleteFolder = useMutation({
    mutationFn: (id: number) => del(`/api/folders/${id}`),
    onSuccess: () => {
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const copyCells = useMutation({
    mutationFn: (body: { sourceFolderId: number; targetFolderId: number; cellIds: number[] }) =>
      post(`/api/folders/${body.targetFolderId}/cells/copy`, {
        source_folder_id: body.sourceFolderId,
        cell_ids: body.cellIds,
      }),
    onSuccess: () => invalidateTree(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const copyGroups = useMutation({
    mutationFn: (body: { sourceFolderId: number; targetFolderId: number; groupIds: number[] }) =>
      post(`/api/folders/${body.targetFolderId}/replicate-groups/copy`, {
        source_folder_id: body.sourceFolderId,
        group_ids: body.groupIds,
      }),
    onSuccess: () => invalidateTree(),
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const moveCells = useMutation({
    mutationFn: (body: { sourceFolderId: number; targetFolderId: number; cellIds: number[] }) =>
      post(`/api/folders/${body.targetFolderId}/cells/move`, {
        source_folder_id: body.sourceFolderId,
        cell_ids: body.cellIds,
      }),
    onSuccess: () => {
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const moveGroups = useMutation({
    mutationFn: (body: { sourceFolderId: number; targetFolderId: number; groupIds: number[] }) =>
      post(`/api/folders/${body.targetFolderId}/replicate-groups/move`, {
        source_folder_id: body.sourceFolderId,
        group_ids: body.groupIds,
      }),
    onSuccess: () => {
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const removeCell = useMutation({
    mutationFn: (body: { folderId: number; cellId: number }) =>
      del(`/api/folders/${body.folderId}/cells/${body.cellId}`),
    onSuccess: () => {
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const removeGroup = useMutation({
    mutationFn: (body: { folderId: number; groupId: number }) =>
      del(`/api/folders/${body.folderId}/replicate-groups/${body.groupId}`),
    onSuccess: () => {
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const bulkDelete = useMutation({
    mutationFn: async (items: TreeItem[]) => {
      for (const item of items) {
        if (item.kind === "folder") await del(`/api/folders/${item.id}`);
        if (item.kind === "cell") await del(`/api/folders/${item.folderId}/cells/${item.id}`);
        if (item.kind === "replicate_group") {
          await del(`/api/folders/${item.folderId}/replicate-groups/${item.id}`);
        }
      }
    },
    onSuccess: () => {
      setSelectedKeys(new Set());
      setPreview(null);
      invalidateTree();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  // Turn a multi-cell selection into a replicate group, filed into the same
  // folder(s) the cells already sit in. Source cells are then removed from
  // those folders so only the replicate remains.
  const groupAsReplicate = useMutation({
    mutationFn: async (payload: {
      name: string;
      cellIds: number[];
      folderIds: number[];
      cells: { id: number; folderId: number }[];
    }) => {
      return post<ReplicateGroupSummary>("/api/replicate-groups", {
        name: payload.name,
        cell_ids: payload.cellIds,
        folder_ids: payload.folderIds,
        remove_folder_cells: payload.cells.map((cell) => ({
          cell_id: cell.id,
          folder_id: cell.folderId,
        })),
      });
    },
    onSuccess: (group) => {
      notifications.show({ message: `Grouped as replicate ${group.name}`, color: "teal" });
      setSelectedKeys(new Set());
      invalidateTree();
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["cells"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  // Explode a replicate group and replace every filed group reference with
  // its cells, so no project placement is lost when the shared group is deleted.
  const explodeReplicate = useMutation({
    mutationFn: (groups: { groupId: number; folderIds: number[] }[]) =>
      post<{ removed: number; deleted_empty_groups: number[] }>(
        "/api/replicate-groups/explode",
        {
          groups: groups.map((group) => ({
            group_id: group.groupId,
            folder_ids: group.folderIds,
          })),
        }
      ),
    onSuccess: () => {
      notifications.show({ message: "Replicate exploded into its cells", color: "teal" });
      setSelectedKeys(new Set());
      invalidateTree();
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["cells"] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["analyses"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const requestExplode = (groups: TreeItem[]) => {
    const payload = buildExplodePayload(groups);
    if (payload.length === 0) return;
    const groupIds = payload.map((group) => group.groupId);
    setImpactRequest({
      title: groupIds.length === 1 ? "Explode replicate?" : `Explode ${groupIds.length} replicates?`,
      confirmLabel: "Explode",
      plainMessage:
        groupIds.length === 1
          ? "Explode this replicate into its cells everywhere it is filed?"
          : `Explode ${groupIds.length} replicates into their cells everywhere they are filed?`,
      cellIds: [],
      groupIds,
      run: async (options) => {
        await explodeReplicate.mutateAsync(payload);
        const deleted = await deleteEmptyAnalysesIfRequested(options);
        if (deleted.length) {
          notifications.show({
            message: `Deleted ${deleted.length} empty ${deleted.length === 1 ? "analysis" : "analyses"}.`,
            color: "orange",
          });
          qc.invalidateQueries({ queryKey: ["analyses"] });
          invalidateTree();
          qc.invalidateQueries({ queryKey: ["cells"] });
          qc.invalidateQueries({ queryKey: ["replicate-groups"] });
          void invalidateAnalysisQueries(qc);
        }
      },
    });
  };

  const createAnalysis = useMutation({
    mutationFn: (body: { title: string; folder_id: number | null }) =>
      post<AnalysisFull>("/api/analyses", body),
    onSuccess: (analysis) => {
      invalidateTree();
      modals.closeAll();
      navigate(`/analyses/${analysis.id}`);
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const updateAnalysis = useMutation({
    mutationFn: (body: { id: number; title?: string; folderId?: number | null }) =>
      put<AnalysisFull>(
        `/api/analyses/${body.id}`,
        body.title !== undefined
          ? { title: body.title }
          : body.folderId === null
            ? { unfile: true }
            : { folder_id: body.folderId }
      ),
    onSuccess: async (analysis) => {
      setEditingAnalysisId(null);
      await clearAnalysisQueryCache(qc, analysis.id);
      await Promise.all([
        invalidateTree(),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
      ]);
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const copyAnalysis = useMutation({
    mutationFn: (body: { id: number; folderId: number | null }) =>
      post<AnalysisFull>(
        `/api/analyses/${body.id}/duplicate`,
        body.folderId === null ? { unfile: true } : { folder_id: body.folderId }
      ),
    onSuccess: async (analysis) => {
      await clearAnalysisQueryCache(qc, analysis.id);
      await Promise.all([
        invalidateTree(),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
      ]);
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });
  const deleteAnalysis = useMutation({
    mutationFn: async (id: number) => {
      await del(`/api/analyses/${id}`);
      await clearAnalysisQueryCache(qc, id);
    },
    onSuccess: async () => {
      setSelectedKeys(new Set());
      setPreview(null);
      await Promise.all([
        invalidateTree(),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
      ]);
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const openCreateFolder = (parentId: number | null) =>
    modals.open({
      title: "New folder",
      children: <FolderNameForm onSubmit={(name) => createFolder.mutate({ name, parent_id: parentId })} />,
    });

  const openDestination = (title: string, onSubmit: (folderId: number | null) => void) =>
    modals.open({
      title,
      children: <DestinationForm folders={folderOptions} onSubmit={onSubmit} />,
    });

  const openCreateAnalysis = () =>
    modals.open({
      title: "New analysis",
      children: (
        <AnalysisCreateForm
          folders={folderOptions}
          defaultFolderId={selectedFolderId}
          defaultTitle={`${selectedFolder?.name ?? "Untitled"} analysis`}
          loading={createAnalysis.isPending}
          onSubmit={(payload) => createAnalysis.mutate(payload)}
        />
      ),
    });

  const startRename = (folder: FolderNode) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  };

  const startAnalysisRename = (analysis: { id: number; title: string }) => {
    setEditingAnalysisId(analysis.id);
    setEditingAnalysisTitle(analysis.title);
  };

  const commitAnalysisRename = (analysis: { id: number; title: string }) => {
    const nextTitle = editingAnalysisTitle.trim();
    if (!nextTitle || nextTitle === analysis.title) {
      setEditingAnalysisId(null);
      return;
    }
    updateAnalysis.mutate({ id: analysis.id, title: nextTitle });
  };

  const commitRename = (folder: FolderNode) => {
    const nextName = editingFolderName.trim();
    if (!nextName || nextName === folder.name) {
      setEditingFolderId(null);
      return;
    }
    renameFolder.mutate({ id: folder.id, name: nextName });
  };

  const confirmDeleteFolder = (folder: FolderNode) =>
    modals.openConfirmModal({
      title: `Remove folder ${folder.name}?`,
      children: (
        <Text size="sm">
          Cells and analyses are not deleted. Child folders and filed items move up one level; root
          folder cell references become unfiled.
        </Text>
      ),
      labels: { confirm: "Remove", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => deleteFolder.mutate(folder.id),
    });

  const selectPreview = (next: PreviewSelection) => {
    setPreview(next);
    setPreviewOpen(true);
  };

  const toggleFolder = (folderId: number) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };


  const handleSelect = (event: MouseEvent, item: TreeItem) => {
    if (event.shiftKey && lastSelectedKey) {
      const start = visibleItems.findIndex((candidate) => candidate.key === lastSelectedKey);
      const end = visibleItems.findIndex((candidate) => candidate.key === item.key);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedKeys(new Set(visibleItems.slice(from, to + 1).map((candidate) => candidate.key)));
      }
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedKeys((current) => {
        const next = new Set(current);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      setLastSelectedKey(item.key);
    } else {
      setSelectedKeys(new Set([item.key]));
      setLastSelectedKey(item.key);
    }
    if (item.kind === "folder") setSelectedFolderId(item.id);
    if (item.kind === "cell") {
      setSelectedFolderId(item.folderId);
      selectPreview({ kind: "cell", id: item.id });
    }
    if (item.kind === "analysis") {
      setSelectedFolderId(item.folderId);
      selectPreview({ kind: "analysis", id: item.id, title: item.label });
    }
    if (item.kind === "replicate_group") {
      setSelectedFolderId(item.folderId);
      selectPreview({ kind: "replicate_group", id: item.id, title: item.label });
    }
  };

  const handleContextMenu = (event: MouseEvent, item: TreeItem) => {
    event.preventDefault();
    if (!selectedKeys.has(item.key)) {
      setSelectedKeys(new Set([item.key]));
      setLastSelectedKey(item.key);
    }
    if (item.kind === "folder") setSelectedFolderId(item.id);
    else setSelectedFolderId(item.folderId);
    setContextMenu({ x: event.clientX, y: event.clientY, item });
  };

  const selectedActionItems = contextMenu
    ? selectedKeys.has(contextMenu.item.key)
      ? selectedItems
      : [contextMenu.item]
    : selectedItems;

  const selectedFolders = selectedActionItems.filter((item) => item.kind === "folder");
  const selectedCells = selectedActionItems.filter((item) => item.kind === "cell");
  const selectedGroups = selectedActionItems.filter((item) => item.kind === "replicate_group");
  const selectedAnalyses = selectedActionItems.filter((item) => item.kind === "analysis");
  const hasOnlyFolders = selectedFolders.length > 0 && selectedFolders.length === selectedActionItems.length;
  const hasOnlyReferences =
    selectedCells.length + selectedGroups.length > 0 &&
    selectedCells.length + selectedGroups.length === selectedActionItems.length;
  const hasSingleFolder = selectedFolders.length === 1 && selectedActionItems.length === 1;
  // Two or more plain cells (no groups/folders/analyses) can become a replicate.
  const canGroupAsReplicate =
    selectedCells.length >= 2 && selectedCells.length === selectedActionItems.length;
  // One or more replicate groups selected (and nothing else) can be exploded.
  const canExplodeReplicate =
    selectedGroups.length > 0 && selectedGroups.length === selectedActionItems.length;
  // Toolbar uses the current tree selection (not the context-menu override).
  const toolbarCells = selectedItems.filter((item) => item.kind === "cell");
  const toolbarGroups = selectedItems.filter((item) => item.kind === "replicate_group");
  const toolbarCanGroupAsReplicate =
    toolbarCells.length >= 2 && toolbarCells.length === selectedItems.length;
  const toolbarCanExplodeReplicate =
    toolbarGroups.length > 0 && toolbarGroups.length === selectedItems.length;

  const buildGroupAsReplicatePayload = (cells: TreeItem[]) => ({
    name: `${cells[0].label} replicates`,
    cellIds: cells.map((item) => item.id),
    folderIds: [...new Set(cells.map((item) => item.folderId))],
    cells: cells.map((item) => ({ id: item.id, folderId: item.folderId })),
  });

  const buildExplodePayload = (groups: TreeItem[]) =>
    [...groups.reduce((byGroup, item) => {
      const current = byGroup.get(item.id) ?? {
        groupId: item.id,
        folderIds: [] as number[],
      };
      if (!current.folderIds.includes(item.folderId)) {
        current.folderIds.push(item.folderId);
      }
      byGroup.set(item.id, current);
      return byGroup;
    }, new Map<number, { groupId: number; folderIds: number[] }>()).values()];

  // Folder ids currently selected in the tree, for the "…selected only" actions.
  const selectedFolderIds = (() => {
    const ids = selectedActionItems
      .filter((item) => item.kind === "folder")
      .map((item) => item.id);
    if (ids.length) return ids;
    return selectedFolderId != null ? [selectedFolderId] : [];
  })();
  const expandAll = () => setExpandedFolders(new Set(collectFolderIds(folders)));
  const collapseAll = () => setExpandedFolders(new Set());
  const branchIds = (targets: number[]) => {
    const ids = new Set<number>();
    for (const id of targets) {
      const node = findFolder(folders, id);
      if (node) collectFolderIds([node]).forEach((value) => ids.add(value));
    }
    return ids;
  };
  const expandSelected = () =>
    setExpandedFolders((current) => new Set([...current, ...branchIds(selectedFolderIds)]));
  const collapseSelected = () =>
    setExpandedFolders((current) => {
      const remove = branchIds(selectedFolderIds);
      return new Set([...current].filter((id) => !remove.has(id)));
    });
  const hasOnlyAnalyses =
    selectedAnalyses.length > 0 && selectedAnalyses.length === selectedActionItems.length;
  const hasSingleAnalysis = selectedAnalyses.length === 1 && selectedActionItems.length === 1;

  const transferCells = (targetFolderId: number, copy: boolean, items = selectedCells) => {
    const bySource = new Map<number, number[]>();
    items.forEach((item) => {
      const ids = bySource.get(item.folderId) ?? [];
      ids.push(item.id);
      bySource.set(item.folderId, ids);
    });
    bySource.forEach((cellIds, sourceFolderId) => {
      if (copy) copyCells.mutate({ sourceFolderId, targetFolderId, cellIds });
      else moveCells.mutate({ sourceFolderId, targetFolderId, cellIds });
    });
  };

  const transferGroups = (targetFolderId: number, copy: boolean, items = selectedGroups) => {
    const bySource = new Map<number, number[]>();
    items.forEach((item) => {
      const ids = bySource.get(item.folderId) ?? [];
      ids.push(item.id);
      bySource.set(item.folderId, ids);
    });
    bySource.forEach((groupIds, sourceFolderId) => {
      if (copy) copyGroups.mutate({ sourceFolderId, targetFolderId, groupIds });
      else moveGroups.mutate({ sourceFolderId, targetFolderId, groupIds });
    });
  };

  const transferFolders = (targetParentId: number | null, copy: boolean, items = selectedFolders) => {
    items.forEach((item) => {
      if (copy) copyFolder.mutate({ id: item.id, parent_id: targetParentId });
      else moveFolder.mutate({ id: item.id, parent_id: targetParentId });
    });
  };

  const transferAnalyses = (
    targetFolderId: number | null,
    copy: boolean,
    items = selectedAnalyses
  ) => {
    items.forEach((item) => {
      if (copy) copyAnalysis.mutate({ id: item.id, folderId: targetFolderId });
      else updateAnalysis.mutate({ id: item.id, folderId: targetFolderId });
    });
  };

  const handleDragStart = (event: DragEvent, item: TreeItem) => {
    const dragItems = selectedKeys.has(item.key) ? selectedActionItems : [item];
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-cellxplorer-items", JSON.stringify(dragItems));
  };

  const handleDropOnFolder = (event: DragEvent, folder: FolderNode) => {
    event.preventDefault();
    // The drop zone wraps the whole folder subtree, so a drop on a child row
    // still files into this folder. stopPropagation lets the innermost folder
    // under the cursor win instead of every ancestor also handling it.
    event.stopPropagation();
    setDropTargetFolderId(null);
    const raw = event.dataTransfer.getData("application/x-cellxplorer-items");
    if (!raw) return;
    const items = JSON.parse(raw) as TreeItem[];
    const copy = event.ctrlKey || event.metaKey;
    const folderItems = items.filter((item) => item.kind === "folder");
    const cellItems = items.filter((item) => item.kind === "cell");
    const groupItems = items.filter((item) => item.kind === "replicate_group");
    const analysisItems = items.filter((item) => item.kind === "analysis");
    if (folderItems.length) transferFolders(folder.id, copy, folderItems);
    if (cellItems.length) transferCells(folder.id, copy, cellItems);
    if (groupItems.length) transferGroups(folder.id, copy, groupItems);
    if (analysisItems.length) transferAnalyses(folder.id, copy, analysisItems);
  };

  const copyTo = () => {
    if (hasOnlyFolders) openDestination("Copy to", (folderId) => transferFolders(folderId, true));
    if (hasOnlyReferences) {
      openDestination("Copy to", (folderId) => {
        if (folderId === null) return;
        if (selectedCells.length) transferCells(folderId, true);
        if (selectedGroups.length) transferGroups(folderId, true);
      });
    }
    if (hasOnlyAnalyses) {
      openDestination("Copy to", (folderId) => transferAnalyses(folderId, true));
    }
  };

  const moveTo = () => {
    if (hasOnlyFolders) openDestination("Move to", (folderId) => transferFolders(folderId, false));
    if (hasOnlyReferences) {
      openDestination("Move to", (folderId) => {
        if (folderId === null) return;
        if (selectedCells.length) transferCells(folderId, false);
        if (selectedGroups.length) transferGroups(folderId, false);
      });
    }
    if (hasOnlyAnalyses) {
      openDestination("Move to", (folderId) => transferAnalyses(folderId, false));
    }
  };

  const deleteSelected = () => {
    if (selectedActionItems.length === 1 && selectedActionItems[0].kind === "folder") {
      const folder = findFolder(folders, selectedActionItems[0].id);
      if (folder) confirmDeleteFolder(folder);
      return;
    }
    if (hasOnlyAnalyses) {
      modals.openConfirmModal({
        title: `Delete ${selectedAnalyses.length === 1 ? selectedAnalyses[0].label : `${selectedAnalyses.length} analyses`}?`,
        children: (
          <Text size="sm">
            This deletes the selected analysis record and its saved plots. Cell data remains in the database.
          </Text>
        ),
        labels: { confirm: "Delete", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => selectedAnalyses.forEach((item) => deleteAnalysis.mutate(item.id)),
      });
      return;
    }
    modals.openConfirmModal({
      title: `Remove ${selectedActionItems.length} selected item${selectedActionItems.length === 1 ? "" : "s"}?`,
      children: <Text size="sm">Cells and replicate groups are removed from folders only; database records stay available.</Text>,
      labels: { confirm: "Remove", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => bulkDelete.mutate(selectedActionItems),
    });
  };

  const startPreviewResize = (event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = previewWidth;
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      setPreviewWidth(Math.min(760, Math.max(300, nextWidth)));
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  return (
    <Stack>
      <style>{`
        .project-tree-row .project-tree-hover-actions { opacity: 0; transition: opacity 120ms ease; }
        .project-tree-row:hover .project-tree-hover-actions { opacity: 1; }
      `}</style>
      <Group justify="space-between" align="center">
        <Title order={3}>Projects</Title>
        <Group gap="xs">
          <Button variant="default" disabled={!selectedFolder} onClick={() => setAddReferencesOpen(true)}>
            Add cell/replicate
          </Button>
          <ImportCellsLauncher
            targetFolderId={selectedFolderId}
            onSaved={() => {
              invalidateTree();
              selectedCellDetail.refetch();
            }}
          >
            {({ open, loading }) => (
              <Button
                variant="default"
                disabled={!selectedFolder}
                leftSection={<IconDatabaseImport size={15} />}
                loading={loading}
                onClick={open}
              >
                Import here
              </Button>
            )}
          </ImportCellsLauncher>
          <Button
            variant="default"
            leftSection={<IconLayersIntersect size={15} />}
            disabled={!toolbarCanGroupAsReplicate}
            loading={groupAsReplicate.isPending}
            onClick={() => groupAsReplicate.mutate(buildGroupAsReplicatePayload(toolbarCells))}
          >
            Group as replicate
          </Button>
          <Button
            variant="default"
            leftSection={<IconUnlink size={15} />}
            disabled={!toolbarCanExplodeReplicate}
            loading={explodeReplicate.isPending}
            onClick={() => requestExplode(toolbarGroups)}
          >
            Explode replicate
          </Button>
          <Button
            leftSection={<IconChartLine size={15} />}
            onClick={openCreateAnalysis}
          >
            New analysis
          </Button>
        </Group>
      </Group>

      <Group align="stretch" wrap="nowrap" gap={0}>
        <Paper withBorder p="sm" style={{ flex: 1 }}>
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={700}>
                Folders
              </Text>
              <Group gap={6} wrap="nowrap">
                <Button.Group>
                  <Button size="compact-xs" variant="default" onClick={expandAll}>
                    Expand all
                  </Button>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon size="22" variant="default" aria-label="Expand options">
                        <IconChevronDown size={13} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        disabled={selectedFolderIds.length === 0}
                        onClick={expandSelected}
                      >
                        Expand selected only
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Button.Group>
                <Button.Group>
                  <Button size="compact-xs" variant="default" onClick={collapseAll}>
                    Collapse all
                  </Button>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon size="22" variant="default" aria-label="Collapse options">
                        <IconChevronDown size={13} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        disabled={selectedFolderIds.length === 0}
                        onClick={collapseSelected}
                      >
                        Collapse selected only
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Button.Group>
                <Tooltip label="New root folder">
                  <ActionIcon variant="subtle" onClick={() => openCreateFolder(null)}>
                    <IconFolderPlus size={17} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
            <ScrollArea h={650} type="auto">
              {tree.isLoading ? (
                <Text size="sm" c="dimmed">
                  Loading folders
                </Text>
              ) : folders.length ? (
                <Stack gap={2}>{folders.map((folder) => renderFolderNode(folder, 0))}</Stack>
              ) : (
                <Alert color="gray">Create a folder to start organizing cells and analyses.</Alert>
              )}
            </ScrollArea>
          </Stack>
        </Paper>

        {previewOpen ? (
          <>
            <Tooltip label="Resize preview">
              <div
                onMouseDown={startPreviewResize}
                style={{
                  width: 18,
                  cursor: "col-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "0 0 18px",
                }}
              >
                <div style={{ display: "flex", gap: 2 }}>
                  <span style={{ width: 2, height: 32, background: "var(--mantine-color-gray-4)" }} />
                  <span style={{ width: 2, height: 32, background: "var(--mantine-color-gray-4)" }} />
                  <span style={{ width: 2, height: 32, background: "var(--mantine-color-gray-4)" }} />
                </div>
              </div>
            </Tooltip>
          <Paper withBorder p="md" w={previewWidth}>
            <PreviewPanel
              selection={preview}
              selectedCell={selectedCellDetail.data}
              replicatePreview={selectedReplicatePreview.data}
              onClose={() => setPreviewOpen(false)}
            />
          </Paper>
          </>
        ) : (
          <Paper withBorder p="xs">
            <Tooltip label="Show preview">
              <ActionIcon variant="subtle" onClick={() => setPreviewOpen(true)}>
                <IconChevronLeft size={16} />
              </ActionIcon>
            </Tooltip>
          </Paper>
        )}
      </Group>

      <Menu opened={contextMenu !== null} onChange={(open) => !open && setContextMenu(null)} withinPortal>
        <Menu.Target>
          <div
            style={{
              position: "fixed",
              left: contextMenu?.x ?? 0,
              top: contextMenu?.y ?? 0,
              width: 1,
              height: 1,
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          {hasSingleFolder && (
            <Menu.Item
              onClick={() => {
                const folder = findFolder(folders, selectedFolders[0].id);
                if (folder) startRename(folder);
              }}
            >
              Rename
            </Menu.Item>
          )}
          {hasSingleAnalysis && (
            <Menu.Item
              onClick={() =>
                startAnalysisRename({
                  id: selectedAnalyses[0].id,
                  title: selectedAnalyses[0].label,
                })
              }
            >
              Rename
            </Menu.Item>
          )}
          {(hasOnlyReferences || hasOnlyFolders || hasOnlyAnalyses) && (
            <Menu.Item
              leftSection={<IconFolder size={14} />}
              onClick={() => setPlaceItemsOpen(true)}
              disabled={selectedCells.length === 0 && selectedGroups.length === 0}
            >
              Place in folders...
            </Menu.Item>
          )}
          {canGroupAsReplicate && (
            <Menu.Item
              leftSection={<IconLayersIntersect size={14} />}
              onClick={() => groupAsReplicate.mutate(buildGroupAsReplicatePayload(selectedCells))}
            >
              Group as replicate
            </Menu.Item>
          )}
          {canExplodeReplicate && (
            <Menu.Item
              leftSection={<IconUnlink size={14} />}
              onClick={() => requestExplode(selectedGroups)}
            >
              Explode replicate{selectedGroups.length === 1 ? "" : "s"}
            </Menu.Item>
          )}
          {(hasOnlyFolders || hasOnlyReferences || hasOnlyAnalyses) && <Menu.Item onClick={moveTo}>Move to...</Menu.Item>}
          {(hasOnlyFolders || hasOnlyReferences || hasOnlyAnalyses) && <Menu.Item leftSection={<IconCopy size={14} />} onClick={copyTo}>Copy to...</Menu.Item>}
          {(hasOnlyFolders || hasOnlyReferences || hasOnlyAnalyses) && (
            <Menu.Item color="red" onClick={deleteSelected}>
              {hasOnlyAnalyses ? "Delete" : "Remove"}
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>

      <AddReferencesModal
        folder={selectedFolder}
        existingCells={selectedFolder?.cell_ids ?? []}
        existingGroups={selectedFolder?.replicate_groups.map((group) => group.id) ?? []}
        opened={addReferencesOpen}
        onClose={() => setAddReferencesOpen(false)}
      />
      <PlaceInFoldersModal
        opened={placeItemsOpen}
        onClose={() => setPlaceItemsOpen(false)}
        cellIds={selectedCells.map((item) => item.id)}
        groupIds={selectedGroups.map((item) => item.id)}
        title="Place selection in folders"
      />
      <DestructiveImpactModal
        opened={impactRequest !== null}
        onClose={() => setImpactRequest(null)}
        title={impactRequest?.title ?? ""}
        confirmLabel={impactRequest?.confirmLabel ?? "Confirm"}
        plainMessage={impactRequest?.plainMessage ?? ""}
        cellIds={impactRequest?.cellIds ?? []}
        groupIds={impactRequest?.groupIds ?? []}
        onConfirm={(options) => {
          const request = impactRequest;
          setImpactRequest(null);
          if (!request) return;
          void request.run(options).catch((error: Error) =>
            notifications.show({ message: error.message, color: "red" }),
          );
        }}
      />
    </Stack>
  );

  function renderFolderNode(folder: FolderNode, depth: number) {
    const key = folderKey(folder.id);
    const selected = selectedKeys.has(key);
    const expanded = expandedFolders.has(folder.id);
    const hasChildren =
      folder.children.length +
        folder.cells.length +
        folder.replicate_groups.length +
        folder.analyses.length >
      0;
    const dropTarget = dropTargetFolderId === folder.id;
    const item: TreeItem = { key, kind: "folder", id: folder.id, folderId: folder.id, label: folder.name };
    return (
      <div
        key={folder.id}
        // The drop zone wraps the whole subtree so a drop onto any child row
        // (cell, replicate, nested folder, analysis) still files into this
        // folder — previously only a hit on the folder's own row registered.
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropTargetFolderId(folder.id);
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (dropTargetFolderId === folder.id) setDropTargetFolderId(null);
        }}
        onDrop={(event) => handleDropOnFolder(event, folder)}
      >
        <Group
          className="project-tree-row"
          justify="space-between"
          wrap="nowrap"
          p={6}
          draggable
          onDragStart={(event) => handleDragStart(event, item)}
          onDoubleClick={() => toggleFolder(folder.id)}
          onContextMenu={(event) => handleContextMenu(event, item)}
          style={{
            marginLeft: depth * 18,
            borderRadius: 6,
            cursor: "pointer",
            background: dropTarget
              ? "var(--mantine-color-teal-1)"
              : selected
                ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))"
                : undefined,
            outline: selected ? "1px solid var(--mantine-color-teal-4)" : undefined,
          }}
          onClick={(event) => handleSelect(event, item)}
        >
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              disabled={!hasChildren}
              aria-label={expanded ? "Collapse folder" : "Expand folder"}
              onClick={(event) => {
                event.stopPropagation();
                toggleFolder(folder.id);
              }}
              style={{ visibility: hasChildren ? "visible" : "hidden" }}
            >
              {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
            <IconFolder size={16} color="var(--mantine-color-teal-6)" />
            {editingFolderId === folder.id ? (
              <TextInput
                size="xs"
                value={editingFolderName}
                onChange={(event) => setEditingFolderName(event.currentTarget.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => commitRename(folder)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(folder);
                  if (event.key === "Escape") setEditingFolderId(null);
                }}
                autoFocus
                style={{ flex: 1 }}
              />
            ) : (
              <Text size="sm" fw={selected ? 700 : 500} truncate>
                {folder.name}
              </Text>
            )}
            <Badge size="xs" variant="light">
              {folder.cells.length + folder.replicate_groups.length + folder.analyses.length}
            </Badge>
          </Group>
          <Group gap={2} wrap="nowrap">
            <ActionIcon
              className="project-tree-hover-actions"
              size="sm"
              variant="subtle"
              onClick={(event) => {
                event.stopPropagation();
                openCreateFolder(folder.id);
              }}
            >
              <IconFolderPlus size={14} />
            </ActionIcon>
            <Menu withinPortal position="bottom-end">
              <Menu.Target>
                <ActionIcon size="sm" variant="subtle" onClick={(event) => event.stopPropagation()}>
                  <IconDotsVertical size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => startRename(folder)}>Rename</Menu.Item>
                <Menu.Item onClick={() => openDestination("Move to", (parentId) => moveFolder.mutate({ id: folder.id, parent_id: parentId }))}>
                  Move to...
                </Menu.Item>
                <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => openDestination("Copy to", (parentId) => copyFolder.mutate({ id: folder.id, parent_id: parentId }))}>
                  Copy to...
                </Menu.Item>
                <Menu.Item color="red" onClick={() => confirmDeleteFolder(folder)}>
                  Remove
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        {expanded && (
          <>
            {folder.children.map((child) => renderFolderNode(child, depth + 1))}
            {folder.cells.map((cell) => renderCellNode(folder, cell, depth + 1))}
            {folder.replicate_groups.map((group) => renderReplicateGroupNode(folder, group, depth + 1))}
            {folder.analyses.map((analysis) => renderAnalysisNode(folder, analysis, depth + 1))}
          </>
        )}
      </div>
    );
  }

  function renderReplicateGroupNode(
    folder: FolderNode,
    group: FolderNode["replicate_groups"][number],
    depth: number
  ) {
    const key = replicateGroupKey(folder.id, group.id);
    const selected = selectedKeys.has(key);
    const item: TreeItem = {
      key,
      kind: "replicate_group",
      id: group.id,
      folderId: folder.id,
      label: group.name,
    };
    return (
      <Group
        key={key}
        className="project-tree-row"
        justify="space-between"
        gap={6}
        wrap="nowrap"
        p={6}
        draggable
        onDragStart={(event) => handleDragStart(event, item)}
        onContextMenu={(event) => handleContextMenu(event, item)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setSelectedFolderId(folder.id);
          selectPreview({ kind: "replicate_group", id: group.id, title: group.name });
        }}
        style={{
          marginLeft: depth * 18,
          borderRadius: 6,
          cursor: "pointer",
          background: selected ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))" : undefined,
          outline: selected ? "1px solid var(--mantine-color-teal-4)" : undefined,
        }}
        onClick={(event) => handleSelect(event, item)}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconLayersIntersect size={15} color="var(--mantine-color-teal-6)" />
          <Text size="sm" fw={selected ? 700 : 400} truncate>
            {group.name}
          </Text>
          <Badge size="xs" variant="light">
            {group.cell_ids.length}
          </Badge>
        </Group>
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon className="project-tree-hover-actions" size="sm" variant="subtle" onClick={(event) => event.stopPropagation()}>
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => openDestination("Move to", (targetFolderId) => targetFolderId !== null && transferGroups(targetFolderId, false, [item]))}>
              Move to...
            </Menu.Item>
            <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => openDestination("Copy to", (targetFolderId) => targetFolderId !== null && transferGroups(targetFolderId, true, [item]))}>
              Copy to...
            </Menu.Item>
            <Menu.Item color="red" onClick={() => removeGroup.mutate({ folderId: folder.id, groupId: group.id })}>
              Remove
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  }

  function renderCellNode(folder: FolderNode, cell: FolderNode["cells"][number], depth: number) {
    const key = cellKey(folder.id, cell.id);
    const selected = selectedKeys.has(key);
    const item: TreeItem = { key, kind: "cell", id: cell.id, folderId: folder.id, label: cell.name };
    return (
      <Group
        key={key}
        className="project-tree-row"
        justify="space-between"
        wrap="nowrap"
        p={6}
        draggable
        onDragStart={(event) => handleDragStart(event, item)}
        onContextMenu={(event) => handleContextMenu(event, item)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setSelectedFolderId(folder.id);
          selectPreview({ kind: "cell", id: cell.id });
        }}
        style={{
          marginLeft: depth * 18,
          borderRadius: 6,
          cursor: "pointer",
          background: selected ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))" : undefined,
          outline: selected ? "1px solid var(--mantine-color-teal-4)" : undefined,
        }}
        onClick={(event) => handleSelect(event, item)}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconDatabase size={15} color="var(--mantine-color-gray-6)" />
          <Text size="sm" fw={selected ? 700 : 400} truncate>
            {cell.name}
          </Text>
          {cell.archived && (
            <Badge size="xs" color="gray" variant="light">
              archived
            </Badge>
          )}
        </Group>
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon className="project-tree-hover-actions" size="sm" variant="subtle" onClick={(event) => event.stopPropagation()}>
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => openDestination("Move to", (targetFolderId) => targetFolderId !== null && transferCells(targetFolderId, false, [item]))}>
              Move to...
            </Menu.Item>
            <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => openDestination("Copy to", (targetFolderId) => targetFolderId !== null && transferCells(targetFolderId, true, [item]))}>
              Copy to...
            </Menu.Item>
            <Menu.Item color="red" onClick={() => removeCell.mutate({ folderId: folder.id, cellId: cell.id })}>
              Remove
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  }

  function renderAnalysisNode(folder: FolderNode, analysis: FolderNode["analyses"][number], depth: number) {
    const key = analysisKey(folder.id, analysis.id);
    const selected = selectedKeys.has(key);
    const item: TreeItem = {
      key,
      kind: "analysis",
      id: analysis.id,
      folderId: folder.id,
      label: analysis.title,
    };
    return (
      <Group
        key={key}
        className="project-tree-row"
        justify="space-between"
        wrap="nowrap"
        p={6}
        draggable={editingAnalysisId !== analysis.id}
        onDragStart={(event) => handleDragStart(event, item)}
        onContextMenu={(event) => handleContextMenu(event, item)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          navigate(`/analyses/${analysis.id}`);
        }}
        style={{
          marginLeft: depth * 18,
          borderRadius: 6,
          cursor: "pointer",
          background: selected ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))" : undefined,
          outline: selected ? "1px solid var(--mantine-color-teal-4)" : undefined,
        }}
        onClick={(event) => handleSelect(event, item)}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <IconChartLine size={15} color="var(--mantine-color-gray-6)" />
          {editingAnalysisId === analysis.id ? (
            <TextInput
              size="xs"
              value={editingAnalysisTitle}
              onChange={(event) => setEditingAnalysisTitle(event.currentTarget.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => commitAnalysisRename(analysis)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitAnalysisRename(analysis);
                if (event.key === "Escape") setEditingAnalysisId(null);
              }}
              autoFocus
              style={{ flex: 1 }}
            />
          ) : (
            <Text size="sm" fw={selected ? 700 : 400} truncate>
              {analysis.title}
            </Text>
          )}
        </Group>
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon
              className="project-tree-hover-actions"
              size="sm"
              variant="subtle"
              onClick={(event) => event.stopPropagation()}
              aria-label={`Actions for ${analysis.title}`}
            >
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => startAnalysisRename(analysis)}>Rename</Menu.Item>
            <Menu.Item
              onClick={() =>
                openDestination("Move to", (targetFolderId) =>
                  transferAnalyses(targetFolderId, false, [item])
                )
              }
            >
              Move to...
            </Menu.Item>
            <Menu.Item
              leftSection={<IconCopy size={14} />}
              onClick={() =>
                openDestination("Copy to", (targetFolderId) =>
                  transferAnalyses(targetFolderId, true, [item])
                )
              }
            >
              Copy to...
            </Menu.Item>
            <Menu.Item
              color="red"
              onClick={() => {
                modals.openConfirmModal({
                  title: `Delete ${analysis.title}?`,
                  children: (
                    <Text size="sm">
                      This deletes the analysis and its saved plots. Cell data remains in the database.
                    </Text>
                  ),
                  labels: { confirm: "Delete", cancel: "Cancel" },
                  confirmProps: { color: "red" },
                  onConfirm: () => deleteAnalysis.mutate(analysis.id),
                });
              }}
            >
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  }
}

function FolderNameForm({
  initialName = "",
  onSubmit,
}: {
  initialName?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    modals.closeAll();
  };
  return (
    <Stack>
      <TextInput
        label="Name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        data-autofocus
      />
      <Button
        disabled={!name.trim()}
        onClick={submit}
      >
        Save
      </Button>
    </Stack>
  );
}

function DestinationForm({
  folders,
  onSubmit,
}: {
  folders: { value: string; label: string }[];
  onSubmit: (folderId: number | null) => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const submit = () => {
    onSubmit(folder ? Number(folder) : null);
    modals.closeAll();
  };
  return (
    <Stack>
      <Select
        label="Destination"
        placeholder="Top level"
        data={folders}
        value={folder}
        onChange={setFolder}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        clearable
        searchable
      />
      <Button onClick={submit}>
        Confirm
      </Button>
    </Stack>
  );
}

function AnalysisCreateForm({
  folders,
  defaultFolderId,
  defaultTitle,
  loading,
  onSubmit,
}: {
  folders: { value: string; label: string }[];
  defaultFolderId: number | null;
  defaultTitle: string;
  loading: boolean;
  onSubmit: (payload: { title: string; folder_id: number | null }) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [folder, setFolder] = useState<string | null>(
    defaultFolderId === null ? "none" : String(defaultFolderId)
  );
  const folderData = [{ value: "none", label: "No folder" }, ...folders];
  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit({ title: trimmed, folder_id: folder && folder !== "none" ? Number(folder) : null });
  };
  return (
    <Stack>
      <TextInput
        label="Title"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        data-autofocus
      />
      <Select
        label="Folder"
        data={folderData}
        value={folder}
        onChange={setFolder}
        searchable
      />
      <Button disabled={!title.trim()} loading={loading} onClick={submit}>
        Create analysis
      </Button>
    </Stack>
  );
}

function PreviewPanel({
  selection,
  selectedCell,
  replicatePreview,
  onClose,
}: {
  selection: PreviewSelection;
  selectedCell?: CellDetail;
  replicatePreview?: ReplicateGroupPreview;
  onClose: () => void;
}) {
  if (!selection) {
    return (
      <Stack>
        <Group justify="space-between">
          <Text fw={700}>Preview</Text>
          <ActionIcon variant="subtle" onClick={onClose}>
            <IconChevronRight size={16} />
          </ActionIcon>
        </Group>
        <Text size="sm" c="dimmed">
          Select a cell or analysis to preview it here.
        </Text>
      </Stack>
    );
  }
  if (selection.kind === "analysis") {
    return (
      <Stack>
        <Group justify="space-between">
          <Text fw={700}>{selection.title}</Text>
          <ActionIcon variant="subtle" onClick={onClose}>
            <IconChevronRight size={16} />
          </ActionIcon>
        </Group>
        <Alert color="gray">Analysis previews will be rebuilt with the analysis workflow.</Alert>
      </Stack>
    );
  }
  if (selection.kind === "replicate_group") {
    return (
      <ReplicatePreviewPanel
        title={selection.title}
        preview={replicatePreview}
        onClose={onClose}
      />
    );
  }
  if (!selectedCell) {
    return <Alert color="gray">Loading cell preview.</Alert>;
  }

  return (
    <Stack>
      <Group justify="space-between" align="start">
        <div>
          <Text fw={700}>{selectedCell.name}</Text>
          <Text size="xs" c="dimmed">
            {selectedCell.total_cycles} cycles - {selectedCell.n_files} file{selectedCell.n_files === 1 ? "" : "s"}
          </Text>
          <Text size="xs" c="dimmed">
            Total charge {formatCapacity(selectedCell.total_charge_capacity_mah)} - total discharge{" "}
            {formatCapacity(selectedCell.total_discharge_capacity_mah)}
          </Text>
        </div>
        <ActionIcon variant="subtle" onClick={onClose}>
          <IconChevronRight size={16} />
        </ActionIcon>
      </Group>
      <CellDetailTabs cell={selectedCell} />
    </Stack>
  );
}
