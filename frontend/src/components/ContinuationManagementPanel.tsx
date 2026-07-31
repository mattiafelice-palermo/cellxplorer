import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconArrowUp, IconDeviceFloppy, IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  CellDetail,
  ContinuationInspectResult,
  ContinuationInspectSource,
  ImportFolderSelectionResult,
  ImportInspectResult,
  ImportPreview,
  SourceChangeImpactPreview,
  SourceFile,
  attachCellContinuations,
  detachCellSource,
  inspectCellContinuationSources,
  post,
  previewCellSourceChange,
  reorderCellSources,
} from "../api";
import { acknowledgementFindingIds, findingSummary, moveSource, preserveAcknowledgements } from "../continuationPolicy";
import { ImportFilesystemPickerModal, ImportSourceSelection } from "./ImportFilesystemPickerModal";
import { ContinuationSourceList } from "./ContinuationSourceList";

function sourceFromFile(file: SourceFile): ContinuationInspectSource {
  return {
    key: `existing-${file.id}`,
    kind: "existing",
    source_file_id: file.id,
    filename: file.filename,
    source_path: file.path,
    hash: file.hash,
    start_time: file.start_time,
    end_time: null,
    local_cycle_start: null,
    local_cycle_end: null,
    local_cycle_count: file.cycle_count,
    protocol_signature: null,
    device_info: file.device_info,
    channel: file.channel,
    nominal_capacity_mah: file.nominal_capacity_mah,
    active_mass_mg: file.active_mass_mg,
    inspection_status: file.parse_status === "error" ? "error" : file.parse_status === "parsed" ? "ready" : "pending",
    inspection_error: file.parse_error,
    location_status: file.location_status,
    parse_status: file.parse_status,
    row_count: file.row_count,
  };
}

function stagedSource(source: ImportPreview) {
  return { staged_name: source.staged_name, source_path: source.source_path };
}

function flattenFiles(cell: CellDetail): SourceFile[] {
  return cell.tests
    .slice()
    .sort((left, right) => left.id - right.id)
    .flatMap((test) => test.files);
}

