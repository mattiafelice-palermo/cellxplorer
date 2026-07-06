// Analysis editor. An analysis is a persistent RECIPE: explicit frozen
// cell/group references, exclusions, computation + aggregation choices,
// presentation, provenance. It never changes unless the user changes it —
// everything reactive is a badge.
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconDeviceFloppy,
  IconCopy,
  IconEyeOff,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  AnalysisFull,
  AnalysisSpec,
  Badge as ApiBadge,
  CellSummary,
  CollectionInfo,
  ComputeResult,
  del,
  get,
  GroupInfo,
  Meta,
  post,
  put,
  RefreshQuery,
  SelectionEntry,
  TagInfo,
  Tree,
} from "../api";
import Plot from "../components/Plot";
import { TagPicker } from "../components/TagPicker";

const PALETTE = [
  "#2E86AB", "#E63946", "#43AA8B", "#F4A261", "#7B2D8E", "#588157",
  "#BC4749", "#3A0CA3", "#FB8500", "#006D77",
];

function allGroups(tree: Tree | undefined): (GroupInfo & { project_name: string })[] {
  if (!tree) return [];
  const out: (GroupInfo & { project_name: string })[] = [];
  const fromProjects = (projects: Tree["projects"]) =>
    projects.forEach((p) => p.groups.forEach((g) => out.push({ ...g, project_name: p.name })));
  fromProjects(tree.projects);
  const walk = (folders: Tree["folders"]) =>
    folders.forEach((f) => {
      fromProjects(f.projects);
      walk(f.children);
    });
  walk(tree.folders);
  return out;
}

