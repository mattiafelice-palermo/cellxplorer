import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ActiveMaterialPresetSettings,
  ApiError,
  ContinuationInspectResult,
  ContinuationPreviewResult,
  ElectrodeAreaPresetSettings,
  ImportPreview,
  inspectContinuationSources,
  previewContinuationSources,
} from "../api";
import {
  continuationSourceCanOpenRawData,
  continuationHasFindings,
  continuationInspectionHasErrors,
  continuationReviewRequired,
  moveSource,
  preserveAcknowledgements,
} from "../continuationPolicy";
import {
  assignContinuationSourceColors,
  buildContinuedImportSubmissionState,
  nextSelectedSourceKey,
  type ContinuedImportSubmissionState,
  type SourceColorAssignments,
} from "../continuedImportWorkspacePolicy";
import {
  shouldRequestImportPreview,
  type ImportPreviewDraftState,
} from "../importPreviewPolicy";
import {
  buildContinuationPreviewTraces,
  continuationPreviewHasPoints,
  continuationPreviewFailureSources,
  continuationPreviewQueryKey,
  continuationPreviewRequest,
} from "../continuedImportPreviewPolicy";
import { PALETTE } from "../features/analyses/editor/plotting/plotStyle";
import { ContinuationReviewModal } from "./ContinuationReviewModal";
import { ContinuationSourceList } from "./ContinuationSourceList";
import Plot from "./Plot";

export type ContinuedCellDraft = {
  cell_name: string;
  description: string;
  metadata: Record<string, string>;
  active_mass_mg_override: number | null;
  nominal_capacity_mah_override: number | null;
  electrode_area_cm2_override: number | null;
  active_material_selection: string;
  active_material_preset_id: string | null;
  active_material_name: string | null;
  active_material_specific_capacity_mah_g: number | null;
  electrode_area_selection: string;
  electrode_area_preset_id: string | null;
  electrode_area_preset_name: string | null;
  source_metadata: ImportPreview | null;
};

type DraftSource = ImportPreviewDraftState;

function draftSource(draft: DraftSource) {
  return {
    staged_name: draft.staged_name,
    source_path: draft.source_path,
    inspection: draft.inspection,
    allow_metadata_only: draft.metadata_only,
  };
}

function fallbackSource(draft: DraftSource) {
  return {
    key: draft.staged_name,
    kind: "staged" as const,
    source_file_id: null,
    filename: draft.filename,
    source_path: draft.source_path,
    hash: draft.hash || null,
    start_time: draft.start_time,
    end_time: null,
    local_cycle_start: null,
    local_cycle_end: null,
    local_cycle_count: null,
    protocol_signature: null,
    device_info: draft.device_info,
    channel: draft.channel,
    nominal_capacity_mah: draft.nominal_capacity_mah,
    active_mass_mg: draft.active_mass_mg,
    inspection_status: "pending" as const,
    canonical_cycling: !draft.metadata_only,
    metadata_only: draft.metadata_only,
    capability_warning: draft.capability_warning,
  };
}

function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** One compact fact line in the selected-source summary. Unavailable facts render as "—" rather than being guessed. */
function SummaryRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Group gap="xs" wrap="nowrap" align="start">
      <Text size="xs" c="dimmed" style={{ flex: "none", width: 84 }}>{label}</Text>
      <Text size="xs" truncate title={value ?? undefined} style={{ flex: 1, minWidth: 0 }}>
        {value || "—"}
      </Text>
    </Group>
  );
}

