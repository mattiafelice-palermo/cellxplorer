import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Paper,
  ScrollArea,
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
  IconGripVertical,
  IconPlus,
  IconTable,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { ChangeEvent, DragEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  ImportInspectResult,
  ImportPreview,
  ImportPreviewResult,
  ImportRawDataResult,
  get,
  post,
  postForm,
  Tree,
} from "../api";
import Plot from "../components/Plot";
import { addDebugEvent } from "../debug";

type ImportDraft = ImportPreview & {
  cell_name: string;
  description: string;
  test_name: string;
  metadata: Record<string, string>;
  preview_loading: boolean;
};

type ImportReplicateDraft = {
  id: string;
  name: string;
  description: string;
  staged_names: string[];
};

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function suggestedCellName(file: ImportPreview) {
  return file.barcode || file.remarks || file.filename.replace(/\.(nda|ndax)$/i, "");
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
  onSaved,
  targetFolderId,
}: {
  drafts: ImportDraft[];
  active: number;
  opened: boolean;
  onActive: (index: number) => void;
  onChange: (index: number, draft: ImportDraft) => void;
  onClose: () => void;
  onSaved: () => void;
  targetFolderId: number | null;
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
  const treeQuery = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const folderSelectData = useMemo(() => folderOptions(treeQuery.data?.folders ?? []), [treeQuery.data]);

  useEffect(() => {
    if (opened) {
      setDestinationFolders(targetFolderId === null ? [] : [String(targetFolderId)]);
      setSelectedStagedNames(new Set());
      setReplicateGroups([]);
      setNewGroupName(drafts.length > 1 ? `${drafts[0]?.cell_name ?? "Imported"} replicates` : "");
    }
  }, [opened, targetFolderId]);

  const loadRawData = (offset = 0) => {
    if (!draft) return;
    setRawOpen(true);
    setRawLoading(true);
    setRawError(null);
    addDebugEvent("import:rawDataRequested", {
      staged_name: draft.staged_name,
      filename: draft.filename,
      offset,
      limit: RAW_PAGE_SIZE,
    });
    post<ImportRawDataResult>("/api/imports/raw-data", {
      staged_name: draft.staged_name,
      source_path: draft.source_path,
      offset,
      limit: RAW_PAGE_SIZE,
    })
      .then((result) => {
        addDebugEvent("import:rawDataReady", {
          staged_name: draft.staged_name,
          columns: result.columns.length,
          rows: result.rows.length,
          total_rows: result.total_rows,
          offset: result.offset,
        });
        setRawData(result);
      })
      .catch((error: Error) => {
        addDebugEvent("import:rawDataFailed", {
          staged_name: draft.staged_name,
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
    mutationFn: () =>
      post<{
        created: { cell_id: number; cell_name: string }[];
        replicate_group?: { id: number; name: string; cell_ids: number[] } | null;
        replicate_groups?: { id: number; name: string; cell_ids: number[] }[];
      }>("/api/imports/cells", {
        folder_ids: destinationFolders.map(Number),
        replicate_groups: replicateGroups
          .filter((group) => group.name.trim() && group.staged_names.length > 0)
          .map((group) => ({
            name: group.name.trim(),
            description: group.description.trim() || null,
            staged_names: group.staged_names,
          })),
        cells: drafts.map((d) => ({
          staged_name: d.staged_name,
          source_path: d.source_path,
          filename: d.filename,
          cell_name: d.cell_name,
          description: d.description || null,
          test_name: d.test_name || null,
          metadata: d.metadata,
        })),
      }),
    onSuccess: (result) => {
      notifications.show({
        message: `Imported ${result.created.length} cell${result.created.length === 1 ? "" : "s"}`,
        color: "teal",
      });
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      onSaved();
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const hasExactDuplicate = drafts.some(
    (d) => d.import_match?.kind === "exact_duplicate" && d.import_match.registered
  );
  const groupNames = replicateGroups.map((group) => group.name.trim()).filter(Boolean);
  const duplicateGroupName = new Set(groupNames).size !== groupNames.length;
  const invalidGroups = replicateGroups.filter(
    (group) => group.name.trim() && group.staged_names.length > 0 && group.staged_names.length < 2
  );
  const canSave =
    drafts.length > 0 &&
    drafts.every((d) => d.cell_name.trim()) &&
    !hasExactDuplicate &&
    !duplicateGroupName &&
    invalidGroups.length === 0;
  const rawRangeStart = rawData && rawData.total_rows > 0 ? rawData.offset + 1 : 0;
  const rawRangeEnd = rawData
    ? Math.min(rawData.offset + rawData.rows.length, rawData.total_rows)
    : 0;
  const metadataRows = draft ? Object.entries(combinedMetadata(draft)) : [];

  return (
    <>
      <Modal opened={opened} onClose={handleClose} title="Import cells" size="95rem">
        {draft && (
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                Review {drafts.length} selected file{drafts.length === 1 ? "" : "s"} before saving.
              </Text>
              <Group gap="xs">
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
                <Button variant="default" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  disabled={!canSave}
                  loading={save.isPending}
                  onClick={() => save.mutate()}
                >
                  Import {drafts.length} cell{drafts.length === 1 ? "" : "s"}
                </Button>
              </Group>
            </Group>
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
                              ? "var(--mantine-color-teal-5)"
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
                              <Paper withBorder p="xs" bg="gray.0">
                                <Text size="xs" c="dimmed" ta="center">
                                  Drop selected cells here
                                </Text>
                              </Paper>
                            )}
                          </Stack>
                        </Paper>
                      ))}
                      {replicateGroups.length === 0 && (
                        <Paper withBorder p="sm" bg="gray.0">
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
                                index === active ? "var(--mantine-color-teal-5)" : undefined,
                              background: checked ? "var(--mantine-color-teal-0)" : undefined,
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
                                {groups.length > 0 && (
                                  <Group gap={4}>
                                    {groups.map((group) => (
                                      <Badge key={group.id} size="xs" color="teal" variant="light">
                                        {group.name}
                                      </Badge>
                                    ))}
                                  </Group>
                                )}
                              </Stack>
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

              <Paper withBorder p="sm" bg="gray.0">
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
              {draft.preview_loading ? (
                <Paper withBorder p="xs" h={250}>
                  <Center h="100%">
                    <Stack align="center" gap="xs">
                      <Loader color="teal" />
                      <Text size="sm" c="dimmed">
                        Generating capacity preview
                      </Text>
                    </Stack>
                  </Center>
                </Paper>
              ) : draft.capacity_preview && draft.capacity_preview.x.length > 0 ? (
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
                <Alert color={draft.preview_error ? "orange" : "gray"}>
                  {draft.preview_error
                    ? `Preview could not be generated: ${draft.preview_error}`
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
                  <Loader color="teal" />
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
  children: (state: { open: () => void; loading: boolean; selectedCount: number }) => ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [active, setActive] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const loadPreview = (draft: ImportDraft) => {
    addDebugEvent("import:previewRequested", {
      staged_name: draft.staged_name,
      filename: draft.filename,
    });
    post<ImportPreviewResult>("/api/imports/preview", {
      staged_name: draft.staged_name,
      source_path: draft.source_path,
    })
      .then((result) => {
        addDebugEvent("import:previewReady", {
          staged_name: draft.staged_name,
          points: result.capacity_preview?.x.length ?? 0,
          error: result.preview_error,
        });
        setDrafts((current) =>
          current.map((item) =>
            item.staged_name === draft.staged_name
              ? {
                  ...item,
                  capacity_preview: result.capacity_preview,
                  preview_error: result.preview_error,
                  preview_loading: false,
                }
              : item
          )
        );
      })
      .catch((error: Error) => {
        addDebugEvent("import:previewFailed", {
          staged_name: draft.staged_name,
          error: error.message,
        });
        setDrafts((current) =>
          current.map((item) =>
            item.staged_name === draft.staged_name
              ? { ...item, preview_error: error.message, preview_loading: false }
              : item
          )
        );
      });
  };

  const hydrateInspection = (result: ImportInspectResult) => {
    const next = result.files.map((file) => ({
      ...file,
      cell_name: suggestedCellName(file),
      description: file.remarks || "",
      test_name: "Imported file",
      metadata: file.metadata,
      preview_loading: true,
    }));
    setDrafts(next);
    setActive(0);
    setModalOpen(next.length > 0);
    next.forEach(loadPreview);
  };

  const inspect = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      return postForm<ImportInspectResult>("/api/imports/inspect", form);
    },
    onSuccess: hydrateInspection,
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const pickNative = useMutation({
    mutationFn: () => post<ImportInspectResult>("/api/imports/pick-files"),
    onSuccess: hydrateInspection,
    onError: (e: Error) => {
      notifications.show({
        message: `${e.message}. Falling back to browser upload.`,
        color: "orange",
      });
      inputRef.current?.click();
    },
  });

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    const selected = files ? Array.from(files) : [];
    addDebugEvent("import:selectedFiles", {
      count: selected.length,
      files: selected.map((file) => ({ name: file.name, size: file.size, type: file.type || null })),
    });
    if (selected.length > 0) inspect.mutate(selected);
    event.currentTarget.value = "";
  };

  return (
    <>
      {children({
        open: () => pickNative.mutate(),
        loading: inspect.isPending || pickNative.isPending,
        selectedCount: drafts.length,
      })}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".ndax,.nda"
        hidden
        onChange={handleFiles}
      />
      <ImportModal
        drafts={drafts}
        active={active}
        opened={modalOpen}
        targetFolderId={targetFolderId}
        onActive={setActive}
        onChange={(index, draft) =>
          setDrafts((current) => current.map((item, i) => (i === index ? draft : item)))
        }
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [searchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [active, setActive] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
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

  const loadPreview = (draft: ImportDraft) => {
    addDebugEvent("import:previewRequested", {
      staged_name: draft.staged_name,
      filename: draft.filename,
    });
    post<ImportPreviewResult>("/api/imports/preview", {
      staged_name: draft.staged_name,
      source_path: draft.source_path,
    })
      .then((result) => {
        addDebugEvent("import:previewReady", {
          staged_name: draft.staged_name,
          points: result.capacity_preview?.x.length ?? 0,
          error: result.preview_error,
        });
        setDrafts((current) =>
          current.map((item) =>
            item.staged_name === draft.staged_name
              ? {
                  ...item,
                  capacity_preview: result.capacity_preview,
                  preview_error: result.preview_error,
                  preview_loading: false,
                }
              : item
          )
        );
      })
      .catch((error: Error) => {
        addDebugEvent("import:previewFailed", {
          staged_name: draft.staged_name,
          error: error.message,
        });
        setDrafts((current) =>
          current.map((item) =>
            item.staged_name === draft.staged_name
              ? { ...item, preview_error: error.message, preview_loading: false }
              : item
          )
        );
      });
  };

  const hydrateInspection = (result: ImportInspectResult) => {
    const next = result.files.map((file) => ({
      ...file,
      cell_name: suggestedCellName(file),
      description: file.remarks || "",
      test_name: "Imported file",
      metadata: file.metadata,
      preview_loading: true,
    }));
    setDrafts(next);
    setActive(0);
    setModalOpen(next.length > 0);
    next.forEach(loadPreview);
  };

  const inspect = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      return postForm<ImportInspectResult>("/api/imports/inspect", form);
    },
    onSuccess: hydrateInspection,
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const pickNative = useMutation({
    mutationFn: () => post<ImportInspectResult>("/api/imports/pick-files"),
    onSuccess: hydrateInspection,
    onError: (e: Error) => {
      notifications.show({
        message: `${e.message}. Falling back to browser upload.`,
        color: "orange",
      });
      inputRef.current?.click();
    },
  });

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    const selected = files ? Array.from(files) : [];
    addDebugEvent("import:selectedFiles", {
      count: selected.length,
      files: selected.map((file) => ({ name: file.name, size: file.size, type: file.type || null })),
    });
    if (selected.length > 0) inspect.mutate(selected);
    event.currentTarget.value = "";
  };

  return (
    <Stack>
      <Group justify="space-between" align="end">
        <div>
          <Title order={3}>Import</Title>
          <Text size="sm" c="dimmed">
            Load Neware files and define one cell per file.
          </Text>
        </div>
        <Tooltip label="Select one or more .ndax/.nda files">
          <Button
            leftSection={<IconUpload size={16} />}
            onClick={() => pickNative.mutate()}
            loading={inspect.isPending || pickNative.isPending}
          >
            Load cell file
          </Button>
        </Tooltip>
      </Group>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".ndax,.nda"
        hidden
        onChange={handleFiles}
      />

      {targetFolderId !== null && (
        <Alert color="teal">
          Import target: {targetFolderName ?? `folder #${targetFolderId}`}. Imported cells will be
          filed in this folder.
        </Alert>
      )}

      <Paper withBorder p="lg">
        <Group gap="lg" align="start">
          <IconFileImport size={34} color="var(--mantine-color-teal-6)" />
          <Stack gap={6}>
            <Text fw={700}>Start from Neware files</Text>
            <Text size="sm" c="dimmed" maw={720}>
              Select a single file or a batch. The next step opens a modal where each file is named
              as a cell and its detected metadata can be reviewed before saving.
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

      <Alert color="gray">
        Concatenating multiple files into one cell is intentionally left out for this first pass.
      </Alert>

      <ImportModal
        drafts={drafts}
        active={active}
        opened={modalOpen}
        targetFolderId={targetFolderId}
        onActive={setActive}
        onChange={(index, draft) =>
          setDrafts((current) => current.map((item, i) => (i === index ? draft : item)))
        }
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          setDrafts([]);
        }}
      />
    </Stack>
  );
}