function AddEntriesModal({
  opened,
  onClose,
  onAdd,
  existing,
}: {
  opened: boolean;
  onClose: () => void;
  onAdd: (entries: SelectionEntry[]) => void;
  existing: SelectionEntry[];
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<string | null>("groups");
  const cells = useQuery({
    queryKey: ["cells", search],
    queryFn: () =>
      get<CellSummary[]>(`/api/cells${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const groups = allGroups(tree.data);
  const has = (kind: string, id: number) =>
    existing.some((e) => e.kind === kind && e.ref_id === id);

  return (
    <Modal opened={opened} onClose={onClose} title="Add to selection" size="lg">
      <Text size="xs" c="dimmed" mb="sm">
        Selection is by identity from ANYWHERE in the library — where this analysis is filed has
        zero effect on what it can reach. What you pick here becomes an explicit, frozen reference
        list.
      </Text>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="groups">Groups (replicates)</Tabs.Tab>
          <Tabs.Tab value="cells">Individual cells</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="groups" pt="sm">
          {groups.length === 0 ? (
            <Alert color="gray">No groups exist yet — create them inside a project.</Alert>
          ) : (
            <Table highlightOnHover>
              <Table.Tbody>
                {groups.map((g) => (
                  <Table.Tr key={g.id}>
                    <Table.Td>{g.name}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {g.project_name} · {g.cell_ids.length} cells
                      </Text>
                    </Table.Td>
                    <Table.Td w={90}>
                      <Button
                        size="compact-xs"
                        disabled={has("group", g.id)}
                        onClick={() => onAdd([{ kind: "group", ref_id: g.id }])}
                      >
                        {has("group", g.id) ? "Added" : "Add"}
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
            placeholder="Search library"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            mb="sm"
          />
          <Table highlightOnHover>
            <Table.Tbody>
              {(cells.data ?? []).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>{c.name}</Table.Td>
                  <Table.Td>
                    {c.tags.map((t) => (
                      <Badge key={t} size="xs" variant="light" mr={4}>
                        {t}
                      </Badge>
                    ))}
                  </Table.Td>
                  <Table.Td w={90}>
                    <Button
                      size="compact-xs"
                      disabled={has("cell", c.id)}
                      onClick={() => onAdd([{ kind: "cell", ref_id: c.id }])}
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

export function AnalysisPage() {
  const { analysisId } = useParams();
  const aid = Number(analysisId);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const analysis = useQuery({
    queryKey: ["analysis", aid],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${aid}`),
  });
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => get<Meta>("/api/meta") });
  const tree = useQuery({ queryKey: ["tree"], queryFn: () => get<Tree>("/api/tree") });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => get<TagInfo[]>("/api/tags") });
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => get<CollectionInfo[]>("/api/collections"),
  });

  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (analysis.data && spec === null) {
      setSpec(analysis.data.spec);
      setTitle(analysis.data.title);
    }
  }, [analysis.data, spec]);

  const update = (fn: (s: AnalysisSpec) => AnalysisSpec) => {
    setSpec((s) => (s ? fn(structuredClone(s)) : s));
    setDirty(true);
  };

  // preview compute — renders from cache at provenance-pinned versions,
  // persists nothing
  const compute = useQuery({
    queryKey: ["compute", aid, JSON.stringify(spec)],
    queryFn: () => post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec }),
    enabled: spec !== null,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: async () => {
      await put(`/api/analyses/${aid}`, { title, spec });
      return post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec, save_provenance: true });
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      notifications.show({ message: "Analysis saved (spec + provenance)", color: "teal" });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const recompute = useMutation({
    mutationFn: () =>
      post<ComputeResult>(`/api/analyses/${aid}/compute`, { spec, recompute: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["compute", aid] });
      notifications.show({
        message: "Recomputed with current parser/calc versions; provenance updated",
        color: "teal",
      });
    },
  });

  const duplicate = useMutation({
    mutationFn: () => post<AnalysisFull>(`/api/analyses/${aid}/duplicate`),
    onSuccess: (a) => {
      notifications.show({ message: "Duplicated — you are now editing the copy", color: "teal" });
      navigate(`/analyses/${a.id}`);
      setSpec(null);
    },
  });

  const remove = useMutation({
    mutationFn: () => del(`/api/analyses/${aid}`),
    onSuccess: () => navigate("/analyses"),
  });

  const setFacets = useMutation({
    mutationFn: (v: { tags?: string[]; collection_ids?: number[] }) =>
      put(`/api/analyses/${aid}`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analysis", aid] }),
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const setFiling = useMutation({
    mutationFn: (v: { folder_id?: number; project_id?: number; unfile?: boolean }) =>
      put(`/api/analyses/${aid}`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", aid] });
      qc.invalidateQueries({ queryKey: ["tree"] });
    },
  });

  const refreshSelection = useMutation({
    mutationFn: (query: RefreshQuery) =>
      post<{
        query: RefreshQuery;
        added: { cell_id: number; cell_name: string }[];
        removed: { cell_id: number; cell_name: string }[];
      }>(`/api/analyses/${aid}/refresh-selection`, { query }),
    onSuccess: (diff, query) => {
      if (diff.added.length === 0 && diff.removed.length === 0) {
        notifications.show({ message: "Selection is up to date with the query", color: "teal" });
        return;
      }
      modals.openConfirmModal({
        title: "Refresh selection?",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              The recorded query now matches a different set of cells. Nothing changes unless you
              confirm.
            </Text>
            {diff.added.length > 0 && (
              <Text size="sm" c="teal">
                +{diff.added.length}: {diff.added.map((c) => c.cell_name).join(", ")}
              </Text>
            )}
            {diff.removed.length > 0 && (
              <Text size="sm" c="red">
                −{diff.removed.length}: {diff.removed.map((c) => c.cell_name).join(", ")}
              </Text>
            )}
          </Stack>
        ),
        labels: { confirm: "Apply to selection", cancel: "Keep as is" },
        onConfirm: () =>
          update((s) => {
            const removedIds = new Set(diff.removed.map((c) => c.cell_id));
            s.selection.entries = [
              ...s.selection.entries.filter(
                (e) => !(e.kind === "cell" && removedIds.has(e.ref_id))
              ),
              ...diff.added.map(
                (c) => ({ kind: "cell", ref_id: c.cell_id }) as SelectionEntry
              ),
            ];
            s.selection.refresh_suggestion = {
              query,
              last_applied_at: new Date().toISOString(),
            };
            return s;
          }),
      });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: "red" }),
  });

  const groups = allGroups(tree.data);
  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? `group #${id}`;

  const result = compute.data;

  const traces = useMemo(() => {
    if (!result || !spec) return [];
    const out: Plotly.Data[] = [];
    const showIndividual = spec.presentation.show_individual_cells;
    const colorFor = new Map<string, string>();
    let ci = 0;
    const pick = (key: string, preset?: string | null) => {
      if (preset) return preset;
      if (!colorFor.has(key)) colorFor.set(key, PALETTE[ci++ % PALETTE.length]);
      return colorFor.get(key)!;
    };

    // aggregate bands + means
    for (const agg of result.aggregates) {
      const color = pick(`g${agg.group_id}`, agg.color);
      const lowN = spec.aggregation.fade_low_n
        ? agg.n.map((n) => n < agg.max_n && n >= agg.min_n_for_band)
        : [];
      out.push({
        x: [...agg.x, ...[...agg.x].reverse()],
        y: [...agg.band_high, ...[...agg.band_low].reverse()],
        fill: "toself",
        fillcolor: color + "33",
        line: { width: 0 },
        hoverinfo: "skip",
        showlegend: false,
        name: `${agg.group_name} band`,
        type: "scatter",
      } as Plotly.Data);
      out.push({
        x: agg.x,
        y: agg.mean,
        name: `${agg.group_name} (mean, ${agg.dispersion}, n≤${agg.max_n})`,
        line: { color, width: 2.5 },
        type: "scatter",
        mode: "lines",
        customdata: agg.n,
        hovertemplate: "cycle %{x}: %{y:.3f} (n=%{customdata})<extra>" + agg.group_name + "</extra>",
      } as Plotly.Data);
    }

    // individual cells (thin lines behind the mean — the outlier-finding loop)
    if (showIndividual || result.aggregates.length === 0) {
      for (const s of result.cell_series) {
        if (s.excluded) continue;
        const color = s.group_id !== null ? pick(`g${s.group_id}`, s.color) : pick(`c${s.cell_id}`, s.color);
        out.push({
          x: s.x,
          y: s.y,
          name: s.group_name ? `${s.label} (${s.group_name})` : s.label,
          line: { color, width: 1 },
          opacity: result.aggregates.length > 0 ? 0.35 : 0.9,
          type: "scatter",
          mode: "lines",
          showlegend: result.aggregates.length === 0,
        } as Plotly.Data);
      }
    }
    return out;
  }, [result, spec]);

  if (analysis.isLoading || spec === null)
    return (
      <Center h={300}>
        <Loader />
      </Center>
    );
  if (analysis.isError) return <Alert color="red">Analysis not found.</Alert>;

  const a = analysis.data!;
  const excludedIds = new Set(spec.selection.exclusions.map((e) => e.cell_id));
  const resolvedCells = result?.cell_series ?? [];

  const filingOptions = [
    { value: "none", label: "Not filed (library only)" },
    ...flattenTreeProjects(tree.data),
    ...flattenTreeFolders(tree.data),
  ];

  const filingValue = a.filed_in
    ? (a.filed_in.node_type === "project" ? "p" : "f") + a.filed_in.node_id
    : "none";

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="start">
        <TextInput
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setDirty(true);
          }}
          size="md"
          fw={700}
          style={{ flex: 1, maxWidth: 480 }}
          variant="unstyled"
          styles={{ input: { fontSize: 22, fontWeight: 700 } }}
        />
        <Group gap="xs">
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={() => save.mutate()}
            loading={save.isPending}
            color={dirty ? "teal" : "gray"}
            variant={dirty ? "filled" : "default"}
          >
            {dirty ? "Save" : "Saved"}
          </Button>
          <Tooltip label="Duplicate-and-recompute: update the copy, leave this record intact">
            <Button
              variant="default"
              leftSection={<IconCopy size={16} />}
              onClick={() => duplicate.mutate()}
            >
              Duplicate
            </Button>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={() =>
              modals.openConfirmModal({
                title: "Delete this analysis?",
                children: <Text size="sm">The spec and provenance are removed. Data is untouched.</Text>,
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

      {result && <BadgeBar badges={result.badges} />}

      <Group align="start" wrap="nowrap">
        {/* left: selection & settings */}
        <Stack w={360} gap="xs" style={{ flexShrink: 0 }}>
          <Paper p="sm" withBorder>
            <Group justify="space-between" mb={4}>
              <Text fw={600} size="sm">
                Selection
              </Text>
              <Button size="compact-xs" leftSection={<IconPlus size={12} />} onClick={() => setAddOpen(true)}>
                Add
              </Button>
            </Group>
            {spec.selection.entries.length === 0 && (
              <Text size="xs" c="dimmed">
                Nothing selected. Add groups (replicates) or individual cells from anywhere in the
                library.
              </Text>
            )}
            <Stack gap={4}>
              {spec.selection.entries.map((e, i) => (
                <Group key={`${e.kind}${e.ref_id}`} justify="space-between" gap={4}>
                  <Text size="sm">
                    <Badge size="xs" variant="outline" mr={6}>
                      {e.kind}
                    </Badge>
                    {e.kind === "group"
                      ? groupName(e.ref_id)
                      : (resolvedCells.find((c) => c.cell_id === e.ref_id && c.group_id === null)
                          ?.cell_name ?? `cell #${e.ref_id}`)}
                  </Text>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      update((s) => {
                        s.selection.entries.splice(i, 1);
                        return s;
                      })
                    }
                  >
                    <IconX size={12} />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>

            {resolvedCells.length > 0 && (
              <>
                <Divider my="xs" />
                <Text size="xs" fw={600} c="dimmed" mb={4}>
                  RESOLVED CELLS ({resolvedCells.length}) — click eye to exclude here only
                </Text>
                <Stack gap={2}>
                  {resolvedCells.map((c) => (
                    <Group key={`${c.cell_id}-${c.group_id}`} justify="space-between" gap={4}>
                      <Text
                        size="xs"
                        c={c.excluded ? "dimmed" : undefined}
                        td={c.excluded ? "line-through" : undefined}
                      >
                        {c.cell_name}
                        {c.group_name ? ` · ${c.group_name}` : ""}
                        {c.archived ? " (archived)" : ""}
                      </Text>
                      <Group gap={2}>
                        {c.excluded && c.exclusion_reason && (
                          <Tooltip label={`Reason: ${c.exclusion_reason}`}>
                            <Badge size="xs" color="gray">
                              excluded
                            </Badge>
                          </Tooltip>
                        )}
                        <Tooltip
                          label={
                            c.excluded
                              ? "Re-include in this analysis"
                              : "Exclude in THIS analysis only (with reason)"
                          }
                        >
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color={c.excluded ? "teal" : "gray"}
                            onClick={() => {
                              if (excludedIds.has(c.cell_id)) {
                                update((s) => {
                                  s.selection.exclusions = s.selection.exclusions.filter(
                                    (x) => x.cell_id !== c.cell_id
                                  );
                                  return s;
                                });
                              } else {
                                const reason = window.prompt(
                                  `Exclude ${c.cell_name} from this analysis only.\nReason (optional):`
                                );
                                if (reason === null) return;
                                update((s) => {
                                  s.selection.exclusions.push({
                                    cell_id: c.cell_id,
                                    reason: reason || null,
                                    excluded_at: new Date().toISOString(),
                                  });
                                  return s;
                                });
                              }
                            }}
                          >
                            <IconEyeOff size={12} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  ))}
                </Stack>
              </>
            )}

            <Divider my="xs" />
            <RefreshSuggestionEditor
              spec={spec}
              tags={(tags.data ?? []).map((t) => t.name)}
              onRun={(q) => refreshSelection.mutate(q)}
              onSaveQuery={(q) =>
                update((s) => {
                  s.selection.refresh_suggestion = { query: q, last_applied_at: null };
                  return s;
                })
              }
            />
          </Paper>

          <Paper p="sm" withBorder>
            <Accordion multiple defaultValue={["computation", "aggregation"]} variant="default">
              <Accordion.Item value="computation">
                <Accordion.Control>
                  <Text fw={600} size="sm">
                    Computation
                  </Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Select
                      label="Quantity"
                      data={meta.data?.quantities.map((q) => ({ value: q.value, label: q.label }))}
                      value={spec.computation.quantity}
                      onChange={(v) =>
                        v && update((s) => ((s.computation.quantity = v), s))
                      }
                    />
                    <Group grow>
                      <NumberInput
                        label="From cycle"
                        min={1}
                        value={spec.computation.cycle_range.start ?? undefined}
                        onChange={(v) =>
                          update((s) => {
                            s.computation.cycle_range.start = typeof v === "number" ? v : null;
                            return s;
                          })
                        }
                      />
                      <NumberInput
                        label="To cycle"
                        min={1}
                        placeholder="end"
                        value={spec.computation.cycle_range.end ?? undefined}
                        onChange={(v) =>
                          update((s) => {
                            s.computation.cycle_range.end = typeof v === "number" ? v : null;
                            return s;
                          })
                        }
                      />
                    </Group>
                    <NumberInput
                      label="Exclude check/RPT cycles (every Nth)"
                      description="0 = off"
                      min={0}
                      value={
                        (spec.computation.filters.find((f) => f.kind === "exclude_check_cycles")
                          ?.params.every_n as number) ?? 0
                      }
                      onChange={(v) =>
                        update((s) => {
                          s.computation.filters = s.computation.filters.filter(
                            (f) => f.kind !== "exclude_check_cycles"
                          );
                          if (typeof v === "number" && v > 1)
                            s.computation.filters.push({
                              kind: "exclude_check_cycles",
                              params: { every_n: v },
                            });
                          return s;
                        })
                      }
                    />
                    <Select
                      label="Normalization"
                      data={[
                        { value: "none", label: "None (absolute values)" },
                        { value: "reference_cycle", label: "% of a reference cycle" },
                        { value: "first_cycle", label: "% of first cycle" },
                        { value: "max", label: "% of maximum" },
                      ]}
                      value={spec.computation.normalization.kind}
                      onChange={(v) =>
                        v &&
                        update((s) => {
                          s.computation.normalization = {
                            kind: v,
                            params: v === "reference_cycle" ? { cycle: 3 } : {},
                          };
                          return s;
                        })
                      }
                    />
                    {spec.computation.normalization.kind === "reference_cycle" && (
                      <NumberInput
                        label="Reference cycle"
                        min={1}
                        value={(spec.computation.normalization.params.cycle as number) ?? 3}
                        onChange={(v) =>
                          update((s) => {
                            s.computation.normalization.params.cycle =
                              typeof v === "number" ? v : 3;
                            return s;
                          })
                        }
                      />
                    )}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="aggregation">
                <Accordion.Control>
                  <Text fw={600} size="sm">
                    Replicate statistics
                  </Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                      Computed per cycle over group members minus exclusions, at render time —
                      never stored.
                    </Text>
                    <Select
                      label="Aggregation"
                      data={[
                        { value: "group_mean", label: "Group mean ± band" },
                        { value: "none", label: "Individual cells only" },
                      ]}
                      value={spec.aggregation.mode}
                      onChange={(v) =>
                        v && update((s) => ((s.aggregation.mode = v as "group_mean" | "none"), s))
                      }
                    />
                    <Select
                      label="Dispersion"
                      data={[
                        { value: "std", label: "Standard deviation" },
                        { value: "sem", label: "Standard error of mean" },
                        { value: "minmax", label: "Min–max" },
                        { value: "percentile", label: "10–90 percentile" },
                      ]}
                      value={spec.aggregation.dispersion}
                      onChange={(v) =>
                        v &&
                        update(
                          (s) => ((s.aggregation.dispersion = v as AnalysisSpec["aggregation"]["dispersion"]), s)
                        )
                      }
                    />
                    <NumberInput
                      label="Min replicates for band"
                      description="Replicates die at different cycle counts; band shows only where n ≥ this"
                      min={1}
                      value={spec.aggregation.min_n_for_band}
                      onChange={(v) =>
                        update(
                          (s) => ((s.aggregation.min_n_for_band = typeof v === "number" ? v : 2), s)
                        )
                      }
                    />
                    <Switch
                      label="Show individual cells (thin lines behind the mean)"
                      checked={spec.presentation.show_individual_cells}
                      onChange={(e) =>
                        update(
                          (s) => (
                            (s.presentation.show_individual_cells = e.currentTarget.checked), s
                          )
                        )
                      }
                    />
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="filing">
                <Accordion.Control>
                  <Text fw={600} size="sm">
                    Filing, tags & collections
                  </Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Select
                      label="Filed under"
                      description="Co-location only — filing never affects what data this analysis can reach"
                      data={filingOptions}
                      value={filingValue}
                      onChange={(v) => {
                        if (!v) return;
                        if (v === "none") setFiling.mutate({ unfile: true });
                        else if (v.startsWith("p"))
                          setFiling.mutate({ project_id: Number(v.slice(1)) });
                        else setFiling.mutate({ folder_id: Number(v.slice(1)) });
                      }}
                    />
                    <TagPicker value={a.tags} onChange={(t) => setFacets.mutate({ tags: t })} />
                    <MultiSelect
                      label="Collections"
                      description="Flat, many-to-many — an analysis can be in several (e.g. “Paper X”, “Q1 review”)"
                      data={(collections.data ?? []).map((c) => ({
                        value: String(c.id),
                        label: c.name,
                      }))}
                      value={a.collections.map((c) => String(c.id))}
                      onChange={(vals) =>
                        setFacets.mutate({ collection_ids: vals.map(Number) })
                      }
                    />
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Paper>
        </Stack>

        {/* right: plot + provenance */}
        <Stack style={{ flex: 1, minWidth: 0 }}>
          <Paper p="sm" withBorder>
            {compute.isFetching && (
              <Group gap={6} mb={4}>
                <Loader size={14} />
                <Text size="xs" c="dimmed">
                  computing…
                </Text>
              </Group>
            )}
            {compute.isError && (
              <Alert color="red">{(compute.error as Error).message || "Compute failed"}</Alert>
            )}
            {result && traces.length === 0 && (
              <Alert color="gray">
                Nothing to plot yet — add cells or groups to the selection.
              </Alert>
            )}
            {traces.length > 0 && (
              <Plot
                data={traces}
                layout={{
                  height: 520,
                  margin: { l: 60, r: 20, t: 20, b: 50 },
                  xaxis: { title: { text: spec.presentation.axis_labels.x ?? "Cycle" } },
                  yaxis: { title: { text: result?.y_label ?? "" } },
                  showlegend: spec.presentation.legend,
                  legend: { orientation: "h", y: -0.18 },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: "100%" }}
                useResizeHandler
              />
            )}
          </Paper>

          {result && (
            <Paper p="sm" withBorder>
              <Group justify="space-between">
                <div>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    Provenance
                  </Text>
                  <Text size="xs" c="dimmed">
                    {a.provenance
                      ? `Last saved computation: ${new Date(
                          a.provenance.computed_at
                        ).toLocaleString()} · parser ${a.provenance.parser_version} · calc ${a.provenance.calc_version} · ${a.provenance.sources.length} cell(s)`
                      : "Never computed & saved — Save to pin provenance (versions + file hashes)."}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Rendering now at parser {result.parser_version} / calc {result.calc_version}
                    {result.parser_version !== result.current_parser_version ||
                    result.calc_version !== result.current_calc_version
                      ? ` — current is ${result.current_parser_version}/${result.current_calc_version}`
                      : " (current)"}
                  </Text>
                </div>
                <Tooltip label="Re-parse sources with the CURRENT parser/calc versions and pin new provenance. Old caches are kept, so the previous result stays reproducible.">
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconRefresh size={14} />}
                    loading={recompute.isPending}
                    onClick={() => recompute.mutate()}
                  >
                    Recompute at current versions
                  </Button>
                </Tooltip>
              </Group>
            </Paper>
          )}
        </Stack>
      </Group>

      <AddEntriesModal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        existing={spec.selection.entries}
        onAdd={(entries) =>
          update((s) => {
            s.selection.entries.push(...entries);
            return s;
          })
        }
      />
    </Stack>
  );
}

function RefreshSuggestionEditor({
  spec,
  tags,
  onRun,
  onSaveQuery,
}: {
  spec: AnalysisSpec;
  tags: string[];
  onRun: (q: RefreshQuery) => void;
  onSaveQuery: (q: RefreshQuery) => void;
}) {
  const saved = spec.selection.refresh_suggestion?.query;
  const [open, setOpen] = useState(false);
  const [nameContains, setNameContains] = useState(saved?.name_contains ?? "");
  const [tagsAll, setTagsAll] = useState<string[]>(saved?.tags_all ?? []);

  const query: RefreshQuery = {
    ...(nameContains ? { name_contains: nameContains } : {}),
    ...(tagsAll.length ? { tags_all: tagsAll } : {}),
  };
  const hasQuery = Object.keys(query).length > 0;

  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Text size="xs" fw={600} c="dimmed">
          REFRESH SUGGESTION
        </Text>
        <Button size="compact-xs" variant="subtle" onClick={() => setOpen(!open)}>
          {open ? "Hide" : saved ? "Edit query" : "Record query"}
        </Button>
      </Group>
      {saved && !open && (
        <Group gap={6}>
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {[
              saved.name_contains && `name ~ “${saved.name_contains}”`,
              saved.tags_all?.length && `tags: ${saved.tags_all.join(", ")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <Button size="compact-xs" variant="light" onClick={() => onRun(saved)}>
            Refresh selection
          </Button>
        </Group>
      )}
      {open && (
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Optionally record the query that produced this selection. “Refresh selection” re-runs
            it and shows a diff — applied only on your confirmation.
          </Text>
          <TextInput
            size="xs"
            label="Cell name contains"
            value={nameContains}
            onChange={(e) => setNameContains(e.currentTarget.value)}
          />
          <MultiSelect
            size="xs"
            label="Has all tags"
            data={tags}
            value={tagsAll}
            onChange={setTagsAll}
          />
          <Group gap={6}>
            <Button
              size="compact-xs"
              disabled={!hasQuery}
              onClick={() => {
                onSaveQuery(query);
                setOpen(false);
              }}
            >
              Save query
            </Button>
            <Button size="compact-xs" variant="default" disabled={!hasQuery} onClick={() => onRun(query)}>
              Run now
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

function flattenTreeProjects(tree: Tree | undefined): { value: string; label: string }[] {
  if (!tree) return [];
  const out: { value: string; label: string }[] = [];
  const add = (projects: Tree["projects"]) =>
    projects.forEach((p) => out.push({ value: `p${p.id}`, label: `Project: ${p.name}` }));
  add(tree.projects);
  const walk = (folders: Tree["folders"]) =>
    folders.forEach((f) => {
      add(f.projects);
      walk(f.children);
    });
  walk(tree.folders);
  return out;
}

function flattenTreeFolders(tree: Tree | undefined): { value: string; label: string }[] {
  if (!tree) return [];
  const out: { value: string; label: string }[] = [];
  const walk = (folders: Tree["folders"], depth: number) =>
    folders.forEach((f) => {
      out.push({ value: `f${f.id}`, label: `Folder: ${"— ".repeat(depth)}${f.name}` });
      walk(f.children, depth + 1);
    });
  walk(tree.folders, 0);
  return out;
}
