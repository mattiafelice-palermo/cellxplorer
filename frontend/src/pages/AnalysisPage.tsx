// Analysis editor. Saved plots snapshot their exact samples and view state,
// while the current workspace stays fluid for quick plotting.
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconActivity,
  IconBolt,
  IconChartLine,
  IconClock,
  IconCopy,
  IconDeviceFloppy,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconGauge,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTable,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSpec,
  AnalysisTabKey,
  Badge as ApiBadge,
  CellMetrics,
  CellSummary,
  ComputeResult,
  del,
  FolderNode,
  get,
  post,
  put,
  ReplicateGroupSummary,
  SavedAnalysisPlot,
  SelectionEntry,
  Tree,
} from "../api";
import Plot from "../components/Plot";

const PALETTE = [
  "#12b886",
  "#2E86AB",
  "#E63946",
  "#43AA8B",
  "#F4A261",
  "#7B2D8E",
  "#588157",
  "#BC4749",
  "#3A0CA3",
  "#FB8500",
];

const CAPACITY_KEYS = new Set(["discharge_capacity", "charge_capacity"]);

const TAB_DEFS: {
  value: AnalysisTabKey;
  label: string;
  icon: typeof IconChartLine;
  plotTab: boolean;
}[] = [
  { value: "time_capacity", label: "Time / capacity", icon: IconClock, plotTab: true },
  { value: "cycles", label: "Cycles", icon: IconChartLine, plotTab: true },
  { value: "polarization", label: "Polarization", icon: IconActivity, plotTab: true },
  { value: "crate", label: "C-rate", icon: IconGauge, plotTab: true },
  { value: "chargeability", label: "Chargeability", icon: IconBolt, plotTab: true },
  { value: "dcir", label: "DCIR", icon: IconActivity, plotTab: true },
  { value: "recap", label: "Recap", icon: IconTable, plotTab: true },
  { value: "settings", label: "Settings", icon: IconSettings, plotTab: false },
];

const DEFAULT_COMPUTATION: AnalysisSpec["computation"] = {
  cycle_range: { start: 1, end: null },
  exclude_check_cycles_every_n: 0,
  retention_reference: { mode: "max_first_n", n: 5, cycle: null },
  formation_cycles: 3,
};

const DEFAULT_AGGREGATION: AnalysisSpec["aggregation"] = {
  mode: "replicate_mean",
  dispersion: "std",
  min_n_for_band: 2,
};

const DEFAULT_PRESENTATION: AnalysisSpec["presentation"] = {
  quantity: "discharge_capacity",
  ce_overlay: true,
  show_individual_cells: true,
  legend: true,
};

const METRIC_COLUMNS: { key: keyof CellMetrics; label: string; digits: number }[] = [
  { key: "n_cycles", label: "Cycles", digits: 0 },
  { key: "max_discharge_capacity_mah", label: "Max Qd", digits: 2 },
  { key: "mean_discharge_capacity_mah", label: "Mean Qd", digits: 2 },
  { key: "first_cycle_ce_pct", label: "1st CE", digits: 2 },
  { key: "mean_ce_pct", label: "CE", digits: 3 },
  { key: "mean_ee_pct", label: "EE", digits: 2 },
  { key: "mean_ve_pct", label: "VE", digits: 2 },
  { key: "retention_last_pct", label: "SoH last", digits: 1 },
  { key: "discharge_loss_mah_per_cycle", label: "Fade Qd/cyc", digits: 4 },
  { key: "discharge_loss_pct_per_cycle", label: "Fade %/cyc", digits: 4 },
  { key: "cycles_to_80_pct", label: "Cyc to 80%", digits: 0 },
  { key: "total_duration_h", label: "Total h", digits: 1 },
  { key: "mean_cycle_duration_h", label: "Cycle h", digits: 2 },
  { key: "mean_charge_time_h", label: "Chg h", digits: 2 },
  { key: "mean_discharge_time_h", label: "Dchg h", digits: 2 },
];

const FALLBACK_QUANTITY_LABELS: Record<string, string> = {
  discharge_capacity: "Discharge capacity (mAh)",
  charge_capacity: "Charge capacity (mAh)",
  coulombic_efficiency: "Coulombic efficiency (%)",
  discharge_energy: "Discharge energy (mWh)",
  charge_energy: "Charge energy (mWh)",
  energy_efficiency: "Energy efficiency (%)",
  mean_charge_voltage: "Mean charge voltage (V)",
  mean_discharge_voltage: "Mean discharge voltage (V)",
  cycle_duration: "Cycle duration (h)",
  charge_time: "Charge time (h)",
  discharge_time: "Discharge time (h)",
  voltaic_efficiency: "Voltaic efficiency (%)",
  capacity_retention: "Capacity retention / SoH (%)",
  discharge_capacity_loss: "Discharge capacity loss (mAh/cycle)",
  charge_capacity_loss: "Charge capacity loss (mAh/cycle)",
};

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return v.toFixed(digits);
}

function tabLabel(tab: AnalysisTabKey): string {
  return TAB_DEFS.find((t) => t.value === tab)?.label ?? tab;
}

function quantityLabel(result: ComputeResult | undefined, spec: AnalysisSpec): string {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  return (
    result?.quantities.find((q) => q.key === quantity)?.label ??
    FALLBACK_QUANTITY_LABELS[quantity] ??
    quantity.replace(/_/g, " ")
  );
}

function plotSubtitle(tab: AnalysisTabKey, result: ComputeResult | undefined, spec: AnalysisSpec): string {
  if (tab === "cycles") return `${quantityLabel(result, spec)} vs cycle`;
  if (tab === "recap") return "Recap table";
  if (tab === "settings") return "Analysis settings";
  return `${tabLabel(tab)} view`;
}

