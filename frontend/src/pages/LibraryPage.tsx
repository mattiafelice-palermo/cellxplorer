import {
  ActionIcon,
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
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
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
  IconDeviceFloppy,
  IconEye,
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

import {
  ActiveMaterialPresetSettings,
  CellDetail,
  CellSummary,
  ElectrodeAreaPresetSettings,
  del,
  get,
  patch,
  post,
  ReplicateGroupPreview,
  ReplicateGroupSummary,
  SourceCheckJob,
  SourceFile,
} from "../api";
import { CellDetailTabs } from "../components/CellDetailTabs";
import { ReplicatePreviewPanel } from "../components/ReplicatePreviewPanel";
import { nominalCapacityFromMass } from "../scientificMetadata";
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

function cellsUrl(search: string) {
  return `/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`;
}

export function LibraryPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [replicateSearch, setReplicateSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCellIds, setSelectedCellIds] = useState<Set<number>>(new Set());
  const [lastSelectedCellId, setLastSelectedCellId] = useState<number | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [addToGroupDialogOpen, setAddToGroupDialogOpen] = useState(false);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [previewGroupId, setPreviewGroupId] = useState<number | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState(false);
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
  const handledSourceCheckJob = useRef<number | null>(null);

  const cells = useQuery({
    queryKey: ["cells", search],
    queryFn: () => get<CellSummary[]>(cellsUrl(search)),
    refetchInterval: (query) =>
      query.state.data?.some((cell) => cell.has_parsing || cell.has_summary_pending)
        ? 2000
        : false,
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
    queryKey: ["replicate-groups", replicateSearch],
    queryFn: () =>
      get<ReplicateGroupSummary[]>(
        `/api/replicate-groups${
          replicateSearch ? `?search=${encodeURIComponent(replicateSearch)}` : ""
        }`
      ),
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
      qc.invalidateQueries({ queryKey: ["analysis"] });
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
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  const checkSources = useMutation({
    mutationFn: (cellIds: number[]) =>
      post<SourceCheckJob>("/api/cells/check-sources/jobs", {
        cell_ids: cellIds.length ? cellIds : null,
      }),
    onSuccess: (job) => {
      qc.setQueryData(["source-check-job"], job);
      qc.invalidateQueries({ queryKey: ["background-jobs"] });
      notifications.show({
        message: `Checking ${job.total} source file${job.total === 1 ? "" : "s"} with ${job.workers} worker${job.workers === 1 ? "" : "s"}.`,
        color: "teal",
      });
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
  });

  useEffect(() => {
    const job = sourceCheckJob.data;
    if (!job || job.status !== "completed" || handledSourceCheckJob.current === job.id) return;
    handledSourceCheckJob.current = job.id;
    const checkedScope = new Set(job.requested_cell_ids);
    void qc
      .fetchQuery({
        queryKey: ["cells", search],
        queryFn: () => get<CellSummary[]>(cellsUrl(search)),
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
  }, [qc, search, sourceCheckJob.data]);

  const updateChangedSources = useMutation({
    mutationFn: (cellIds: number[]) =>
      post<{
        updated: number;
        updated_file_ids: number[];
        ready_cell_ids: number[];
        skipped_complete: number;
        errors: { file_id: number; filename: string; error: string }[];
      }>("/api/cells/update-changed-sources", {
        cell_ids: cellIds.length ? cellIds : null,
      }),
    onSuccess: async (result) => {
      notifications.show({
        message: `Updated ${result.updated} changed source file${result.updated === 1 ? "" : "s"}.`,
        color: result.errors.length ? "orange" : "teal",
      });
      result.errors.forEach((error) =>
        notifications.show({ message: `${error.filename}: ${error.error}`, color: "red" })
      );
      const ready = new Set(result.ready_cell_ids);
      qc.setQueriesData<CellSummary[]>({ queryKey: ["cells"] }, (current) =>
        current?.map((cell) =>
          ready.has(cell.id)
            ? { ...cell, has_changed: false, has_offline: false, has_changing: false }
            : cell
        )
      );
      setSelectedCellIds((current) => {
        const next = new Set(current);
        result.ready_cell_ids.forEach((cellId) => next.delete(cellId));
        return next;
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cells"] }),
        qc.invalidateQueries({ queryKey: ["cell"] }),
        qc.invalidateQueries({ queryKey: ["cell-cycles"] }),
        qc.invalidateQueries({ queryKey: ["replicate-groups"] }),
        qc.invalidateQueries({ queryKey: ["replicate-preview"] }),
        qc.invalidateQueries({ queryKey: ["files"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
      ]);
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
      ? `\n\nThis will also remove empty replicate group${emptiedGroups.length === 1 ? "" : "s"}: ${emptiedGroups
          .map((group) => group.name)
          .join(", ")}.`
      : "";
    if (
      window.confirm(
        `Remove ${selectedCells.length} selected cell${selectedCells.length === 1 ? "" : "s"} from the library?${suffix}`
      )
    ) {
      removeCells.mutate(selectedIds);
    }
  };

  const totals = useMemo(() => {
    const rows = cells.data ?? [];
    return {
      cells: rows.length,
      active: rows.filter((cell) => cell.cycling_status !== "complete").length,
      complete: rows.filter((cell) => cell.cycling_status === "complete").length,
      parsing: rows.filter((cell) => cell.has_parsing).length,
      needUpdate: rows.filter((cell) => cell.has_changed).length,
      changing: rows.filter((cell) => cell.has_changing).length,
      offline: rows.filter((cell) => cell.has_offline).length,
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

  const toggleCellSelection = (cellId: number, range = false) => {
    const visible = cells.data ?? [];
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

      <Group gap="xs" justify="end" align="center">
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
        <Button
          variant="default"
          size="sm"
          leftSection={<IconRefresh size={15} />}
          loading={checkSources.isPending || sourceCheckJob.data?.status === "running"}
          disabled={(cells.data ?? []).length === 0 || sourceCheckJob.data?.status === "running"}
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
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <Button
              variant="default"
              size="sm"
              rightSection={<IconChevronDown size={14} />}
              leftSection={<IconLayersIntersect size={15} />}
            >
              Replicate
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconLayersIntersect size={14} />}
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
          leftSection={nextStatus === "complete" ? <IconCircleCheck size={15} /> : <IconPlayerPlay size={15} />}
          loading={setCellStatus.isPending}
          disabled={selectedCellIds.size === 0}
          onClick={() => setCellStatus.mutate({ cellIds: selectedIds, cyclingStatus: nextStatus })}
        >
          {statusButtonLabel}
        </Button>
        <Button
          variant="default"
          color="red"
          size="sm"
          leftSection={<IconTrash size={15} />}
          loading={removeCells.isPending}
          disabled={selectedCellIds.size === 0}
          onClick={confirmRemoveSelected}
        >
          Remove selected
        </Button>
        <TextInput
          leftSection={<IconSearch size={15} />}
          placeholder="Search cells"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </Group>

      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Group gap={8}>
            <IconDatabase size={18} color="var(--mantine-color-teal-6)" />
            <Title order={4}>Cells</Title>
          </Group>
          {selectedCellIds.size > 0 && (
            <Badge color="teal" variant="light">
              {selectedCellIds.size} selected
            </Badge>
          )}
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
                        {
                          setSelectedCellIds(
                            event.currentTarget.checked
                              ? new Set((cells.data ?? []).map((cell) => cell.id))
                              : new Set()
                          );
                          setLastSelectedCellId(null);
                        }
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
                        onChange={(event) =>
                          toggleCellSelection(cell.id, (event.nativeEvent as MouseEvent).shiftKey)
                        }
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
                            <Badge key={group.id} size="xs" color="teal" variant="light">
                              {group.name}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>{cell.n_tests}</Table.Td>
                    <Table.Td>{cell.n_files}</Table.Td>
                    <Table.Td>{cell.total_cycles}</Table.Td>
                    <Table.Td>
                      <CapacityValue value={cell.total_charge_capacity_mah} pending={cell.has_summary_pending} failed={cell.has_summary_error} />
                    </Table.Td>
                    <Table.Td>
                      <CapacityValue value={cell.total_discharge_capacity_mah} pending={cell.has_summary_pending} failed={cell.has_summary_error} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {cell.cycling_status === "complete" && (
                          <Badge color="gray" variant="light">
                            complete
                          </Badge>
                        )}
                        {cell.cycling_status !== "complete" && (
                          <Badge color="teal" variant="outline">
                            active
                          </Badge>
                        )}
                        {cell.has_parsing && (
                          <Badge color="blue" variant="light">
                            parsing
                          </Badge>
                        )}
                        {cell.has_summary_pending && (
                          <Badge color="gray" variant="light">
                            calculating
                          </Badge>
                        )}
                        {cell.has_summary_error && (
                          <Badge color="red" variant="light">
                            summary failed
                          </Badge>
                        )}
                        {cell.has_changed && (
                          <Badge color="orange" variant="light">
                            changed
                          </Badge>
                        )}
                        {cell.has_changing && (
                          <Badge color="yellow" variant="light">
                            source changing
                          </Badge>
                        )}
                        {cell.has_offline && (
                          <Badge color="red" variant="light">
                            offline
                          </Badge>
                        )}
                        {!cell.has_changed &&
                          !cell.has_changing &&
                          !cell.has_offline &&
                          !cell.has_parsing &&
                          !cell.has_summary_pending &&
                          !cell.has_summary_error &&
                          cell.cycling_status !== "complete" && (
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
                      <Tooltip label="Edit cell details">
                        <ActionIcon
                          variant="default"
                          aria-label={`Edit ${cell.name}`}
                          onClick={() => startEditingCell(cell)}
                        >
                          <IconPencil size={15} />
                        </ActionIcon>
                      </Tooltip>
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
                        loading={removeCell.isPending || removeCells.isPending}
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
              <Table.Tfoot>
                <Table.Tr>
                  <Table.Td colSpan={10}>
                    <Group gap="xs" justify="space-between">
                      <Text size="xs" c="dimmed">
                        {totals.cells} cell{totals.cells === 1 ? "" : "s"} - {totals.active} active -{" "}
                        {totals.complete} complete - {totals.parsing} parsing - {totals.needUpdate} need update
                        {totals.changing ? ` - ${totals.changing} changing` : ""}
                        {totals.offline ? ` - ${totals.offline} offline` : ""}
                      </Text>
                      {selectedCellIds.size > 0 && (
                        <Text size="xs" c="teal">
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
      )}
      </Stack>

      {((replicateGroups.data?.length ?? 0) > 0 || replicateSearch) && (
        <Stack gap="xs" mt="xl">
          <Group justify="space-between" align="center">
            <Group gap={6}>
              <IconLayersIntersect size={16} color="var(--mantine-color-teal-6)" />
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
                onClick={() =>
                  ungroupReplicates.mutate(
                    { group_ids: [...selectedGroupIds] },
                    { onSuccess: () => setSelectedGroupIds(new Set()) }
                  )
                }
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
                        (replicateGroups.data ?? []).length > 0 &&
                        (replicateGroups.data ?? []).every((g) => selectedGroupIds.has(g.id))
                      }
                      indeterminate={
                        selectedGroupIds.size > 0 &&
                        !(replicateGroups.data ?? []).every((g) => selectedGroupIds.has(g.id))
                      }
                      onChange={(event) =>
                        setSelectedGroupIds(
                          event.currentTarget.checked
                            ? new Set((replicateGroups.data ?? []).map((g) => g.id))
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
                {(replicateGroups.data ?? []).map((group) => (
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
              color={editGroupCellIds.length === 0 ? "red" : "teal"}
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
                  Overrides are used in calculations while the original Neware values remain visible
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
            />
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}