function reorderStaged(items: ImportPreview[], index: number, direction: -1 | 1): ImportPreview[] {
  const next = [...items];
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function impactSummary(impact: SourceChangeImpactPreview, sourceName: (id: number | null) => string) {
  const oldTail = sourceName(impact.old_tracked_source_id);
  const newTail = impact.new_tracked_source_id === null
    ? impact.new_tracked_filename ?? impact.new_tracked_staged_name ?? "Unknown"
    : sourceName(impact.new_tracked_source_id);
  return `${oldTail} → ${newTail}. ${impact.analysis_count} analyses and ${impact.saved_plot_count} saved plots will be invalidated.`;
}

type Mode = "attach" | "reorder" | "detach" | null;

export function ContinuationManagementPanel({
  cell,
  onChanged,
  onUpdateFile,
  updating = false,
}: {
  cell: CellDetail;
  onChanged: () => void;
  onUpdateFile?: (file: SourceFile) => void;
  updating?: boolean;
}) {
  const queryClient = useQueryClient();
  const files = useMemo(() => flattenFiles(cell), [cell]);
  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const currentFileIds = useMemo(() => files.map((file) => file.id), [files]);
  const [order, setOrder] = useState<number[]>(currentFileIds);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [stagedSources, setStagedSources] = useState<ImportPreview[]>([]);
  const [mode, setMode] = useState<Mode>(null);
  const [detachFileId, setDetachFileId] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  useEffect(() => {
    setOrder(currentFileIds);
  }, [cell.id, currentFileIds.join(",")]);

  const currentInspection = useQuery<ContinuationInspectResult>({
    queryKey: ["cell-continuation-details", cell.id, currentFileIds],
    queryFn: () => inspectCellContinuationSources(cell.id, {
      sources: [],
      proposed_order: currentFileIds.map((fileId) => `existing-${fileId}`),
    }),
    enabled: currentFileIds.length > 0,
    refetchInterval: (query) => query.state.status === "success" && !query.state.data?.inspection_complete ? 1000 : false,
  });

  const proposalQuery = useQuery<SourceChangeImpactPreview>({
    queryKey: [
      "cell-source-change-proposal",
      cell.id,
      mode,
      order,
      stagedSources.map((source) => `${source.staged_name}:${source.source_path ?? ""}`).join("|"),
      detachFileId,
    ],
    queryFn: () => {
      if (mode === "attach") {
        return previewCellSourceChange(cell.id, {
          operation: "attach",
          sources: stagedSources.map(stagedSource),
        });
      }
      if (mode === "reorder") {
        return previewCellSourceChange(cell.id, { operation: "reorder", file_ids: order });
      }
      return previewCellSourceChange(cell.id, { operation: "detach", detach_file_id: detachFileId });
    },
    enabled: mode === "attach"
      ? stagedSources.length > 0
      : mode === "reorder"
        ? order.length > 0
        : mode === "detach" && detachFileId !== null,
    refetchInterval: (query) => query.state.status === "success" && !query.state.data?.inspection?.inspection_complete ? 1000 : false,
  });

  const proposal = proposalQuery.data;
  const proposalInspection = proposal?.inspection;
  const displayedSources = useMemo(() => {
    if (mode === "attach") {
      return proposalInspection?.sources ?? stagedSources.map((source) => ({
        ...sourceFromFile({
          id: 0,
          hash: source.hash,
          path: source.source_path ?? source.staged_name,
          filename: source.filename,
          size: source.size,
          ext: source.ext,
          nda_version: source.nda_version,
          device_info: source.device_info,
          channel: source.channel,
          barcode: source.barcode,
          remarks: source.remarks,
          start_time: source.start_time,
          active_mass_mg: source.active_mass_mg,
          nominal_capacity_mah: source.nominal_capacity_mah,
          location_status: "online",
          parse_status: "parsing",
          parse_error: null,
          parser_version: null,
          row_count: null,
          cycle_count: null,
          registered: false,
          test_id: null,
          test_name: null,
          cell_id: null,
          cell_name: null,
          created_at: "",
        }),
        key: source.staged_name,
        kind: "staged" as const,
        source_file_id: null,
      })) as ContinuationInspectSource[];
    }
    const sourceMap = new Map((currentInspection.data?.sources ?? []).map((source) => [source.key, source]));
    return order.map((fileId) => sourceMap.get(`existing-${fileId}`) ?? sourceFromFile(fileById.get(fileId)!)).filter(Boolean);
  }, [currentInspection.data?.sources, fileById, mode, order, proposalInspection?.sources, stagedSources]);

  useEffect(() => {
    if (proposalInspection) {
      setAcknowledged((current) => new Set(preserveAcknowledgements(current, proposalInspection)));
    }
  }, [proposalInspection]);

  const sourceName = (id: number | null) => id === null ? "Unknown" : fileById.get(id)?.filename ?? `Source ${id}`;
  const proposalConfirmationIds = proposalInspection ? acknowledgementFindingIds(proposalInspection) : [];
  const proposalReady = Boolean(
    proposalInspection?.inspection_complete &&
      proposalInspection.can_submit &&
      proposalConfirmationIds.every((id) => acknowledged.has(id)),
  );

  const closeProposal = () => {
    setMode(null);
    setDetachFileId(null);
    setStagedSources([]);
    setAcknowledged(new Set());
  };

  const lifecycleMutation = useMutation({
    mutationFn: (action: { mode: Exclude<Mode, null>; order?: number[]; sources?: ReturnType<typeof stagedSource>[]; fileId?: number; confirmationToken?: string }) => {
      if (action.mode === "attach") return attachCellContinuations(cell.id, { sources: action.sources ?? [], acknowledged_finding_ids: Array.from(acknowledged) });
      if (action.mode === "reorder") return reorderCellSources(cell.id, { file_ids: action.order ?? [], acknowledged_finding_ids: Array.from(acknowledged) });
      return detachCellSource(cell.id, action.fileId ?? 0, { confirm: true, confirmation_token: action.confirmationToken, acknowledged_finding_ids: Array.from(acknowledged) });
    },
    onSuccess: (result, action) => {
      notifications.show({
        message: action.mode === "attach" ? `Added ${result.sources.length} source${result.sources.length === 1 ? "" : "s"} to ${result.cell.name}` : action.mode === "reorder" ? `Saved source order for ${result.cell.name}` : `Detached source from ${result.cell.name}`,
        color: "teal",
      });
      for (const key of ["cell", "cells", "files", "tree", "analyses", "activity", "background-jobs", "source-check-job"]) {
        void queryClient.invalidateQueries({ queryKey: key === "cell" ? [key, cell.id] : [key] });
      }
      closeProposal();
      onChanged();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
        void queryClient.invalidateQueries({ queryKey: ["cell-source-change-proposal"] });
      }
      notifications.show({ message: error.message, color: "red" });
    },
  });

  const loadStagedSources = async ({ filePaths, folderPaths }: ImportSourceSelection) => {
    setPickerLoading(true);
    try {
      let paths = filePaths;
      if (folderPaths.length) {
        const listed = await post<ImportFolderSelectionResult>("/api/imports/list-sources", { file_paths: filePaths, folder_paths: folderPaths });
        paths = listed.files.map((file) => file.path).filter((path): path is string => Boolean(path));
      }
      const inspected = await post<ImportInspectResult>("/api/imports/inspect-paths", { paths });
      setStagedSources(inspected.files);
      setPickerOpen(false);
      setMode("attach");
    } catch (error) {
      notifications.show({ message: error instanceof Error ? error.message : "Sources could not be inspected.", color: "red" });
    } finally {
      setPickerLoading(false);
    }
  };

  const mainSources = useMemo(() => {
    const details = new Map((currentInspection.data?.sources ?? []).map((source) => [source.key, source]));
    return order.map((fileId) => details.get(`existing-${fileId}`) ?? sourceFromFile(fileById.get(fileId)!)).filter(Boolean);
  }, [currentInspection.data?.sources, fileById, order]);
  const dirty = order.join(",") !== currentFileIds.join(",");
  const actionInProgress = lifecycleMutation.isPending || proposalQuery.isFetching;

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <div>
          <Text fw={700}>Cell source chain</Text>
          <Text size="xs" c="dimmed">Original files stay separate. The final source is the tracked tail; earlier sources are historical.</Text>
        </div>
        <Group gap="xs">
          {dirty && <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={proposalQuery.isFetching} onClick={() => { setAcknowledged(new Set()); setMode("reorder"); }}>Review order</Button>}
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setPickerOpen(true)}>Add continuation</Button>
        </Group>
      </Group>
      {currentInspection.isError && <Alert color="red">{currentInspection.error instanceof Error ? currentInspection.error.message : "Source details could not be prepared."}</Alert>}
      {currentInspection.data && !currentInspection.data.inspection_complete && <Alert color="blue">Preparing source details from the current Cell caches…</Alert>}
      <ContinuationSourceList
        sources={mainSources}
        findings={[]}
        onMove={(index, direction) => setOrder((current) => moveSource(current, index, direction))}
        onDragStart={setDraggedIndex}
        onDrop={(index) => {
          if (draggedIndex === null) return;
          setOrder((current) => {
            const next = [...current];
            const [item] = next.splice(draggedIndex, 1);
            next.splice(index, 0, item);
            return next;
          });
          setDraggedIndex(null);
        }}
        onUpdateSource={(sourceKey) => {
          const fileId = Number(sourceKey.replace("existing-", ""));
          const file = fileById.get(fileId);
          if (file && onUpdateFile) onUpdateFile(file);
        }}
        updateDisabled={updating}
        onRemove={(sourceKey) => {
          const fileId = Number(sourceKey.replace("existing-", ""));
          setMode("detach");
          setDetachFileId(fileId);
          setAcknowledged(new Set());
        }}
        disabled={lifecycleMutation.isPending}
      />

      <ImportFilesystemPickerModal opened={pickerOpen} loading={pickerLoading} onClose={() => setPickerOpen(false)} onConfirm={loadStagedSources} />
      <Modal opened={mode !== null} onClose={closeProposal} title={mode === "attach" ? "Review added sources" : mode === "reorder" ? "Review source order" : "Review source detachment"} size="70rem">
        <Stack gap="sm">
          {proposalQuery.isPending && <Alert color="blue">Preparing the complete Cell proposal…</Alert>}
          {proposalQuery.isError && <Alert color="red">{proposalQuery.error instanceof Error ? proposalQuery.error.message : "The Cell proposal could not be prepared."}</Alert>}
          {proposalInspection && !proposalInspection.inspection_complete && <Alert color="blue">Preparation is still pending. This review will update automatically.</Alert>}
          {proposalInspection?.findings.filter((finding) => finding.severity === "blocking").map((finding) => <Alert key={finding.id} color="red" icon={<IconAlertTriangle size={16} />}>{findingSummary(finding)}</Alert>)}
          {proposal && <Text size="sm" c="dimmed">{impactSummary(proposal, sourceName)} {proposal.global_cycle_numbering_changes ? "Global cycle numbering will change." : "Global cycle numbering is unchanged."} {proposal.destructive ? "The source row will be detached, but the original disk file will remain." : "This change is reversible by changing the order."}</Text>}
          {mode === "attach" && proposalInspection && proposalInspection.suggested_order.length > 0 && <Group justify="flex-end"><Button size="compact-xs" variant="default" leftSection={<IconArrowUp size={13} />} disabled={actionInProgress} onClick={() => setStagedSources((current) => { const byKey = new Map(current.map((source) => [source.staged_name, source])); return proposalInspection.suggested_order.map((key) => byKey.get(key)).filter((source): source is ImportPreview => Boolean(source)); })}>Use suggested order</Button></Group>}
          <ContinuationSourceList
            sources={displayedSources}
            findings={proposalInspection?.findings ?? []}
            onMove={(index, direction) => {
              if (mode !== "attach") return;
              const existingCount = (proposalInspection?.sources.length ?? stagedSources.length) - stagedSources.length;
              setStagedSources((current) => reorderStaged(current, index - existingCount, direction));
            }}
            onRemove={mode === "attach" ? (sourceKey) => setStagedSources((current) => current.filter((source) => source.staged_name !== sourceKey)) : undefined}
            canRemoveSource={mode === "attach" ? (sourceKey) => stagedSources.some((source) => source.staged_name === sourceKey) : undefined}
            disabled={actionInProgress || mode !== "attach"}
            emptyMessage="No sources remain in this proposal."
          />
          {proposalInspection && proposalConfirmationIds.length > 0 && <Stack gap={4}><Text size="xs" fw={700}>Acknowledgements</Text>{proposalInspection.findings.filter((finding) => finding.severity === "confirmation").map((finding) => <Checkbox key={finding.id} size="xs" disabled={actionInProgress} checked={acknowledged.has(finding.id)} onChange={(event) => setAcknowledged((current) => { const next = new Set(current); if (event.currentTarget.checked) next.add(finding.id); else next.delete(finding.id); return next; })} label={findingSummary(finding)} />)}</Stack>}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={closeProposal}>Cancel</Button>
            <Button
              leftSection={mode === "attach" ? <IconPlus size={14} /> : mode === "reorder" ? <IconArrowUp size={14} /> : <IconTrash size={14} />}
              color={mode === "detach" ? "red" : undefined}
              disabled={!proposalReady || actionInProgress || (mode === "attach" && stagedSources.length === 0)}
              loading={lifecycleMutation.isPending}
              onClick={() => {
                if (!mode || !proposal) return;
                lifecycleMutation.mutate(mode === "attach"
                  ? { mode, sources: stagedSources.map(stagedSource) }
                  : mode === "reorder"
                    ? { mode, order }
                    : { mode, fileId: detachFileId ?? 0, confirmationToken: proposal.confirmation_token });
              }}
            >
              {mode === "attach" ? "Add sources" : mode === "reorder" ? "Save order" : "Detach source"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
