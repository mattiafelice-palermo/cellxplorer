import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconPlus, IconRefresh, IconTrash, IconDeviceFloppy } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  CellDetail,
  ContinuationInspectSource,
  ImportFolderSelectionResult,
  ImportInspectResult,
  ImportPreview,
  SourceChangeImpactPreview,
  SourceFile,
  attachContinuations,
  detachTestSource,
  inspectContinuationSources,
  previewTestSourceChange,
  reorderTestSources,
  post,
} from "../api";
import { acknowledgementFindingIds, findingSummary, moveSource, preserveAcknowledgements } from "../continuationPolicy";
import { ImportFilesystemPickerModal, ImportSourceSelection } from "./ImportFilesystemPickerModal";
import { ContinuationSourceList } from "./ContinuationSourceList";

function sourceFromFile(file: SourceFile): ContinuationInspectSource {
  return {
    key: `existing:${file.id}`,
    kind: "existing",
    source_file_id: file.id,
    filename: file.filename,
    hash: file.hash,
    start_time: file.start_time,
    end_time: null,
    local_cycle_start: file.cycle_count ? 1 : null,
    local_cycle_end: file.cycle_count,
    local_cycle_count: file.cycle_count,
    protocol_signature: null,
    device_info: file.device_info,
    channel: file.channel,
    nominal_capacity_mah: file.nominal_capacity_mah,
    active_mass_mg: file.active_mass_mg,
    inspection_status: file.parse_status === "error" ? "error" : "ready",
    inspection_error: file.parse_error,
  };
}

function stagedSource(source: ImportPreview) {
  return { staged_name: source.staged_name, source_path: source.source_path };
}

function impactText(impact: SourceChangeImpactPreview) {
  return `${impact.analysis_count} analyses and ${impact.saved_plot_count} saved plots will be invalidated.`;
}

