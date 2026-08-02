import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconDeviceFloppy,
  IconInfoCircle,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import {
  ActiveMaterialPresetSettings,
  ContinuationInspectResult,
  ElectrodeAreaPresetSettings,
  ImportPreview,
  inspectContinuationSources,
} from "../api";
import {
  acknowledgementFindingIds,
  applySuggestedOrder,
  blockingFindings,
  continuedImportCanSubmit,
  findingSummary,
  informationalFindings,
  moveSource,
  preserveAcknowledgements,
  scientificDraftIsValid,
} from "../continuationPolicy";
import {
  shouldRequestImportPreview,
  type ImportPreviewDraftState,
} from "../importPreviewPolicy";
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
  };
}

function fallbackSource(draft: DraftSource) {
  return {
    key: draft.staged_name,
    kind: "staged" as const,
    source_file_id: null,
    filename: draft.filename,
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
  };
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
  onImport,
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
  onImport: (order: string[], acknowledgedFindingIds: string[]) => void;
  onRawData?: (stagedName: string) => void;
  onPreviewRequested?: (draft: DraftSource, retry?: boolean) => void;
  importing: boolean;
}) {
  const [order, setOrder] = useState<string[]>(() => drafts.map((item) => item.staged_name));
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [submittedOrder, setSubmittedOrder] = useState<string[] | null>(null);
  const [previewKey, setPreviewKey] = useState<string>(drafts[0]?.staged_name ?? "");
  const [inspectionRequested, setInspectionRequested] = useState(false);
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
  const orderedSources = useMemo(
    () => result?.sources.length
      ? order
        .map((key) => result.sources.find((source) => source.key === key))
        .filter((source): source is NonNullable<typeof source> => Boolean(source))
      : orderedDrafts.map(fallbackSource),
    [order, orderedDrafts, result],
  );

  useEffect(() => {
    const available = new Set(drafts.map((item) => item.staged_name));
    setOrder((current) => [
      ...current.filter((key) => available.has(key)),
      ...drafts.map((item) => item.staged_name).filter((key) => !current.includes(key)),
    ]);
  }, [drafts]);

  useEffect(() => {
    if (!byKey.has(previewKey)) setPreviewKey(order[0] ?? "");
  }, [byKey, order, previewKey]);

  useEffect(() => {
    if (result) setAcknowledged((current) => new Set(preserveAcknowledgements(current, result)));
  }, [result]);

  useEffect(() => {
    if (!importing) setSubmittedOrder(null);
  }, [importing]);

  useEffect(() => {
    if (!opened) {
      setInspectionRequested(false);
      setSubmittedOrder(null);
      setAcknowledged(new Set());
    }
  }, [opened]);

  const disabled = inspectionQuery.isPending || importing || submittedOrder !== null;
  const move = (index: number, direction: -1 | 1) => {
    if (disabled) return;
    setOrder((current) => moveSource(current, index, direction));
  };
  const useSuggestedOrder = () => {
    if (!disabled && result) setOrder((current) => applySuggestedOrder(current, result.suggested_order));
  };
  const confirmationFindings = result ? acknowledgementFindingIds(result) : [];
  const previewDraft = byKey.get(previewKey) ?? orderedDrafts[0];
  const canImport =
    orderedDrafts.length >= 2 &&
    scientificDraftIsValid(cellDraft) &&
    continuedImportCanSubmit(result, cellDraft.cell_name, acknowledged);
  const updateDraft = (patch: Partial<ContinuedCellDraft>) =>
    onCellDraftChange({ ...cellDraft, ...patch });

  const selectPreview = (value: string | null) => {
    const nextKey = value ?? orderedDrafts[0]?.staged_name ?? "";
    setPreviewKey(nextKey);
    const nextDraft = byKey.get(nextKey);
    if (shouldRequestImportPreview(nextDraft, true)) {
      onPreviewRequested?.(nextDraft);
    }
  };
  const submit = () => {
    const frozen = [...order];
    setSubmittedOrder(frozen);
    onImport(frozen, Array.from(acknowledged));
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
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Text size="sm" fw={700}>One continued cell</Text>
          <Text size="xs" c="dimmed">
            The original files remain separate. This creates one virtual Cell with one ordered source chain.
          </Text>
        </Stack>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconPlus size={16} />} loading={addingMore} onClick={onAddMoreSources}>
            Add more sources
          </Button>
          <MultiSelect
            w={320}
            size="xs"
            placeholder="No folder"
            data={folderSelectData}
            value={destinationFolders}
            onChange={onDestinationFoldersChange}
            clearable
            searchable
          />
          <Button
            variant="default"
            leftSection={<IconSearch size={16} />}
            disabled={orderedDrafts.length < 2 || importing || submittedOrder !== null}
            loading={inspectionQuery.isFetching}
            onClick={() => {
              setInspectionRequested(true);
              void inspectionQuery.refetch();
            }}
          >
            Inspect continuity
          </Button>
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!canImport || disabled}
            loading={importing}
            onClick={submit}
          >
            Import one continued cell
          </Button>
        </Group>
      </Group>

      {orderedDrafts.length < 2 && (
        <Alert color="orange" title="A continued Cell needs at least two sources">
          Add another source to continue, or switch back to the separate-cell import workflow.
          <Button mt="xs" size="compact-sm" variant="default" onClick={onSwitchToSeparate}>
            Use separate cells
          </Button>
        </Alert>
      )}
      {!inspectionRequested && orderedDrafts.length >= 2 && (
        <Alert color="blue">
          Continuity inspection is deferred until you explicitly request it.
        </Alert>
      )}
      {inspectionQuery.isError && (
        <Alert color="red" title="Inspection failed">
          {inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Continuation inspection failed."}
        </Alert>
      )}
      {inspectionRequested && inspectionQuery.isPending && (
        <Alert color="blue">Preparing source timing, local cycles, and protocol compatibility…</Alert>
      )}
      {result && !result.inspection_complete && !inspectionQuery.isPending && (
        <Alert color="blue" title="Preparing source data">
          Inspection is still preparing one or more source caches. This form will update automatically.
        </Alert>
      )}
      {result && blockingFindings(result).length > 0 && (
        <Alert color="red" title="Resolve blocking findings">
          <Stack gap={2}>{blockingFindings(result).map((finding) => (
            <Group key={finding.id} gap="xs" wrap="nowrap" align="start">
              <IconAlertTriangle size={16} aria-hidden="true" />
              <Text size="sm">{findingSummary(finding)}</Text>
            </Group>
          ))}</Stack>
        </Alert>
      )}
      {result && informationalFindings(result).length > 0 && (
        <Alert color="orange" title="Review continuation findings">
          <Stack gap="xs">{informationalFindings(result).map((finding) => (
            <Group key={finding.id} gap="xs" wrap="nowrap" align="start">
              <IconInfoCircle size={16} aria-hidden="true" />
              <Text size="sm">{findingSummary(finding)}</Text>
            </Group>
          ))}</Stack>
        </Alert>
      )}

      {previewDraft && (
        <>
          <Group justify="space-between" align="end" gap="xs">
            <Text size="xs" fw={700}>Quick preview</Text>
            <Select
              size="xs"
              label="Source"
              value={previewKey || previewDraft.staged_name}
              data={orderedDrafts.map((source) => ({ value: source.staged_name, label: source.filename }))}
              onChange={selectPreview}
              searchable
              styles={{ root: { minWidth: 260 } }}
            />
          </Group>
          <Text size="xs" c="dimmed" mt={4} title={previewDraft.filename}>
            Previewing {previewDraft.filename}
          </Text>
          {previewDraft.preview_state.status === "loading" ? (
            <Alert color="gray">Generating capacity preview…</Alert>
          ) : previewDraft.preview_state.status === "error" ? (
            <Alert color="orange" title="Preview could not be generated">
              <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
                <Text size="sm">{previewDraft.preview_state.message}</Text>
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() => onPreviewRequested?.(previewDraft, true)}
                >
                  Retry
                </Button>
              </Group>
            </Alert>
          ) : previewDraft.preview_state.status === "ready"
            && previewDraft.capacity_preview
            && previewDraft.capacity_preview.x.length > 0 ? (
            <Paper withBorder p="xs">
              <Plot data={[{ x: previewDraft.capacity_preview.x, y: previewDraft.capacity_preview.y, type: "scatter", mode: "markers", marker: { size: 5, color: "#12b886" }, name: previewDraft.capacity_preview.label }]} layout={{ height: 220, margin: { l: 54, r: 16, t: 12, b: 42 }, xaxis: { title: { text: "Cycle" } }, yaxis: { title: { text: previewDraft.capacity_preview.label } }, showlegend: false, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)" }} config={{ displayModeBar: false, responsive: true }} style={{ width: "100%" }} />
            </Paper>
          ) : (
            <Alert color="gray">
              {previewDraft.preview_state.status === "idle"
                ? "Preview is available when this source is active."
                : "No capacity preview points were found in this file."}
            </Alert>
          )}
        </>
      )}

      <Group align="start" grow>
        <Stack gap="xs" style={{ flex: 1.1 }}>
          <Group justify="space-between">
            <Text fw={700}>Ordered source chain</Text>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconArrowUp size={13} />}
              disabled={disabled || !result?.suggested_order.length}
              onClick={useSuggestedOrder}
            >
              Use suggested order
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Move sources with the arrow controls or drag them. The final visible source is the tracked tail.
          </Text>
          <ContinuationSourceList
            sources={orderedSources}
            findings={result?.findings ?? []}
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
            }}
            onOpenRawData={onRawData}
            disabled={disabled}
          />
          {result && confirmationFindings.length > 0 && (
            <Stack gap={4}>
              <Divider label="Acknowledgements" labelPosition="left" />
              {result.findings.filter((finding) => finding.severity === "confirmation").map((finding) => (
                <Checkbox
                  key={finding.id}
                  size="xs"
                  disabled={disabled}
                  checked={acknowledged.has(finding.id)}
                  onChange={(event) => setAcknowledged((current) => {
                    const next = new Set(current);
                    if (event.currentTarget.checked) next.add(finding.id);
                    else next.delete(finding.id);
                    return next;
                  })}
                  label={findingSummary(finding)}
                />
              ))}
            </Stack>
          )}
        </Stack>
        <Stack gap="sm" style={{ flex: 0.9 }}>
          <TextInput label="Cell name" value={cellDraft.cell_name} onChange={(event) => updateDraft({ cell_name: event.currentTarget.value })} />
          <Textarea label="Cell notes" autosize minRows={3} value={cellDraft.description} onChange={(event) => updateDraft({ description: event.currentTarget.value })} />
          <Divider label="Scientific overrides and presets" labelPosition="left" />
          <NumberInput label="Active material mass (mg)" min={0.000001} decimalScale={6} value={cellDraft.active_mass_mg_override ?? ""} placeholder={cellDraft.source_metadata?.active_mass_mg?.toString() ?? "Source value"} onChange={(value) => updateDraft({ active_mass_mg_override: value === "" ? null : Number(value) })} />
          <Select label="Active material preset" data={materialOptions} value={cellDraft.active_material_selection} searchable onChange={(value) => { const preset = materialPresets.find((item) => item.id === value); updateDraft({ active_material_selection: value ?? "custom", active_material_preset_id: preset?.id ?? null, active_material_name: preset?.name ?? null, active_material_specific_capacity_mah_g: preset?.specific_capacity_mah_g ?? null, nominal_capacity_mah_override: preset ? (cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg) ? ((cellDraft.active_mass_mg_override ?? cellDraft.source_metadata?.active_mass_mg)! * preset.specific_capacity_mah_g) / 1000 : null : cellDraft.nominal_capacity_mah_override }); }} />
          <NumberInput label="Nominal capacity (mAh)" min={0.000001} decimalScale={6} value={cellDraft.nominal_capacity_mah_override ?? ""} placeholder={cellDraft.source_metadata?.nominal_capacity_mah?.toString() ?? "Source value"} disabled={cellDraft.active_material_selection !== "custom"} onChange={(value) => updateDraft({ nominal_capacity_mah_override: value === "" ? null : Number(value) })} />
          <Group grow align="end"><Select label="Electrode-area preset" data={areaOptions} value={cellDraft.electrode_area_selection} searchable onChange={(value) => { const preset = areaPresets.find((item) => item.id === value); updateDraft({ electrode_area_selection: value ?? "custom", electrode_area_preset_id: preset?.id ?? null, electrode_area_preset_name: preset?.name ?? null, electrode_area_cm2_override: preset?.area_cm2 ?? cellDraft.electrode_area_cm2_override }); }} /><NumberInput label="Electrode area (cm²)" min={0.000001} decimalScale={6} value={cellDraft.electrode_area_cm2_override ?? ""} disabled={cellDraft.electrode_area_selection !== "custom"} onChange={(value) => updateDraft({ electrode_area_cm2_override: value === "" ? null : Number(value) })} /></Group>
          <Alert color="gray"><Text size="xs">Cell metadata belongs to this Cell draft and stays unchanged when sources are reordered or previewed.</Text></Alert>
        </Stack>
      </Group>
    </Stack>
  );
}