function normalizeSavedPlot(plot: SavedAnalysisPlot, base: AnalysisSpec): SavedAnalysisPlot {
  return {
    ...plot,
    subtitle: plot.subtitle || plotSubtitle(plot.tab, undefined, {
      ...base,
      selection: clone(plot.selection),
      computation: clone(plot.computation),
      aggregation: clone(plot.aggregation),
      presentation: clone(plot.presentation),
    }),
  };
}

function normalizeSpec(input: AnalysisSpec): AnalysisSpec {
  const spec = clone(input);
  spec.selection = {
    entries: spec.selection?.entries ?? [],
    exclusions: spec.selection?.exclusions ?? [],
  };
  spec.computation = {
    ...DEFAULT_COMPUTATION,
    ...(spec.computation ?? {}),
    cycle_range: {
      ...DEFAULT_COMPUTATION.cycle_range,
      ...(spec.computation?.cycle_range ?? {}),
    },
    retention_reference: {
      ...DEFAULT_COMPUTATION.retention_reference,
      ...(spec.computation?.retention_reference ?? {}),
    },
  };
  spec.aggregation = { ...DEFAULT_AGGREGATION, ...(spec.aggregation ?? {}) };
  spec.presentation = { ...DEFAULT_PRESENTATION, ...(spec.presentation ?? {}) };
  spec.saved_plots = (spec.saved_plots ?? []).map((plot) => normalizeSavedPlot(plot, spec));
  return spec;
}

function specForSavedPlot(base: AnalysisSpec, plot: SavedAnalysisPlot): AnalysisSpec {
  const next = normalizeSpec(base);
  next.selection = clone(plot.selection);
  next.computation = clone(plot.computation);
  next.aggregation = clone(plot.aggregation);
  next.presentation = clone(plot.presentation);
  return next;
}

function snapshotSignature(spec: AnalysisSpec): string {
  return JSON.stringify({
    selection: spec.selection,
    computation: spec.computation,
    aggregation: spec.aggregation,
    presentation: spec.presentation,
  });
}

function savedPlotFromSpec(
  spec: AnalysisSpec,
  tab: AnalysisTabKey,
  name: string,
  subtitle: string,
  description: string | null,
  existing?: SavedAnalysisPlot
): SavedAnalysisPlot {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? uid(),
    tab,
    name: name.trim() || "Untitled plot",
    subtitle,
    description: description?.trim() || null,
    selection: clone(spec.selection),
    computation: clone(spec.computation),
    aggregation: clone(spec.aggregation),
    presentation: clone(spec.presentation),
    created_at: existing?.created_at ?? now,
    modified_at: now,
  };
}

function flattenFolders(tree: Tree | undefined): { value: string; label: string }[] {
  if (!tree) return [];
  const out: { value: string; label: string }[] = [{ value: "none", label: "Unfiled" }];
  const walk = (folders: FolderNode[], depth: number) => {
    for (const folder of folders) {
      out.push({ value: String(folder.id), label: `${"-- ".repeat(depth)}${folder.name}` });
      walk(folder.children, depth + 1);
    }
  };
  walk(tree.folders, 0);
  return out;
}