export function ContinuationManagementPanel({
  cell,
  onChanged,
}: {
  cell: CellDetail;
  onChanged: () => void;
}) {
  const [orders, setOrders] = useState<Record<number, number[]>>({});
  const [reorderTestId, setReorderTestId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [addTestId, setAddTestId] = useState<number | null>(null);
  const [draggedSource, setDraggedSource] = useState<{ testId: number; index: number } | null>(null);
  const [stagedSources, setStagedSources] = useState<ImportPreview[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{
    title: string;
    message: string;
    impact: SourceChangeImpactPreview;
    run: () => void;
  } | null>(null);

  useEffect(() => {
    setOrders(Object.fromEntries(cell.tests.map((test) => [test.id, test.files.map((file) => file.id)])));
  }, [cell]);

  const currentTest = addTestId === null ? null : cell.tests.find((test) => test.id === addTestId) ?? null;
  const attachSources = useMemo(() => stagedSources.map(stagedSource), [stagedSources]);
  const attachInspection = useQuery({
    queryKey: ["continuation-attach-inspection", addTestId, attachSources],
    queryFn: () => inspectContinuationSources({ existing_test_id: addTestId, sources: attachSources }),
    enabled: attachOpen && addTestId !== null && attachSources.length > 0,
  });
  const reorderInspection = useQuery({
    queryKey: ["continuation-reorder-inspection", reorderTestId],
    queryFn: () => inspectContinuationSources({ existing_test_id: reorderTestId, sources: [] }),
    enabled: reorderTestId !== null,
  });

  const lifecycleMutation = useMutation({
    mutationFn: (action: { kind: "attach" | "reorder" | "detach"; testId: number; fileIds?: number[]; fileId?: number; sources?: ReturnType<typeof stagedSource>[]; acknowledgedFindingIds?: string[] }) => {
      if (action.kind === "attach") return attachContinuations(action.testId, { sources: action.sources ?? [], acknowledged_finding_ids: action.acknowledgedFindingIds });
      if (action.kind === "reorder") return reorderTestSources(action.testId, { file_ids: action.fileIds ?? [], acknowledged_finding_ids: action.acknowledgedFindingIds });
      return detachTestSource(action.testId, action.fileId ?? 0, { confirm: true, confirmation_token: pendingAction?.impact.confirmation_token });
    },
    onSuccess: (result, action) => {
      notifications.show({ message: action.kind === "attach" ? `Added sources to ${result.cell.name}` : action.kind === "reorder" ? `Saved source order for ${result.cell.name}` : `Detached source from ${result.cell.name}`, color: "teal" });
      setPendingAction(null);
      setAttachOpen(false);
      setStagedSources([]);
      setAcknowledged(new Set());
      onChanged();
    },
    onError: (error: Error) => notifications.show({ message: error.message, color: "red" }),
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
      setAttachOpen(true);
    } catch (error) {
      notifications.show({ message: error instanceof Error ? error.message : "Sources could not be inspected.", color: "red" });
    } finally {
      setPickerLoading(false);
    }
  };

  const saveReorder = (testId: number) => {
    const fileIds = orders[testId] ?? [];
    const test = cell.tests.find((item) => item.id === testId);
    if (!test) return;
    previewTestSourceChange(testId, { operation: "reorder", file_ids: fileIds })
      .then((impact) => setPendingAction({
        title: "Confirm source reorder",
        message: `Tracked tail: ${test.files.find((file) => file.id === test.files[test.files.length - 1]?.id)?.filename ?? "—"} → ${test.files.find((file) => file.id === fileIds[fileIds.length - 1])?.filename ?? "—"}. ${impactText(impact)}`,
        impact,
        run: () => lifecycleMutation.mutate({ kind: "reorder", testId, fileIds, acknowledgedFindingIds: Array.from(acknowledged) }),
      }))
      .catch((error: Error) => notifications.show({ message: error.message, color: "red" }));
  };

  const detach = (testId: number, file: SourceFile) => {
    previewTestSourceChange(testId, { operation: "detach", detach_file_id: file.id })
      .then((impact) => setPendingAction({
        title: `Detach ${file.filename}`,
        message: `The source file stays on disk. ${impactText(impact)} Global cycle numbering and saved-analysis data may change.`,
        impact,
        run: () => lifecycleMutation.mutate({ kind: "detach", testId, fileId: file.id }),
      }))
      .catch((error: Error) => notifications.show({ message: error.message, color: "red" }));
  };

  const attach = () => {
    if (addTestId === null || !attachSources.length || !attachInspection.data) return;
    const findings = attachInspection.data.findings;
    const nextAcknowledged = preserveAcknowledgements(acknowledged, attachInspection.data);
    setAcknowledged(new Set(nextAcknowledged));
    previewTestSourceChange(addTestId, { operation: "attach", sources: attachSources })
      .then((impact) => setPendingAction({
        title: `Add sources to ${currentTest?.name ?? "Test"}`,
        message: `${attachSources.length} source${attachSources.length === 1 ? "" : "s"} will be appended. ${impactText(impact)} ${findings.length ? "Review the findings shown in the source list." : "No continuation findings were reported."}`,
        impact,
        run: () => lifecycleMutation.mutate({ kind: "attach", testId: addTestId, sources: attachSources, acknowledgedFindingIds: nextAcknowledged }),
      }))
      .catch((error: Error) => notifications.show({ message: error.message, color: "red" }));
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between"><Text fw={700}>Continuation sources</Text><Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => { setAddTestId(cell.tests[cell.tests.length - 1]?.id ?? null); setPickerOpen(true); }}>Add continuation</Button></Group>
      <Text size="xs" c="dimmed">Sources stay as original files. Reordering changes the logical chain and tracked tail; detaching never deletes the disk file.</Text>
      {cell.tests.map((test, testIndex) => {
        const order = orders[test.id] ?? test.files.map((file) => file.id);
        const filesById = new Map(test.files.map((file) => [file.id, file]));
        const orderedFiles = order.map((id) => filesById.get(id)).filter((file): file is SourceFile => Boolean(file));
        const dirty = order.join(",") !== test.files.map((file) => file.id).join(",");
        const listSources = orderedFiles.map(sourceFromFile);
        return <Paper key={test.id} withBorder p="sm"><Group justify="space-between" mb="xs"><Text fw={700}>{test.name}</Text><Badge size="xs" variant="light">{orderedFiles.length} source{orderedFiles.length === 1 ? "" : "s"}</Badge></Group><ContinuationSourceList sources={listSources} findings={reorderTestId === test.id ? reorderInspection.data?.findings ?? [] : []} onMove={(index, direction) => { setOrders((current) => ({ ...current, [test.id]: moveSource(current[test.id] ?? order, index, direction) })); setReorderTestId(test.id); }} onDragStart={(index) => setDraggedSource({ testId: test.id, index })} onDrop={(index) => { if (!draggedSource || draggedSource.testId !== test.id) return; setOrders((current) => { const next = [...(current[test.id] ?? order)]; const [item] = next.splice(draggedSource.index, 1); next.splice(index, 0, item); return { ...current, [test.id]: next }; }); setReorderTestId(test.id); setDraggedSource(null); }} disabled={lifecycleMutation.isPending} /><Group justify="space-between" mt="xs"><Text size="xs" c="dimmed">{testIndex === cell.tests.length - 1 ? "Final Test in Cell" : "Earlier Test; this Test has its own tail"}</Text><Group gap="xs">{dirty && <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={lifecycleMutation.isPending} onClick={() => saveReorder(test.id)}>Save order</Button>}</Group></Group><Stack gap={3} mt="xs">{orderedFiles.map((file) => <Group key={file.id} justify="space-between" gap="xs"><Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>{file.filename}</Text><Button size="compact-xs" variant="subtle" color="red" disabled={orderedFiles.length <= 1} leftSection={<IconTrash size={13} />} onClick={() => detach(test.id, file)}>Detach</Button></Group>)}</Stack></Paper>;
      })}

      <ImportFilesystemPickerModal opened={pickerOpen} loading={pickerLoading} onClose={() => setPickerOpen(false)} onConfirm={loadStagedSources} />
      <Modal opened={attachOpen} onClose={() => setAttachOpen(false)} title="Add continuation sources" size="60rem">
        <Stack gap="sm"><Select label="Target Test" data={cell.tests.map((test) => ({ value: String(test.id), label: test.name }))} value={addTestId === null ? null : String(addTestId)} onChange={(value) => { setAddTestId(value ? Number(value) : null); setAcknowledged(new Set()); }} />
          {currentTest && currentTest.id !== cell.tests[cell.tests.length - 1]?.id && <Alert color="blue">These sources will be appended to {currentTest.name}. Its final source remains that Test’s tracked tail; the Cell’s overall tracked tail is still the final source of the final non-empty Test.</Alert>}
          {attachInspection.isPending && <Alert color="blue">Inspecting the proposed continuation…</Alert>}
          {attachInspection.isError && <Alert color="red">{attachInspection.error instanceof Error ? attachInspection.error.message : "Inspection failed."}</Alert>}
          {attachInspection.data && <ContinuationSourceList sources={attachInspection.data.sources} findings={attachInspection.data.findings} onMove={() => undefined} disabled />}
          {attachInspection.data && acknowledgementFindingIds(attachInspection.data).length > 0 && <Stack gap={4}><Text size="xs" fw={700}>Acknowledgements</Text>{attachInspection.data.findings.filter((finding) => finding.severity === "confirmation").map((finding) => <Checkbox key={finding.id} size="xs" checked={acknowledged.has(finding.id)} onChange={(event) => setAcknowledged((current) => { const next = new Set(current); if (event.currentTarget.checked) next.add(finding.id); else next.delete(finding.id); return next; })} label={findingSummary(finding)} />)}</Stack>}
          <Group justify="flex-end"><Button variant="default" onClick={() => setAttachOpen(false)}>Cancel</Button><Button leftSection={<IconPlus size={14} />} disabled={!attachInspection.data?.can_submit || attachInspection.data?.inspection_complete !== true || (attachInspection.data ? !acknowledgementFindingIds(attachInspection.data).every((id) => acknowledged.has(id)) : true)} loading={lifecycleMutation.isPending} onClick={attach}>Review impact and add</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={pendingAction !== null} onClose={() => setPendingAction(null)} title={pendingAction?.title ?? "Confirm source change"}>
        <Stack gap="sm"><Text size="sm">{pendingAction?.message}</Text>{pendingAction?.impact.analyses.length ? <Alert color="orange"><Stack gap={2}>{pendingAction.impact.analyses.map((analysis) => <Text key={analysis.id} size="xs">{analysis.title}: {analysis.plot_count} saved plots</Text>)}</Stack></Alert> : null}<Group justify="flex-end"><Button variant="default" onClick={() => setPendingAction(null)}>Cancel</Button><Button color="red" loading={lifecycleMutation.isPending} onClick={() => pendingAction?.run()}>Confirm change</Button></Group></Stack>
      </Modal>
    </Stack>
  );
}
