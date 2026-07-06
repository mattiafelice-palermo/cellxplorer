import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Collapse,
  Code,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconDatabase,
  IconEye,
  IconLayersIntersect,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUnlink,
  IconUpload,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import {
  CellDetail,
  CellSummary,
  del,
  get,
  post,
  ReplicateGroupPreview,
  ReplicateGroupSummary,
  SourceFile,
} from "../api";
import { CellQuickPlot } from "../components/CellQuickPlot";
import { ReplicatePreviewPanel } from "../components/ReplicatePreviewPanel";
import { ImportCellsLauncher } from "./InboxPage";

function statusColor(status: string) {
  if (status === "parsed" || status === "online") return "teal";
  if (status === "changed") return "orange";
  if (status === "error" || status === "offline") return "red";
  return "gray";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatCapacity(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)} mAh`;
}

export function LibraryPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [replicateSearch, setReplicateSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCellIds, setSelectedCellIds] = useState<Set<number>>(new Set());
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [addToGroupDialogOpen, setAddToGroupDialogOpen] = useState(false);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [previewGroupId, setPreviewGroupId] = useState<number | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);

  const cells = useQuery({
    queryKey: ["cells", search],
    queryFn: () => get<CellSummary[]>(`/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });

  const detail = useQuery({
    queryKey: ["cell", selectedId],
    queryFn: () => get<CellDetail>(`/api/cells/${selectedId}`),
    enabled: selectedId !== null,
  });

  const replicateGroups = useQuery({
    queryKey: ["replicate-groups", replicateSearch],
    queryFn: () =>
      get<ReplicateGroupSummary[]>(
        `/api/replicate-groups${
          replicateSearch ? `?search=${encodeURIComponent(replicateSearch)}` : ""
        }`
      ),
  });

  const replicatePreview = useQuery({
    queryKey: ["replicate-preview", previewGroupId],
    queryFn: () => get<ReplicateGroupPreview>(`/api/replicate-groups/${previewGroupId}/preview`),
    enabled: previewGroupId !== null,
  });

  const removeCell = useMutation({
    mutationFn: (cell: CellSummary | CellDetail) =>
      del<{ ok: boolean }>(`/api/cells/${cell.id}`),
    onSuccess: (_, cell) => {
      notifications.show({ message: `Removed ${cell.name} from the library`, color: "teal" });
      setSelectedId(null);
      setSelectedCellIds((current) => {
        const next = new Set(current);
        next.delete(cell.id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell", cell.id] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const createReplicateGroup = useMutation({
    mutationFn: (body: { name: string; cell_ids: number[] }) =>
      post<ReplicateGroupSummary>("/api/replicate-groups", body),
    onSuccess: (group) => {
      notifications.show({ message: `Created replicate group ${group.name}`, color: "teal" });
      setGroupDialogOpen(false);
      setGroupName("");
      setSelectedCellIds(new Set());
      setPreviewGroupId(group.id);
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const addCellsToReplicateGroup = useMutation({
    mutationFn: (body: { groupId: number; cell_ids: number[] }) =>
      post<ReplicateGroupSummary & { added_cell_ids: number[]; skipped_cell_ids: number[] }>(
        `/api/replicate-groups/${body.groupId}/cells`,
        { cell_ids: body.cell_ids }
      ),
    onSuccess: (group) => {
      notifications.show({
        message: `Added ${group.added_cell_ids.length} cell${group.added_cell_ids.length === 1 ? "" : "s"} to ${group.name}`,
        color: "teal",
      });
      setAddToGroupDialogOpen(false);
      setTargetGroupId(null);
      setSelectedCellIds(new Set());
      setPreviewGroupId(group.id);
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const ungroupReplicates = useMutation({
    mutationFn: (body: { cell_ids?: number[]; group_ids?: number[] }) =>
      post<{ ok: boolean }>("/api/replicate-groups/ungroup", body),
    onSuccess: () => {
      notifications.show({ message: "Replicate grouping removed", color: "teal" });
      setSelectedCellIds(new Set());
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const updateSource = useMutation({
    mutationFn: (file: SourceFile) =>
      post<SourceFile>(`/api/files/${file.id}/update-from-source`, {}),
    onSuccess: (_, file) => {
      notifications.show({ message: `Updated ${file.filename} from source`, color: "teal" });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell", selectedId] });
      if (selectedId !== null) qc.invalidateQueries({ queryKey: ["cell-cycles", selectedId] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const checkSources = useMutation({
    mutationFn: (cellIds: number[]) =>
      post<{
        checked: number;
        skipped_complete: number;
        changed: number;
        offline: number;
        online: number;
        changed_file_ids: number[];
      }>("/api/cells/check-sources", {
        cell_ids: cellIds.length ? cellIds : null,
      }),
    onSuccess: (result) => {
      notifications.show({
        message: `Checked ${result.checked} source file${result.checked === 1 ? "" : "s"} (${result.changed} changed, ${result.offline} offline).`,
        color: result.changed || result.offline ? "orange" : "teal",
      });
      if (result.skipped_complete) {
        notifications.show({
          message: `Skipped ${result.skipped_complete} completed cell${result.skipped_complete === 1 ? "" : "s"}.`,
          color: "gray",
        });
      }
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const updateChangedSources = useMutation({
    mutationFn: (cellIds: number[]) =>
      post<{
        updated: number;
        updated_file_ids: number[];
        skipped_complete: number;
        errors: { file_id: number; filename: string; error: string }[];
      }>("/api/cells/update-changed-sources", {
        cell_ids: cellIds.length ? cellIds : null,
      }),
    onSuccess: (result) => {
      notifications.show({
        message: `Updated ${result.updated} changed source file${result.updated === 1 ? "" : "s"}.`,
        color: result.errors.length ? "orange" : "teal",
      });
      result.errors.forEach((error) =>
        notifications.show({ message: `${error.filename}: ${error.error}`, color: "red" })
      );
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell"] });
      qc.invalidateQueries({ queryKey: ["cell-cycles"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const setCellStatus = useMutation({
    mutationFn: (body: { cellIds: number[]; cyclingStatus: "active" | "complete" }) =>
      post<{ updated: number; cycling_status: "active" | "complete" }>("/api/cells/status", {
        cell_ids: body.cellIds,
        cycling_status: body.cyclingStatus,
      }),
    onSuccess: (result) => {
      notifications.show({
        message: `Marked ${result.updated} cell${result.updated === 1 ? "" : "s"} as ${result.cycling_status === "complete" ? "complete" : "active"}.`,
        color: "teal",
      });
      setSelectedCellIds(new Set());
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const confirmRemove = (cell: CellSummary | CellDetail) => {
    const emptiedGroups = (replicateGroups.data ?? []).filter(
      (group) => group.cell_ids.includes(cell.id) && group.cell_ids.length === 1
    );
    const suffix = emptiedGroups.length
      ? `\n\nThis will also remove empty replicate group${emptiedGroups.length === 1 ? "" : "s"}: ${emptiedGroups
          .map((group) => group.name)
          .join(", ")}.`
      : "";
    if (window.confirm(`Remove ${cell.name} from the library?${suffix}`)) {
      removeCell.mutate(cell);
    }
  };

  const totals = useMemo(() => {
    const rows = cells.data ?? [];
    return {
      cells: rows.length,
      files: rows.reduce((sum, cell) => sum + cell.n_files, 0),
      cycles: rows.reduce((sum, cell) => sum + cell.total_cycles, 0),
      charge: rows.reduce((sum, cell) => sum + (cell.total_charge_capacity_mah ?? 0), 0),
      discharge: rows.reduce((sum, cell) => sum + (cell.total_discharge_capacity_mah ?? 0), 0),
      warnings: rows.filter((cell) => cell.has_changed || cell.has_offline).length,
    };
  }, [cells.data]);

  const selectedIds = useMemo(() => Array.from(selectedCellIds), [selectedCellIds]);
  const selectedCells = useMemo(
    () => (cells.data ?? []).filter((cell) => selectedCellIds.has(cell.id)),
    [cells.data, selectedCellIds]
  );
  const changedCells = useMemo(
    () => (cells.data ?? []).filter((cell) => cell.has_changed),
    [cells.data]
  );
  const changedCellsInScope =
    selectedCellIds.size > 0
      ? selectedCells.filter((cell) => cell.has_changed).length
      : changedCells.length;
  const allVisibleSelected =
    (cells.data?.length ?? 0) > 0 && (cells.data ?? []).every((cell) => selectedCellIds.has(cell.id));
  const groupsByCellId = useMemo(() => {
    const map = new Map<number, ReplicateGroupSummary[]>();
    (replicateGroups.data ?? []).forEach((group) => {
      group.cell_ids.forEach((cellId) => {
        const rows = map.get(cellId) ?? [];
        rows.push(group);
        map.set(cellId, rows);
      });
    });
    return map;
  }, [replicateGroups.data]);
  const previewGroup = (replicateGroups.data ?? []).find((group) => group.id === previewGroupId) ?? null;
  const replicateSelectData = useMemo(
    () => (replicateGroups.data ?? []).map((group) => ({ value: String(group.id), label: group.name })),
    [replicateGroups.data]
  );

  const toggleCellSelection = (cellId: number) => {
    setSelectedCellIds((current) => {
      const next = new Set(current);
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
  };

  return (
    <Stack>
      <Group justify="space-between" align="end">
        <div>
          <Title order={3}>Cell Database</Title>
          <Text size="sm" c="dimmed">
            Flat repository of imported cells, cached cycling data, and source-file status.
          </Text>
        </div>
        <Group gap="xs" justify="end">
          <ImportCellsLauncher
            targetFolderId={null}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ["cells"] });
              qc.invalidateQueries({ queryKey: ["replicate-groups"] });
              qc.invalidateQueries({ queryKey: ["tree"] });
            }}
          >
            {({ open, loading }) => (
              <Button
                size="sm"
                leftSection={<IconUpload size={15} />}
                loading={loading}
                onClick={open}
              >
              Load cell files
            </Button>
            )}
          </ImportCellsLauncher>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconRefresh size={15} />}
            loading={checkSources.isPending}
            disabled={(cells.data ?? []).length === 0}
            onClick={() => checkSources.mutate(selectedIds)}
          >
            Check sources
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconRefresh size={15} />}
            loading={updateChangedSources.isPending}
            disabled={changedCellsInScope === 0}
            onClick={() => updateChangedSources.mutate(selectedIds)}
          >
            Update changed{changedCellsInScope ? ` (${changedCellsInScope})` : ""}
          </Button>
          {selectedCellIds.size > 0 && (
            <>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconLayersIntersect size={15} />}
                disabled={selectedCellIds.size < 2}
                onClick={() => {
                  setGroupName(
                    selectedCells.length > 0
                      ? `${selectedCells[0].name} replicates`
                      : "Replicate group"
                  );
                  setGroupDialogOpen(true);
                }}
              >
                Group as replicates
              </Button>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconLayersIntersect size={15} />}
                disabled={(replicateGroups.data ?? []).length === 0}
                onClick={() => {
                  setTargetGroupId(null);
                  setAddToGroupDialogOpen(true);
                }}
              >
                Add to replicate
              </Button>
              <Button
                variant="subtle"
                size="sm"
                leftSection={<IconUnlink size={15} />}
                loading={ungroupReplicates.isPending}
                onClick={() => ungroupReplicates.mutate({ cell_ids: selectedIds })}
              >
                Separate
              </Button>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconCircleCheck size={15} />}
                loading={setCellStatus.isPending}
                onClick={() =>
                  setCellStatus.mutate({ cellIds: selectedIds, cyclingStatus: "complete" })
                }
              >
                Mark complete
              </Button>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconPlayerPlay size={15} />}
                loading={setCellStatus.isPending}
                onClick={() =>
                  setCellStatus.mutate({ cellIds: selectedIds, cyclingStatus: "active" })
                }
              >
                Mark active
              </Button>
            </>
          )}
          <TextInput
            leftSection={<IconSearch size={15} />}
            placeholder="Search cells"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </Group>
      </Group>

      <Group grow>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">Cells</Text>
          <Text fw={700}>{totals.cells}</Text>
        </Paper>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            Files
          </Text>
          <Text fw={700}>{totals.files}</Text>
        </Paper>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            Cached cycles
          </Text>
          <Text fw={700}>{totals.cycles}</Text>
        </Paper>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            Total charge
          </Text>
          <Text fw={700}>{formatCapacity(totals.charge)}</Text>
        </Paper>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            Total discharge
          </Text>
          <Text fw={700}>{formatCapacity(totals.discharge)}</Text>
        </Paper>
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            Warnings
          </Text>
          <Text fw={700}>{totals.warnings}</Text>
        </Paper>
      </Group>

      {cells.isLoading ? (
        <Center h={360}>
          <Loader color="teal" />
        </Center>
      ) : cells.isError ? (
        <Alert color="red">Could not load the cell library.</Alert>
      ) : (cells.data ?? []).length === 0 ? (
        <Paper withBorder p="lg">
          <Group gap="lg" align="start">
            <IconDatabase size={34} color="var(--mantine-color-teal-6)" />
            <Stack gap={6}>
              <Text fw={700}>No cells in the library yet</Text>
              <Text size="sm" c="dimmed" maw={720}>
                Import a Neware file to create the first cell. The parsed cycle cache will appear
                here after import.
              </Text>
            </Stack>
          </Group>
        </Paper>
      ) : (
        <Paper withBorder>
          <ScrollArea type="auto">
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={42}>
                    <Checkbox
                      aria-label="Select visible cells"
                      checked={allVisibleSelected}
                      indeterminate={selectedCellIds.size > 0 && !allVisibleSelected}
                      onChange={(event) =>
                        setSelectedCellIds(
                          event.currentTarget.checked
                            ? new Set((cells.data ?? []).map((cell) => cell.id))
                            : new Set()
                        )
                      }
                    />
                  </Table.Th>
                  <Table.Th>Cell</Table.Th>
                  <Table.Th>Tests</Table.Th>
                  <Table.Th>Files</Table.Th>
                  <Table.Th>Cycles</Table.Th>
                  <Table.Th>Total charge</Table.Th>
                  <Table.Th>Total discharge</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(cells.data ?? []).map((cell) => {
                  const cellGroups = groupsByCellId.get(cell.id) ?? [];
                  return (
                  <Table.Tr key={cell.id} bg={selectedCellIds.has(cell.id) ? "teal.0" : undefined}>
                    <Table.Td>
                      <Checkbox
                        aria-label={`Select ${cell.name}`}
                        checked={selectedCellIds.has(cell.id)}
                        onChange={() => toggleCellSelection(cell.id)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text fw={700}>{cell.name}</Text>
                      {cell.description && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {cell.description}
                        </Text>
                      )}
                      {cellGroups.length > 0 && (
                        <Group gap={4} mt={4}>
                          {cellGroups.map((group) => (
                            <Badge
                              key={group.id}
                              size="xs"
                              color="teal"
                              variant="light"
                              leftSection={<IconLayersIntersect size={10} />}
                            >
                              {group.name}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>{cell.n_tests}</Table.Td>
                    <Table.Td>{cell.n_files}</Table.Td>
                    <Table.Td>{cell.total_cycles}</Table.Td>
                    <Table.Td>{formatCapacity(cell.total_charge_capacity_mah)}</Table.Td>
                    <Table.Td>{formatCapacity(cell.total_discharge_capacity_mah)}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {cell.cycling_status === "complete" && (
                          <Badge color="gray" variant="light">
                            complete
                          </Badge>
                        )}
                        {cell.has_changed && (
                          <Badge color="orange" variant="light">
                            changed
                          </Badge>
                        )}
                        {cell.has_offline && (
                          <Badge color="red" variant="light">
                            offline
                          </Badge>
                        )}
                        {!cell.has_changed && !cell.has_offline && cell.cycling_status !== "complete" && (
                          <Badge color="teal" variant="light">
                            ready
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(cell.created_at)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="end">
                      <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconEye size={14} />}
                        onClick={() => {
                          setMetadataOpen(false);
                          setSelectedId(cell.id);
                        }}
                      >
                        Open
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        loading={removeCell.isPending}
                        onClick={() => confirmRemove(cell)}
                      >
                        Remove
                      </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      {((replicateGroups.data?.length ?? 0) > 0 || replicateSearch) && (
        <Paper withBorder p="sm">
          <Group justify="space-between" mb="xs">
            <Group gap={6}>
              <IconLayersIntersect size={16} color="var(--mantine-color-teal-6)" />
              <Text fw={700}>Replicate groups</Text>
            </Group>
            <TextInput
              size="xs"
              leftSection={<IconSearch size={14} />}
              placeholder="Search replicates"
              value={replicateSearch}
              onChange={(event) => setReplicateSearch(event.currentTarget.value)}
            />
          </Group>
          <ScrollArea type="auto">
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Replicate group</Table.Th>
                  <Table.Th>Cells</Table.Th>
                  <Table.Th>Avg charge</Table.Th>
                  <Table.Th>Avg discharge</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(replicateGroups.data ?? []).map((group) => (
                  <Table.Tr key={group.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <IconLayersIntersect size={16} color="var(--mantine-color-teal-6)" />
                        <div>
                          <Text fw={700}>{group.name}</Text>
                          {group.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {group.description}
                            </Text>
                          )}
                        </div>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{group.cells.map((cell) => cell.name).join(", ")}</Text>
                    </Table.Td>
                    <Table.Td>{formatCapacity(group.average_total_charge_capacity_mah)}</Table.Td>
                    <Table.Td>{formatCapacity(group.average_total_discharge_capacity_mah)}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(group.created_at)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="end">
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<IconEye size={14} />}
                          onClick={() => setPreviewGroupId(group.id)}
                        >
                          Preview
                        </Button>
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconUnlink size={14} />}
                          loading={ungroupReplicates.isPending}
                          onClick={() => ungroupReplicates.mutate({ group_ids: [group.id] })}
                        >
                          Separate
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {(replicateGroups.data ?? []).length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text size="sm" c="dimmed">
                        No replicate groups match this search.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      <Modal
        opened={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        title="Create replicate group"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {selectedCellIds.size} selected cells will remain separate cells in the database, linked
            as replicates for grouped previews and future analyses.
          </Text>
          <TextInput
            label="Group name"
            value={groupName}
            onChange={(event) => setGroupName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && selectedCellIds.size >= 2 && groupName.trim()) {
                createReplicateGroup.mutate({ name: groupName.trim(), cell_ids: selectedIds });
              }
            }}
            data-autofocus
          />
          <Button
            disabled={selectedCellIds.size < 2 || !groupName.trim()}
            loading={createReplicateGroup.isPending}
            onClick={() =>
              createReplicateGroup.mutate({
                name: groupName.trim(),
                cell_ids: selectedIds,
              })
            }
          >
            Create group
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={addToGroupDialogOpen}
        onClose={() => setAddToGroupDialogOpen(false)}
        title="Add to replicate"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Add {selectedCellIds.size} selected cell{selectedCellIds.size === 1 ? "" : "s"} to an
            existing replicate group. Cells already in the group are skipped.
          </Text>
          <Select
            label="Replicate group"
            placeholder="Choose replicate group"
            data={replicateSelectData}
            value={targetGroupId}
            onChange={setTargetGroupId}
            onKeyDown={(event) => {
              if (event.key === "Enter" && targetGroupId) {
                addCellsToReplicateGroup.mutate({
                  groupId: Number(targetGroupId),
                  cell_ids: selectedIds,
                });
              }
            }}
            searchable
            data-autofocus
          />
          <Button
            disabled={!targetGroupId || selectedIds.length === 0}
            loading={addCellsToReplicateGroup.isPending}
            onClick={() =>
              targetGroupId &&
              addCellsToReplicateGroup.mutate({
                groupId: Number(targetGroupId),
                cell_ids: selectedIds,
              })
            }
          >
            Add to replicate
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={previewGroupId !== null}
        onClose={() => setPreviewGroupId(null)}
        title={previewGroup?.name ?? "Replicate group"}
        size="xl"
      >
        <ReplicatePreviewPanel
          title={previewGroup?.name ?? "Replicate group"}
          preview={replicatePreview.data}
        />
      </Modal>

      <Modal
        opened={selectedId !== null}
        onClose={() => {
          setMetadataOpen(false);
          setSelectedId(null);
        }}
        title={detail.data?.name ?? "Cell"}
        size="90rem"
      >
        {detail.isLoading ? (
          <Center h={320}>
            <Loader color="teal" />
          </Center>
        ) : detail.isError ? (
          <Alert color="red">Could not load this cell.</Alert>
        ) : detail.data ? (
          <Stack gap="md">
            <Group justify="space-between" align="start">
              <div>
                <Text fw={700}>{detail.data.name}</Text>
                <Text size="xs" c="dimmed">
                  {detail.data.n_files} file{detail.data.n_files === 1 ? "" : "s"} -{" "}
                  {detail.data.total_cycles} cached cycles
                </Text>
                <Text size="xs" c="dimmed">
                  Total charge {formatCapacity(detail.data.total_charge_capacity_mah)} - total
                  discharge {formatCapacity(detail.data.total_discharge_capacity_mah)}
                </Text>
              </div>
              <Group gap={4}>
                {detail.data.cycling_status === "complete" && (
                  <Badge color="gray" variant="light">
                    cycling complete
                  </Badge>
                )}
                {detail.data.has_changed && (
                  <Badge color="orange" variant="light">
                    source changed
                  </Badge>
                )}
                {detail.data.has_offline && (
                  <Badge color="red" variant="light">
                    source offline
                  </Badge>
                )}
              </Group>
            </Group>

            <Group justify="end">
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={15} />}
                loading={removeCell.isPending}
                onClick={() => confirmRemove(detail.data!)}
              >
                Remove from library
              </Button>
            </Group>

            {detail.data.description && <Alert color="gray">{detail.data.description}</Alert>}

            <Paper withBorder p="sm">
              <CellQuickPlot cellId={detail.data.id} cellName={detail.data.name} />
            </Paper>

            <Divider label="Metadata" labelPosition="left" />
            <Button
              variant="subtle"
              size="xs"
              leftSection={
                metadataOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
              }
              onClick={() => setMetadataOpen((current) => !current)}
            >
              {metadataOpen
                ? "Hide metadata"
                : `Show metadata (${Object.keys(detail.data.metadata).length})`}
            </Button>
            <Collapse in={metadataOpen}>
              {Object.keys(detail.data.metadata).length ? (
                <Table withTableBorder>
                  <Table.Tbody>
                    {Object.entries(detail.data.metadata).map(([key, value]) => (
                      <Table.Tr key={key}>
                        <Table.Td w="35%">
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
                <Alert color="gray">No cell metadata stored.</Alert>
              )}
            </Collapse>

            <Divider label="Tests and files" labelPosition="left" />
            <Stack gap="xs">
              {detail.data.tests.map((test) => (
                <Paper key={test.id} withBorder p="sm">
                  <Stack gap="xs">
                    <Text fw={700}>{test.name}</Text>
                    {test.description && (
                      <Text size="sm" c="dimmed">
                        {test.description}
                      </Text>
                    )}
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>File</Table.Th>
                          <Table.Th>Rows</Table.Th>
                          <Table.Th>Cycles</Table.Th>
                          <Table.Th>Source</Table.Th>
                          <Table.Th>Parse</Table.Th>
                          <Table.Th>Hash</Table.Th>
                          <Table.Th>Actions</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {test.files.map((file) => (
                          <Table.Tr key={file.id}>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {file.filename}
                              </Text>
                              <Text size="xs" c="dimmed" lineClamp={1}>
                                {file.path}
                              </Text>
                            </Table.Td>
                            <Table.Td>{file.row_count ?? "-"}</Table.Td>
                            <Table.Td>{file.cycle_count ?? "-"}</Table.Td>
                            <Table.Td>
                              <Badge color={statusColor(file.location_status)} variant="light">
                                {file.location_status}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              <Badge color={statusColor(file.parse_status)} variant="light">
                                {file.parse_status}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              <Code fz={10}>{file.hash.slice(0, 12)}...</Code>
                            </Table.Td>
                            <Table.Td>
                              <Tooltip
                                label={
                                  file.location_status === "changed"
                                    ? "Read the updated source file and rebuild the cache"
                                    : "Available when the source checksum changes"
                                }
                              >
                                <Button
                                  size="xs"
                                  variant="default"
                                  leftSection={<IconRefresh size={14} />}
                                  disabled={file.location_status !== "changed"}
                                  loading={updateSource.isPending}
                                  onClick={() => updateSource.mutate(file)}
                                >
                                  Update
                                </Button>
                              </Tooltip>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}
