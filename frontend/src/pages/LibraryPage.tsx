import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Collapse,
  Code,
  Divider,
  Group,
  HoverCard,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Pagination,
  Paper,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconDatabase,
  IconDeviceFloppy,
  IconEye,
  IconFolder,
  IconInfoCircle,
  IconLayersIntersect,
  IconPlayerPlay,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUnlink,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  ActiveMaterialPresetSettings,
  CellDetail,
  CellSummary,
  ElectrodeAreaPresetSettings,
  del,
  FolderNode,
  get,
  patch,
  post,
  ReplicateGroupPreview,
  ReplicateGroupSummary,
  SourceCheckJob,
  SourceFile,
  Tree,
} from "../api";
import { CellDetailTabs } from "../components/CellDetailTabs";
import { CellHoverCard } from "../components/CellSamplePopovers";
import { CellLibraryColumnMenu } from "../components/CellLibraryColumnMenu";
import {
  deleteEmptyAnalysesIfRequested,
  DestructiveImpactModal,
  type DestructiveImpactConfirmOptions,
} from "../components/DestructiveImpactModal";
import { FolderTree } from "../components/FolderTree";
import { PlaceInFoldersModal } from "../components/PlaceInFoldersModal";
import { ReplicatePreviewPanel } from "../components/ReplicatePreviewPanel";
import { nominalCapacityFromMass } from "../scientificMetadata";
import {
  invalidateAnalysisQueries,
  invalidateSourceScientificQueries,
  sourceUpdateCellId,
} from "../features/analyses/workspace/analysisQueryCache";
import { ImportCellsLauncher } from "./InboxPage";
import {
  buildCellLibraryRows,
  DEFAULT_CELL_LIBRARY_SORT,
  EMPTY_CELL_LIBRARY_FILTERS,
  cellLibraryStatuses,
  processCellLibraryRows,
  type CellLibraryFilters,
  type CellLibrarySort,
  type CellLibraryStatus,
  type SortDirection,
} from "../libraryTableLogic";
import {
  getLibrarySelectionScope,
  hasActiveCellLibraryFilters,
  selectAllMatchingCellIds,
} from "../librarySelectionScope";
import { adjacentListItem } from "../projectSelection";

type LibraryImpactRequest = {
  title: string;
  confirmLabel: string;
  plainMessage: string;
  cellIds: number[];
  groupIds: number[];
  run: (options: DestructiveImpactConfirmOptions) => Promise<void>;
};

/** Union of folder ids that currently contain any of the given cells. */
function foldersContainingCells(nodes: FolderNode[], cellIds: number[]): Set<number> {
  const wanted = new Set(cellIds);
  const found = new Set<number>();
  const walk = (folder: FolderNode) => {
    if (folder.cell_ids.some((id) => wanted.has(id))) found.add(folder.id);
    folder.children.forEach(walk);
  };
  nodes.forEach(walk);
  return found;
}

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

function CapacityValue({
  value,
  pending,
  failed = false,
}: {
  value: number | null | undefined;
  pending: boolean;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <Tooltip label="The cached cycling data could not be summarized. Open Activity for details.">
        <Text component="span" size="sm" c="red">Unavailable</Text>
      </Tooltip>
    );
  }
  if (!pending) return <>{formatCapacity(value)}</>;
  return (
    <Tooltip label="Being calculated from the cached cycling data. No partial value is shown.">
      <Text component="span" size="sm" c="dimmed" fs="italic">Calculating...</Text>
    </Tooltip>
  );
}

function SpecificCapacityValue({
  value,
  pending,
  failed = false,
}: {
  value: number | null | undefined;
  pending: boolean;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <Tooltip label="The cached cycling data could not be summarized. Open Activity for details.">
        <Text component="span" size="sm" c="red">
          Unavailable
        </Text>
      </Tooltip>
    );
  }
  if (pending) {
    return (
      <Tooltip label="Being calculated from the cached cycling data. No partial value is shown.">
        <Text component="span" size="sm" c="dimmed" fs="italic">
          Calculating...
        </Text>
      </Tooltip>
    );
  }
  if (value === null || value === undefined) {
    return (
      <Tooltip label="Add a valid active mass to calculate specific discharge capacity.">
        <Text component="span" size="sm" c="dimmed">
          —
        </Text>
      </Tooltip>
    );
  }
  return <>{`${value.toFixed(1)} mAh/g`}</>;
}

