import {
  ActionIcon,
  Alert,
  Box,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { FolderNode } from "../api";
import {
  ancestorsOfPresentFolders,
  folderContentCount,
  folderMatchesSearch,
  type PlacementCheckbox,
} from "../folderPlacement";
import styles from "./FolderTree.module.css";

const INDENT_PX = 20;
const MAX_INDENT_DEPTH = 6;
const ROW_HEIGHT = 36;

function collectFolderIds(nodes: FolderNode[]): number[] {
  return nodes.flatMap((node) => [node.id, ...collectFolderIds(node.children)]);
}

function countAllFolders(nodes: FolderNode[]): number {
  return collectFolderIds(nodes).length;
}

/** Folders whose name matches, plus every ancestor needed to keep hierarchy. */
function visibleIdsForSearch(nodes: FolderNode[], search: string): Set<number> | null {
  const needle = search.trim();
  if (!needle) return null;
  const visible = new Set<number>();
  const walk = (node: FolderNode, ancestors: number[]): boolean => {
    const selfMatch = folderMatchesSearch(node.name, needle);
    let childMatch = false;
    for (const child of node.children) {
      if (walk(child, [...ancestors, node.id])) childMatch = true;
    }
    if (selfMatch || childMatch) {
      visible.add(node.id);
      ancestors.forEach((id) => visible.add(id));
      return true;
    }
    return false;
  };
  for (const root of nodes) walk(root, []);
  return visible;
}

function matchingBranchIds(nodes: FolderNode[], search: string): Set<number> {
  const needle = search.trim();
  const expand = new Set<number>();
  if (!needle) return expand;
  const walk = (node: FolderNode, ancestors: number[]): boolean => {
    const selfMatch = folderMatchesSearch(node.name, needle);
    let childMatch = false;
    for (const child of node.children) {
      if (walk(child, [...ancestors, node.id])) childMatch = true;
    }
    if (selfMatch || childMatch) {
      ancestors.forEach((id) => expand.add(id));
      if (childMatch || node.children.length) expand.add(node.id);
      return true;
    }
    return false;
  };
  for (const root of nodes) walk(root, []);
  return expand;
}

/**
 * Collapsible folder tree with search and optional inline create.
 * Expand/collapse state is owned here and not persisted across opens.
 */
export function FolderTree({
  folders,
  loading,
  checkedState,
  onToggle,
  highlightedId = null,
  onHighlight,
  search,
  onSearch,
  onCreateFolder,
  presentFolderIds,
  stagedIds,
  maxHeight = 420,
  showSearch,
  emptyMessage = "No folders yet. Create one below.",
  /** Bump when the owning dialog opens so expansion resets for this session. */
  sessionKey = 0,
}: {
  folders: FolderNode[];
  loading?: boolean;
  checkedState: (node: FolderNode) => PlacementCheckbox;
  onToggle: (node: FolderNode) => void;
  highlightedId?: number | null;
  onHighlight?: (node: FolderNode) => void;
  search: string;
  onSearch: (value: string) => void;
  onCreateFolder?: (name: string, parentId: number | null) => void;
  /** Folders that already hold any of the selection — used for initial expand. */
  presentFolderIds?: Set<number>;
  /** Staged folders must stay expanded while ticked. */
  stagedIds?: Set<number>;
  maxHeight?: number;
  showSearch?: boolean;
  emptyMessage?: string;
  sessionKey?: number;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);
  const totalFolders = useMemo(() => countAllFolders(folders), [folders]);
  const searchVisible = showSearch ?? totalFolders >= 10;
  const presence = presentFolderIds ?? new Set<number>();
  const staged = stagedIds ?? new Set<number>();

  // Reset expansion when the tree identity changes (dialog open / data swap).
  const folderSignature = useMemo(
    () => collectFolderIds(folders).join(","),
    [folders],
  );
  useEffect(() => {
    const next = ancestorsOfPresentFolders(folders, presence);
    for (const id of staged) {
      next.add(id);
      // Also expand ancestors of staged folders.
      ancestorsOfPresentFolders(folders, new Set([id])).forEach((ancestor) => next.add(ancestor));
    }
    setExpanded(next);
    setCreating(false);
    setDraftName("");
    // sessionKey resets expansion each time the owning dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderSignature, sessionKey]);

  // Keep staged branches open while the user ticks folders.
  useEffect(() => {
    if (!staged.size) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of staged) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
        for (const ancestor of ancestorsOfPresentFolders(folders, new Set([id]))) {
          if (!next.has(ancestor)) {
            next.add(ancestor);
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [staged, folders]);

  const visibleFilter = useMemo(
    () => visibleIdsForSearch(folders, search),
    [folders, search],
  );
  const searchExpand = useMemo(
    () => matchingBranchIds(folders, search),
    [folders, search],
  );

  useEffect(() => {
    if (!search.trim()) return;
    setExpanded((current) => {
      const next = new Set(current);
      searchExpand.forEach((id) => next.add(id));
      return next;
    });
  }, [search, searchExpand]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  const toggleExpand = (folderId: number, event: MouseEvent) => {
    event.stopPropagation();
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const commitCreate = () => {
    const name = draftName.trim();
    if (!name || !onCreateFolder) {
      setCreating(false);
      setDraftName("");
      return;
    }
    onCreateFolder(name, highlightedId);
    setCreating(false);
    setDraftName("");
  };

  const cancelCreate = () => {
    setCreating(false);
    setDraftName("");
  };

  const onCreateKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCreate();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelCreate();
    }
  };

  const renderNode = (node: FolderNode, depth: number): ReactNode => {
    if (visibleFilter && !visibleFilter.has(node.id)) return null;
    const hasChildren = node.children.length > 0;
    const isExpanded = search.trim()
      ? searchExpand.has(node.id) || expanded.has(node.id)
      : expanded.has(node.id);
    const state = checkedState(node);
    const highlighted = highlightedId === node.id;
    const indent = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX;
    const complete = state === "complete";
    const checked = state === "all" || state === "complete";
    const indeterminate = state === "some";
    const count = folderContentCount(node);

    const row = (
      <Group
        key={node.id}
        gap={6}
        wrap="nowrap"
        h={ROW_HEIGHT}
        pl={8 + indent}
        pr={8}
        className={`${styles.row}${highlighted ? ` ${styles.highlighted}` : ""}`}
      >
        <Box w={20} className={styles.chevronCell}>
          {hasChildren ? (
            <ActionIcon
              size={20}
              variant="subtle"
              color="gray"
              onClick={(event) => toggleExpand(node.id, event)}
              aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            >
              {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          ) : null}
        </Box>
        <Tooltip
          label="All selected items are already here."
          disabled={!complete}
          withArrow
        >
          <Box
            onClick={(event) => {
              event.stopPropagation();
              if (complete) return;
              onToggle(node);
              onHighlight?.(node);
            }}
            style={{ display: "flex", alignItems: "center" }}
          >
            <Checkbox
              size="xs"
              checked={checked}
              indeterminate={indeterminate}
              readOnly
              color={complete ? "gray" : "var(--mantine-primary-color-6)"}
              styles={
                complete
                  ? {
                      input: {
                        backgroundColor: "var(--mantine-color-gray-5)",
                        borderColor: "var(--mantine-color-gray-5)",
                        cursor: "default",
                      },
                      icon: { color: "white" },
                    }
                  : undefined
              }
            />
          </Box>
        </Tooltip>
        <Group
          gap={6}
          wrap="nowrap"
          style={{ flex: 1, minWidth: 0 }}
          onClick={() => onHighlight?.(node)}
        >
          <IconFolder
            size={16}
            stroke={1.5}
            color="var(--mantine-primary-color-6)"
            style={{ flexShrink: 0 }}
          />
          <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
            {node.name}
          </Text>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {count}
          </Text>
        </Group>
      </Group>
    );

    return (
      <Box key={node.id}>
        {row}
        {hasChildren && isExpanded && (
          <Stack gap={0}>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </Stack>
        )}
      </Box>
    );
  };

  if (loading) {
    return (
      <Group gap="xs" p="sm">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          Loading folders…
        </Text>
      </Group>
    );
  }

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      {searchVisible && (
        <Box p="sm" pb="xs" style={{ flexShrink: 0 }}>
          <TextInput
            placeholder="Search folders"
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(event) => onSearch(event.currentTarget.value)}
            styles={{
              input: {
                height: 36,
                minHeight: 36,
                borderRadius: 8,
                borderColor: "var(--mantine-color-gray-3)",
              },
            }}
          />
        </Box>
      )}
      <ScrollArea type="auto" style={{ flex: 1 }} mah={maxHeight} offsetScrollbars>
        <Stack gap={2} px="xs" pb="xs">
          {folders.length === 0 ? (
            <Alert color="gray" variant="light">
              {emptyMessage}
            </Alert>
          ) : (
            folders.map((node) => renderNode(node, 0))
          )}
          {onCreateFolder && (
            creating ? (
              <Box px={8} py={2}>
                <TextInput
                  ref={createInputRef}
                  placeholder="Folder name"
                  value={draftName}
                  onChange={(event) => setDraftName(event.currentTarget.value)}
                  onKeyDown={onCreateKey}
                  onBlur={commitCreate}
                  size="sm"
                  styles={{ input: { height: 32, minHeight: 32 } }}
                />
              </Box>
            ) : (
              <UnstyledButton
                onClick={() => setCreating(true)}
                px={8}
                py={6}
                style={{ borderRadius: 6 }}
              >
                <Group gap={6}>
                  <IconPlus size={14} color="var(--mantine-primary-color-6)" />
                  <Text size="xs" c="var(--mantine-primary-color-6)" fw={500}>
                    New folder
                  </Text>
                </Group>
              </UnstyledButton>
            )
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

/** Locate a folder and its ancestor chain in a tree. */
export function findFolderPath(
  roots: FolderNode[],
  folderId: number | null,
): { folder: FolderNode | null; breadcrumb: FolderNode[] } {
  if (folderId == null) return { folder: null, breadcrumb: [] };
  const path: FolderNode[] = [];
  const walk = (nodes: FolderNode[], trail: FolderNode[]): FolderNode | null => {
    for (const node of nodes) {
      const next = [...trail, node];
      if (node.id === folderId) {
        path.push(...next);
        return node;
      }
      const found = walk(node.children, next);
      if (found) return found;
    }
    return null;
  };
  const folder = walk(roots, []);
  return { folder, breadcrumb: path };
}
