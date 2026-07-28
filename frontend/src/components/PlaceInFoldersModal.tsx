import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconBattery,
  IconFolder,
  IconLayersIntersect,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  get,
  post,
  type CellSummary,
  type FolderNode,
  type ReplicateGroupSummary,
  type Tree,
} from "../api";
import {
  placementCanApply,
  placementCheckboxState,
  placementFooterSummary,
  placementItemStatus,
  type PlacementCheckbox,
} from "../folderPlacement";
import { findFolderPath, FolderTree } from "./FolderTree";

const EMPTY_FOLDERS: FolderNode[] = [];

type SelectedItem =
  | { kind: "cell"; id: number; name: string }
  | { kind: "group"; id: number; name: string };

function presentInFolder(
  node: FolderNode,
  cellIds: number[],
  groupIds: number[],
): { count: number; cellIds: number[]; groupIds: number[] } {
  const presentCells = cellIds.filter((id) => node.cell_ids.includes(id));
  const presentGroups = groupIds.filter((id) =>
    node.replicate_groups.some((group) => group.id === id),
  );
  return {
    count: presentCells.length + presentGroups.length,
    cellIds: presentCells,
    groupIds: presentGroups,
  };
}

/**
 * Additive folder picker: stage folders to file cells/replicate groups into.
 * Removal is intentionally out of scope — use the Projects tree for that.
 */