function ReplicateMembershipCell({
  groups,
  loading,
  failed,
}: {
  groups: ReplicateGroupSummary[];
  loading: boolean;
  failed: boolean;
}) {
  const [opened, setOpened] = useState(false);

  if (loading) {
    return (
      <Text size="sm" c="dimmed" ta="right">
        …
      </Text>
    );
  }
  if (failed) {
    return (
      <Tooltip label="Replicate membership could not be loaded.">
        <Text component="span" size="sm" c="red" ta="right">
          Unavailable
        </Text>
      </Tooltip>
    );
  }
  const count = groups.length;
  if (count === 0) {
    return (
      <Text size="sm" c="dimmed" ta="right">
        0
      </Text>
    );
  }
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={320}
      position="right"
      shadow="md"
      withinPortal
      trapFocus={false}
    >
      <Popover.Target>
        <UnstyledButton
          aria-label={`${count} replicate group${count === 1 ? "" : "s"}`}
          aria-expanded={opened}
          aria-haspopup="dialog"
          style={{ display: "block", width: "100%", textAlign: "right" }}
          onMouseEnter={() => setOpened(true)}
          onMouseLeave={() => setOpened(false)}
          onFocus={() => setOpened(true)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpened((current) => !current);
            }
            if (event.key === "Escape") {
              setOpened(false);
            }
          }}
        >
          <Text size="sm" td="underline" style={{ textDecorationStyle: "dotted" }}>
            {count}
          </Text>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown
        onMouseEnter={() => setOpened(true)}
        onMouseLeave={() => setOpened(false)}
      >
        <Text size="sm" fw={600} mb={8}>
          Replicate groups
        </Text>
        <Stack gap={4}>
          {groups.map((group) => (
            <Text key={group.id} size="sm" lineClamp={1} title={group.name}>
              {group.name}
            </Text>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

const STATUS_BADGE_ORDER: CellLibraryStatus[] = [
  "Complete",
  "Active",
  "Parsing",
  "Calculating",
  "Summary failed",
  "Changed",
  "Source changing",
  "Offline",
  "Ready",
];

function statusBadgeProps(status: CellLibraryStatus): {
  color: string;
  variant: "light" | "outline";
  label: string;
} {
  switch (status) {
    case "Complete":
      return { color: "gray", variant: "light", label: "complete" };
    case "Active":
      return { color: "teal", variant: "outline", label: "active" };
    case "Parsing":
      return { color: "blue", variant: "light", label: "parsing" };
    case "Calculating":
      return { color: "gray", variant: "light", label: "calculating" };
    case "Summary failed":
      return { color: "red", variant: "light", label: "summary failed" };
    case "Changed":
      return { color: "orange", variant: "light", label: "changed" };
    case "Source changing":
      return { color: "yellow", variant: "light", label: "source changing" };
    case "Offline":
      return { color: "red", variant: "light", label: "offline" };
    case "Ready":
      return { color: "teal", variant: "light", label: "ready" };
    default:
      return { color: "gray", variant: "light", label: status };
  }
}

function CellStatusBadges({ cell }: { cell: CellSummary }) {
  const statuses = new Set(cellLibraryStatuses(cell));
  return (
    <Group gap={4} wrap="nowrap">
      {STATUS_BADGE_ORDER.filter((status) => statuses.has(status)).map((status) => {
        const badge = statusBadgeProps(status);
        return (
          <Badge key={status} color={badge.color} variant={badge.variant}>
            {badge.label}
          </Badge>
        );
      })}
    </Group>
  );
}

const STATUS_HELP_ITEMS = [
  "Active / Complete — whether the cell is still expected to receive new cycling data. Completed cells are skipped by normal source checks.",
  "Ready — cached cycling data are available and the source has no detected change.",
  "Changed — the source file differs from the registered version and can be updated.",
  "Source changing — the file still appears to be written; updating is deferred.",
  "Offline — the registered source path cannot be reached.",
  "Parsing / Calculating / Summary failed — current state of preparing the cached cycling summary.",
] as const;

function StatusHeaderHelp() {
  return (
    <Popover width={360} position="bottom-start" withinPortal shadow="md">
      <Popover.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label="Explain cell statuses"
          onClick={(event) => event.stopPropagation()}
        >
          <IconInfoCircle size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="sm" fw={600} mb={8}>
          Cell statuses
        </Text>
        <Stack gap={6}>
          {STATUS_HELP_ITEMS.map((item) => (
            <Text key={item} size="xs">
              {item}
            </Text>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function cellsUrl(search: string) {
  return `/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`;
}

const CELL_PAGE_SIZE_OPTIONS = ["25", "50", "100"] as const;
type CellPageSize = 25 | 50 | 100;
const CELL_PAGE_SIZE_STORAGE_KEY = "cellxplorer-library-page-size";

function loadCellPageSize(): CellPageSize {
  if (typeof window === "undefined") return 25;
  const raw = window.localStorage.getItem(CELL_PAGE_SIZE_STORAGE_KEY);
  if (raw === "25" || raw === "50" || raw === "100") return Number(raw) as CellPageSize;
  return 25;
}

const LIBRARY_STICKY_BAR_STYLE = {
  position: "sticky" as const,
  top: "var(--app-shell-header-height, 52px)",
  zIndex: 40,
  marginInline: "calc(-1 * var(--mantine-spacing-md))",
  paddingInline: "var(--mantine-spacing-md)",
  paddingBlock: 8,
  borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
  background: "light-dark(var(--mantine-color-body), var(--mantine-color-dark-7))",
};

const CELL_SEARCH_DEBOUNCE_MS = 300;

const LIBRARY_CELL_TABLE_COL_WIDTHS = {
  select: 42,
  cell: "26%",
  replicates: 98,
  cycles: 76,
  maxSpecific: 156,
  charge: 112,
  discharge: 120,
  status: 188,
  created: 96,
  actions: 132,
} as const;

export function LibraryPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [cellPage, setCellPage] = useState(1);
  const [cellPageSize, setCellPageSize] = useState<CellPageSize>(() => loadCellPageSize());
  const [cellSort, setCellSortState] = useState<CellLibrarySort>(DEFAULT_CELL_LIBRARY_SORT);
  const [cellFilters, setCellFilters] = useState<CellLibraryFilters>(EMPTY_CELL_LIBRARY_FILTERS);
  const [replicateSearch, setReplicateSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCellIds, setSelectedCellIds] = useState<Set<number>>(new Set());
  const [lastSelectedCellId, setLastSelectedCellId] = useState<number | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [placeCellsOpen, setPlaceCellsOpen] = useState(false);
  const [placeCellOpen, setPlaceCellOpen] = useState(false);
  const [addToGroupDialogOpen, setAddToGroupDialogOpen] = useState(false);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupFolderIds, setGroupFolderIds] = useState<Set<number>>(new Set());
  const [groupReplacesFolderCells, setGroupReplacesFolderCells] = useState(false);
  // Prefill from the tree must not overwrite ticks made while a cold fetch settles.
  const groupFoldersTouched = useRef(false);
  const [groupFolderSearch, setGroupFolderSearch] = useState("");
  const [groupFolderSessionKey, setGroupFolderSessionKey] = useState(0);
  const [previewGroupId, setPreviewGroupId] = useState<number | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState(false);
  // Deep links from the command palette: ?cell=<id> opens that cell's detail,
  // ?replicate=<id> opens the replicate preview. The parameter is consumed
  // once so normal navigation afterwards is unaffected.
  useEffect(() => {
    const cellParam = searchParams.get("cell");
    const replicateParam = searchParams.get("replicate");
    if (!cellParam && !replicateParam) return;
    if (cellParam) {
      const id = Number(cellParam);
      if (Number.isFinite(id)) {
        setSelectedId(id);
        setPreviewGroupId(null);
      }
    } else if (replicateParam) {
      const id = Number(replicateParam);
      if (Number.isFinite(id)) {
        setPreviewGroupId(id);
        setSelectedId(null);
      }
    }
    const next = new URLSearchParams(searchParams);
    next.delete("cell");
    next.delete("replicate");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const id = window.setTimeout(() => setSearchQuery(searchInput), CELL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editActiveMass, setEditActiveMass] = useState<number | null>(null);
  const [editNominalCapacity, setEditNominalCapacity] = useState<number | null>(null);
  const [editElectrodeArea, setEditElectrodeArea] = useState<number | null>(null);
  const [editMaterialSelection, setEditMaterialSelection] = useState("custom");
  const [editAreaSelection, setEditAreaSelection] = useState("custom");
  const [editingGroup, setEditingGroup] = useState<ReplicateGroupSummary | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [editGroupDescription, setEditGroupDescription] = useState("");
  const [editGroupCellIds, setEditGroupCellIds] = useState<string[]>([]);
  const [impactRequest, setImpactRequest] = useState<LibraryImpactRequest | null>(null);
  const handledSourceCheckJob = useRef<number | null>(null);

  const cells = useQuery({
    queryKey: ["cells", searchQuery],
    queryFn: () => get<CellSummary[]>(cellsUrl(searchQuery)),
    refetchInterval: (query) =>
      query.state.data?.some((cell) => cell.has_parsing || cell.has_summary_pending)
        ? 2000
        : false,
  });
  const libraryCells = useQuery({
    queryKey: ["cells", ""],
    queryFn: () => get<CellSummary[]>(cellsUrl("")),
  });

  const sourceCheckJob = useQuery({
    queryKey: ["source-check-job"],
    queryFn: () => get<SourceCheckJob | null>("/api/source-check-jobs/latest"),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 600 : false),
  });

  const detail = useQuery({
    queryKey: ["cell", selectedId],
    queryFn: () => get<CellDetail>(`/api/cells/${selectedId}`),
    enabled: selectedId !== null,
  });

  const replicateGroups = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
  });
  const filteredReplicateGroups = useQuery({
    queryKey: ["replicate-groups", "search", replicateSearch],
    queryFn: () =>
      get<ReplicateGroupSummary[]>(
        `/api/replicate-groups${
          replicateSearch ? `?search=${encodeURIComponent(replicateSearch)}` : ""
        }`
      ),
    enabled:
      replicateGroups.isSuccess &&
      ((replicateGroups.data?.length ?? 0) > 0 || Boolean(replicateSearch.trim())),
  });
  const tree = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
    enabled: groupDialogOpen,
  });

  const replicateEditCells = useQuery({
    queryKey: ["cells", "replicate-edit"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
    enabled: editingGroup !== null,
  });
  const areaPresets = useQuery({
    queryKey: ["electrode-area-presets"],
    queryFn: () =>
      get<ElectrodeAreaPresetSettings>("/api/settings/electrode-area-presets"),
    enabled: editingCell,
  });
  const materialPresets = useQuery({
    queryKey: ["active-material-presets"],
    queryFn: () =>
      get<ActiveMaterialPresetSettings>("/api/settings/active-material-presets"),
    enabled: editingCell,
  });
  const materialPresetData = [
    { value: "custom", label: "Custom nominal capacity" },
    ...(materialPresets.data?.presets ?? []).map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.specific_capacity_mah_g} mAh/g)`,
    })),
  ];
  if (
    editMaterialSelection !== "custom" &&
    !materialPresetData.some((option) => option.value === editMaterialSelection)
  ) {
    materialPresetData.push({
      value: editMaterialSelection,
      label: `${
        detail.data?.scientific_presets.active_material.name ?? "Saved material preset"
      } (saved value)`,
    });
  }
  const areaPresetData = [
    { value: "custom", label: "Custom" },
    ...(areaPresets.data?.presets ?? []).map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.area_cm2} cm²)`,
    })),
  ];
  if (
    editAreaSelection !== "custom" &&
    !areaPresetData.some((option) => option.value === editAreaSelection)
  ) {
    areaPresetData.push({
      value: editAreaSelection,
      label:
        detail.data?.scientific_presets.electrode_area_preset_name ??
        "Saved area preset",
    });
  }
  const editScientificValid =
    editMaterialSelection === "custom" ||
    Boolean(
      (editActiveMass ??
        detail.data?.scientific_metadata.active_mass_mg.source_value) &&
        editNominalCapacity
    );

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
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const removeCells = useMutation({
    mutationFn: (cellIds: number[]) =>
      post<{
        ok: boolean;
        deleted_cell_ids: number[];
        deleted_replicate_group_ids: number[];
        missing_cell_ids: number[];
      }>("/api/cells/delete", { cell_ids: cellIds }),
    onSuccess: (result) => {
      notifications.show({
        message: `Removed ${result.deleted_cell_ids.length} cell${result.deleted_cell_ids.length === 1 ? "" : "s"} from the library`,
        color: "teal",
      });
      if (selectedId !== null && result.deleted_cell_ids.includes(selectedId)) setSelectedId(null);
      setSelectedCellIds(new Set());
      setLastSelectedCellId(null);
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const createReplicateGroup = useMutation({
    mutationFn: async (body: {
      name: string;
      cell_ids: number[];
      folder_ids: number[];
      remove_folder_cells?: { cell_id: number; folder_id: number }[];
    }) => {
      return post<ReplicateGroupSummary>("/api/replicate-groups", {
        name: body.name,
        cell_ids: body.cell_ids,
        folder_ids: body.folder_ids,
        remove_folder_cells: body.remove_folder_cells ?? [],
      });
    },
    onSuccess: (group) => {
      notifications.show({ message: `Created replicate group ${group.name}`, color: "teal" });
      setGroupDialogOpen(false);
      setGroupName("");
      setGroupFolderIds(new Set());
      setGroupReplacesFolderCells(false);
      groupFoldersTouched.current = false;
      setGroupFolderSearch("");
      setSelectedCellIds(new Set());
      setPreviewGroupId(group.id);
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["cells"] });
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

  const editReplicateGroup = useMutation({
    mutationFn: (body: { id: number; name: string; description: string; cell_ids: number[] }) =>
      patch<ReplicateGroupSummary>(`/api/replicate-groups/${body.id}`, {
        name: body.name,
        description: body.description,
        cell_ids: body.cell_ids,
      }),
    onSuccess: (group) => {
      notifications.show({ message: `Saved changes to ${group.name}`, color: "teal" });
      setEditingGroup(null);
      setPreviewGroupId((current) => (current === group.id ? group.id : current));
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview", group.id] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const deleteReplicateGroup = useMutation({
    mutationFn: (group: ReplicateGroupSummary) => del(`/api/replicate-groups/${group.id}`),
    onSuccess: (_, group) => {
      notifications.show({ message: `Removed empty replicate group ${group.name}`, color: "teal" });
      setEditingGroup(null);
      setPreviewGroupId((current) => (current === group.id ? null : current));
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["analysis"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const ungroupReplicates = useMutation({
    mutationFn: (body: { cell_ids?: number[]; group_ids?: number[] }) =>
      post<{ ok: boolean }>("/api/replicate-groups/ungroup", body),
    onSuccess: () => {
      notifications.show({ message: "Replicate grouping removed", color: "teal" });
      setSelectedCellIds(new Set());
      setSelectedGroupIds(new Set());
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["cells"] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["analyses"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const invalidateAfterImpact = () => {
    qc.invalidateQueries({ queryKey: ["analyses"] });
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["cells"] });
    qc.invalidateQueries({ queryKey: ["replicate-groups"] });
    void invalidateAnalysisQueries(qc);
  };

  const updateSource = useMutation({
    mutationFn: (file: Pick<SourceFile, "id" | "filename">) =>
      post<SourceFile>(`/api/files/${file.id}/update-from-source`, {}),
    onSuccess: (updated, file) => {
      const updatedCellId = sourceUpdateCellId(updated);
      notifications.show({ message: `Updated ${file.filename} from source`, color: "teal" });
      qc.invalidateQueries({ queryKey: ["cells"] });
      if (updatedCellId !== null && updatedCellId !== undefined) {
        qc.invalidateQueries({ queryKey: ["cell", updatedCellId] });
        qc.invalidateQueries({ queryKey: ["cell-cycles", updatedCellId] });
      } else {
        qc.invalidateQueries({ queryKey: ["cell"] });
      }
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["replicate-preview"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      void invalidateAnalysisQueries(qc);
      void invalidateSourceScientificQueries(qc, {
        cellIds:
          updatedCellId === null || updatedCellId === undefined
            ? undefined
            : [updatedCellId],
      });
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const editCell = useMutation({
    mutationFn: (body: {
      id: number;
      name: string;
      description: string;
      active_mass_mg_override: number | null;
      nominal_capacity_mah_override: number | null;
      electrode_area_cm2_override: number | null;
      active_material_preset_id: string | null;
      active_material_name: string | null;
      active_material_specific_capacity_mah_g: number | null;
      electrode_area_preset_id: string | null;
      electrode_area_preset_name: string | null;
    }) =>
      patch<CellSummary>(`/api/cells/${body.id}`, {
        name: body.name,
        description: body.description,
        active_mass_mg_override: body.active_mass_mg_override,
        nominal_capacity_mah_override: body.nominal_capacity_mah_override,
        electrode_area_cm2_override: body.electrode_area_cm2_override,
        active_material_preset_id: body.active_material_preset_id,
        active_material_name: body.active_material_name,
        active_material_specific_capacity_mah_g:
          body.active_material_specific_capacity_mah_g,
        electrode_area_preset_id: body.electrode_area_preset_id,
        electrode_area_preset_name: body.electrode_area_preset_name,
      }),
    onSuccess: (updated) => {
      notifications.show({ message: `Saved changes to ${updated.name}`, color: "teal" });
      qc.setQueryData<CellDetail>(["cell", updated.id], (current) =>
        current ? { ...current, ...updated } : current
      );
      setEditingCell(false);
      setEditName(updated.name);
      setEditDescription(updated.description ?? "");
      setEditActiveMass(updated.scientific_metadata.active_mass_mg.override_value);
      setEditNominalCapacity(updated.scientific_metadata.nominal_capacity_mah.override_value);
      setEditElectrodeArea(updated.scientific_metadata.electrode_area_cm2.override_value);
      setEditMaterialSelection(
        updated.scientific_presets.active_material.preset_id ?? "custom"
      );
      setEditAreaSelection(updated.scientific_presets.electrode_area_preset_id ?? "custom");
      qc.invalidateQueries({ queryKey: ["cells"] });
      qc.invalidateQueries({ queryKey: ["cell", updated.id] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["replicate-groups"] });
      qc.invalidateQueries({ queryKey: ["analysis"] });
      void invalidateSourceScientificQueries(qc, { cellIds: [updated.id] });
      void invalidateAnalysisQueries(qc);
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const startSourceMaintenance = useMutation({
    mutationFn: (body: { cellIds: number[]; updateAfterCheck: boolean }) =>
      post<SourceCheckJob>(
        body.updateAfterCheck
          ? "/api/cells/check-update-sources/jobs"
          : "/api/cells/check-sources/jobs",
        {
          cell_ids: body.cellIds.length ? body.cellIds : null,
        }
      ),
    onSuccess: (job, variables) => {
      qc.setQueryData(["source-check-job"], job);
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      notifications.show({
        message: variables.updateAfterCheck
          ? `Checking and updating ${job.total} source file${job.total === 1 ? "" : "s"}.`
          : `Checking ${job.total} source file${job.total === 1 ? "" : "s"}.`,
        color: "teal",
      });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  useEffect(() => {
    const job = sourceCheckJob.data;
    if (!job || job.status !== "completed" || handledSourceCheckJob.current === job.id) return;
    handledSourceCheckJob.current = job.id;

    if (job.update_after_check) {
      const ready = new Set(job.ready_cell_ids ?? []);
      void Promise.all([
        qc.invalidateQueries({ queryKey: ["cells"] }),
        qc.invalidateQueries({ queryKey: ["cell"] }),
        qc.invalidateQueries({ queryKey: ["cell-cycles"] }),
        qc.invalidateQueries({ queryKey: ["replicate-groups"] }),
        qc.invalidateQueries({ queryKey: ["replicate-preview"] }),
        qc.invalidateQueries({ queryKey: ["files"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        invalidateAnalysisQueries(qc),
      ]);
      if (ready.size > 0) {
        setSelectedCellIds((current) => {
          const next = new Set(current);
          ready.forEach((cellId) => next.delete(cellId));
          return next;
        });
      }
      return;
    }

    const checkedScope = new Set(job.requested_cell_ids);
    void qc
      .fetchQuery({
        queryKey: ["cells", searchQuery],
        queryFn: () => get<CellSummary[]>(cellsUrl(searchQuery)),
      })
      .then((refreshed) => {
        const changedIds = refreshed
          .filter(
            (cell) =>
              cell.has_changed && (checkedScope.size === 0 || checkedScope.has(cell.id))
          )
          .map((cell) => cell.id);
        setSelectedCellIds(new Set(changedIds));
      });
  }, [qc, searchQuery, sourceCheckJob.data]);

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
      ? ` This will also remove empty replicate group${emptiedGroups.length === 1 ? "" : "s"}: ${emptiedGroups
          .map((group) => group.name)
          .join(", ")}.`
      : "";
    setImpactRequest({
      title: `Remove ${cell.name}?`,
      confirmLabel: "Remove",
      plainMessage: `Remove ${cell.name} from the library?${suffix}`,
      cellIds: [cell.id],
      groupIds: [],
      run: async (options) => {
        await removeCell.mutateAsync(cell);
        const deleted = await deleteEmptyAnalysesIfRequested(options);
        if (deleted.length) {
          notifications.show({
            message: `Deleted ${deleted.length} empty ${deleted.length === 1 ? "analysis" : "analyses"}.`,
            color: "orange",
          });
          invalidateAfterImpact();
        }
      },
    });
  };

  const startEditingCell = (cell: CellSummary | CellDetail) => {
    setMetadataOpen(false);
    setSelectedId(cell.id);
    setEditName(cell.name);
    setEditDescription(cell.description ?? "");
    setEditActiveMass(cell.scientific_metadata.active_mass_mg.override_value);
    setEditNominalCapacity(cell.scientific_metadata.nominal_capacity_mah.override_value);
    setEditElectrodeArea(cell.scientific_metadata.electrode_area_cm2.override_value);
    setEditMaterialSelection(cell.scientific_presets.active_material.preset_id ?? "custom");
    setEditAreaSelection(cell.scientific_presets.electrode_area_preset_id ?? "custom");
    setEditingCell(true);
  };

  const startEditingGroup = (group: ReplicateGroupSummary) => {
    setEditingGroup(group);
    setEditGroupName(group.name);
    setEditGroupDescription(group.description ?? "");
    setEditGroupCellIds(group.cell_ids.map(String));
  };

  const saveGroupEdit = () => {
    if (!editingGroup || !editGroupName.trim()) return;
    const cellIds = editGroupCellIds.map(Number);
    if (cellIds.length === 0) {
      if (
        window.confirm(
          `${editingGroup.name} has no cells left. Remove this empty replicate group?`
        )
      ) {
        deleteReplicateGroup.mutate(editingGroup);
      }
      return;
    }
    editReplicateGroup.mutate({
      id: editingGroup.id,
      name: editGroupName.trim(),
      description: editGroupDescription,
      cell_ids: cellIds,
    });
  };

  const stopEditingCell = () => {
    setEditingCell(false);
    if (detail.data) {
      setEditName(detail.data.name);
      setEditDescription(detail.data.description ?? "");
      setEditActiveMass(detail.data.scientific_metadata.active_mass_mg.override_value);
      setEditNominalCapacity(detail.data.scientific_metadata.nominal_capacity_mah.override_value);
      setEditElectrodeArea(detail.data.scientific_metadata.electrode_area_cm2.override_value);
      setEditMaterialSelection(
        detail.data.scientific_presets.active_material.preset_id ?? "custom"
      );
      setEditAreaSelection(
        detail.data.scientific_presets.electrode_area_preset_id ?? "custom"
      );
    }
  };

  const saveCellEdit = () => {
    if (selectedId === null || !editName.trim() || !editScientificValid) return;
    const selectedMaterial = materialPresets.data?.presets.find(
      (preset) => preset.id === editMaterialSelection
    );
    editCell.mutate({
      id: selectedId,
      name: editName.trim(),
      description: editDescription,
      active_mass_mg_override: editActiveMass,
      nominal_capacity_mah_override: editNominalCapacity,
      electrode_area_cm2_override: editElectrodeArea,
      active_material_preset_id:
        editMaterialSelection === "custom" ? null : editMaterialSelection,
      active_material_name:
        editMaterialSelection === "custom"
          ? null
          : selectedMaterial?.name ??
            detail.data?.scientific_presets.active_material.name ??
            null,
      active_material_specific_capacity_mah_g:
        editMaterialSelection === "custom"
          ? null
          : selectedMaterial?.specific_capacity_mah_g ??
            detail.data?.scientific_presets.active_material.specific_capacity_mah_g ??
            null,
      electrode_area_preset_id:
        editAreaSelection === "custom" ? null : editAreaSelection,
      electrode_area_preset_name:
        editAreaSelection === "custom"
          ? null
          : areaPresets.data?.presets.find(
              (preset) => preset.id === editAreaSelection
            )?.name ??
            detail.data?.scientific_presets.electrode_area_preset_name ??
            null,
    });
  };

  const confirmRemoveSelected = () => {
    if (selectedCells.length === 0) return;
    const selected = new Set(selectedIds);
    const emptiedGroups = (replicateGroups.data ?? []).filter(
      (group) => group.cell_ids.length > 0 && group.cell_ids.every((cellId) => selected.has(cellId))
    );
    const suffix = emptiedGroups.length
      ? ` This will also remove empty replicate group${emptiedGroups.length === 1 ? "" : "s"}: ${emptiedGroups
          .map((group) => group.name)
          .join(", ")}.`
      : "";
    const cellIds = [...selectedIds];
    setImpactRequest({
      title: `Remove ${cellIds.length} cell${cellIds.length === 1 ? "" : "s"}?`,
      confirmLabel: "Remove",
      plainMessage: `Remove ${cellIds.length} selected cell${cellIds.length === 1 ? "" : "s"} from the library?${suffix}`,
      cellIds,
      groupIds: [],
      run: async (options) => {
        await removeCells.mutateAsync(cellIds);
        const deleted = await deleteEmptyAnalysesIfRequested(options);
        if (deleted.length) {
          notifications.show({
            message: `Deleted ${deleted.length} empty ${deleted.length === 1 ? "analysis" : "analyses"}.`,
            color: "orange",
          });
          invalidateAfterImpact();
        }
      },
    });
  };

  const confirmUngroup = (groupIds: number[]) => {
    if (groupIds.length === 0) return;
    setImpactRequest({
      title:
        groupIds.length === 1 ? "Separate replicate?" : `Separate ${groupIds.length} replicates?`,
      confirmLabel: "Separate",
      plainMessage:
        groupIds.length === 1
          ? "Remove this replicate grouping? Cells remain in the library."
          : `Remove grouping for ${groupIds.length} replicates? Cells remain in the library.`,
      cellIds: [],
      groupIds,
      run: async (options) => {
        await ungroupReplicates.mutateAsync({ group_ids: groupIds });
        const deleted = await deleteEmptyAnalysesIfRequested(options);
        if (deleted.length) {
          notifications.show({
            message: `Deleted ${deleted.length} empty ${deleted.length === 1 ? "analysis" : "analyses"}.`,
            color: "orange",
          });
          invalidateAfterImpact();
        }
      },
    });
  };

  const selectedIds = useMemo(() => Array.from(selectedCellIds), [selectedCellIds]);
  const selectedCells = useMemo(
    () => (cells.data ?? []).filter((cell) => selectedCellIds.has(cell.id)),
    [cells.data, selectedCellIds]
  );
  const selectedAllComplete =
    selectedCells.length > 0 && selectedCells.every((cell) => cell.cycling_status === "complete");
  const selectedAnyComplete = selectedCells.some((cell) => cell.cycling_status === "complete");
  const nextStatus: "active" | "complete" = selectedAllComplete ? "active" : "complete";
  const statusButtonLabel =
    selectedCells.length === 0
      ? "Set status"
      : selectedAllComplete
        ? "Mark active"
        : selectedAnyComplete
          ? "Mark complete"
          : "Mark complete";
  const allCells = cells.data ?? [];
  const sourceMaintenanceAvailable = (libraryCells.data?.length ?? 0) > 0;
  const sourceMaintenanceBusy =
    startSourceMaintenance.isPending || sourceCheckJob.data?.status === "running";
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
  const replicateFiltersEnabled = replicateGroups.isSuccess;
  const replicateFiltersFailed = replicateGroups.isError;
  const libraryRows = useMemo(
    () => buildCellLibraryRows(allCells, groupsByCellId),
    [allCells, groupsByCellId]
  );
  const filteredSortedRows = useMemo(
    () =>
      processCellLibraryRows(libraryRows, cellFilters, cellSort, {
        replicateFiltersEnabled,
      }),
    [cellFilters, cellSort, libraryRows, replicateFiltersEnabled]
  );
  const cellPageCount = Math.max(1, Math.ceil(filteredSortedRows.length / cellPageSize));
  const safeCellPage = Math.min(cellPage, cellPageCount);
  const pageStart = (safeCellPage - 1) * cellPageSize;
  const pageRows = filteredSortedRows.slice(pageStart, pageStart + cellPageSize);
  const pageCells = pageRows.map((row) => row.cell);
  const pageEnd = pageStart + pageCells.length;
  const totals = useMemo(() => {
    const rows = filteredSortedRows.map((row) => row.cell);
    return {
      cells: rows.length,
      active: rows.filter((cell) => cell.cycling_status !== "complete").length,
      complete: rows.filter((cell) => cell.cycling_status === "complete").length,
      parsing: rows.filter((cell) => cell.has_parsing).length,
      needUpdate: rows.filter((cell) => cell.has_changed).length,
      changing: rows.filter((cell) => cell.has_changing).length,
      offline: rows.filter((cell) => cell.has_offline).length,
    };
  }, [filteredSortedRows]);
  const filteredResultCount = filteredSortedRows.length;
  const searchResultCount = allCells.length;
  const showSearchScope = filteredResultCount !== searchResultCount;

  useEffect(() => {
    setCellPage(1);
  }, [searchQuery, cellPageSize, cellFilters, cellSort]);

  useEffect(() => {
    if (cellPage > cellPageCount) setCellPage(cellPageCount);
  }, [cellPage, cellPageCount]);

  useEffect(() => {
    const visibleIds = new Set(filteredSortedRows.map((row) => row.cell.id));
    setSelectedCellIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filteredSortedRows]);

  const selectionScope = getLibrarySelectionScope(
    pageCells.map((cell) => cell.id),
    filteredSortedRows.map((row) => row.cell.id),
    selectedCellIds,
  );
  const allVisibleSelected = selectionScope.allPageSelected;
  const hasActiveSearchOrFilter = hasActiveCellLibraryFilters(searchQuery, cellFilters);
  const selectAllMatchingLabel = hasActiveSearchOrFilter
    ? `Select all ${filteredResultCount} matching cells`
    : `Select all ${filteredResultCount} cells`;
  const selectAllMatching = () => {
    setSelectedCellIds(selectAllMatchingCellIds(filteredSortedRows.map((row) => row.cell.id)));
    setLastSelectedCellId(null);
  };

  const setCellSort = (column: CellLibrarySort["column"], direction: SortDirection) => {
    setCellSortState({ column, direction });
  };
  const previewGroup = (replicateGroups.data ?? []).find((group) => group.id === previewGroupId) ?? null;
  const replicateSelectData = useMemo(
    () => (replicateGroups.data ?? []).map((group) => ({ value: String(group.id), label: group.name })),
    [replicateGroups.data]
  );

  const setPageSize = (value: string | null) => {
    if (value !== "25" && value !== "50" && value !== "100") return;
    const next = Number(value) as CellPageSize;
    setCellPageSize(next);
    try {
      window.localStorage.setItem(CELL_PAGE_SIZE_STORAGE_KEY, value);
    } catch {
      // Ignoring persistence failure must not block pagination.
    }
  };

  const toggleCellSelection = (cellId: number, range = false) => {
    const visible = pageCells;
    setSelectedCellIds((current) => {
      const next = new Set(current);
      if (range && lastSelectedCellId !== null) {
        const from = visible.findIndex((cell) => cell.id === lastSelectedCellId);
        const to = visible.findIndex((cell) => cell.id === cellId);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(cellId);
          visible.slice(start, end + 1).forEach((cell) => {
            if (shouldSelect) next.add(cell.id);
            else next.delete(cell.id);
          });
          return next;
        }
      }
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
    setLastSelectedCellId(cellId);
  };

  const openCreateReplicateDialog = (
    folderIds?: number[],
    replaceFolderCells = false,
  ) => {
    setGroupName(
      selectedCells.length > 0
        ? `${selectedCells[0].name} replicates`
        : "Replicate group"
    );
    groupFoldersTouched.current = folderIds !== undefined;
    setGroupReplacesFolderCells(replaceFolderCells);
    setGroupFolderSearch("");
    setGroupFolderSessionKey((value) => value + 1);
    if (folderIds !== undefined) {
      setGroupFolderIds(new Set(folderIds));
      setGroupDialogOpen(true);
      return;
    }
    setGroupFolderIds(foldersContainingCells(tree.data?.folders ?? [], selectedIds));
    void qc.ensureQueryData({
      queryKey: ["tree"],
      queryFn: () => get<Tree>("/api/tree"),
    }).then((data) => {
      if (groupFoldersTouched.current) return;
      setGroupFolderIds(foldersContainingCells(data.folders ?? [], selectedIds));
    });
    setGroupDialogOpen(true);
  };

  const extendCellSelectionWithArrow = (
    currentCellId: number,
    direction: -1 | 1,
  ) => {
    const next = adjacentListItem(
      pageCells.map((cell) => cell.id),
      currentCellId,
      direction,
    );
    if (next === null) return false;
    setSelectedCellIds((current) => new Set(current).add(next));
    setLastSelectedCellId(next);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTableRowElement>(`tr[data-cell-row-id="${next}"]`)
        ?.focus({ preventScroll: true });
    });
    return true;
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
      </Group>

      <Stack gap="xs">
      <Stack gap={6} style={LIBRARY_STICKY_BAR_STYLE}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <TextInput
            size="sm"
            w={220}
            style={{ flexShrink: 0 }}
            leftSection={<IconSearch size={15} />}
            placeholder="Search cells"
            value={searchInput}
            onChange={(event) => setSearchInput(event.currentTarget.value)}
          />
          <Group ml="auto" justify="flex-end" gap="xs" wrap="wrap">
          <ImportCellsLauncher
            targetFolderId={null}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ["cells"] });
              qc.invalidateQueries({ queryKey: ["replicate-groups"] });
              qc.invalidateQueries({ queryKey: ["tree"] });
            }}
          >
            {({ open, loading }) => (
              <Button size="sm" leftSection={<IconUpload size={15} />} loading={loading} onClick={open}>
                Load cells
              </Button>
            )}
          </ImportCellsLauncher>
          <Menu withinPortal position="bottom-start" width="target">
            <Menu.Target>
              <Box component="span" display="inline-block">
                <Button.Group>
                  <Button
                    variant="default"
                    size="sm"
                    leftSection={<IconRefresh size={15} />}
                    loading={sourceMaintenanceBusy}
                    disabled={!sourceMaintenanceAvailable || sourceMaintenanceBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      startSourceMaintenance.mutate({ cellIds: selectedIds, updateAfterCheck: true });
                    }}
                  >
                    Check and update
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    px={6}
                    aria-label="Source maintenance options"
                    disabled={!sourceMaintenanceAvailable || sourceMaintenanceBusy}
                  >
                    <IconChevronDown size={14} />
                  </Button>
                </Button.Group>
              </Box>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={sourceMaintenanceBusy}
                onClick={() =>
                  startSourceMaintenance.mutate({ cellIds: selectedIds, updateAfterCheck: false })
                }
              >
                Check only
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Menu withinPortal position="bottom-end">
            <Menu.Target>
              <Button
                variant="default"
                size="sm"
                rightSection={<IconChevronDown size={14} />}
                leftSection={<IconLayersIntersect size={15} />}
                disabled={selectedCellIds.size === 0}
              >
                Replicate
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconLayersIntersect size={14} />}
                disabled={selectedCellIds.size < 2}
                onClick={() => openCreateReplicateDialog()}
              >
                Group selected as replicate
              </Menu.Item>
              <Menu.Item
                leftSection={<IconLayersIntersect size={14} />}
                disabled={selectedCellIds.size === 0 || (replicateGroups.data ?? []).length === 0}
                onClick={() => {
                  setTargetGroupId(null);
                  setAddToGroupDialogOpen(true);
                }}
              >
                Add selected to replicate
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconFolder size={15} />}
            disabled={selectedCellIds.size === 0}
            onClick={() => setPlaceCellsOpen(true)}
          >
            Place in folders
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={nextStatus === "complete" ? <IconCircleCheck size={15} /> : <IconPlayerPlay size={15} />}
            loading={setCellStatus.isPending}
            disabled={selectedCellIds.size === 0}
            onClick={() => setCellStatus.mutate({ cellIds: selectedIds, cyclingStatus: nextStatus })}
          >
            {statusButtonLabel}
          </Button>
          <Tooltip label="Remove selected">
            <ActionIcon
              variant="default"
              color="red"
              size={30}
              aria-label="Remove selected"
              loading={removeCells.isPending}
              disabled={selectedCellIds.size === 0}
              onClick={confirmRemoveSelected}
            >
              <IconTrash size={15} />
            </ActionIcon>
          </Tooltip>
          </Group>
        </Group>
        <Group gap="sm" justify="space-between" align="center" wrap="nowrap">
          <Group gap={8} align="center" wrap="nowrap">
            <IconDatabase size={18} color="var(--mantine-primary-color-6)" />
            <Title order={4}>Cells</Title>
            {selectedCellIds.size > 0 && (
              <Badge color="var(--mantine-primary-color-6)" variant="light">
                {selectedCellIds.size} selected
              </Badge>
            )}
          </Group>
          {filteredSortedRows.length > 0 && (
            <Group gap="sm" align="center" wrap="nowrap">
              <Group gap={6} align="center" wrap="nowrap">
                <Text size="xs" c="dimmed">
                  Per page
                </Text>
                <Select
                  size="xs"
                  w={80}
                  allowDeselect={false}
                  data={[...CELL_PAGE_SIZE_OPTIONS]}
                  value={String(cellPageSize)}
                  onChange={setPageSize}
                  aria-label="Cells per page"
                />
              </Group>
              <Pagination
                size="sm"
                value={safeCellPage}
                onChange={setCellPage}
                total={cellPageCount}
                disabled={cellPageCount <= 1}
              />
            </Group>
          )}
        </Group>
      </Stack>

      <Stack gap="xs">
      {cells.isLoading ? (
        <Center h={360}>
          <Loader />
        </Center>
      ) : cells.isError && !cells.data ? (
        <Alert color="red">Could not load the cell library.</Alert>
      ) : allCells.length === 0 ? (
        <Paper withBorder p="lg">
          <Group gap="lg" align="start">
            <IconDatabase size={34} color="var(--mantine-primary-color-6)" />
            <Stack gap={6}>
              <Text fw={700}>No cells in the library yet</Text>
              <Text size="sm" c="dimmed" maw={720}>
                Import a cycler file to create the first cell. The parsed cycle cache will appear
                here after import.
              </Text>
            </Stack>
          </Group>
        </Paper>
      ) : (
        <>
        {/* Above the table, directly under the pagination controls: at the foot of a
            full page of rows this prompt sits below the fold and is never seen. */}
        {selectionScope.showSelectAllMatchingPrompt && (
          <Alert
            color="orange"
            variant="light"
            radius="md"
            p="xs"
            icon={<IconInfoCircle size={16} />}
            style={{ border: "1px solid var(--mantine-color-orange-6)" }}
          >
            <Group justify="space-between" gap="sm" wrap="wrap">
              <Text size="sm">All {pageCells.length} cells on this page are selected.</Text>
              <Button
                size="compact-sm"
                variant="light"
                color="orange"
                onClick={selectAllMatching}
              >
                {selectAllMatchingLabel}
              </Button>
            </Group>
          </Alert>
        )}
        <Paper withBorder>
          <ScrollArea type="auto">
            <Table highlightOnHover style={{ tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.select }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.cell }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.replicates }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.cycles }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.maxSpecific }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.charge }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.discharge }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.status }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.created }} />
                <col style={{ width: LIBRARY_CELL_TABLE_COL_WIDTHS.actions }} />
              </colgroup>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={LIBRARY_CELL_TABLE_COL_WIDTHS.select}>
                    <Checkbox
                      aria-label="Select cells on this page"
                      checked={allVisibleSelected}
                      indeterminate={
                        pageCells.some((cell) => selectedCellIds.has(cell.id)) && !allVisibleSelected
                      }
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedCellIds((current) => {
                          const next = new Set(current);
                          pageCells.forEach((cell) => {
                            if (checked) next.add(cell.id);
                            else next.delete(cell.id);
                          });
                          return next;
                        });
                        setLastSelectedCellId(null);
                      }}
                    />
                  </Table.Th>
                  <Table.Th>
                    <CellLibraryColumnMenu
                      column="cell"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                    />
                  </Table.Th>
                  <Table.Th ta="right">
                    <CellLibraryColumnMenu
                      column="replicates"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                      align="right"
                    />
                  </Table.Th>
                  <Table.Th ta="right">
                    <CellLibraryColumnMenu
                      column="cycles"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                      align="right"
                    />
                  </Table.Th>
                  <Table.Th ta="right">
                    <CellLibraryColumnMenu
                      column="maxSpecificDischarge"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                      align="right"
                    />
                  </Table.Th>
                  <Table.Th ta="right">
                    <CellLibraryColumnMenu
                      column="totalCharge"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                      align="right"
                    />
                  </Table.Th>
                  <Table.Th ta="right">
                    <CellLibraryColumnMenu
                      column="totalDischarge"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                      align="right"
                    />
                  </Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap" }}>
                    <Group gap={4} wrap="nowrap" justify="space-between">
                      <CellLibraryColumnMenu
                        column="status"
                        sort={cellSort}
                        filters={cellFilters}
                        setFilters={setCellFilters}
                        setSort={setCellSort}
                        replicateFiltersEnabled={replicateFiltersEnabled}
                        replicateFiltersFailed={replicateFiltersFailed}
                      />
                      <StatusHeaderHelp />
                    </Group>
                  </Table.Th>
                  <Table.Th>
                    <CellLibraryColumnMenu
                      column="created"
                      sort={cellSort}
                      filters={cellFilters}
                      setFilters={setCellFilters}
                      setSort={setCellSort}
                      replicateFiltersEnabled={replicateFiltersEnabled}
                      replicateFiltersFailed={replicateFiltersFailed}
                    />
                  </Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pageCells.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={10}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No cells match the current filters.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                pageCells.map((cell) => {
                  const cellGroups = groupsByCellId.get(cell.id) ?? [];
                  return (
                  <Table.Tr
                    key={cell.id}
                    data-cell-row-id={cell.id}
                    tabIndex={0}
                    bg={
                      selectedCellIds.has(cell.id)
                        ? "var(--mantine-primary-color-light)"
                        : undefined
                    }
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      toggleCellSelection(cell.id, event.shiftKey);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        !event.shiftKey ||
                        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.altKey
                      ) {
                        return;
                      }
                      if (
                        extendCellSelectionWithArrow(
                          cell.id,
                          event.key === "ArrowUp" ? -1 : 1,
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <Table.Td>
                      <Checkbox
                        aria-label={`Select ${cell.name}`}
                        checked={selectedCellIds.has(cell.id)}
                        onClick={(event) => {
                          event.stopPropagation();
                          event.currentTarget
                            .closest<HTMLTableRowElement>("tr")
                            ?.focus({ preventScroll: true });
                        }}
                        onChange={(event) =>
                          toggleCellSelection(cell.id, (event.nativeEvent as MouseEvent).shiftKey)
                        }
                      />
                    </Table.Td>
                    <Table.Td>
                      <CellHoverCard cell={cell} result={undefined}>
                        <UnstyledButton
                          aria-label={`Open ${cell.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMetadataOpen(false);
                            setSelectedId(cell.id);
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            minWidth: 0,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <Text fw={700} lineClamp={1}>
                            {cell.name}
                          </Text>
                          {cell.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {cell.description}
                            </Text>
                          )}
                        </UnstyledButton>
                      </CellHoverCard>
                    </Table.Td>
                    <Table.Td>
                      <ReplicateMembershipCell
                        groups={cellGroups}
                        loading={replicateGroups.isLoading}
                        failed={replicateGroups.isError}
                      />
                    </Table.Td>
                    <Table.Td ta="right">{cell.total_cycles}</Table.Td>
                    <Table.Td ta="right">
                      <SpecificCapacityValue
                        value={cell.max_specific_discharge_capacity_mah_g}
                        pending={cell.has_summary_pending || cell.has_parsing}
                        failed={cell.has_summary_error}
                      />
                    </Table.Td>
                    <Table.Td ta="right">
                      <CapacityValue
                        value={cell.total_charge_capacity_mah}
                        pending={cell.has_summary_pending || cell.has_parsing}
                        failed={cell.has_summary_error}
                      />
                    </Table.Td>
                    <Table.Td ta="right">
                      <CapacityValue
                        value={cell.total_discharge_capacity_mah}
                        pending={cell.has_summary_pending || cell.has_parsing}
                        failed={cell.has_summary_error}
                      />
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      <CellStatusBadges cell={cell} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(cell.created_at)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group
                        gap="xs"
                        justify="end"
                        wrap="nowrap"
                        onClick={(event) => event.stopPropagation()}
                      >
                      <Tooltip label="Edit cell details">
                        <ActionIcon
                          variant="default"
                          aria-label={`Edit ${cell.name}`}
                          onClick={() => startEditingCell(cell)}
                        >
                          <IconPencil size={15} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Open">
                        <ActionIcon
                          variant="default"
                          aria-label={`Open ${cell.name}`}
                          onClick={() => {
                            setMetadataOpen(false);
                            setSelectedId(cell.id);
                          }}
                        >
                          <IconEye size={15} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Remove">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Remove ${cell.name}`}
                          loading={removeCell.isPending || removeCells.isPending}
                          onClick={() => confirmRemove(cell)}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
                })
                )}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr>
                  <Table.Td colSpan={10}>
                    <Group gap="xs" justify="space-between">
                      <Text size="xs" c="dimmed">
                        {totals.cells} cell{totals.cells === 1 ? "" : "s"} - {totals.active} active -{" "}
                        {totals.complete} complete - {totals.parsing} parsing - {totals.needUpdate} need update
                        {totals.changing ? ` - ${totals.changing} changing` : ""}
                        {totals.offline ? ` - ${totals.offline} offline` : ""}
                        {showSearchScope
                          ? ` (filtered from ${searchResultCount} matching search)`
                          : ""}
                      </Text>
                      {selectedCellIds.size > 0 && (
                        <Text size="xs" c="var(--mantine-primary-color-6)">
                          {selectedCellIds.size} selected
                        </Text>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              </Table.Tfoot>
            </Table>
          </ScrollArea>
        </Paper>
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Text size="sm" c="dimmed">
            {pageCells.length === 0
              ? `0 of ${filteredResultCount}`
              : `Showing ${pageStart + 1}–${pageEnd} of ${filteredResultCount}`}
          </Text>
          <Group gap="sm" align="center">
            <Group gap={6} align="center">
              <Text size="xs" c="dimmed">
                Per page
              </Text>
              <Select
                size="xs"
                w={80}
                allowDeselect={false}
                data={[...CELL_PAGE_SIZE_OPTIONS]}
                value={String(cellPageSize)}
                onChange={setPageSize}
                aria-label="Cells per page"
              />
            </Group>
            <Pagination
              size="sm"
              value={safeCellPage}
              onChange={setCellPage}
              total={cellPageCount}
              disabled={cellPageCount <= 1}
            />
          </Group>
        </Group>
        </>
      )}
      </Stack>
      </Stack>

      {((replicateGroups.data?.length ?? 0) > 0 || replicateSearch) && (
        <Stack gap="xs" mt="xl">
          <Group justify="space-between" align="center" style={LIBRARY_STICKY_BAR_STYLE}>
            <Group gap={6}>
              <IconLayersIntersect size={16} color="var(--mantine-primary-color-6)" />
              <Title order={4}>Replicate groups</Title>
            </Group>
            <Group gap="xs">
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconUnlink size={14} />}
                disabled={selectedGroupIds.size === 0}
                loading={ungroupReplicates.isPending}
                onClick={() => confirmUngroup([...selectedGroupIds])}
              >
                Separate selected{selectedGroupIds.size > 0 ? ` (${selectedGroupIds.size})` : ""}
              </Button>
              <TextInput
                size="xs"
                leftSection={<IconSearch size={14} />}
                placeholder="Search replicates"
                value={replicateSearch}
                onChange={(event) => setReplicateSearch(event.currentTarget.value)}
              />
            </Group>
          </Group>
          <Paper withBorder p="sm">
          <ScrollArea type="auto">
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36}>
                    <Checkbox
                      size="xs"
                      aria-label="Select all replicate groups"
                      checked={
                        (filteredReplicateGroups.data ?? []).length > 0 &&
                        (filteredReplicateGroups.data ?? []).every((g) => selectedGroupIds.has(g.id))
                      }
                      indeterminate={
                        selectedGroupIds.size > 0 &&
                        !(filteredReplicateGroups.data ?? []).every((g) => selectedGroupIds.has(g.id))
                      }
                      onChange={(event) =>
                        setSelectedGroupIds(
                          event.currentTarget.checked
                            ? new Set((filteredReplicateGroups.data ?? []).map((g) => g.id))
                            : new Set()
                        )
                      }
                    />
                  </Table.Th>
                  <Table.Th>Replicate group</Table.Th>
                  <Table.Th>Cells</Table.Th>
                  <Table.Th>Avg charge</Table.Th>
                  <Table.Th>Avg discharge</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(filteredReplicateGroups.data ?? []).map((group) => (
                  <Table.Tr key={group.id}>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        aria-label={`Select ${group.name}`}
                        checked={selectedGroupIds.has(group.id)}
                        onChange={(event) =>
                          setSelectedGroupIds((current) => {
                            const next = new Set(current);
                            if (event.currentTarget.checked) next.add(group.id);
                            else next.delete(group.id);
                            return next;
                          })
                        }
                      />
                    </Table.Td>
                    <Table.Td>
                      <div>
                        <Text fw={700}>{group.name}</Text>
                        {group.description && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {group.description}
                          </Text>
                        )}
                      </div>
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
                          leftSection={<IconPencil size={14} />}
                          onClick={() => startEditingGroup(group)}
                        >
                          Edit
                        </Button>
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
                          onClick={() => confirmUngroup([group.id])}
                        >
                          Separate
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {(filteredReplicateGroups.data ?? []).length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
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
        </Stack>
      )}

      <PlaceInFoldersModal
        opened={placeCellsOpen}
        onClose={() => setPlaceCellsOpen(false)}
        cellIds={selectedIds}
        title={`Place ${selectedIds.length} cell${selectedIds.length === 1 ? "" : "s"} in folders`}
        onPlaceAsReplicate={(folderIds) => {
          setPlaceCellsOpen(false);
          openCreateReplicateDialog(folderIds, true);
        }}
      />
      <PlaceInFoldersModal
        opened={placeCellOpen}
        onClose={() => setPlaceCellOpen(false)}
        cellIds={selectedId !== null ? [selectedId] : []}
        title={`Place ${detail.data?.name ?? "cell"} in folders`}
      />

      <Modal
        opened={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        title="Create replicate group"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {groupReplacesFolderCells
              ? `${selectedCellIds.size} selected cells will remain in the database. In the chosen folders, their individual references will be replaced by one replicate group.`
              : `${selectedCellIds.size} selected cells will remain separate cells in the database, linked as replicates for grouped previews and future analyses.`}
          </Text>
          <TextInput
            label="Group name"
            value={groupName}
            onChange={(event) => setGroupName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && selectedCellIds.size >= 2 && groupName.trim()) {
                createReplicateGroup.mutate({
                  name: groupName.trim(),
                  cell_ids: selectedIds,
                  folder_ids: [...groupFolderIds],
                  remove_folder_cells: groupReplacesFolderCells
                    ? [...groupFolderIds].flatMap((folderId) =>
                        selectedIds.map((cellId) => ({
                          cell_id: cellId,
                          folder_id: folderId,
                        }))
                      )
                    : [],
                });
              }
            }}
            data-autofocus
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Place in folders
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              Folders already holding the selected cells are pre-checked.
            </Text>
            <Box
              style={{
                border: "1px solid var(--mantine-color-gray-2)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <FolderTree
                folders={tree.data?.folders ?? []}
                loading={tree.isLoading}
                checkedState={(node) =>
                  groupFolderIds.has(node.id) ? "all" : "none"
                }
                onToggle={(node) => {
                  groupFoldersTouched.current = true;
                  setGroupFolderIds((current) => {
                    const next = new Set(current);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  });
                }}
                search={groupFolderSearch}
                onSearch={setGroupFolderSearch}
                presentFolderIds={foldersContainingCells(
                  tree.data?.folders ?? [],
                  selectedIds,
                )}
                stagedIds={groupFolderIds}
                maxHeight={220}
                sessionKey={groupFolderSessionKey}
                emptyMessage="No folders yet. Create a folder in the Projects view first."
              />
            </Box>
          </div>
          <Button
            disabled={selectedCellIds.size < 2 || !groupName.trim()}
            loading={createReplicateGroup.isPending}
            onClick={() =>
              createReplicateGroup.mutate({
                name: groupName.trim(),
                cell_ids: selectedIds,
                folder_ids: [...groupFolderIds],
                remove_folder_cells: groupReplacesFolderCells
                  ? [...groupFolderIds].flatMap((folderId) =>
                      selectedIds.map((cellId) => ({
                        cell_id: cellId,
                        folder_id: folderId,
                      }))
                    )
                  : [],
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
        opened={editingGroup !== null}
        onClose={() => setEditingGroup(null)}
        title="Edit replicate group"
        size="lg"
      >
        <Stack>
          <TextInput
            label="Name"
            value={editGroupName}
            onChange={(event) => setEditGroupName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveGroupEdit();
            }}
            data-autofocus
          />
          <Textarea
            label="Description"
            value={editGroupDescription}
            onChange={(event) => setEditGroupDescription(event.currentTarget.value)}
            minRows={2}
          />
          <MultiSelect
            label="Cells"
            description="A one-cell replicate is allowed. Saving an empty group will offer to remove it."
            placeholder="Search and select cells"
            data={(replicateEditCells.data ?? []).map((cell) => ({
              value: String(cell.id),
              label: cell.name,
            }))}
            value={editGroupCellIds}
            onChange={setEditGroupCellIds}
            searchable
            clearable
            hidePickedOptions
            nothingFoundMessage="No cells found"
          />
          {editGroupCellIds.length === 0 && (
            <Alert color="orange">
              This group will be empty. Saving will ask whether to remove the group.
            </Alert>
          )}
          <Group justify="end">
            <Button variant="default" onClick={() => setEditingGroup(null)}>
              Cancel
            </Button>
            <Button
              leftSection={editGroupCellIds.length === 0 ? <IconTrash size={16} /> : <IconDeviceFloppy size={16} />}
              color={editGroupCellIds.length === 0 ? "red" : "var(--mantine-primary-color-6)"}
              disabled={!editGroupName.trim()}
              loading={editReplicateGroup.isPending || deleteReplicateGroup.isPending}
              onClick={saveGroupEdit}
            >
              {editGroupCellIds.length === 0 ? "Remove empty group" : "Save changes"}
            </Button>
          </Group>
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
          setEditingCell(false);
          setSelectedId(null);
        }}
        title={detail.data?.name ?? "Cell"}
        size="90rem"
      >
        {detail.isLoading ? (
          <Center h={320}>
            <Loader />
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
                  Total charge <CapacityValue value={detail.data.total_charge_capacity_mah} pending={detail.data.has_summary_pending} failed={detail.data.has_summary_error} /> - total
                  discharge <CapacityValue value={detail.data.total_discharge_capacity_mah} pending={detail.data.has_summary_pending} failed={detail.data.has_summary_error} />
                </Text>
              </div>
              <Group gap={4}>
                {detail.data.cycling_status === "complete" && (
                  <Badge color="gray" variant="light">
                    cycling complete
                  </Badge>
                )}
                {detail.data.cycling_status !== "complete" && (
                  <Badge color="teal" variant="outline">
                    cycling active
                  </Badge>
                )}
                {detail.data.has_changed && (
                  <Badge color="orange" variant="light">
                    source changed
                  </Badge>
                )}
                {detail.data.has_changing && (
                  <Badge color="yellow" variant="light">
                    source changing
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
              {editingCell ? (
                <>
                  <Button
                    variant="default"
                    leftSection={<IconFolder size={15} />}
                    disabled={editCell.isPending || selectedId === null}
                    onClick={() => setPlaceCellOpen(true)}
                  >
                    Place in folders
                  </Button>
                  <Button
                    variant="default"
                    leftSection={<IconX size={15} />}
                    disabled={editCell.isPending}
                    onClick={stopEditingCell}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconDeviceFloppy size={15} />}
                    loading={editCell.isPending}
                    disabled={!editName.trim() || !editScientificValid}
                    onClick={saveCellEdit}
                  >
                    Save changes
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="default"
                    leftSection={<IconPencil size={15} />}
                    onClick={() => startEditingCell(detail.data!)}
                  >
                    Edit details
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    leftSection={<IconTrash size={15} />}
                    loading={removeCell.isPending}
                    onClick={() => confirmRemove(detail.data!)}
                  >
                    Remove from library
                  </Button>
                </>
              )}
            </Group>

            {editingCell ? (
              <Stack gap="sm">
                <Divider label="Editable details" labelPosition="left" />
                <TextInput
                  label="Cell name"
                  value={editName}
                  onChange={(event) => setEditName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveCellEdit();
                  }}
                  error={!editName.trim() ? "Cell name is required" : undefined}
                  data-autofocus
                />
                <Textarea
                  label="Cell notes"
                  description="User notes only. Original file metadata and cycling data remain preserved."
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) saveCellEdit();
                  }}
                  autosize
                  minRows={3}
                  maxRows={7}
                />
                <Divider label="Scientific metadata overrides" labelPosition="left" />
                <Alert color="gray">
                  Overrides are used in calculations while the original cycler values remain visible
                  in the Metadata tab. Clear a field to restore the source value.
                </Alert>
                <Group grow align="start">
                  <NumberInput
                    label="Active material mass (mg)"
                    description={`Source: ${
                      detail.data.scientific_metadata.active_mass_mg.source_value ?? "not detected"
                    }`}
                    min={0.000001}
                    decimalScale={6}
                    value={editActiveMass ?? ""}
                    placeholder={
                      detail.data.scientific_metadata.active_mass_mg.effective_value?.toString() ??
                      "Custom value"
                    }
                    error={
                      editMaterialSelection !== "custom" &&
                      !(editActiveMass ??
                        detail.data.scientific_metadata.active_mass_mg.source_value)
                        ? "Enter a mass to calculate nominal capacity"
                        : undefined
                    }
                    onChange={(value) => {
                      const mass = value === "" ? null : Number(value);
                      setEditActiveMass(mass);
                      if (editMaterialSelection !== "custom") {
                        const preset = materialPresets.data?.presets.find(
                          (item) => item.id === editMaterialSelection
                        );
                        const specificCapacity =
                          preset?.specific_capacity_mah_g ??
                          detail.data.scientific_presets.active_material
                            .specific_capacity_mah_g;
                        const effectiveMass =
                          mass ??
                          detail.data.scientific_metadata.active_mass_mg.source_value;
                        setEditNominalCapacity(
                          nominalCapacityFromMass(effectiveMass, specificCapacity)
                        );
                      }
                    }}
                  />
                  <Select
                    label="Active material"
                    description="Preset specific capacity is used with the active material mass"
                    data={materialPresetData}
                    value={editMaterialSelection}
                    searchable
                    onChange={(selection) => {
                      const nextSelection = selection ?? "custom";
                      setEditMaterialSelection(nextSelection);
                      if (nextSelection === "custom") return;
                      const preset = materialPresets.data?.presets.find(
                        (item) => item.id === nextSelection
                      );
                      const specificCapacity =
                        preset?.specific_capacity_mah_g ??
                        detail.data.scientific_presets.active_material
                          .specific_capacity_mah_g;
                      const mass =
                        editActiveMass ??
                        detail.data.scientific_metadata.active_mass_mg.source_value;
                      setEditNominalCapacity(
                        nominalCapacityFromMass(mass, specificCapacity)
                      );
                    }}
                  />
                </Group>
                <NumberInput
                  label="Nominal capacity (mAh)"
                  description={
                    editMaterialSelection === "custom"
                      ? `Custom value; source: ${
                          detail.data.scientific_metadata.nominal_capacity_mah.source_value ??
                          "not detected"
                        }`
                      : "Calculated from active material mass × preset specific capacity"
                  }
                  min={0.000001}
                  decimalScale={6}
                  value={editNominalCapacity ?? ""}
                  placeholder={
                    detail.data.scientific_metadata.nominal_capacity_mah.effective_value?.toString() ??
                    "Custom value"
                  }
                  disabled={editMaterialSelection !== "custom"}
                  onChange={(value) =>
                    setEditNominalCapacity(value === "" ? null : Number(value))
                  }
                />
                <Group grow align="end">
                  <Select
                    label="Electrode-area preset"
                    value={editAreaSelection}
                    searchable
                    data={areaPresetData}
                    onChange={(presetId) => {
                      const nextSelection = presetId ?? "custom";
                      setEditAreaSelection(nextSelection);
                      if (nextSelection === "custom") return;
                      const preset = areaPresets.data?.presets.find(
                        (item) => item.id === nextSelection
                      );
                      if (preset) setEditElectrodeArea(preset.area_cm2);
                    }}
                  />
                  <NumberInput
                    label="Electrode area (cm²)"
                    description="Used for current-density calculations"
                    min={0.000001}
                    decimalScale={6}
                    value={editElectrodeArea ?? ""}
                    placeholder={
                      detail.data.scientific_metadata.electrode_area_cm2.effective_value?.toString() ??
                      "Custom value"
                    }
                    disabled={editAreaSelection !== "custom"}
                    onChange={(value) =>
                      setEditElectrodeArea(value === "" ? null : Number(value))
                    }
                  />
                </Group>
              </Stack>
            ) : (
              detail.data.description && <Alert color="gray">{detail.data.description}</Alert>
            )}

            <CellDetailTabs
              cell={detail.data}
              onUpdateFile={(file) => updateSource.mutate(file)}
              updating={updateSource.isPending}
              onContinuationChanged={() => {
                qc.invalidateQueries({ queryKey: ["cell", selectedId] });
                qc.invalidateQueries({ queryKey: ["cells"] });
                qc.invalidateQueries({ queryKey: ["tree"] });
                qc.invalidateQueries({ queryKey: ["files"] });
                qc.invalidateQueries({ queryKey: ["analyses"] });
                qc.invalidateQueries({ queryKey: ["activity"] });
                qc.invalidateQueries({ queryKey: ["background-jobs"] });
              }}
            />
          </Stack>
        ) : null}
      </Modal>

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
}
