// Flat analysis index — every analysis, filed or not, in one list.
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  FileButton,
  Group,
  Loader,
  Modal,
  Paper,
  Radio,
  Select,
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
  IconFileImport,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderPlus,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSummary,
  del,
  FolderNode,
  get,
  PortableAnalysisInspection,
  PortableAnalysisImportResult,
  PortableSourceReview,
  post,
  postForm,
  Tree,
} from "../api";
import { clearAnalysisQueryCache } from "../analysisQueryCache";

function flattenFolders(nodes: FolderNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((node) => [
    { value: String(node.id), label: `${"  ".repeat(depth)}${node.name}` },
    ...flattenFolders(node.children, depth + 1),
  ]);
}

function formatBytes(value: number | null | undefined): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function comparisonText(value: PortableSourceReview["candidates"][number]["comparison"]): string {
  if (value === "library_newer") return "Library version appears newer";
  if (value === "embedded_newer") return "Imported version appears newer";
  return "Version order is uncertain";
}

function InfoHint({ label }: { label: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Tooltip label={label} multiline maw={330} withArrow opened={opened}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label="More information"
        onMouseEnter={() => setOpened(true)}
        onMouseLeave={() => setOpened(false)}
        onFocus={() => setOpened(true)}
        onBlur={() => setOpened(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpened((current) => !current);
        }}
      >
        <IconInfoCircle size={15} />
      </ActionIcon>
    </Tooltip>
  );
}

function PortableFolderTree({
  folders,
  value,
  onChange,
  onCreate,
}: {
  folders: FolderNode[];
  value: string | null;
  onChange: (value: string) => void;
  onCreate: (parentId: number | null, name: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(folders.map((folder) => folder.id))
  );
  const [draftParent, setDraftParent] = useState<number | null | undefined>(undefined);
  const [draftName, setDraftName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      flattenFolders(folders).forEach((folder) => next.add(Number(folder.value)));
      return next;
    });
  }, [folders]);
  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const beginCreate = () => {
    const parentId = value && value !== "none" ? Number(value) : null;
    if (parentId !== null) {
      setExpanded((current) => new Set(current).add(parentId));
    }
    setDraftParent(parentId);
    setDraftName("");
  };
  const cancelCreate = () => {
    if (submitting) return;
    setDraftParent(undefined);
    setDraftName("");
  };
  const submitCreate = async () => {
    const name = draftName.trim();
    if (draftParent === undefined || !name || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(draftParent, name);
      setDraftParent(undefined);
      setDraftName("");
    } catch {
      // The mutation displays the backend validation message; keep the inline editor open.
    } finally {
      setSubmitting(false);
    }
  };
  const draftRow = (depth: number) => (
    <Group gap={5} px="xs" py={4} wrap="nowrap" style={{ marginLeft: depth * 18 }}>
      <Box w={22} />
      <IconFolder size={16} color="var(--mantine-color-teal-6)" />
      <TextInput
        value={draftName}
        onChange={(event) => setDraftName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submitCreate();
          if (event.key === "Escape") cancelCreate();
        }}
        placeholder="Folder name"
        size="xs"
        autoFocus
        disabled={submitting}
        rightSection={submitting ? <Loader size={13} /> : null}
        style={{ flex: 1 }}
      />
    </Group>
  );
  const row = (folder: FolderNode, depth: number): ReactNode => (
    <div key={folder.id}>
      <Group
        gap={5}
        px="xs"
        py={5}
        wrap="nowrap"
        onClick={() => onChange(String(folder.id))}
        style={{
          marginLeft: depth * 18,
          cursor: "pointer",
          borderRadius: 5,
          background:
            value === String(folder.id) ? "var(--mantine-color-teal-0)" : "transparent",
        }}
      >
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          disabled={folder.children.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            toggle(folder.id);
          }}
          aria-label={expanded.has(folder.id) ? "Collapse folder" : "Expand folder"}
        >
          {expanded.has(folder.id) ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )}
        </ActionIcon>
        <IconFolder size={16} color="var(--mantine-color-teal-6)" />
        <Text size="sm" fw={value === String(folder.id) ? 650 : 400} truncate style={{ flex: 1 }}>
          {folder.name}
        </Text>
      </Group>
      {expanded.has(folder.id)
        ? <>
            {folder.children.map((child) => row(child, depth + 1))}
            {draftParent === folder.id ? draftRow(depth + 1) : null}
          </>
        : null}
    </div>
  );
  return (
    <Stack gap={6}>
      <Group justify="space-between" align="center">
        <Group gap={4}>
          <Text size="sm" fw={500}>Folder</Text>
          <InfoHint label="Choose where the analysis appears. New folders are created inside the selected folder, or at the root when No folder is selected." />
        </Group>
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<IconFolderPlus size={15} />}
          onClick={beginCreate}
          disabled={draftParent !== undefined}
        >
          New folder
        </Button>
      </Group>
      <Paper withBorder p={5}>
      <Group
        gap={5}
        px="xs"
        py={5}
        wrap="nowrap"
        onClick={() => onChange("none")}
        style={{
          cursor: "pointer",
          borderRadius: 5,
          background: value === "none" ? "var(--mantine-color-teal-0)" : "transparent",
        }}
      >
        <Box w={22} />
        <IconFolder size={16} color="var(--mantine-color-gray-6)" />
        <Text size="sm" fw={value === "none" ? 650 : 400} style={{ flex: 1 }}>
          No folder
        </Text>
      </Group>
      {draftParent === null ? draftRow(0) : null}
      <Box mah={230} style={{ overflowY: "auto" }}>
        {folders.map((folder) => row(folder, 0))}
      </Box>
      </Paper>
    </Stack>
  );
}

