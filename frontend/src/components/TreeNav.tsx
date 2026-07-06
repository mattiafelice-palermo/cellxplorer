import {
  ActionIcon,
  Button,
  Group,
  Menu,
  NavLink,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChartLine,
  IconDots,
  IconFolder,
  IconFolderPlus,
  IconFlask,
  IconPlus,
} from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { del, FolderNode, get, patch, post, ProjectNode, Tree } from "../api";

function NewNodeForm({
  kind,
  folders,
  onSubmit,
}: {
  kind: "folder" | "project";
  folders: { value: string; label: string }[];
  onSubmit: (name: string, folderId: number | null) => void;
}) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed, parent ? Number(parent) : null);
    modals.closeAll();
  };
  return (
    <Stack>
      <TextInput
        label="Name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        data-autofocus
      />
      <Select
        label={kind === "folder" ? "Parent folder (optional)" : "Folder (optional)"}
        placeholder="Top level"
        data={folders}
        value={parent}
        onChange={setParent}
        clearable
      />
      {kind === "folder" ? (
        <Text size="xs" c="dimmed">
          Folders organize; they never compute. Filing an analysis under a folder never feeds it
          data.
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          A project is a working context: it holds references to cells, plus groups and filed
          analyses. Cells always live in the one library.
        </Text>
      )}
      <Button
        disabled={!name.trim()}
        onClick={submit}
      >
        Create
      </Button>
    </Stack>
  );
}

function flattenFolders(nodes: FolderNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((n) => [
    { value: String(n.id), label: `${"— ".repeat(depth)}${n.name}` },
    ...flattenFolders(n.children, depth + 1),
  ]);
}

export function TreeNav() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["tree"] });

  const createFolder = useMutation({
    mutationFn: (v: { name: string; parent_id: number | null }) => post("/api/folders", v),
    onSuccess: invalidate,
  });
  const createProject = useMutation({
    mutationFn: (v: { name: string; folder_id: number | null }) => post("/api/projects", v),
    onSuccess: invalidate,
  });
  const deleteFolder = useMutation({
    mutationFn: (id: number) => del(`/api/folders/${id}`),
    onSuccess: invalidate,
  });
  const deleteProject = useMutation({
    mutationFn: (id: number) => del(`/api/projects/${id}`),
    onSuccess: invalidate,
  });
  const renameNode = useMutation({
    mutationFn: (v: { kind: "folder" | "project"; id: number; name: string }) =>
      patch(`/api/${v.kind === "folder" ? "folders" : "projects"}/${v.id}`, { name: v.name }),
    onSuccess: invalidate,
  });

  const folderOptions = tree.data ? flattenFolders(tree.data.folders) : [];

  const openNew = (kind: "folder" | "project") =>
    modals.open({
      title: kind === "folder" ? "New folder" : "New project",
      children: (
        <NewNodeForm
          kind={kind}
          folders={folderOptions}
          onSubmit={(name, folderId) =>
            kind === "folder"
              ? createFolder.mutate({ name, parent_id: folderId })
              : createProject.mutate({ name, folder_id: folderId })
          }
        />
      ),
    });

  const nodeMenu = (kind: "folder" | "project", id: number, name: string) => (
    <Menu withinPortal position="bottom-end">
      <Menu.Target>
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => e.stopPropagation()}
        >
          <IconDots size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          onClick={(e) => {
            e.stopPropagation();
            const newName = window.prompt(`Rename ${kind}`, name);
            if (newName?.trim()) renameNode.mutate({ kind, id, name: newName.trim() });
          }}
        >
          Rename
        </Menu.Item>
        <Menu.Item
          color="red"
          onClick={(e) => {
            e.stopPropagation();
            modals.openConfirmModal({
              title: `Delete ${kind} “${name}”?`,
              children: (
                <Text size="sm">
                  {kind === "folder"
                    ? "Only the navigation node is deleted. Projects inside move to the top level; filed analyses become unfiled (they keep working — they live in the library)."
                    : "Only the project (a set of references) is deleted. Cells, data and analyses are untouched; analyses filed here become unfiled."}
                </Text>
              ),
              labels: { confirm: "Delete", cancel: "Cancel" },
              confirmProps: { color: "red" },
              onConfirm: () =>
                kind === "folder" ? deleteFolder.mutate(id) : deleteProject.mutate(id),
            });
          }}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  const renderProject = (p: ProjectNode) => (
    <NavLink
      key={`p${p.id}`}
      label={p.name}
      description={`${p.cell_ids.length} cells · ${p.groups.length} groups`}
      leftSection={<IconFlask size={14} />}
      rightSection={nodeMenu("project", p.id, p.name)}
      onClick={() => navigate(`/projects/${p.id}`)}
      childrenOffset={16}
    >
      {p.analyses.length > 0
        ? p.analyses.map((a) => (
            <NavLink
              key={`a${a.id}`}
              label={a.title}
              leftSection={<IconChartLine size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/analyses/${a.id}`);
              }}
            />
          ))
        : undefined}
    </NavLink>
  );

  const renderFolder = (f: FolderNode) => (
    <NavLink
      key={`f${f.id}`}
      label={f.name}
      leftSection={<IconFolder size={14} />}
      rightSection={nodeMenu("folder", f.id, f.name)}
      childrenOffset={12}
      defaultOpened
    >
      {f.children.map(renderFolder)}
      {f.projects.map(renderProject)}
      {f.analyses.map((a) => (
        <NavLink
          key={`a${a.id}`}
          label={a.title}
          leftSection={<IconChartLine size={12} />}
          onClick={() => navigate(`/analyses/${a.id}`)}
        />
      ))}
      {f.children.length + f.projects.length + f.analyses.length === 0 && (
        <Text size="xs" c="dimmed" pl="sm">
          empty
        </Text>
      )}
    </NavLink>
  );

  return (
    <Stack gap={4}>
      <Group justify="space-between" px={4}>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          Data tree
        </Text>
        <Group gap={4}>
          <Tooltip label="New folder">
            <ActionIcon size="sm" variant="subtle" onClick={() => openNew("folder")}>
              <IconFolderPlus size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="New project">
            <ActionIcon size="sm" variant="subtle" onClick={() => openNew("project")}>
              <IconPlus size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {tree.data?.folders.map(renderFolder)}
      {tree.data?.projects.map(renderProject)}
      {tree.data && tree.data.folders.length === 0 && tree.data.projects.length === 0 && (
        <Text size="xs" c="dimmed" px={4}>
          No folders or projects yet. The tree organizes your work — data always lives in the
          library.
        </Text>
      )}
      {tree.isError && (
        <Text size="xs" c="red" px={4}>
          Could not load tree — is the backend running?
        </Text>
      )}
    </Stack>
  );
}