export function PlaceInFoldersModal({
  opened,
  onClose,
  cellIds = [],
  groupIds = [],
  title = "Place in folders",
  onSaved,
}: {
  opened: boolean;
  onClose: () => void;
  cellIds?: number[];
  groupIds?: number[];
  title?: string;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const tree = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
    enabled: opened,
  });
  const cells = useQuery({
    queryKey: ["cells", ""],
    queryFn: () => get<CellSummary[]>("/api/cells"),
    enabled: opened && cellIds.length > 0,
    staleTime: 60_000,
  });
  const groups = useQuery({
    queryKey: ["replicate-groups", ""],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
    enabled: opened && groupIds.length > 0,
    staleTime: 60_000,
  });

  const [staged, setStaged] = useState<Set<number>>(new Set());
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sessionKey, setSessionKey] = useState(0);

  // Reset staging only when the dialog opens — never on cellIds/groupIds identity.
  useEffect(() => {
    if (!opened) return;
    setStaged(new Set());
    setSearch("");
    setHighlightedId(null);
    setSessionKey((value) => value + 1);
  }, [opened]);

  const roots = tree.data?.folders ?? EMPTY_FOLDERS;
  const selectionSize = cellIds.length + groupIds.length;

  const selectedItems: SelectedItem[] = useMemo(() => {
    const cellNames = new Map((cells.data ?? []).map((cell) => [cell.id, cell.name]));
    const groupNames = new Map((groups.data ?? []).map((group) => [group.id, group.name]));
    // Fall back to names found on the tree when list queries are still loading.
    for (const folder of flattenAll(roots)) {
      for (const cell of folder.cells) {
        if (!cellNames.has(cell.id)) cellNames.set(cell.id, cell.name);
      }
      for (const group of folder.replicate_groups) {
        if (!groupNames.has(group.id)) groupNames.set(group.id, group.name);
      }
    }
    return [
      ...cellIds.map((id) => ({
        kind: "cell" as const,
        id,
        name: cellNames.get(id) ?? `Cell #${id}`,
      })),
      ...groupIds.map((id) => ({
        kind: "group" as const,
        id,
        name: groupNames.get(id) ?? `Replicate #${id}`,
      })),
    ];
  }, [cellIds, groupIds, cells.data, groups.data, roots]);

  const presentFolderIds = useMemo(() => {
    const ids = new Set<number>();
    for (const folder of flattenAll(roots)) {
      if (presentInFolder(folder, cellIds, groupIds).count > 0) ids.add(folder.id);
    }
    return ids;
  }, [roots, cellIds, groupIds]);

  // Initial highlight: first folder that already holds any selected item.
  useEffect(() => {
    if (!opened || highlightedId != null) return;
    const first = [...presentFolderIds][0];
    if (first != null) setHighlightedId(first);
  }, [opened, presentFolderIds, highlightedId]);

  const checkboxFor = (node: FolderNode): PlacementCheckbox => {
    const { count } = presentInFolder(node, cellIds, groupIds);
    return placementCheckboxState(count, selectionSize, staged.has(node.id));
  };

  const toggle = (node: FolderNode) => {
    const state = checkboxFor(node);
    if (state === "complete") return;
    setStaged((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  const { itemsAdded, foldersReceiving, addPlan } = useMemo(() => {
    const itemsTouched = new Set<string>();
    let folders = 0;
    const plan: { folderId: number; cellIds: number[]; groupIds: number[] }[] = [];
    const byId = new Map(flattenAll(roots).map((folder) => [folder.id, folder]));
    for (const folderId of staged) {
      const node = byId.get(folderId);
      if (!node) continue;
      const present = presentInFolder(node, cellIds, groupIds);
      if (present.count >= selectionSize) continue;
      const addCells = cellIds.filter((id) => !node.cell_ids.includes(id));
      const addGroups = groupIds.filter(
        (id) => !node.replicate_groups.some((group) => group.id === id),
      );
      if (!addCells.length && !addGroups.length) continue;
      folders += 1;
      for (const id of addCells) itemsTouched.add(`cell:${id}`);
      for (const id of addGroups) itemsTouched.add(`group:${id}`);
      plan.push({ folderId, cellIds: addCells, groupIds: addGroups });
    }
    return {
      itemsAdded: itemsTouched.size,
      foldersReceiving: folders,
      addPlan: plan,
    };
  }, [staged, roots, cellIds, groupIds, selectionSize]);

  const footer = placementFooterSummary({
    selectionEmpty: selectionSize === 0,
    itemsAdded,
    foldersReceiving,
  });
  const canApply = placementCanApply(itemsAdded, foldersReceiving);

  const save = useMutation({
    mutationFn: async () => {
      for (const entry of addPlan) {
        if (entry.cellIds.length) {
          await post(`/api/folders/${entry.folderId}/cells`, {
            cell_ids: entry.cellIds,
          });
        }
        if (entry.groupIds.length) {
          await post(`/api/folders/${entry.folderId}/replicate-groups`, {
            group_ids: entry.groupIds,
          });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      notifications.show({
        color: "teal",
        message: footer,
      });
      onSaved?.();
      onClose();
    },
    onError: (error: Error) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      notifications.show({ message: error.message, color: "red" });
    },
  });

  const createFolder = useMutation({
    mutationFn: (body: { name: string; parent_id: number | null }) =>
      post<{ id: number; name: string; parent_id: number | null }>("/api/folders", body),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ["tree"] });
      setStaged((current) => new Set(current).add(created.id));
      setHighlightedId(created.id);
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const { folder: highlighted, breadcrumb } = findFolderPath(roots, highlightedId);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      centered
      withCloseButton={false}
      padding={0}
      radius={12}
      size={900}
      shadow="0 8px 32px rgba(0,0,0,0.12)"
      styles={{
        content: { height: 640, maxHeight: "calc(100vh - 2rem)", display: "flex", flexDirection: "column" },
        body: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 0 },
      }}
    >
      <Group
        justify="space-between"
        align="flex-start"
        px="md"
        py="sm"
        style={{
          height: 56,
          borderBottom: "1px solid var(--mantine-color-gray-2)",
          flexShrink: 0,
        }}
      >
        <div>
          <Text size="lg" fw={700} lh={1.3}>
            {title}
          </Text>
          <Text size="xs" c="dimmed">
            Tick the folders these items should be filed into.
          </Text>
        </div>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          px={6}
          onClick={onClose}
          aria-label="Close"
        >
          <IconX size={16} />
        </Button>
      </Group>

      <Group
        align="stretch"
        gap={0}
        wrap="nowrap"
        style={{ flex: 1, minHeight: 0, height: 520 }}
      >
        <Box
          w={380}
          style={{
            borderRight: "1px solid var(--mantine-color-gray-2)",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <FolderTree
            folders={roots}
            loading={tree.isLoading}
            checkedState={checkboxFor}
            onToggle={toggle}
            highlightedId={highlightedId}
            onHighlight={(node) => setHighlightedId(node.id)}
            search={search}
            onSearch={setSearch}
            onCreateFolder={(name, parentId) =>
              createFolder.mutate({ name, parent_id: parentId })
            }
            presentFolderIds={presentFolderIds}
            stagedIds={staged}
            maxHeight={460}
            sessionKey={sessionKey}
            emptyMessage="No folders yet. Create one below."
          />
        </Box>

        <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {highlighted ? (
            <>
              <Box px="md" pt="md" pb="sm">
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <ThemeIcon size={36} radius="md" variant="light" color="var(--mantine-primary-color-6)">
                    <IconFolder size={22} />
                  </ThemeIcon>
                  <div style={{ minWidth: 0 }}>
                    <Text size="lg" fw={700} truncate>
                      {highlighted.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {breadcrumb.map((node) => node.name).join(" › ")}
                    </Text>
                  </div>
                </Group>
              </Box>
              <Divider color="gray.2" />
              <Stack gap={0} style={{ flex: 1, overflow: "auto" }}>
                {selectedItems.map((item) => {
                  const isPresent =
                    item.kind === "cell"
                      ? highlighted.cell_ids.includes(item.id)
                      : highlighted.replicate_groups.some((group) => group.id === item.id);
                  const status = placementItemStatus(
                    isPresent,
                    staged.has(highlighted.id),
                  );
                  return (
                    <Group
                      key={`${item.kind}-${item.id}`}
                      justify="space-between"
                      wrap="nowrap"
                      px="md"
                      h={44}
                      style={{
                        borderBottom: "1px solid var(--mantine-color-gray-1)",
                      }}
                    >
                      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                        {item.kind === "cell" ? (
                          <IconBattery
                            size={18}
                            color="var(--mantine-primary-color-6)"
                            style={{ flexShrink: 0 }}
                          />
                        ) : (
                          <IconLayersIntersect
                            size={18}
                            color="var(--mantine-primary-color-6)"
                            style={{ flexShrink: 0 }}
                          />
                        )}
                        <Text size="sm" truncate>
                          {item.name}
                        </Text>
                      </Group>
                      <StatusPill status={status} />
                    </Group>
                  );
                })}
              </Stack>
              <Text size="xs" c="dimmed" px="md" py="sm">
                To take items out of a folder, open it in Projects.
              </Text>
            </>
          ) : (
            <Group justify="center" align="center" style={{ flex: 1 }}>
              <Text size="sm" c="dimmed" ta="center" maw={240}>
                Select a folder to see how it is affected.
              </Text>
            </Group>
          )}
        </Box>
      </Group>

      <Group
        justify="space-between"
        px="md"
        style={{
          height: 64,
          borderTop: "1px solid var(--mantine-color-gray-2)",
          background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          flexShrink: 0,
        }}
      >
        <Text size="sm" c={canApply ? "dark.4" : "dimmed"}>
          {footer}
        </Text>
        <Group gap="xs">
          <Button variant="default" h={38} onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="var(--mantine-primary-color-6)"
            h={38}
            fw={600}
            loading={save.isPending}
            disabled={!canApply || save.isPending}
            onClick={() => save.mutate()}
          >
            Apply
          </Button>
        </Group>
      </Group>
    </Modal>
  );
}

function StatusPill({ status }: { status: ReturnType<typeof placementItemStatus> }) {
  if (status === "already") {
    return (
      <Badge
        size="md"
        radius="xl"
        variant="filled"
        color="gray"
        styles={{
          root: {
            height: 26,
            background: "light-dark(#F1F3F5, var(--mantine-color-dark-5))",
            color: "light-dark(#495057, var(--mantine-color-gray-3))",
            textTransform: "none",
            fontWeight: 500,
            fontSize: 12,
          },
        }}
      >
        Already here
      </Badge>
    );
  }
  if (status === "will_add") {
    return (
      <Badge
        size="md"
        radius="xl"
        variant="filled"
        styles={{
          root: {
            height: 26,
            background: "var(--mantine-primary-color-1)",
            color: "var(--mantine-primary-color-8)",
            textTransform: "none",
            fontWeight: 500,
            fontSize: 12,
          },
        }}
      >
        Will be added
      </Badge>
    );
  }
  return (
    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
      Not here
    </Text>
  );
}

function flattenAll(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenAll(node.children)]);
}