export function ContinuedImportEditor({
  opened,
  drafts,
  cellDraft,
  onCellDraftChange,
  onAddMoreSources,
  onRemoveSource,
  onSwitchToSeparate,
  addingMore,
  destinationFolders,
  onDestinationFoldersChange,
  folderSelectData,
  materialPresets,
  areaPresets,
  onSubmissionStateChange,
  onRawData,
  onPreviewRequested,
  importing,
}: {
  opened: boolean;
  drafts: DraftSource[];
  cellDraft: ContinuedCellDraft;
  onCellDraftChange: (draft: ContinuedCellDraft) => void;
  onAddMoreSources: () => void;
  onRemoveSource: (stagedName: string) => void;
  onSwitchToSeparate: () => void;
  addingMore: boolean;
  destinationFolders: string[];
  onDestinationFoldersChange: (folders: string[]) => void;
  folderSelectData: { value: string; label: string }[];
  materialPresets: ActiveMaterialPresetSettings["presets"];
  areaPresets: ElectrodeAreaPresetSettings["presets"];
  /** Immutable submission projection for the shared footer's Import action. */
  onSubmissionStateChange: (state: ContinuedImportSubmissionState) => void;
  onRawData?: (stagedName: string) => void;
  onPreviewRequested?: (draft: DraftSource, retry?: boolean) => void;
  importing: boolean;
}) {
  const [order, setOrder] = useState<string[]>(() => drafts.map((item) => item.staged_name));
  const [colors, setColors] = useState<SourceColorAssignments>({});
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>(() => drafts[0]?.staged_name ?? "");
  const [previewMode, setPreviewMode] = useState<"combined" | "source">("combined");
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const previousOrderRef = useRef<string[]>(order);

  const byKey = useMemo(() => new Map(drafts.map((item) => [item.staged_name, item])), [drafts]);
  const orderedDrafts = useMemo(
    () => order.map((key) => byKey.get(key)).filter((item): item is DraftSource => Boolean(item)),
    [byKey, order],
  );
  const inspectionQuery = useQuery<ContinuationInspectResult>({
    queryKey: [
      "continued-import-inspection",
      order,
      drafts.map((item) => `${item.staged_name}:${item.hash}:${item.source_path ?? ""}`).join("|"),
    ],
    queryFn: () => inspectContinuationSources({
      sources: orderedDrafts.map(draftSource),
      proposed_order: order,
    }),
    enabled: opened && inspectionRequested && orderedDrafts.length >= 2,
    refetchInterval: (query) =>
      opened && inspectionRequested && orderedDrafts.length >= 2 && !query.state.data?.inspection_complete ? 1000 : false,
  });
  const result = inspectionQuery.data;
  const sourceInspectionFailed = continuationInspectionHasErrors(result);
  const combinedPreviewQuery = useQuery<ContinuationPreviewResult>({
    queryKey: continuationPreviewQueryKey(order, orderedDrafts, inspectionQuery.dataUpdatedAt),
    queryFn: ({ signal }) => previewContinuationSources(
      continuationPreviewRequest(orderedDrafts, order),
      { signal },
    ),
    enabled: opened
      && previewMode === "combined"
      && inspectionRequested
      && Boolean(result?.inspection_complete)
      && orderedDrafts.length >= 2,
    staleTime: Infinity,
  });
  const orderedSources = useMemo(
    () => result?.sources.length
      ? order
        .map((key) => result.sources.find((source) => source.key === key))
        .filter((source): source is NonNullable<typeof source> => Boolean(source))
      : orderedDrafts.map(fallbackSource),
    [order, orderedDrafts, result],
  );

  // Keep the visible order in sync with staged drafts: append newly staged
  // sources, drop removed ones, preserve everyone else's position.
  useEffect(() => {
    const available = new Set(drafts.map((item) => item.staged_name));
    setOrder((current) => [
      ...current.filter((key) => available.has(key)),
      ...drafts.map((item) => item.staged_name).filter((key) => !current.includes(key)),
    ]);
  }, [drafts]);

  // Color belongs to source identity, not list position: reordering never
  // recolors a source, and a newly added source takes the next free slot.
  useEffect(() => {
    setColors((current) => assignContinuationSourceColors(current, order, PALETTE));
  }, [order]);

  // Selection is stable by source key: reordering keeps the same source
  // selected, and removing the selected source falls back to its nearest
  // surviving neighbour rather than jumping to the first row.
  useEffect(() => {
    setSelectedSourceKey((current) => nextSelectedSourceKey(current || null, previousOrderRef.current, order) ?? "");
    previousOrderRef.current = order;
  }, [order]);

  // Preview stays lazy (still one source, still on demand), but every way a
  // source becomes selected -- an explicit click as well as the automatic
  // initial/fallback selection above -- should request it, not only clicks.
  useEffect(() => {
    const selected = byKey.get(selectedSourceKey);
    if (shouldRequestImportPreview(selected, true)) {
      onPreviewRequested?.(selected);
    }
  }, [selectedSourceKey]);

  useEffect(() => {
    if (result) setAcknowledged((current) => new Set(preserveAcknowledgements(current, result)));
  }, [result]);

  // Findings that require action get one focused review surface when a fresh,
  // complete inspection arrives. Reorders clear the result first, so a stale
  // review cannot remain open for a different source order.
  useEffect(() => {
    if (!opened || !inspectionQuery.dataUpdatedAt || (!result?.inspection_complete && !sourceInspectionFailed)) {
      setReviewOpen(false);
      return;
    }
    if (sourceInspectionFailed || continuationReviewRequired(result)) setReviewOpen(true);
  }, [inspectionQuery.dataUpdatedAt, opened, result, sourceInspectionFailed]);

  useEffect(() => {
    if (!opened) {
      setInspectionRequested(false);
      setPreviewMode("combined");
      setAcknowledged(new Set());
      setReviewOpen(false);
    }
  }, [opened]);

  const submissionState = useMemo(
    () => buildContinuedImportSubmissionState(
      order,
      cellDraft,
      cellDraft.cell_name,
      result,
      acknowledged,
      inspectionQuery.isError,
    ),
    [acknowledged, cellDraft, inspectionQuery.isError, order, result],
  );
  useEffect(() => {
    onSubmissionStateChange(submissionState);
  }, [submissionState, onSubmissionStateChange]);

  // Reordering/removal must reflect work actually in flight (submission), not
  // the query's resting "pending" status for an inspection that was never
  // requested or that a reorder just invalidated. canSubmit already re-gates
  // import through continuedImportCanSubmit(...) whenever the order changes
  // without a matching complete inspection, so this lock does not need to
  // track inspection fetch state for safety.
  const disabled = importing;
  const move = (index: number, direction: -1 | 1) => {
    if (disabled) return;
    setOrder((current) => moveSource(current, index, direction));
  };
  const reviewRequired = continuationReviewRequired(result, acknowledged);
  const hasFindings = continuationHasFindings(result);
  const selectedDraft = byKey.get(selectedSourceKey) ?? orderedDrafts[0];
  const selectedSource = orderedSources.find((source) => source.key === selectedSourceKey) ?? orderedSources[0];
  const combinedPreviewFailureSources = combinedPreviewQuery.isError
    ? continuationPreviewFailureSources(
      combinedPreviewQuery.error instanceof ApiError ? combinedPreviewQuery.error.detail : null,
    )
    : [];
  const updateDraft = (patch: Partial<ContinuedCellDraft>) =>
    onCellDraftChange({ ...cellDraft, ...patch });

  const selectSource = (key: string) => {
    setSelectedSourceKey(key);
    setPreviewMode("source");
  };
  const materialOptions = [
    { value: "custom", label: "Custom nominal capacity" },
    ...materialPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.specific_capacity_mah_g} mAh/g)`,
    })),
  ];
  const areaOptions = [
    { value: "custom", label: "Custom" },
    ...areaPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.name} (${preset.area_cm2} cm²)`,
    })),
  ];

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" align="center" wrap="wrap" style={{ flex: "none" }}>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconPlus size={16} />} loading={addingMore} disabled={importing} onClick={onAddMoreSources}>
            Add more sources
          </Button>
          <MultiSelect
            w={280}
            size="xs"
            placeholder="No folder"
            data={folderSelectData}
            value={destinationFolders}
            onChange={onDestinationFoldersChange}
            clearable
            searchable
          />
        </Group>
        <Group gap="xs" align="center">
          {inspectionQuery.isError && (
            <Text size="xs" c="red">
              {inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Continuation inspection failed."}
            </Text>
          )}
          <Button
            variant="default"
            leftSection={<IconSearch size={16} />}
            disabled={orderedDrafts.length < 2 || importing}
            loading={inspectionQuery.isFetching}
            onClick={() => {
              setInspectionRequested(true);
              if (sourceInspectionFailed || (result?.inspection_complete && hasFindings)) {
                setReviewOpen(true);
              } else {
                void inspectionQuery.refetch();
              }
            }}
          >
            {sourceInspectionFailed
              ? "Review source errors"
              : result?.inspection_complete && hasFindings
                ? "Review continuity"
                : result?.inspection_complete
                  ? "Inspected"
                  : "Inspect continuity"}
          </Button>
          {sourceInspectionFailed && (
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRefresh size={15} />}
              disabled={importing}
              onClick={() => {
                setReviewOpen(false);
                setInspectionRequested(true);
                void inspectionQuery.refetch();
              }}
            >
              Re-inspect
            </Button>
          )}
        </Group>
      </Group>

      {orderedDrafts.length < 2 && (
        <Alert color="orange" title="A continued Cell needs at least two sources" style={{ flex: "none" }}>
          Add another source to continue, or switch back to the separate-cell import workflow.
          <Button mt="xs" size="compact-sm" variant="default" onClick={onSwitchToSeparate}>
            Use separate cells
          </Button>
        </Alert>
      )}

      <Group align="stretch" gap="md" wrap="nowrap" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Paper withBorder p="xs" w={320} style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between" wrap="nowrap" style={{ flex: "none" }}>
              <Text size="sm" fw={700}>Source chain</Text>
              <Badge size="xs" variant="light">{orderedSources.length}</Badge>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
              <ContinuationSourceList
                variant="compact-import"
                sources={orderedSources}
                findings={result?.findings ?? []}
                colorsBySourceKey={colors}
                selectedSourceKey={selectedSourceKey}
                onSelect={selectSource}
                onMove={move}
                onDragStart={disabled ? undefined : setDragIndex}
                onDrop={disabled ? undefined : (index) => {
                  if (dragIndex === null) return;
                  setOrder((current) => {
                    const next = [...current];
                    const [item] = next.splice(dragIndex, 1);
                    next.splice(index, 0, item);
                    return next;
                  });
                  setDragIndex(null);
                }}
                onRemove={disabled ? undefined : (sourceKey) => {
                  onRemoveSource(sourceKey);
                  setAcknowledged(new Set());
                  setReviewOpen(false);
                }}
                disabled={disabled}
              />
            </ScrollArea>
          </Stack>
        </Paper>

        <Paper withBorder p="xs" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between" align="end" gap="xs" wrap="nowrap" style={{ flex: "none" }}>
              <Select
                size="xs"
                label="Preview source"
                value={previewMode === "combined" ? "combined" : selectedSourceKey || selectedDraft?.staged_name || null}
                data={[
                  { value: "combined", label: "All sources (combined)" },
                  ...orderedDrafts.map((source, index) => ({
                    value: source.staged_name,
                    label: `Source ${index + 1} — ${source.filename}`,
                  })),
                ]}
                onChange={(value) => {
                  if (value === "combined") setPreviewMode("combined");
                  else if (value) selectSource(value);
                }}
                searchable
                styles={{ root: { minWidth: 260 } }}
              />
              <Tooltip
                label={
                  !selectedDraft
                    ? "Select a source to view raw data"
                    : selectedSource && !continuationSourceCanOpenRawData(selectedSource)
                      ? "Raw data is unavailable for a metadata-only source"
                      : "Open raw cycling data"
                }
              >
                <Button
                  size="compact-sm"
                  variant="default"
                  disabled={!selectedDraft || !selectedSource || !continuationSourceCanOpenRawData(selectedSource)}
                  onClick={() => selectedDraft && onRawData?.(selectedDraft.staged_name)}
                >
                  Raw data
                </Button>
              </Tooltip>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
              <Stack gap="md" pr="xs">
                {previewMode === "combined" ? (
                  sourceInspectionFailed ? (
                    <Text size="sm" c="red">Continuity inspection failed. Review the source error before retrying.</Text>
                  ) : !inspectionRequested || !result?.inspection_complete || inspectionQuery.isError ? (
                    <Text size="sm" c="dimmed">Inspect continuity to prepare the combined preview.</Text>
                  ) : inspectionQuery.isFetching ? (
                    <Alert color="gray">Waiting for continuity inspection…</Alert>
                  ) : combinedPreviewQuery.isPending
                    || (combinedPreviewQuery.isFetching && !combinedPreviewQuery.data) ? (
                    <Alert color="gray">
                      <Group gap="xs" align="center">
                        <Loader size="sm" />
                        <Text size="sm">Preparing combined capacity preview…</Text>
                      </Group>
                    </Alert>
                  ) : combinedPreviewQuery.isError ? (
                    <Alert
                      color={combinedPreviewQuery.error instanceof ApiError && combinedPreviewQuery.error.status === 422 ? "gray" : "orange"}
                      title={combinedPreviewQuery.error instanceof ApiError && combinedPreviewQuery.error.status === 409 ? "Re-inspect continuity" : "Combined preview could not be generated"}
                    >
                      <Group justify="space-between" align="start" gap="xs" wrap="nowrap">
                        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm">
                            {combinedPreviewQuery.error instanceof Error
                              ? combinedPreviewQuery.error.message
                              : "The combined preview is unavailable."}
                          </Text>
                          {combinedPreviewFailureSources.length > 0 && (
                            <Stack gap={2} mt={2} style={{ maxHeight: 96, overflowY: "auto" }}>
                              {combinedPreviewFailureSources.map((source, index) => (
                                <Text key={`${source.filename}-${index}`} size="xs" c="dimmed">
                                  {source.filename}: {source.reason}
                                </Text>
                              ))}
                            </Stack>
                          )}
                        </Stack>
                        {!(combinedPreviewQuery.error instanceof ApiError && (combinedPreviewQuery.error.status === 409 || combinedPreviewQuery.error.status === 422)) && (
                          <Button
                            size="compact-sm"
                            variant="default"
                            onClick={() => void combinedPreviewQuery.refetch()}
                          >
                            Retry
                          </Button>
                        )}
                      </Group>
                    </Alert>
                  ) : combinedPreviewQuery.data && continuationPreviewHasPoints(combinedPreviewQuery.data) ? (
                    <Paper withBorder p="xs">
                      <Plot
                        data={buildContinuationPreviewTraces(combinedPreviewQuery.data, colors)}
                        layout={{
                          height: 220,
                          title: { text: "Capacity vs. cycle" },
                          margin: { l: 54, r: 16, t: 34, b: 48 },
                          xaxis: { title: { text: "Cycle number (global)" } },
                          yaxis: { title: { text: combinedPreviewQuery.data.label } },
                          showlegend: false,
                          paper_bgcolor: "rgba(0,0,0,0)",
                          plot_bgcolor: "rgba(0,0,0,0)",
                        }}
                        config={{ displayModeBar: false, responsive: true }}
                        style={{ width: "100%" }}
                      />
                    </Paper>
                  ) : (
                    <Alert color="gray">No capacity preview points were found for this chain.</Alert>
                  )
                ) : selectedDraft ? (
                  selectedDraft.metadata_only ? (
                    <Alert color="gray" title="Capacity preview unavailable">
                      Canonical cycling preview and cache preparation are unavailable for this
                      source until its full-cycle identity is independently resolved. Retry will
                      not change that limitation.
                    </Alert>
                  ) : selectedDraft.preview_state.status === "loading" ? (
                    <Alert color="gray">Generating capacity preview…</Alert>
                  ) : selectedDraft.preview_state.status === "error" ? (
                    <Alert color="orange" title="Preview could not be generated">
                      <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
                        <Text size="sm">{selectedDraft.preview_state.message}</Text>
                        <Button
                          size="compact-sm"
                          variant="default"
                          onClick={() => onPreviewRequested?.(selectedDraft, true)}
                        >
                          Retry
                        </Button>
                      </Group>
                    </Alert>
                  ) : selectedDraft.preview_state.status === "ready"
                    && selectedDraft.capacity_preview
                    && selectedDraft.capacity_preview.x.length > 0 ? (
                    <Paper withBorder p="xs">
                      <Plot
                        data={[{
                          x: selectedDraft.capacity_preview.x,
                          y: selectedDraft.capacity_preview.y,
                          type: "scatter",
                          mode: "markers",
                          marker: { size: 5, color: colors[selectedDraft.staged_name] ?? "#12b886" },
                          name: selectedDraft.capacity_preview.label,
                        }]}
                        layout={{
                          height: 220,
                          margin: { l: 54, r: 16, t: 12, b: 42 },
                          xaxis: { title: { text: "Cycle" } },
                          yaxis: { title: { text: selectedDraft.capacity_preview.label } },
                          showlegend: false,
                          paper_bgcolor: "rgba(0,0,0,0)",
                          plot_bgcolor: "rgba(0,0,0,0)",
                        }}
                        config={{ displayModeBar: false, responsive: true }}
                        style={{ width: "100%" }}
                      />
                    </Paper>
                  ) : (
                    <Alert color="gray">
                      {selectedDraft.preview_state.status === "idle"
                        ? "Preview is available when this source is selected."
                        : "No capacity preview points were found in this file."}
                    </Alert>
                  )
                ) : (
                  <Text size="sm" c="dimmed">Select a source to preview it.</Text>
                )}

                <Divider label="Selected source" labelPosition="left" />
                <Stack gap={4}>
                  <SummaryRow label="Filename" value={selectedDraft?.filename} />
                  <SummaryRow label="Full path" value={selectedDraft?.source_path} />
                  <SummaryRow label="Size" value={selectedDraft ? formatBytes(selectedDraft.size) : null} />
                  <SummaryRow label="Format" value={selectedDraft?.source_format} />
                  <SummaryRow label="Technique" value={selectedDraft?.technique} />
                  <SummaryRow
                    label="Local cycles"
                    value={
                      selectedSource?.local_cycle_count
                        ? `${selectedSource.local_cycle_start ?? "—"}–${selectedSource.local_cycle_end ?? "—"} (${selectedSource.local_cycle_count})`
                        : null
                    }
                  />
                  <SummaryRow label="Start time" value={selectedSource?.start_time ?? selectedDraft?.start_time} />
                  <SummaryRow label="End time" value={selectedSource?.end_time} />
                  <SummaryRow label="Protocol" value={selectedSource?.protocol_signature} />
                </Stack>
              </Stack>
            </ScrollArea>
          </Stack>
        </Paper>

        <Paper withBorder p="xs" w={380} style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
            <Stack gap="sm" pr="xs">
              <Text size="sm" fw={700}>Cell draft</Text>
              <TextInput label="Cell name" value={cellDraft.cell_name} onChange={(event) => updateDraft({ cell_name: event.currentTarget.value })} />
              <Textarea label="Cell notes" autosize minRows={3} value={cellDraft.description} onChange={(event) => updateDraft({ description: event.currentTarget.value })} />
              <Divider label="Scientific overrides and presets" labelPosition="left" />
              <NumberInput label="Active material mass (mg)" min={0.000001} decimalScale={6} value={cellDraft.active_mass_mg_override ?? ""} placeholder={cellDraft.source_metadata?.active_mass_mg?.toString() ?? "Source value"} onChange={(value) => updateDraft({ active_mass_mg_override: value === "" ? null : Number(value) })} />
              <Select label="Active material preset" data={materialOptions} value={cellDraft.active_material_selection} searchable onChange={(value) => { const preset = materialPresets.find((item) => item.id === value); updateDraft({ active_material_selection: value ?? "custom", active_material_preset_id: preset?.id ?? null, active_material_name: preset?.name ?? null, active_material_specific_capacity_mah_g: preset?.specific_capacity_mah_g ?? null, nominal_capacity_mah_override: preset ? (cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg) ? ((cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg)! * preset.specific_capacity_mah_g) / 1000 : null : cellDraft.nominal_capacity_mah_override }); }} />
              <NumberInput label="Nominal capacity (mAh)" min={0.000001} decimalScale={6} value={cellDraft.nominal_capacity_mah_override ?? ""} placeholder={cellDraft.source_metadata?.nominal_capacity_mah?.toString() ?? "Source value"} disabled={cellDraft.active_material_selection !== "custom"} onChange={(value) => updateDraft({ nominal_capacity_mah_override: value === "" ? null : Number(value) })} />
              <Group grow align="end">
                <Select label="Electrode-area preset" data={areaOptions} value={cellDraft.electrode_area_selection} searchable onChange={(value) => { const preset = areaPresets.find((item) => item.id === value); updateDraft({ electrode_area_selection: value ?? "custom", electrode_area_preset_id: preset?.id ?? null, electrode_area_preset_name: preset?.name ?? null, electrode_area_cm2_override: preset?.area_cm2 ?? cellDraft.electrode_area_cm2_override }); }} />
                <NumberInput label="Electrode area (cm²)" min={0.000001} decimalScale={6} value={cellDraft.electrode_area_cm2_override ?? ""} disabled={cellDraft.electrode_area_selection !== "custom"} onChange={(value) => updateDraft({ electrode_area_cm2_override: value === "" ? null : Number(value) })} />
              </Group>
              <Alert color="gray"><Text size="xs">Cell metadata belongs to this Cell draft and stays unchanged when sources are reordered or previewed.</Text></Alert>
            </Stack>
          </ScrollArea>
        </Paper>
      </Group>

      {sourceInspectionFailed && !reviewOpen ? (
        <Text size="xs" c="red" style={{ flex: "none" }}>
          Review source errors before importing.
        </Text>
      ) : reviewRequired && !reviewOpen && (
        <Text size="xs" c="orange" style={{ flex: "none" }}>
          Continuity review required before import.
        </Text>
      )}

      <ContinuationReviewModal
        opened={reviewOpen}
        onClose={() => setReviewOpen(false)}
        result={result}
        acknowledged={acknowledged}
        onAcknowledgementChange={(findingId, checked) => setAcknowledged((current) => {
          const next = new Set(current);
          if (checked) next.add(findingId);
          else next.delete(findingId);
          return next;
        })}
        disabled={disabled}
      />
    </Stack>
  );
}
