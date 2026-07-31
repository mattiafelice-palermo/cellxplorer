import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp, IconDeviceFloppy, IconPlus } from "@tabler/icons-react";
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
} from "../continuationPolicy";
import { ContinuationSourceList } from "./ContinuationSourceList";

type DraftLike = ImportPreview & {
  cell_name: string;
  description: string;
  test_name: string;
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
};

function draftSource(draft: DraftLike) {
  return {
    staged_name: draft.staged_name,
    source_path: draft.source_path,
  };
}

function fallbackSource(draft: DraftLike) {
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
  draft,
  onChange,
  onAddMoreSources,
  addingMore,
  destinationFolders,
  onDestinationFoldersChange,
  folderSelectData,
  materialPresets,
  areaPresets,
  onImport,
  importing,
}: {
  opened: boolean;
  drafts: DraftLike[];
  draft: DraftLike;
  onChange: (draft: DraftLike) => void;
  onAddMoreSources: () => void;
  addingMore: boolean;
  destinationFolders: string[];
  onDestinationFoldersChange: (folders: string[]) => void;
  folderSelectData: { value: string; label: string }[];
  materialPresets: ActiveMaterialPresetSettings["presets"];
  areaPresets: ElectrodeAreaPresetSettings["presets"];
  onImport: (order: string[], acknowledgedFindingIds: string[]) => void;
  importing: boolean;
}) {
  const [order, setOrder] = useState<string[]>(() => drafts.map((item) => item.staged_name));
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const byKey = useMemo(() => new Map(drafts.map((item) => [item.staged_name, item])), [drafts]);
  const orderedDrafts = useMemo(
    () => order.map((key) => byKey.get(key)).filter((item): item is DraftLike => Boolean(item)),
    [byKey, order],
  );
  const inspectionQuery = useQuery<ContinuationInspectResult>({
    queryKey: ["continued-import-inspection", order, drafts.map((item) => `${item.staged_name}:${item.hash}`).join("|")],
    queryFn: () => inspectContinuationSources({
      sources: orderedDrafts.map(draftSource),
      proposed_order: order,
    }),
    enabled: opened && orderedDrafts.length >= 2,
  });
  const result = inspectionQuery.data;
  const orderedSources = useMemo(
    () => result?.sources.length ? order.map((key) => result.sources.find((source) => source.key === key)).filter((source): source is NonNullable<typeof source> => Boolean(source)) : orderedDrafts.map(fallbackSource),
    [order, orderedDrafts, result],
  );

  useEffect(() => {
    const available = new Set(drafts.map((item) => item.staged_name));
    setOrder((current) => [...current.filter((key) => available.has(key)), ...drafts.map((item) => item.staged_name).filter((key) => !current.includes(key))]);
  }, [drafts]);

  useEffect(() => {
    if (result) setAcknowledged((current) => new Set(preserveAcknowledgements(current, result)));
  }, [result]);

  const move = (index: number, direction: -1 | 1) => setOrder((current) => moveSource(current, index, direction));
  const useSuggestedOrder = () => {
    if (result) setOrder((current) => applySuggestedOrder(current, result.suggested_order));
  };
  const confirmationFindings = result ? acknowledgementFindingIds(result) : [];
  const canImport = continuedImportCanSubmit(result, draft.cell_name, acknowledged);
  const updateDraft = (patch: Partial<DraftLike>) => onChange({ ...draft, ...patch });
  const materialOptions = [
    { value: "custom", label: "Custom nominal capacity" },
    ...materialPresets.map((preset) => ({ value: preset.id, label: `${preset.name} (${preset.specific_capacity_mah_g} mAh/g)` })),
  ];
  const areaOptions = [
    { value: "custom", label: "Custom" },
    ...areaPresets.map((preset) => ({ value: preset.id, label: `${preset.name} (${preset.area_cm2} cm²)` })),
  ];

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Text size="sm" fw={700}>One continued cell</Text>
          <Text size="xs" c="dimmed">The original files remain separate. This creates one virtual continued Cell with an ordered source chain.</Text>
        </Stack>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconPlus size={16} />} loading={addingMore} onClick={onAddMoreSources}>Add more sources</Button>
          <MultiSelect w={320} size="xs" placeholder="No folder" data={folderSelectData} value={destinationFolders} onChange={onDestinationFoldersChange} clearable searchable />
          <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!canImport} loading={importing} onClick={() => onImport(order, Array.from(acknowledged))}>Import one continued cell</Button>
        </Group>
      </Group>

      {inspectionQuery.isError && <Alert color="red">{inspectionQuery.error instanceof Error ? inspectionQuery.error.message : "Continuation inspection failed."}</Alert>}
      {inspectionQuery.isPending && <Alert color="blue">Inspecting source order, local cycles, timing, and protocol compatibility…</Alert>}
      {result && blockingFindings(result).length > 0 && <Alert color="red" title="Resolve blocking findings"><Stack gap={2}>{blockingFindings(result).map((finding) => <Text key={finding.id} size="sm">{findingSummary(finding)}</Text>)}</Stack></Alert>}
      {result && informationalFindings(result).length > 0 && <Alert color="orange" title="Review continuation findings"><Stack gap="xs">{informationalFindings(result).map((finding) => <Text key={finding.id} size="sm">{findingSummary(finding)}</Text>)}</Stack></Alert>}

      <Group align="start" grow>
        <Stack gap="xs" style={{ flex: 1.1 }}>
          <Group justify="space-between"><Text fw={700}>Ordered source chain</Text><Group gap={4}><Button size="compact-xs" variant="default" leftSection={<IconArrowUp size={13} />} disabled={!result?.suggested_order.length} onClick={useSuggestedOrder}>Use suggested order</Button></Group></Group>
          <Text size="xs" c="dimmed">Move sources with the arrow controls or drag them. The final visible source is the tracked tail.</Text>
          <ContinuationSourceList sources={orderedSources} findings={result?.findings ?? []} onMove={move} onDragStart={setDragIndex} onDrop={(index) => { if (dragIndex === null) return; setOrder((current) => { const next = [...current]; const [item] = next.splice(dragIndex, 1); next.splice(index, 0, item); return next; }); setDragIndex(null); }} disabled={inspectionQuery.isPending || importing} />
          {result && confirmationFindings.length > 0 && <Stack gap={4}><Divider label="Acknowledgements" labelPosition="left" />{result.findings.filter((finding) => finding.severity === "confirmation").map((finding) => <Checkbox key={finding.id} size="xs" checked={acknowledged.has(finding.id)} onChange={(event) => setAcknowledged((current) => { const next = new Set(current); if (event.currentTarget.checked) next.add(finding.id); else next.delete(finding.id); return next; })} label={findingSummary(finding)} />)}</Stack>}
        </Stack>
        <Stack gap="sm" style={{ flex: 0.9 }}>
          <TextInput label="Cell name" value={draft.cell_name} onChange={(event) => updateDraft({ cell_name: event.currentTarget.value })} />
          <Textarea label="Cell notes" autosize minRows={3} value={draft.description} onChange={(event) => updateDraft({ description: event.currentTarget.value })} />
          <TextInput label="Test name" value={draft.test_name} onChange={(event) => updateDraft({ test_name: event.currentTarget.value })} />
          <Divider label="Scientific overrides and presets" labelPosition="left" />
          <NumberInput label="Active material mass (mg)" min={0.000001} decimalScale={6} value={draft.active_mass_mg_override ?? ""} placeholder={draft.active_mass_mg?.toString() ?? "Source value"} onChange={(value) => updateDraft({ active_mass_mg_override: value === "" ? null : Number(value) })} />
          <Select label="Active material preset" data={materialOptions} value={draft.active_material_selection} searchable onChange={(value) => { const preset = materialPresets.find((item) => item.id === value); updateDraft({ active_material_selection: value ?? "custom", active_material_preset_id: preset?.id ?? null, active_material_name: preset?.name ?? null, active_material_specific_capacity_mah_g: preset?.specific_capacity_mah_g ?? null, nominal_capacity_mah_override: preset ? (draft.active_mass_mg_override ?? draft.active_mass_mg) ? ((draft.active_mass_mg_override ?? draft.active_mass_mg)! * preset.specific_capacity_mah_g) / 1000 : null : draft.nominal_capacity_mah_override }); }} />
          <NumberInput label="Nominal capacity (mAh)" min={0.000001} decimalScale={6} value={draft.nominal_capacity_mah_override ?? ""} placeholder={draft.nominal_capacity_mah?.toString() ?? "Source value"} disabled={draft.active_material_selection !== "custom"} onChange={(value) => updateDraft({ nominal_capacity_mah_override: value === "" ? null : Number(value) })} />
          <Group grow align="end"><Select label="Electrode-area preset" data={areaOptions} value={draft.electrode_area_selection} searchable onChange={(value) => { const preset = areaPresets.find((item) => item.id === value); updateDraft({ electrode_area_selection: value ?? "custom", electrode_area_preset_id: preset?.id ?? null, electrode_area_preset_name: preset?.name ?? null, electrode_area_cm2_override: preset?.area_cm2 ?? draft.electrode_area_cm2_override }); }} /><NumberInput label="Electrode area (cm²)" min={0.000001} decimalScale={6} value={draft.electrode_area_cm2_override ?? ""} disabled={draft.electrode_area_selection !== "custom"} onChange={(value) => updateDraft({ electrode_area_cm2_override: value === "" ? null : Number(value) })} /></Group>
          <Alert color="gray"><Text size="xs">Cell metadata defaults to the first source in the current order. Reordering changes source order only; it does not silently rewrite these editable fields.</Text></Alert>
        </Stack>
      </Group>
    </Stack>
  );
}