function AnalysisCreateForm({
  folders,
  loading,
  onSubmit,
}: {
  folders: { value: string; label: string }[];
  loading: boolean;
  onSubmit: (payload: { title: string; folder_id: number | null }) => void;
}) {
  const [title, setTitle] = useState("Untitled analysis");
  const [folder, setFolder] = useState<string | null>("none");
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
        data={[{ value: "none", label: "No folder" }, ...folders]}
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

export function AnalysesIndexPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [portableFile, setPortableFile] = useState<File | null>(null);
  const [portableReview, setPortableReview] = useState<PortableAnalysisInspection | null>(null);
  const [portableTitle, setPortableTitle] = useState("");
  const [portableFolder, setPortableFolder] = useState<string | null>("none");
  const [portableAddCells, setPortableAddCells] = useState(true);
  const [portableChoices, setPortableChoices] = useState<Record<string, string>>({});
  const [portableCellNames, setPortableCellNames] = useState<Record<string, string>>({});
  const [portableImportOpen, setPortableImportOpen] = useState(
    () => searchParams.get("portableImport") === "1"
  );
  const handledPortableSource = useRef<string | null>(null);

  useEffect(() => {
    if (searchParams.get("portableImport") === "1") setPortableImportOpen(true);
  }, [searchParams]);

  const analyses = useQuery({
    queryKey: ["analyses", search],
    queryFn: () =>
      get<AnalysisSummary[]>(`/api/analyses${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const folderOptions = flattenFolders(tree.data?.folders ?? []);

  const create = useMutation({
    mutationFn: (body: { title: string; folder_id: number | null }) =>
      post<AnalysisFull>("/api/analyses", body),
    onSuccess: async (a) => {
      await clearAnalysisQueryCache(qc, a.id);
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      modals.closeAll();
      navigate(`/analyses/${a.id}`);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/analyses/${id}`),
    onSuccess: async (_, id) => {
      await clearAnalysisQueryCache(qc, id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
      ]);
    },
  });

  const applyPortableReview = (review: PortableAnalysisInspection) => {
    setPortableReview(review);
    setPortableTitle(review.analysis_title);
    setPortableChoices(
      Object.fromEntries(
        review.sources
          .filter((source) => source.status === "possible_update")
          .map((source) => [
            source.source_id,
            source.suggested_action === "use_library" &&
            source.suggested_library_source_id
              ? `library:${source.suggested_library_source_id}`
              : "embedded",
          ])
      )
    );
    setPortableCellNames(
      Object.fromEntries(review.cells.map((cell) => [cell.cell_id, cell.name]))
    );
  };

  const inspectPortable = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return postForm<PortableAnalysisInspection>("/api/analyses/portable-inspect", form);
    },
    onSuccess: applyPortableReview,
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const inspectPortablePath = useMutation({
    mutationFn: (source: string) =>
      post<PortableAnalysisInspection>("/api/analyses/portable-inspect-path", { source }),
    onMutate: (source) => {
      let filename = "Portable analysis.html";
      try {
        const url = new URL(source);
        filename = decodeURIComponent(url.pathname.split("/").pop() || filename);
      } catch {
        filename = source.split(/[\\/]/).pop() || filename;
      }
      setPortableFile(new File([], filename, { type: "text/html" }));
      setPortableImportOpen(true);
    },
    onSuccess: applyPortableReview,
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const resetPortable = (discard = true) => {
    const token = portableReview?.token;
    setPortableFile(null);
    setPortableReview(null);
    setPortableTitle("");
    setPortableFolder("none");
    setPortableAddCells(true);
    setPortableChoices({});
    setPortableCellNames({});
    setPortableImportOpen(false);
    inspectPortable.reset();
    inspectPortablePath.reset();
    handledPortableSource.current = null;
    if (searchParams.has("portableImport") || searchParams.has("portableSource")) {
      const next = new URLSearchParams(searchParams);
      next.delete("portableImport");
      next.delete("portableSource");
      setSearchParams(next, { replace: true });
    }
    if (discard && token) {
      del(`/api/analyses/portable-import-staged/${token}`).catch(() => undefined);
    }
  };

  const choosePortableFile = (file: File | null) => {
    if (!file) return;
    resetPortable();
    setPortableImportOpen(true);
    setPortableFolder("none");
    setPortableFile(file);
    inspectPortable.mutate(file);
  };

  const portableSource = searchParams.get("portableSource");
  useEffect(() => {
    if (
      !portableSource ||
      handledPortableSource.current === portableSource ||
      portableReview ||
      inspectPortablePath.isPending
    ) {
      return;
    }
    handledPortableSource.current = portableSource;
    inspectPortablePath.mutate(portableSource);
  }, [portableReview, portableSource, inspectPortablePath.isPending]);

  const createPortableFolder = useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId: number | null }) =>
      post<{ id: number; name: string; parent_id: number | null }>("/api/folders", {
        name,
        parent_id: parentId,
      }),
    onSuccess: async (folder) => {
      await qc.invalidateQueries({ queryKey: ["tree"] });
      setPortableFolder(String(folder.id));
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const importPortable = useMutation({
    mutationFn: async () => {
      if (!portableReview) throw new Error("Inspect a portable HTML analysis first.");
      const sourceResolutions = Object.fromEntries(
        portableReview.sources
          .filter((source) => source.status === "possible_update")
          .map((source) => {
            const choice = portableChoices[source.source_id];
            if (choice?.startsWith("library:")) {
              return [
                source.source_id,
                {
                  action: "use_library",
                  library_source_file_id: Number(choice.split(":")[1]),
                },
              ];
            }
            return [source.source_id, { action: "import_embedded" }];
          })
      );
      return post<PortableAnalysisImportResult>("/api/analyses/portable-import-staged", {
        token: portableReview.token,
        title: portableTitle.trim(),
        folder_id:
          portableFolder && portableFolder !== "none" ? Number(portableFolder) : null,
        add_cells_to_folder:
          Boolean(portableFolder && portableFolder !== "none") && portableAddCells,
        source_resolutions: sourceResolutions,
        cell_names: portableCellNames,
      });
    },
    onSuccess: async (result) => {
      resetPortable(false);
      await clearAnalysisQueryCache(qc, result.analysis.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
        qc.invalidateQueries({ queryKey: ["cells"] }),
        qc.invalidateQueries({ queryKey: ["replicate-groups"] }),
      ]);
      if (result.warnings.length) {
        notifications.show({
          message: `Imported with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`,
          color: "orange",
        });
      } else {
        notifications.show({ message: "Portable analysis imported.", color: "teal" });
      }
      navigate(`/analyses/${result.analysis.id}`);
    },
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const rows = analyses.data ?? [];
  const portableUnresolved = Boolean(
    portableReview?.sources.some(
      (source) =>
        source.status === "possible_update" && !portableChoices[source.source_id]
    )
  );
  const portableMissingCellName = Boolean(
    portableReview?.cells.some((cell) => {
      const importsSeparate =
        cell.status === "add" ||
        cell.sources.some(
          (source) =>
            source.status === "possible_update" &&
            portableChoices[source.source_id] === "embedded"
        );
      return importsSeparate && !(portableCellNames[cell.cell_id] ?? "").trim();
    })
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Analyses</Title>
        <Group gap="xs">
          <Button
            variant="default"
            leftSection={<IconFileImport size={16} />}
            onClick={() => setPortableImportOpen(true)}
          >
            Import portable analysis
          </Button>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() =>
              modals.open({
                title: "New analysis",
                children: (
                  <AnalysisCreateForm
                    folders={folderOptions}
                    loading={create.isPending}
                    onSubmit={(payload) => create.mutate(payload)}
                  />
                ),
              })
            }
            loading={create.isPending}
          >
            New analysis
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        An analysis is a saved recipe: which cells and replicate groups to compare, how to compute,
        and the provenance of the last saved result. It never changes unless you change it.
      </Text>
      <TextInput
        leftSection={<IconSearch size={14} />}
        placeholder="Search titles"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maw={360}
      />
      {analyses.isLoading && !analyses.data ? (
        <Group justify="center" py="xl">
          <Loader color="teal" />
        </Group>
      ) : analyses.isError && !analyses.data ? (
        <Alert color="red">Could not load the analysis database.</Alert>
      ) : rows.length === 0 ? (
        <Alert color="gray">
          No analyses yet. Create one, then add replicate groups or individual cells to compare
          capacities, efficiencies, retention and more.
        </Alert>
      ) : (
        <Table highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Selection</Table.Th>
              <Table.Th>Quantity</Table.Th>
              <Table.Th>Last computed</Table.Th>
              <Table.Th w={44}></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <Table.Tr
                key={a.id}
                style={{
                  cursor: "pointer",
                  // Amber, not green: this matches the source-changed badge
                  // language used elsewhere. It means "out of date", not "good".
                  background: a.sources_changed ? "var(--mantine-color-yellow-0)" : undefined,
                }}
                onClick={() => navigate(`/analyses/${a.id}`)}
              >
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={a.sources_changed ? 700 : 500}>
                      {a.title}
                    </Text>
                    {a.sources_changed && (
                      <Tooltip label="A source file changed after this analysis was last computed. Open it to recompute.">
                        <Badge size="xs" variant="light" color="yellow" style={{ flexShrink: 0 }}>
                          sources updated
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                  {a.folder && (
                    <Text size="xs" c="dimmed">
                      filed in {a.folder.name}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="outline">
                    {a.type}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">
                    {a.n_entries} entr{a.n_entries === 1 ? "y" : "ies"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{a.quantity?.replace(/_/g, " ") ?? "—"}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {a.computed_at
                      ? `${new Date(a.computed_at).toLocaleString()} · parser ${a.parser_version} · calc ${a.calc_version}`
                      : "never"}
                  </Text>
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Delete analysis (data untouched)">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        modals.openConfirmModal({
                          title: `Delete “${a.title}”?`,
                          children: (
                            <Text size="sm">The recipe and provenance are removed. Data is untouched.</Text>
                          ),
                          labels: { confirm: "Delete", cancel: "Cancel" },
                          confirmProps: { color: "red" },
                          onConfirm: () => remove.mutate(a.id),
                        })
                      }
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Modal
        opened={portableImportOpen}
        onClose={() => !importPortable.isPending && resetPortable()}
        // The action buttons live in the modal header: it stays pinned while
        // the source list scrolls, so Import is reachable without scrolling
        // to the bottom of a long package.
        title={
          <Group justify="space-between" wrap="nowrap" w="100%" pr="sm">
            <Text fw={700}>Import portable analysis</Text>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="default"
                disabled={importPortable.isPending}
                onClick={() => resetPortable()}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                leftSection={<IconFileImport size={14} />}
                loading={importPortable.isPending}
                disabled={
                  !portableReview ||
                  !portableTitle.trim() ||
                  portableUnresolved ||
                  portableMissingCellName ||
                  inspectPortable.isPending
                }
                onClick={() => importPortable.mutate()}
              >
                Import
              </Button>
            </Group>
          </Group>
        }
        styles={{ title: { flex: 1 } }}
        size="xl"
        closeOnClickOutside={!importPortable.isPending}
        closeOnEscape={!importPortable.isPending}
      >
        <Stack>
          {!portableFile ? (
            <Paper withBorder p="xl">
              <Stack align="center" gap="sm">
                <IconFileImport size={28} color="var(--mantine-color-teal-6)" />
                <div>
                  <Text ta="center" fw={700}>Choose a portable CellXplorer report</Text>
                  <Text ta="center" size="sm" c="dimmed">
                    Select the HTML file you received or previously exported.
                  </Text>
                </div>
                <FileButton onChange={choosePortableFile} accept=".html,.htm,text/html">
                  {(props) => <Button {...props}>Select HTML file</Button>}
                </FileButton>
              </Stack>
            </Paper>
          ) : null}
          <div>
            <Group gap={4}>
              <Text fw={700} size="sm">
                {portableFile?.name}
              </Text>
              <InfoHint label="CellXplorer reads the package data and verifies its checksums without running JavaScript from the report." />
            </Group>
          </div>
          {inspectPortable.isPending || inspectPortablePath.isPending ? (
            <Stack align="center" py="xl">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Inspecting package and comparing its sources with the library...
              </Text>
            </Stack>
          ) : inspectPortable.isError || inspectPortablePath.isError ? (
            <Alert color="red">
              {(inspectPortable.error ?? inspectPortablePath.error)?.message}
            </Alert>
          ) : portableReview ? (
            <>
              <TextInput
                label={
                  <Group gap={4}>
                    <span>Analysis name</span>
                    <InfoHint label="The original name is suggested. Change it here without modifying the source report." />
                  </Group>
                }
                value={portableTitle}
                onChange={(event) => setPortableTitle(event.currentTarget.value)}
                data-autofocus
              />
              <PortableFolderTree
                folders={tree.data?.folders ?? []}
                value={portableFolder}
                onChange={setPortableFolder}
                onCreate={async (parentId, name) => {
                  await createPortableFolder.mutateAsync({ parentId, name });
                }}
              />
              {portableFolder && portableFolder !== "none" ? (
                <Switch
                  checked={portableAddCells}
                  onChange={(event) => setPortableAddCells(event.currentTarget.checked)}
                  label={
                    <Group gap={4}>
                      <span>Also show the analysis cells in this folder</span>
                      <InfoHint label="This adds folder references only. It does not duplicate cells or their cycling data." />
                    </Group>
                  }
                />
              ) : null}
              <Divider />
              <Group justify="space-between">
                <div>
                  <Text fw={700}>Library reconciliation</Text>
                  <Text size="xs" c="dimmed">
                    {portableReview.cells.length} cell
                    {portableReview.cells.length === 1 ? "" : "s"} ·{" "}
                    {portableReview.plot_count} saved plot
                    {portableReview.plot_count === 1 ? "" : "s"}
                  </Text>
                </div>
                <Badge
                  color={portableReview.requires_resolution ? "orange" : "teal"}
                  variant="light"
                >
                  {portableReview.requires_resolution
                    ? "Decisions required"
                    : "Ready to import"}
                </Badge>
              </Group>
              <Stack gap="sm">
                {portableReview.cells.map((cell) => {
                  const importsSeparate =
                    cell.status === "add" ||
                    cell.sources.some(
                      (source) =>
                        source.status === "possible_update" &&
                        portableChoices[source.source_id] === "embedded"
                    );
                  return (
                    <Paper key={cell.cell_id} withBorder p="sm" radius="sm">
                    <Group justify="space-between" mb="xs">
                      <Text fw={700}>{cell.name}</Text>
                      <Badge
                        size="sm"
                        color={
                          cell.status === "reuse"
                            ? "teal"
                            : cell.status === "review"
                              ? "orange"
                              : "blue"
                        }
                        variant="light"
                      >
                        {cell.status === "reuse"
                          ? "Use library cell"
                          : cell.status === "review"
                            ? "Review version"
                            : "Add to library"}
                      </Badge>
                    </Group>
                    <Stack gap="sm">
                      {cell.sources.map((source) => (
                        <div key={source.source_id}>
                          <Group justify="space-between" gap="xs">
                            <div style={{ minWidth: 0 }}>
                              <Text size="sm" fw={600} truncate>
                                {source.filename}
                              </Text>
                              <Group gap={4}>
                                <Text size="xs" c="dimmed">
                                  {source.cycle_count ?? "?"} cycles · {formatBytes(source.size)}
                                </Text>
                                <InfoHint label={`SHA-256: ${source.hash}\n${source.message}`} />
                              </Group>
                            </div>
                            <Badge
                              size="xs"
                              color={
                                source.status === "exact"
                                  ? "teal"
                                  : source.status === "possible_update"
                                    ? "orange"
                                    : "blue"
                              }
                              variant="outline"
                            >
                              {source.status === "exact"
                                ? "Exact checksum"
                                : source.status === "possible_update"
                                  ? "Possible update"
                                  : "New source"}
                            </Badge>
                          </Group>
                          <Text size="xs" c="dimmed" mt={4}>
                            {source.status === "exact"
                              ? "Already in the library. The library cell will be used."
                              : source.status === "new"
                                ? "Not in the library. This cell will be added."
                                : "A similar file has a different version. Choose which one to use."}
                          </Text>
                          {source.status === "possible_update" ? (
                            <Radio.Group
                              mt="xs"
                              value={portableChoices[source.source_id] ?? ""}
                              onChange={(value) =>
                                setPortableChoices((choices) => ({
                                  ...choices,
                                  [source.source_id]: value,
                                }))
                              }
                            >
                              <Stack gap={6}>
                                {source.candidates.map((candidate) => (
                                  <Radio
                                    key={candidate.source_file_id}
                                    value={`library:${candidate.source_file_id}`}
                                    label={
                                      <div>
                                        <Text size="sm" fw={600}>
                                          Use library cell{" "}
                                          {candidate.cell_name
                                            ? `"${candidate.cell_name}"`
                                            : `source #${candidate.source_file_id}`}
                                        </Text>
                                        <Group gap={4}>
                                          <Text size="xs" c="dimmed">
                                            {comparisonText(candidate.comparison)} · {candidate.cycle_count ?? "?"} cycles
                                          </Text>
                                          <InfoHint label={`Matched by ${candidate.matched_on.join(", ")}. Library path: ${candidate.path}`} />
                                        </Group>
                                      </div>
                                    }
                                  />
                                ))}
                                <Radio
                                  value="embedded"
                                  label={
                                    <div>
                                      <Text size="sm" fw={600}>
                                        Keep imported version as a separate cell
                                      </Text>
                                      <Text size="xs" c="dimmed">
                                        Add this report's version as another library cell
                                      </Text>
                                    </div>
                                  }
                                />
                              </Stack>
                            </Radio.Group>
                          ) : null}
                        </div>
                      ))}
                      {importsSeparate ? (
                        <TextInput
                          label="Imported cell name"
                          value={portableCellNames[cell.cell_id] ?? cell.name}
                          onChange={(event) =>
                            setPortableCellNames((names) => ({
                              ...names,
                              [cell.cell_id]: event.currentTarget.value,
                            }))
                          }
                          description="Used when this package version is added as a separate library cell."
                        />
                      ) : null}
                    </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </>
          ) : null}
        </Stack>
      </Modal>
    </Stack>
  );
}
