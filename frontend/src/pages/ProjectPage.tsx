// Project = a working context holding REFERENCES to cells, plus groups
// (the explicit replicate concept) and analyses filed here for convenience.
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  ColorInput,
  Group,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconChartLine, IconPlus, IconTrash, IconUsersGroup, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  AnalysisFull,
  CellSummary,
  del,
  get,
  GroupInfo,
  patch,
  post,
  ProjectNode,
  Tree,
} from "../api";

function AddCellsModal({
  projectId,
  existing,
  opened,
  onClose,
}: {
  projectId: number;
  existing: number[];
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const cells = useQuery({
    queryKey: ["cells", search],
    queryFn: () =>
      get<CellSummary[]>(`/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
  const add = useMutation({
    mutationFn: () => post(`/api/projects/${projectId}/cells`, { cell_ids: selected }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      setSelected([]);
      onClose();
    },
  });
  const candidates = (cells.data ?? []).filter((c) => !existing.includes(c.id));
  return (
    <Modal opened={opened} onClose={onClose} title="Add cells from the library" size="lg">
      <Stack>
        <Text size="xs" c="dimmed">
          This adds references — the cells stay in the library and can belong to any number of
          projects and groups.
        </Text>
        <TextInput
          placeholder="Search library"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Table>
          <Table.Tbody>
            {candidates.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td w={30}>
                  <Checkbox
                    checked={selected.includes(c.id)}
                    onChange={(e) =>
                      setSelected(
                        e.currentTarget.checked
                          ? [...selected, c.id]
                          : selected.filter((x) => x !== c.id)
                      )
                    }
                  />
                </Table.Td>
                <Table.Td>{c.name}</Table.Td>
                <Table.Td>
                  {c.tags.map((t) => (
                    <Badge key={t} size="xs" variant="light" mr={4}>
                      {t}
                    </Badge>
                  ))}
                </Table.Td>
                <Table.Td>{c.total_cycles} cycles</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Button disabled={selected.length === 0} onClick={() => add.mutate()}>
          Add {selected.length} cell(s)
        </Button>
      </Stack>
    </Modal>
  );
}

function GroupEditor({
  projectId,
  group,
  projectCells,
  onDone,
}: {
  projectId: number;
  group: GroupInfo | null;
  projectCells: CellSummary[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? "");
  const [members, setMembers] = useState<number[]>(group?.cell_ids ?? []);

  const save = useMutation({
    mutationFn: () =>
      group
        ? patch(`/api/groups/${group.id}`, { name, color: color || null, cell_ids: members })
        : post(`/api/projects/${projectId}/groups`, {
            name,
            color: color || null,
            cell_ids: members,
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      onDone();
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  return (
    <Stack>
      <Text size="xs" c="dimmed">
        A group is a thin, named, ordered set of cell references — your replicates (e.g.
        “Formulation A” = 3 cells). A cell can be in many groups.
      </Text>
      <Group grow>
        <TextInput
          label="Group name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
        />
        <ColorInput label="Display color (optional)" value={color} onChange={setColor} />
      </Group>
      <Text size="sm" fw={600}>
        Members ({members.length})
      </Text>
      <Table>
        <Table.Tbody>
          {projectCells.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td w={30}>
                <Checkbox
                  checked={members.includes(c.id)}
                  onChange={(e) =>
                    setMembers(
                      e.currentTarget.checked
                        ? [...members, c.id]
                        : members.filter((x) => x !== c.id)
                    )
                  }
                />
              </Table.Td>
              <Table.Td>{c.name}</Table.Td>
              <Table.Td>{c.total_cycles} cycles</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Button disabled={!name.trim()} onClick={() => save.mutate()}>
        {group ? "Save group" : "Create group"}
      </Button>
    </Stack>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  const pid = Number(projectId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const project = useMemo(() => {
    if (!tree.data) return null;
    const all: ProjectNode[] = [...tree.data.projects];
    const walk = (folders: Tree["folders"]) =>
      folders.forEach((f) => {
        all.push(...f.projects);
        walk(f.children);
      });
    walk(tree.data.folders);
    return all.find((p) => p.id === pid) ?? null;
  }, [tree.data, pid]);

  const cells = useQuery({
    queryKey: ["cells", "project", pid],
    queryFn: () => get<CellSummary[]>(`/api/cells?project_id=${pid}&include_archived=true`),
    enabled: project !== null,
  });

  const removeCell = useMutation({
    mutationFn: (cellId: number) => del(`/api/projects/${pid}/cells/${cellId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["cells", "project", pid] });
    },
  });
  const deleteGroup = useMutation({
    mutationFn: (groupId: number) => del(`/api/groups/${groupId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tree"] }),
  });
  const newAnalysis = useMutation({
    mutationFn: () =>
      post<AnalysisFull>("/api/analyses", { title: `${project?.name} analysis`, project_id: pid }),
    onSuccess: (a) => navigate(`/analyses/${a.id}`),
  });

  if (tree.isLoading) return null;
  if (!project) return <Alert color="red">Project not found.</Alert>;

  const projectCells = cells.data ?? [];
  const cellById = new Map(projectCells.map((c) => [c.id, c]));

  const openGroupEditor = (group: GroupInfo | null) =>
    modals.open({
      title: group ? `Edit group “${group.name}”` : "New group",
      size: "lg",
      children: (
        <GroupEditor
          projectId={pid}
          group={group}
          projectCells={projectCells}
          onDone={() => modals.closeAll()}
        />
      ),
    });

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3}>{project.name}</Title>
          {project.description && (
            <Text size="sm" c="dimmed">
              {project.description}
            </Text>
          )}
        </div>
        <Button
          leftSection={<IconChartLine size={16} />}
          onClick={() => newAnalysis.mutate()}
          variant="light"
        >
          New analysis filed here
        </Button>
      </Group>

      <Group align="start" grow>
        <Paper p="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Cells ({projectCells.length})</Text>
            <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={() => setAddOpen(true)}>
              Add from library
            </Button>
          </Group>
          {projectCells.length === 0 ? (
            <Text size="sm" c="dimmed">
              No cells referenced yet.
            </Text>
          ) : (
            <Table highlightOnHover>
              <Table.Tbody>
                {projectCells.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>{c.name}</Table.Td>
                    <Table.Td>{c.total_cycles} cycles</Table.Td>
                    <Table.Td>
                      {c.archived && (
                        <Badge size="xs" color="gray">
                          archived
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td w={40}>
                      <Tooltip label="Remove reference (cell stays in library; analyses unaffected)">
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          onClick={() => removeCell.mutate(c.id)}
                        >
                          <IconX size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Paper>

        <Paper p="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Groups ({project.groups.length})</Text>
            <Button
              size="compact-xs"
              leftSection={<IconUsersGroup size={12} />}
              onClick={() => openGroupEditor(null)}
            >
              New group
            </Button>
          </Group>
          {project.groups.length === 0 ? (
            <Text size="sm" c="dimmed">
              No groups yet. Groups are your replicate sets — cells you'll plot together as
              mean ± band.
            </Text>
          ) : (
            <Stack gap="xs">
              {project.groups.map((g) => (
                <Paper key={g.id} p="xs" withBorder>
                  <Group justify="space-between">
                    <Group gap={8}>
                      {g.color && (
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: 3,
                            background: g.color,
                          }}
                        />
                      )}
                      <Text fw={600} size="sm">
                        {g.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {g.cell_ids.map((id) => cellById.get(id)?.name ?? `#${id}`).join(", ")}
                      </Text>
                    </Group>
                    <Group gap={4}>
                      <Button size="compact-xs" variant="subtle" onClick={() => openGroupEditor(g)}>
                        Edit
                      </Button>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => deleteGroup.mutate(g.id)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        </Paper>
      </Group>

      <Paper p="md" withBorder>
        <Text fw={600} mb="xs">
          Analyses filed here ({project.analyses.length})
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          Filing is co-location only: these analyses can reference cells from anywhere in the
          library, and analyses elsewhere can reference this project's cells.
        </Text>
        {project.analyses.map((a) => (
          <Button
            key={a.id}
            variant="subtle"
            size="compact-sm"
            leftSection={<IconChartLine size={14} />}
            onClick={() => navigate(`/analyses/${a.id}`)}
          >
            {a.title}
          </Button>
        ))}
      </Paper>

      <AddCellsModal
        projectId={pid}
        existing={project.cell_ids}
        opened={addOpen}
        onClose={() => setAddOpen(false)}
      />
    </Stack>
  );
}