function BadgeBar({ badges }: { badges: ApiBadge[] }) {
  if (badges.length === 0) return null;
  const colors: Record<string, string> = {
    source_offline: "orange",
    source_changed: "yellow",
    cache_missing: "gray",
    cell_archived: "gray",
    newer_parser: "blue",
    newer_calc: "blue",
    selection_drift: "grape",
    new_data: "cyan",
    missing_reference: "red",
  };
  return (
    <Group gap={6}>
      {badges.map((b, i) => (
        <Tooltip key={i} label={b.detail} multiline w={320}>
          <Badge color={colors[b.kind] ?? "gray"} variant="light" size="sm">
            {b.kind.replace(/_/g, " ")}
            {b.cell_name ? `: ${b.cell_name}` : ""}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}

function AddEntriesModal({
  opened,
  onClose,
  onAdd,
  existing,
}: {
  opened: boolean;
  onClose: () => void;
  onAdd: (entry: SelectionEntry) => void;
  existing: SelectionEntry[];
}) {
  const [search, setSearch] = useState("");
  const cells = useQuery({
    queryKey: ["cells", search],
    queryFn: () =>
      get<CellSummary[]>(`/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    enabled: opened,
  });
  const groups = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
    enabled: opened,
  });
  const has = (kind: SelectionEntry["kind"], id: number) =>
    existing.some((e) => e.kind === kind && e.ref_id === id);

  return (
    <Modal opened={opened} onClose={onClose} title="Add to plot" size="lg">
      <Tabs defaultValue="groups">
        <Tabs.List>
          <Tabs.Tab value="groups">Replicates</Tabs.Tab>
          <Tabs.Tab value="cells">Cells</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="groups" pt="sm">
          {(groups.data ?? []).length === 0 ? (
            <Alert color="gray">No replicate groups yet.</Alert>
          ) : (
            <Table highlightOnHover>
              <Table.Tbody>
                {(groups.data ?? []).map((g) => (
                  <Table.Tr key={g.id}>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {g.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {g.cell_ids.length} cells
                      </Text>
                    </Table.Td>
                    <Table.Td w={90}>
                      <Button
                        size="compact-xs"
                        disabled={has("replicate_group", g.id)}
                        onClick={() => onAdd({ kind: "replicate_group", ref_id: g.id })}
                      >
                        {has("replicate_group", g.id) ? "Added" : "Add"}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="cells" pt="sm">
          <TextInput
            placeholder="Search cells"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            mb="sm"
          />
          <Table highlightOnHover>
            <Table.Tbody>
              {(cells.data ?? []).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {c.total_cycles} cycles
                    </Text>
                  </Table.Td>
                  <Table.Td w={90}>
                    <Button
                      size="compact-xs"
                      disabled={has("cell", c.id)}
                      onClick={() => onAdd({ kind: "cell", ref_id: c.id })}
                    >
                      {has("cell", c.id) ? "Added" : "Add"}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function tracesForResult(result: ComputeResult, spec: AnalysisSpec, compact = false): Plotly.Data[] {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = result.quantities.find((q) => q.key === quantity);
  const column = quantityInfo?.column ?? "discharge_capacity_mah";
  const showCeOverlay = !compact && (spec.presentation.ce_overlay ?? false) && CAPACITY_KEYS.has(quantity);
  const out: Plotly.Data[] = [];
  const colorFor = new Map<string, string>();
  let ci = 0;
  const pick = (key: string) => {
    if (!colorFor.has(key)) colorFor.set(key, PALETTE[ci++ % PALETTE.length]);
    return colorFor.get(key)!;
  };

  for (const agg of result.aggregates) {
    const color = pick(`g${agg.group_id}`);
    const q = agg.quantities[column];
    if (!q) continue;
    if (!compact) {
      out.push({
        x: [...agg.x, ...[...agg.x].reverse()],
        y: [...q.band_high, ...[...q.band_low].reverse()],
        fill: "toself",
        fillcolor: color + "2e",
        line: { width: 0 },
        hoverinfo: "skip",
        showlegend: false,
        name: `${agg.group_name} band`,
        type: "scatter",
      } as Plotly.Data);
    }
    out.push({
      x: agg.x,
      y: q.mean,
      name: compact ? agg.group_name : `${agg.group_name} mean`,
      line: { color, width: compact ? 2 : 2.5 },
      type: "scatter",
      mode: "lines",
      customdata: q.n,
      hovertemplate: compact
        ? undefined
        : `cycle %{x}: %{y:.4f} (n=%{customdata})<extra>${agg.group_name}</extra>`,
    } as Plotly.Data);
    if (showCeOverlay && agg.quantities["coulombic_efficiency_pct"]) {
      out.push({
        x: agg.x,
        y: agg.quantities["coulombic_efficiency_pct"].mean,
        name: `${agg.group_name} CE`,
        yaxis: "y2",
        line: { color, width: 1, dash: "dot" },
        type: "scatter",
        mode: "lines",
        opacity: 0.7,
      } as Plotly.Data);
    }
  }

  const soloOrIndividual = (s: ComputeResult["cell_series"][number]) =>
    compact ||
    s.group_id === null ||
    spec.presentation.show_individual_cells ||
    result.aggregates.length === 0;

  for (const s of result.cell_series) {
    if (s.excluded || !soloOrIndividual(s)) continue;
    const grouped = s.group_id !== null;
    const color = grouped ? pick(`g${s.group_id}`) : pick(`c${s.cell_id}`);
    out.push({
      x: s.x,
      y: s.quantities[column] ?? [],
      name: s.group_name ? `${s.label} (${s.group_name})` : s.label,
      line: { color, width: grouped ? 1 : 2 },
      opacity: compact ? 0.45 : grouped ? 0.35 : 0.9,
      type: "scatter",
      mode: "lines",
      showlegend: !compact && !grouped,
    } as Plotly.Data);
    if (showCeOverlay && !grouped && s.quantities["coulombic_efficiency_pct"]) {
      out.push({
        x: s.x,
        y: s.quantities["coulombic_efficiency_pct"],
        name: `${s.label} CE`,
        yaxis: "y2",
        line: { color, width: 1, dash: "dot" },
        type: "scatter",
        mode: "lines",
        opacity: 0.7,
      } as Plotly.Data);
    }
  }
  return out;
}

function SavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
}) {
  const previewSpec = useMemo(() => specForSavedPlot(baseSpec, plot), [baseSpec, plot]);
  const preview = useQuery({
    queryKey: ["saved-plot-preview", analysisId, plot.id, JSON.stringify(plot)],
    queryFn: () => post<ComputeResult>(`/api/analyses/${analysisId}/compute`, { spec: previewSpec }),
    staleTime: 60_000,
  });
  const traces = useMemo(
    () => (preview.data ? tracesForResult(preview.data, previewSpec, true) : []),
    [preview.data, previewSpec]
  );

  if (preview.isLoading) {
    return (
      <Center h={120}>
        <Loader size={18} />
      </Center>
    );
  }
  if (traces.length === 0) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          No preview
        </Text>
      </Center>
    );
  }
  return (
    <Plot
      data={traces}
      layout={{
        height: 130,
        margin: { l: 34, r: 10, t: 8, b: 28 },
        xaxis: { title: { text: "" }, showgrid: false },
        yaxis: { title: { text: "" }, showgrid: true, zeroline: false },
        showlegend: false,
      }}
      config={{ displaylogo: false, responsive: true, staticPlot: true }}
      style={{ width: "100%" }}
      useResizeHandler
    />
  );
}

function MetricsTable({ result }: { result: ComputeResult | undefined }) {
  const metricRows: {
    key: string;
    label: string;
    sub: string | null;
    excluded: boolean;
    values: (string | null)[];
  }[] = [];

  for (const gm of result?.group_metrics ?? []) {
    metricRows.push({
      key: `g${gm.group_id}`,
      label: gm.group_name,
      sub: `replicate aggregate, n=${gm.metrics.n_members as number}`,
      excluded: false,
      values: METRIC_COLUMNS.map((mc) => {
        const v = gm.metrics[mc.key as string];
        if (v === undefined || typeof v === "number") return null;
        return `${fmt(v.mean, mc.digits)}${v.sd !== null ? ` +/- ${fmt(v.sd, mc.digits)}` : ""}`;
      }),
    });
  }

  for (const s of result?.cell_series ?? []) {
    metricRows.push({
      key: `c${s.cell_id}-${s.group_id ?? "solo"}`,
      label: s.group_name ? `${s.label} (${s.group_name})` : s.label,
      sub: s.excluded ? "hidden from plot" : null,
      excluded: s.excluded,
      values: METRIC_COLUMNS.map((mc) => {
        const v = s.metrics[mc.key];
        return v === null || v === undefined ? "-" : fmt(v as number, mc.digits);
      }),
    });
  }

  if (metricRows.length === 0) return <Alert color="gray">No samples selected.</Alert>;

  return (
    <Table.ScrollContainer minWidth={1120}>
      <Table highlightOnHover withTableBorder striped fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Cell / replicate</Table.Th>
            {METRIC_COLUMNS.map((mc) => (
              <Table.Th key={mc.key as string}>{mc.label}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {metricRows.map((row) => (
            <Table.Tr key={row.key} opacity={row.excluded ? 0.5 : 1}>
              <Table.Td>
                <Text size="xs" fw={row.sub?.startsWith("replicate") ? 700 : 500}>
                  {row.label}
                </Text>
                {row.sub && (
                  <Text size="10px" c="dimmed">
                    {row.sub}
                  </Text>
                )}
              </Table.Td>
              {row.values.map((v, i) => (
                <Table.Td key={i}>{v ?? "-"}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function SamplePanel({
  spec,
  groups,
  cells,
  onAdd,
  onRemoveEntry,
  onToggleCell,
}: {
  spec: AnalysisSpec;
  groups: ReplicateGroupSummary[];
  cells: CellSummary[];
  onAdd: () => void;
  onRemoveEntry: (index: number) => void;
  onToggleCell: (cellId: number) => void;
}) {
  const hidden = new Set(spec.selection.exclusions.map((e) => e.cell_id));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const cellById = new Map(cells.map((c) => [c.id, c]));

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">
          Plot samples
        </Text>
        <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={onAdd}>
          Add
        </Button>
      </Group>
      {spec.selection.entries.length === 0 ? (
        <Text size="xs" c="dimmed">
          No cells or replicates selected.
        </Text>
      ) : (
        <Stack gap="xs">
          {spec.selection.entries.map((entry, index) => {
            if (entry.kind === "replicate_group") {
              const group = groupById.get(entry.ref_id);
              return (
                <Box key={`${entry.kind}-${entry.ref_id}-${index}`}>
                  <Group justify="space-between" gap={6} wrap="nowrap">
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={700} truncate>
                        {group?.name ?? `replicate #${entry.ref_id}`}
                      </Text>
                      <Text size="10px" c="dimmed" tt="uppercase">
                        Replicate
                      </Text>
                    </Box>
                    <Tooltip label="Remove replicate from this plot">
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => onRemoveEntry(index)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  <Stack gap={2} mt={4} pl="md">
                    {(group?.cells ?? []).map((cell) => {
                      const isHidden = hidden.has(cell.id);
                      return (
                        <Group key={cell.id} justify="space-between" gap={6} wrap="nowrap">
                          <Text size="xs" c={isHidden ? "dimmed" : undefined} truncate>
                            {cell.name}
                          </Text>
                          <Tooltip label={isHidden ? "Show in plot" : "Hide from plot"}>
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color={isHidden ? "gray" : "teal"}
                              onClick={() => onToggleCell(cell.id)}
                            >
                              {isHidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      );
                    })}
                  </Stack>
                </Box>
              );
            }
            const cell = cellById.get(entry.ref_id);
            const isHidden = hidden.has(entry.ref_id);
            return (
              <Group key={`${entry.kind}-${entry.ref_id}-${index}`} justify="space-between" gap={6} wrap="nowrap">
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm" fw={700} truncate>
                    {cell?.name ?? `cell #${entry.ref_id}`}
                  </Text>
                  <Text size="10px" c="dimmed" tt="uppercase">
                    Cell
                  </Text>
                </Box>
                <Group gap={2} wrap="nowrap">
                  <Tooltip label={isHidden ? "Show in plot" : "Hide from plot"}>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color={isHidden ? "gray" : "teal"}
                      onClick={() => onToggleCell(entry.ref_id)}
                    >
                      {isHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove cell from this plot">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() => onRemoveEntry(index)}
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

function CycleSettings({
  spec,
  result,
  update,
}: {
  spec: AnalysisSpec;
  result: ComputeResult | undefined;
  update: (fn: (s: AnalysisSpec) => void) => void;
}) {
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  return (
    <Paper p="sm" withBorder>
      <Accordion multiple defaultValue={["plot"]}>
        <Accordion.Item value="plot">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Plot settings
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Select
                label="Quantity"
                data={(result?.quantities ?? []).map((q) => ({ value: q.key, label: q.label }))}
                value={quantity}
                onChange={(v) => v && update((s) => void (s.presentation.quantity = v))}
              />
              {CAPACITY_KEYS.has(quantity) && (
                <Switch
                  label="CE on right axis"
                  checked={spec.presentation.ce_overlay}
                  onChange={(e) =>
                    update((s) => void (s.presentation.ce_overlay = e.currentTarget.checked))
                  }
                />
              )}
              <Switch
                label="Individual cells"
                checked={spec.presentation.show_individual_cells}
                onChange={(e) =>
                  update((s) => void (s.presentation.show_individual_cells = e.currentTarget.checked))
                }
              />
              <Select
                label="Replicates"
                data={[
                  { value: "replicate_mean", label: "Mean with band" },
                  { value: "none", label: "Cells only" },
                ]}
                value={spec.aggregation.mode}
                onChange={(v) =>
                  v && update((s) => void (s.aggregation.mode = v as "replicate_mean" | "none"))
                }
              />
              <Select
                label="Band"
                data={[
                  { value: "std", label: "Standard deviation" },
                  { value: "sem", label: "SEM" },
                  { value: "minmax", label: "Min-max" },
                  { value: "percentile", label: "10-90 percentile" },
                ]}
                value={spec.aggregation.dispersion}
                onChange={(v) =>
                  v &&
                  update(
                    (s) => void (s.aggregation.dispersion = v as AnalysisSpec["aggregation"]["dispersion"])
                  )
                }
              />
              <NumberInput
                label="Min cells for band"
                min={1}
                value={spec.aggregation.min_n_for_band}
                onChange={(v) =>
                  update((s) => void (s.aggregation.min_n_for_band = typeof v === "number" ? v : 2))
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="cycles">
          <Accordion.Control>
            <Text fw={700} size="sm">
              Cycles
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Group grow>
                <NumberInput
                  label="From"
                  min={1}
                  value={spec.computation.cycle_range.start ?? undefined}
                  onChange={(v) =>
                    update(
                      (s) => void (s.computation.cycle_range.start = typeof v === "number" ? v : null)
                    )
                  }
                />
                <NumberInput
                  label="To"
                  placeholder="end"
                  min={1}
                  value={spec.computation.cycle_range.end ?? undefined}
                  onChange={(v) =>
                    update((s) => void (s.computation.cycle_range.end = typeof v === "number" ? v : null))
                  }
                />
              </Group>
              <NumberInput
                label="Skip every Nth"
                min={0}
                value={spec.computation.exclude_check_cycles_every_n}
                onChange={(v) =>
                  update(
                    (s) =>
                      void (s.computation.exclude_check_cycles_every_n =
                        typeof v === "number" ? v : 0)
                  )
                }
              />
              <Select
                label="Retention reference"
                data={[
                  { value: "max_first_n", label: "Max in first N cycles" },
                  { value: "cycle", label: "Specific cycle" },
                ]}
                value={spec.computation.retention_reference.mode}
                onChange={(v) =>
                  v &&
                  update(
                    (s) => void (s.computation.retention_reference.mode = v as "max_first_n" | "cycle")
                  )
                }
              />
              {spec.computation.retention_reference.mode === "max_first_n" ? (
                <NumberInput
                  label="First N"
                  min={1}
                  value={spec.computation.retention_reference.n}
                  onChange={(v) =>
                    update(
                      (s) => void (s.computation.retention_reference.n = typeof v === "number" ? v : 5)
                    )
                  }
                />
              ) : (
                <NumberInput
                  label="Reference cycle"
                  min={1}
                  value={spec.computation.retention_reference.cycle ?? 3}
                  onChange={(v) =>
                    update(
                      (s) =>
                        void (s.computation.retention_reference.cycle =
                          typeof v === "number" ? v : 3)
                    )
                  }
                />
              )}
              <NumberInput
                label="Formation cycles"
                min={0}
                value={spec.computation.formation_cycles}
                onChange={(v) =>
                  update((s) => void (s.computation.formation_cycles = typeof v === "number" ? v : 0))
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

function PlotHeader({
  analysisTitle,
  plotName,
  subtitle,
}: {
  analysisTitle: string;
  plotName: string;
  subtitle: string;
}) {
  return (
    <Group justify="space-between" mb="xs" align="start">
      <div>
        <Text size="xs" c="dimmed" fw={700} tt="uppercase">
          {analysisTitle}
        </Text>
        <Text fw={800} size="lg">
          {plotName}
        </Text>
        <Text size="sm" c="dimmed">
          {subtitle}
        </Text>
      </div>
    </Group>
  );
}

function CyclePlotCard({
  title,
  plotName,
  subtitle,
  result,
  spec,
  updating,
  error,
}: {
  title: string;
  plotName: string;
  subtitle: string;
  result: ComputeResult | undefined;
  spec: AnalysisSpec;
  updating: boolean;
  error: Error | null;
}) {
  const traces = useMemo(() => (result ? tracesForResult(result, spec) : []), [result, spec]);
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const quantityInfo = result?.quantities.find((q) => q.key === quantity);
  const showCeOverlay = (spec.presentation.ce_overlay ?? false) && CAPACITY_KEYS.has(quantity);

  return (
    <Paper p="sm" withBorder style={{ minHeight: 590, position: "relative" }}>
      <LoadingOverlay
        visible={updating}
        overlayProps={{ blur: 1.5, backgroundOpacity: 0.18 }}
        loaderProps={{ size: "sm", color: "teal" }}
      />
      <PlotHeader analysisTitle={title} plotName={plotName} subtitle={subtitle} />
      {error && <Alert color="red">{error.message || "Compute failed"}</Alert>}
      {traces.length === 0 ? (
        <Center h={500}>
          <Text size="sm" c="dimmed">
            Add cells or replicates to start plotting.
          </Text>
        </Center>
      ) : (
        <Box style={{ opacity: updating ? 0.42 : 1, transition: "opacity 160ms ease" }}>
          <Plot
            data={traces}
            layout={{
              height: 500,
              margin: { l: 60, r: showCeOverlay ? 60 : 20, t: 20, b: 50 },
              xaxis: { title: { text: "Cycle" } },
              yaxis: { title: { text: quantityInfo?.label ?? "" } },
              ...(showCeOverlay
                ? {
                    yaxis2: {
                      title: { text: "CE (%)" },
                      overlaying: "y" as const,
                      side: "right" as const,
                    },
                  }
                : {}),
              showlegend: spec.presentation.legend,
              legend: { orientation: "h", y: -0.2 },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: "100%" }}
            useResizeHandler
          />
        </Box>
      )}
    </Paper>
  );
}

function FamilyPlaceholder({ tab }: { tab: AnalysisTabKey }) {
  const def = TAB_DEFS.find((item) => item.value === tab)!;
  const Icon = def.icon;
  return (
    <Paper p="lg" withBorder h={590}>
      <Center h="100%">
        <Stack align="center" gap="xs" maw={520}>
          <Icon size={34} color="#12b886" />
          <Text fw={700}>{def.label}</Text>
          <Text size="sm" c="dimmed" ta="center">
            This analysis family needs protocol-specific extraction from the raw cache. The saved
            plot workflow is ready here; the calculator can be added without changing the cycle
            analysis model.
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}

function SavedPlotsPanel({
  analysisId,
  activeTab,
  baseSpec,
  plots,
  activeSavedPlotId,
  activePlotDirty,
  onSaveNew,
  onUpdateActive,
  onOpen,
  onDelete,
}: {
  analysisId: number;
  activeTab: AnalysisTabKey;
  baseSpec: AnalysisSpec;
  plots: SavedAnalysisPlot[];
  activeSavedPlotId: string | null;
  activePlotDirty: boolean;
  onSaveNew: () => void;
  onUpdateActive: () => void;
  onOpen: (plot: SavedAnalysisPlot) => void;
  onDelete: (plotId: string) => void;
}) {
  const visiblePlots = plots.filter((plot) => plot.tab === activeTab);
  if (activeTab === "settings") return null;

  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" mb="xs">
        <div>
          <Text fw={700} size="sm">
            Saved plots
          </Text>
          <Text size="xs" c="dimmed">
            {tabLabel(activeTab)} ({visiblePlots.length})
          </Text>
        </div>
        <Group gap="xs">
          <Button size="xs" variant="default" disabled={!activeSavedPlotId || !activePlotDirty} onClick={onUpdateActive}>
            Update plot
          </Button>
          <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} onClick={onSaveNew}>
            Save new plot
          </Button>
        </Group>
      </Group>
      {visiblePlots.length === 0 ? (
        <Alert color="gray">No saved plots for this tab.</Alert>
      ) : (
        <Stack gap={0}>
          {visiblePlots.map((plot) => {
            const active = plot.id === activeSavedPlotId;
            return (
              <Box
                key={plot.id}
                p="xs"
                style={{
                  borderTop: "1px solid var(--mantine-color-gray-2)",
                  background: active ? "var(--mantine-color-teal-0)" : "transparent",
                  borderRadius: active ? 6 : 0,
                }}
              >
                <Group align="stretch" wrap="nowrap">
                  <Box w={260} style={{ flexShrink: 0 }}>
                    {plot.tab === "cycles" || plot.tab === "recap" ? (
                      <SavedPlotPreview analysisId={analysisId} baseSpec={baseSpec} plot={plot} />
                    ) : (
                      <Center h={130}>
                        <Text size="xs" c="dimmed">
                          {tabLabel(plot.tab)}
                        </Text>
                      </Center>
                    )}
                  </Box>
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6}>
                      <Badge size="xs" variant="light" color={active ? "teal" : "gray"}>
                        {tabLabel(plot.tab)}
                      </Badge>
                      <Text fw={700} truncate>
                        {plot.name}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {plot.subtitle}
                    </Text>
                    {plot.description && (
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {plot.description}
                      </Text>
                    )}
                    <Text size="10px" c="dimmed">
                      Saved {new Date(plot.modified_at).toLocaleString()}
                    </Text>
                  </Stack>
                  <Stack gap={6} justify="center" w={86}>
                    <Button size="compact-xs" variant={active ? "light" : "default"} onClick={() => onOpen(plot)}>
                      Open
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => onDelete(plot.id)}>
                      Delete
                    </Button>
                  </Stack>
                </Group>
              </Box>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

function AnalysisSettingsPanel({
  title,
  setTitle,
  setDirty,
  analysis,
  folderOptions,
  setFiling,
}: {
  title: string;
  setTitle: (title: string) => void;
  setDirty: (dirty: boolean) => void;
  analysis: AnalysisFull;
  folderOptions: { value: string; label: string }[];
  setFiling: ReturnType<typeof useMutation<AnalysisFull, Error, { folder_id?: number; unfile?: boolean }>>;
}) {
  return (
    <Paper p="sm" withBorder>
      <Stack gap="md">
        <div>
          <Text fw={700}>Analysis settings</Text>
          <Text size="sm" c="dimmed">
            Filing is only for organization. It never changes which cells the analysis can reach.
          </Text>
        </div>
        <TextInput
          label="Analysis title"
          value={title}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setDirty(true);
          }}
        />
        <Select
          label="Folder"
          leftSection={<IconFolder size={14} />}
          data={folderOptions}
          searchable
          value={analysis.folder ? String(analysis.folder.id) : "none"}
          onChange={(value) => {
            if (!value) return;
            if (value === "none") setFiling.mutate({ unfile: true });
            else setFiling.mutate({ folder_id: Number(value) });
          }}
          disabled={setFiling.isPending}
        />
        <Text size="xs" c="dimmed">
          Current folder: {analysis.folder?.name ?? "Unfiled"}
        </Text>
      </Stack>
    </Paper>
  );
}

export function AnalysisPage() {
  const { analysisId } = useParams();
  const aid = Number(analysisId);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const analysis = useQuery({
    queryKey: ["analysis", aid],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${aid}`),
  });
  const groupsQuery = useQuery({
    queryKey: ["replicate-groups"],
    queryFn: () => get<ReplicateGroupSummary[]>("/api/replicate-groups"),
  });
  const cellsQuery = useQuery({
    queryKey: ["cells", "analysis-names"],
    queryFn: () => get<CellSummary[]>("/api/cells"),
  });
  const treeQuery = useQuery({
    queryKey: ["tree"],
    queryFn: () => get<Tree>("/api/tree"),
  });

  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<AnalysisTabKey>("cycles");
  const [activeSavedPlotId, setActiveSavedPlotId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ name: string; description: string } | null>(null);
  const [rendered, setRendered] = useState<{ result: ComputeResult; spec: AnalysisSpec } | null>(null);

  useEffect(() => {
    if (analysis.data && spec === null) {
      setSpec(normalizeSpec(analysis.data.spec));
      setTitle(analysis.data.title);
    }
  }, [analysis.data, spec]);

  const update = (fn: (s: AnalysisSpec) => void) => {
    setSpec((s) => {
      if (!s) return s;
      const next = normalizeSpec(s);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const compute = useQuery({
    queryKey: ["compute", aid, JSON.stringify(spec)],
    queryFn: () => post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec }),
    enabled: spec !== null,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (compute.data && spec) setRendered({ result: compute.data, spec: clone(spec) });
  }, [compute.data, spec]);

  const save = useMutation({
    mutationFn: async () => {
      await put(`/api/analyses/${aid}`, { title, spec });
      return post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec, save_provenance: true });
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      notifications.show({ message: "Analysis saved", color: "teal" });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const setFiling = useMutation({
    mutationFn: (payload: { folder_id?: number; unfile?: boolean }) =>
      put<AnalysisFull>(`/api/analyses/${aid}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      notifications.show({ message: "Analysis filing updated", color: "teal" });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const recompute = useMutation({
    mutationFn: () => post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec, recompute: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["compute", aid] });
      notifications.show({ message: "Recomputed at current parser/calc versions", color: "teal" });
    },
  });

  const duplicate = useMutation({
    mutationFn: () => post<AnalysisFull>(`/api/analyses/${aid}/duplicate`),
    onSuccess: (a) => {
      notifications.show({ message: "Duplicated; now editing the copy", color: "teal" });
      setSpec(null);
      setRendered(null);
      setActiveSavedPlotId(null);
      navigate(`/analyses/${a.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => del(`/api/analyses/${aid}`),
    onSuccess: () => navigate("/analyses"),
  });

  if (analysis.isLoading || spec === null) {
    return (
      <Center h={300}>
        <Loader />
      </Center>
    );
  }
  if (analysis.isError) return <Alert color="red">Analysis not found.</Alert>;

  const currentAnalysis = analysis.data!;
  const displayResult = rendered?.result ?? compute.data;
  const displaySpec = rendered?.spec ?? spec;
  const displaySubtitle = plotSubtitle(activeTab, displayResult, spec);
  const activePlot = (spec.saved_plots ?? []).find((plot) => plot.id === activeSavedPlotId) ?? null;
  const activePlotDirty = activePlot
    ? snapshotSignature(spec) !== snapshotSignature(specForSavedPlot(spec, activePlot))
    : false;
  const displayPlotName = activePlot?.name ?? "Unsaved plot";
  const folderOptions = flattenFolders(treeQuery.data);
  const plotTabs = TAB_DEFS.filter((tab) => tab.plotTab).map((tab) => tab.value);
  const isPlotTab = plotTabs.includes(activeTab);
  const plotUpdating = Boolean(compute.isFetching && rendered && activeTab === "cycles");

  const toggleCellVisibility = (cellId: number) => {
    update((s) => {
      const has = s.selection.exclusions.some((e) => e.cell_id === cellId);
      if (has) s.selection.exclusions = s.selection.exclusions.filter((e) => e.cell_id !== cellId);
      else {
        s.selection.exclusions.push({
          cell_id: cellId,
          reason: null,
          excluded_at: new Date().toISOString(),
        });
      }
    });
  };

  const openSavedPlot = (plot: SavedAnalysisPlot) => {
    setActiveSavedPlotId(plot.id);
    update((s) => {
      const restored = specForSavedPlot(s, plot);
      s.selection = restored.selection;
      s.computation = restored.computation;
      s.aggregation = restored.aggregation;
      s.presentation = restored.presentation;
    });
    setActiveTab(plot.tab);
  };

  const updateActivePlot = () => {
    if (!activePlot) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    update((s) => {
      s.saved_plots = (s.saved_plots ?? []).map((plot) =>
        plot.id === activePlot.id
          ? savedPlotFromSpec(s, activeTab, plot.name, subtitle, plot.description, plot)
          : plot
      );
    });
  };

  const commitSavedPlot = () => {
    if (!saveDraft) return;
    const subtitle = plotSubtitle(activeTab, displayResult, spec);
    const plot = savedPlotFromSpec(spec, activeTab, saveDraft.name, subtitle, saveDraft.description);
    update((s) => {
      s.saved_plots = [...(s.saved_plots ?? []), plot];
    });
    setActiveSavedPlotId(plot.id);
    setSaveDraft(null);
  };

  const sidebar = (
    <Stack w={330} gap="xs" style={{ flexShrink: 0 }}>
      <SamplePanel
        spec={spec}
        groups={groupsQuery.data ?? []}
        cells={cellsQuery.data ?? []}
        onAdd={() => setAddOpen(true)}
        onRemoveEntry={(index) => update((s) => void s.selection.entries.splice(index, 1))}
        onToggleCell={toggleCellVisibility}
      />
      {activeTab === "cycles" && <CycleSettings spec={spec} result={displayResult} update={update} />}
    </Stack>
  );

  const savedPlotsPanel = (
    <SavedPlotsPanel
      analysisId={aid}
      activeTab={activeTab}
      baseSpec={spec}
      plots={spec.saved_plots ?? []}
      activeSavedPlotId={activeSavedPlotId}
      activePlotDirty={activePlotDirty}
      onSaveNew={() =>
        setSaveDraft({
          name:
            activeTab === "cycles"
              ? `${quantityLabel(displayResult, spec)} comparison`
              : `${tabLabel(activeTab)} view`,
          description: "",
        })
      }
      onUpdateActive={updateActivePlot}
      onOpen={openSavedPlot}
      onDelete={(plotId) => {
        update((s) => void (s.saved_plots = (s.saved_plots ?? []).filter((plot) => plot.id !== plotId)));
        if (activeSavedPlotId === plotId) setActiveSavedPlotId(null);
      }}
    />
  );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="start">
        <TextInput
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setDirty(true);
          }}
          variant="unstyled"
          style={{ flex: 1, maxWidth: 620 }}
          styles={{ input: { fontSize: 22, fontWeight: 700 } }}
        />
        <Group gap="xs">
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={() => save.mutate()}
            loading={save.isPending}
            variant={dirty ? "filled" : "default"}
          >
            {dirty ? "Save" : "Saved"}
          </Button>
          <Tooltip label="Duplicate and keep this record intact">
            <Button variant="default" leftSection={<IconCopy size={16} />} onClick={() => duplicate.mutate()}>
              Duplicate
            </Button>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={() =>
              modals.openConfirmModal({
                title: "Delete this analysis?",
                children: <Text size="sm">The recipe and provenance are removed. Data is untouched.</Text>,
                labels: { confirm: "Delete", cancel: "Cancel" },
                confirmProps: { color: "red" },
                onConfirm: () => remove.mutate(),
              })
            }
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>

      {displayResult && <BadgeBar badges={displayResult.badges} />}

      <Tabs value={activeTab} onChange={(value) => value && setActiveTab(value as AnalysisTabKey)}>
        <Tabs.List>
          {TAB_DEFS.map((tab) => {
            const Icon = tab.icon;
            return (
              <Tabs.Tab key={tab.value} value={tab.value} leftSection={<Icon size={14} />}>
                {tab.label}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        <Tabs.Panel value="cycles" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              <CyclePlotCard
                title={title}
                plotName={displayPlotName}
                subtitle={displaySubtitle}
                result={displayResult}
                spec={displaySpec}
                updating={plotUpdating}
                error={compute.isError ? (compute.error as Error) : null}
              />
              {savedPlotsPanel}
            </Stack>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="recap" pt="sm">
          <Group align="start" wrap="nowrap">
            {sidebar}
            <Stack style={{ flex: 1, minWidth: 0 }}>
              <Paper p="sm" withBorder style={{ minHeight: 590 }}>
                <PlotHeader title={title} analysisTitle={title} plotName={displayPlotName} subtitle="Recap table" />
                <Divider mb="sm" />
                <MetricsTable result={displayResult} />
              </Paper>
              {savedPlotsPanel}
            </Stack>
          </Group>
        </Tabs.Panel>

        {(["time_capacity", "polarization", "crate", "chargeability", "dcir"] as AnalysisTabKey[]).map(
          (tab) => (
            <Tabs.Panel key={tab} value={tab} pt="sm">
              <Group align="start" wrap="nowrap">
                {sidebar}
                <Stack style={{ flex: 1, minWidth: 0 }}>
                  <FamilyPlaceholder tab={tab} />
                  {savedPlotsPanel}
                </Stack>
              </Group>
            </Tabs.Panel>
          )
        )}

        <Tabs.Panel value="settings" pt="sm">
          <Stack gap="sm">
            <AnalysisSettingsPanel
              title={title}
              setTitle={setTitle}
              setDirty={setDirty}
              analysis={currentAnalysis}
              folderOptions={folderOptions}
              setFiling={setFiling}
            />
            {displayResult && (
              <Paper p="sm" withBorder>
                <Group justify="space-between">
                  <div>
                    <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                      Provenance
                    </Text>
                    <Text size="xs" c="dimmed">
                      {currentAnalysis.provenance
                        ? `Last saved: ${new Date(currentAnalysis.provenance.computed_at).toLocaleString()} - parser ${currentAnalysis.provenance.parser_version} - calc ${currentAnalysis.provenance.calc_version} - ${currentAnalysis.provenance.sources.length} cell(s)`
                        : "Never saved. Save to pin versions and file hashes."}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Rendering at parser {displayResult.parser_version} / calc {displayResult.calc_version}
                      {displayResult.parser_version !== displayResult.current_parser_version ||
                      displayResult.calc_version !== displayResult.current_calc_version
                        ? ` - current is ${displayResult.current_parser_version} / ${displayResult.current_calc_version}`
                        : " (current)"}
                    </Text>
                  </div>
                  <Tooltip label="Render with current parser/calc versions and pin new provenance">
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconRefresh size={14} />}
                      loading={recompute.isPending}
                      onClick={() => recompute.mutate()}
                    >
                      Recompute
                    </Button>
                  </Tooltip>
                </Group>
              </Paper>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {isPlotTab && (
        <AddEntriesModal
          opened={addOpen}
          onClose={() => setAddOpen(false)}
          existing={spec.selection.entries}
          onAdd={(entry) => {
            update((s) => void s.selection.entries.push(entry));
            setAddOpen(false);
          }}
        />
      )}

      <Modal opened={saveDraft !== null} onClose={() => setSaveDraft(null)} title="Save new plot">
        <Stack>
          <TextInput
            label="Title"
            value={saveDraft?.name ?? ""}
            onChange={(event) =>
              setSaveDraft((draft) => (draft ? { ...draft, name: event.currentTarget.value } : draft))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSavedPlot();
            }}
          />
          <Text size="sm" c="dimmed">
            {plotSubtitle(activeTab, displayResult, spec)}
          </Text>
          <Textarea
            label="Description"
            minRows={3}
            value={saveDraft?.description ?? ""}
            onChange={(event) =>
              setSaveDraft((draft) =>
                draft ? { ...draft, description: event.currentTarget.value } : draft
              )
            }
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSaveDraft(null)}>
              Cancel
            </Button>
            <Button onClick={commitSavedPlot}>Save</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
