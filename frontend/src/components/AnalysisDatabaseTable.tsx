import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  HoverCard,
  Menu,
  NumberInput,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronUp,
  IconColumns3,
  IconDotsVertical,
  IconFilter,
  IconFolder,
  IconLayoutSidebarRight,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";

import { get, type AnalysisFull, type AnalysisSavedPlotSummary, type AnalysisSummary } from "../api";
import {
  AnalysisSamplePreviewModal,
  type AnalysisSamplePreview,
} from "./AnalysisSamplePreviewModal";

type ColumnKey = "title" | "samples" | "plots" | "folder" | "created" | "modified";
type SortDirection = "asc" | "desc";

type Filters = {
  title: string;
  samplesMin: number | null;
  samplesMax: number | null;
  plotsMin: number | null;
  plotsMax: number | null;
  folders: string[];
  quantities: string[];
  createdFrom: string;
  createdTo: string;
  modifiedFrom: string;
  modifiedTo: string;
};

const STORAGE_KEY = "cellxplorer.analysis-database-table.v1";
const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  title: 300,
  samples: 180,
  plots: 130,
  folder: 190,
  created: 175,
  modified: 175,
};
const MIN_WIDTHS: Record<ColumnKey, number> = {
  title: 190,
  samples: 125,
  plots: 100,
  folder: 125,
  created: 140,
  modified: 140,
};
const COLUMN_LABELS: Record<ColumnKey, string> = {
  title: "Title",
  samples: "Samples",
  plots: "Plots",
  folder: "Folder",
  created: "Created",
  modified: "Modified",
};
const DEFAULT_FILTERS: Filters = {
  title: "",
  samplesMin: null,
  samplesMax: null,
  plotsMin: null,
  plotsMax: null,
  folders: [],
  quantities: [],
  createdFrom: "",
  createdTo: "",
  modifiedFrom: "",
  modifiedTo: "",
};

function humanize(value: string): string {
  if (!value) return "Unspecified";
  const words = value.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function formatTab(value: string): string {
  if (value === "time_capacity") return "Time / capacity";
  if (value === "c_rate") return "C-rate";
  return humanize(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function savedPlots(row: AnalysisSummary) {
  return row.saved_plots ?? [];
}

function sampleCount(row: AnalysisSummary): number {
  return row.n_cells ?? row.n_entries ?? 0;
}

function dateMatches(value: string, from: string, to: string): boolean {
  const timestamp = new Date(value).getTime();
  if (from && timestamp < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && timestamp > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function loadPreferences(): {
  widths: Record<ColumnKey, number>;
  visible: Record<ColumnKey, boolean>;
} {
  const fallback = {
    widths: DEFAULT_WIDTHS,
    visible: Object.fromEntries(
      (Object.keys(DEFAULT_WIDTHS) as ColumnKey[]).map((key) => [key, true])
    ) as Record<ColumnKey, boolean>,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed) return fallback;
    return {
      widths: { ...DEFAULT_WIDTHS, ...(parsed.widths ?? {}) },
      visible: { ...fallback.visible, ...(parsed.visible ?? {}) },
    };
  } catch {
    return fallback;
  }
}

function activeFilter(column: ColumnKey, filters: Filters): boolean {
  if (column === "title") return Boolean(filters.title.trim());
  if (column === "samples") return filters.samplesMin !== null || filters.samplesMax !== null;
  if (column === "plots") {
    return filters.plotsMin !== null || filters.plotsMax !== null || filters.quantities.length > 0;
  }
  if (column === "folder") return filters.folders.length > 0;
  if (column === "created") return Boolean(filters.createdFrom || filters.createdTo);
  return Boolean(filters.modifiedFrom || filters.modifiedTo);
}

function sortValue(row: AnalysisSummary, column: ColumnKey): string | number {
  if (column === "title") return row.title.toLocaleLowerCase();
  if (column === "samples") return sampleCount(row);
  if (column === "plots") return savedPlots(row).length;
  if (column === "folder") return (row.folder?.name ?? "").toLocaleLowerCase();
  if (column === "created") return new Date(row.created_at).getTime();
  return new Date(row.modified_at).getTime();
}

function CachedPlotThumbnail({ analysisId, plotId }: { analysisId: number; plotId: string }) {
  const thumbnail = useQuery({
    queryKey: ["analysis-database-thumbnail", analysisId, plotId],
    queryFn: () =>
      get<{ thumbnail: string }>(
        `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/thumbnail/latest`
          + "?variant=preview"
    ),
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) => query.state.data?.thumbnail ? false : 3_000,
  });
  if (thumbnail.data?.thumbnail) {
    return (
      <Box className="cx-plot-thumbnail-frame" w="100%" h="100%" style={{ display: "grid", placeItems: "center" }}>
        <Box
          component="img"
          className="cx-plot-thumbnail"
          src={thumbnail.data.thumbnail}
          alt="Cached plot preview"
          maw="100%"
          mah="100%"
          style={{ display: "block" }}
        />
      </Box>
    );
  }
  return (
    <Text size="xs" c="dimmed" ta="center">
      {thumbnail.isLoading ? "Loading preview..." : "Preview not cached"}
    </Text>
  );
}

function PlotSummary({
  analysis,
  onOpenPlot,
}: {
  analysis: AnalysisSummary;
  onOpenPlot: (analysis: AnalysisSummary, plot: AnalysisSavedPlotSummary, background: boolean) => void;
}) {
  const plots = savedPlots(analysis);
  const count = plots.length;
  const [hoveredPlotId, setHoveredPlotId] = useState(plots[0]?.id ?? null);
  const hoveredPlot = plots.find((plot) => plot.id === hoveredPlotId) ?? plots[0];
  if (!count) return <Text size="sm" c="dimmed">No plots</Text>;
  return (
    <HoverCard width={760} shadow="md" position="right" openDelay={160} closeDelay={120} withinPortal>
      <HoverCard.Target>
        <UnstyledButton onClick={(event) => event.stopPropagation()}>
          <Text size="sm" td="underline" style={{ textDecorationStyle: "dotted" }}>
            {count} plot{count === 1 ? "" : "s"}
          </Text>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Group align="stretch" gap="md" wrap="nowrap">
          <Stack gap={4} w={330} mah={330} style={{ overflowY: "auto" }}>
            {plots.map((plot) => (
              <UnstyledButton
                key={plot.id}
                p="xs"
                onMouseEnter={() => setHoveredPlotId(plot.id)}
                onFocus={() => setHoveredPlotId(plot.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenPlot(analysis, plot, event.ctrlKey || event.metaKey);
                }}
                style={{
                  borderRadius: 5,
                  background: hoveredPlot?.id === plot.id ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))" : undefined,
                }}
              >
                <Text size="sm" fw={600}>{plot.name}</Text>
                <Text size="xs" c="dimmed">
                  {formatTab(plot.tab)} - {plot.subtitle || humanize(plot.quantity)}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
          <Box w={390} style={{ flexShrink: 0 }}>
            <Box
              bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
              style={{ aspectRatio: "4 / 3", display: "grid", placeItems: "center", overflow: "hidden" }}
            >
              {hoveredPlot ? (
                <CachedPlotThumbnail analysisId={analysis.id} plotId={hoveredPlot.id} />
              ) : null}
            </Box>
            <Text size="xs" c="dimmed" mt={6} truncate>{hoveredPlot?.name}</Text>
          </Box>
        </Group>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function SampleSummary({
  analysis,
  onPreview,
}: {
  analysis: AnalysisSummary;
  onPreview: (sample: NonNullable<AnalysisSamplePreview>) => void;
}) {
  const [activated, setActivated] = useState(false);
  const detail = useQuery({
    queryKey: ["analysis", analysis.id],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${analysis.id}`),
    enabled: activated,
    staleTime: 60_000,
  });
  const count = sampleCount(analysis);
  return (
    <HoverCard width={380} shadow="md" position="right" openDelay={160} closeDelay={120} withinPortal>
      <HoverCard.Target>
        <UnstyledButton
          onMouseEnter={() => setActivated(true)}
          onFocus={() => setActivated(true)}
          onClick={(event) => event.stopPropagation()}
        >
          <Text size="sm" td="underline" style={{ textDecorationStyle: "dotted" }}>
            {count} cell{count === 1 ? "" : "s"}
          </Text>
          {(analysis.n_replicate_groups ?? 0) > 0 && (
            <Text size="xs" c="dimmed">
              {analysis.n_replicate_groups} replicate{analysis.n_replicate_groups === 1 ? "" : "s"}
            </Text>
          )}
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        {detail.isLoading ? (
          <Text size="sm" c="dimmed">Loading samples...</Text>
        ) : detail.isError ? (
          <Text size="sm" c="red">Could not load samples.</Text>
        ) : (
          <Stack gap="sm" mah={360} style={{ overflowY: "auto" }}>
            {(detail.data?.selection_groups.length ?? 0) > 0 && (
              <Stack gap={3}>
                <Text size="xs" fw={700} c="dimmed" tt="uppercase">Replicates</Text>
                {detail.data!.selection_groups.map((group) => (
                  <UnstyledButton
                    key={group.id}
                    p="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreview({ kind: "replicate", id: group.id, name: group.name });
                    }}
                    style={{ borderRadius: 5 }}
                  >
                    <Text size="sm" fw={600}>{group.name}</Text>
                    <Text size="xs" c="dimmed">{group.cells.length} cells</Text>
                  </UnstyledButton>
                ))}
              </Stack>
            )}
            {(detail.data?.selection_cells.length ?? 0) > 0 && (
              <Stack gap={3}>
                <Text size="xs" fw={700} c="dimmed" tt="uppercase">Individual cells</Text>
                {detail.data!.selection_cells.map((cell) => (
                  <UnstyledButton
                    key={cell.id}
                    p="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreview({ kind: "cell", id: cell.id, name: cell.name });
                    }}
                    style={{ borderRadius: 5 }}
                  >
                    <Text size="sm" fw={600}>{cell.name}</Text>
                    {cell.description ? <Text size="xs" c="dimmed" lineClamp={1}>{cell.description}</Text> : null}
                  </UnstyledButton>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function HeaderMenu({
  column,
  sort,
  filters,
  folderOptions,
  quantityOptions,
  setFilters,
  setSort,
}: {
  column: ColumnKey;
  sort: { column: ColumnKey; direction: SortDirection };
  filters: Filters;
  folderOptions: string[];
  quantityOptions: string[];
  setFilters: Dispatch<SetStateAction<Filters>>;
  setSort: (column: ColumnKey, direction: SortDirection) => void;
}) {
  const filtered = activeFilter(column, filters);
  const sorted = sort.column === column;
  const toggleArray = (key: "folders" | "quantities", value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };
  const clear = () => {
    setFilters((current) => {
      if (column === "title") return { ...current, title: "" };
      if (column === "samples") return { ...current, samplesMin: null, samplesMax: null };
      if (column === "plots") {
        return { ...current, plotsMin: null, plotsMax: null, quantities: [] };
      }
      if (column === "folder") return { ...current, folders: [] };
      if (column === "created") return { ...current, createdFrom: "", createdTo: "" };
      return { ...current, modifiedFrom: "", modifiedTo: "" };
    });
  };

  return (
    <Menu closeOnItemClick={false} withinPortal position="bottom-start" shadow="md">
      <Menu.Target>
        <UnstyledButton
          aria-label={`Sort and filter ${COLUMN_LABELS[column]}`}
          onClick={(event) => event.stopPropagation()}
          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}
        >
          <Text size="sm" fw={700} truncate>{COLUMN_LABELS[column]}</Text>
          {sorted ? (
            sort.direction === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
          ) : filtered ? (
            <IconFilter size={13} color="var(--mantine-primary-color-6)" />
          ) : (
            <IconArrowsSort size={13} color="var(--mantine-color-gray-5)" />
          )}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown onClick={(event) => event.stopPropagation()} miw={230}>
        <Menu.Item onClick={() => setSort(column, "asc")} leftSection={<IconChevronUp size={14} />}>
          Sort ascending
        </Menu.Item>
        <Menu.Item onClick={() => setSort(column, "desc")} leftSection={<IconChevronDown size={14} />}>
          Sort descending
        </Menu.Item>
        <Divider my="xs" />
        <Box px="sm" pb="xs">
          {column === "title" && (
            <TextInput
              size="xs"
              label="Contains"
              value={filters.title}
              onChange={(event) => setFilters((current) => ({ ...current, title: event.currentTarget.value }))}
            />
          )}
          {(column === "samples" || column === "plots") && (
            <Group grow align="end">
              <NumberInput
                size="xs"
                label="Minimum"
                min={0}
                value={column === "samples" ? filters.samplesMin ?? "" : filters.plotsMin ?? ""}
                onChange={(value) => setFilters((current) => ({
                  ...current,
                  [column === "samples" ? "samplesMin" : "plotsMin"]:
                    typeof value === "number" ? value : null,
                }))}
              />
              <NumberInput
                size="xs"
                label="Maximum"
                min={0}
                value={column === "samples" ? filters.samplesMax ?? "" : filters.plotsMax ?? ""}
                onChange={(value) => setFilters((current) => ({
                  ...current,
                  [column === "samples" ? "samplesMax" : "plotsMax"]:
                    typeof value === "number" ? value : null,
                }))}
              />
            </Group>
          )}
          {column === "plots" && quantityOptions.length > 0 && (
            <Stack gap={5} mt="sm">
              <Text size="xs" fw={600}>Includes quantity</Text>
              {quantityOptions.map((quantity) => (
                <Checkbox
                  key={quantity}
                  size="xs"
                  label={humanize(quantity)}
                  checked={filters.quantities.includes(quantity)}
                  onChange={() => toggleArray("quantities", quantity)}
                />
              ))}
            </Stack>
          )}
          {column === "folder" && (
            <Stack gap={5} mah={240} style={{ overflowY: "auto" }}>
              {folderOptions.map((folder) => (
                <Checkbox
                  key={folder}
                  size="xs"
                  label={folder}
                  checked={filters.folders.includes(folder)}
                  onChange={() => toggleArray("folders", folder)}
                />
              ))}
            </Stack>
          )}
          {(column === "created" || column === "modified") && (
            <Stack gap="xs">
              <TextInput
                type="date"
                size="xs"
                label="From"
                value={column === "created" ? filters.createdFrom : filters.modifiedFrom}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  [column === "created" ? "createdFrom" : "modifiedFrom"]: event.currentTarget.value,
                }))}
              />
              <TextInput
                type="date"
                size="xs"
                label="To"
                value={column === "created" ? filters.createdTo : filters.modifiedTo}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  [column === "created" ? "createdTo" : "modifiedTo"]: event.currentTarget.value,
                }))}
              />
            </Stack>
          )}
          {filtered && (
            <Button size="compact-xs" variant="subtle" color="gray" mt="sm" onClick={clear}>
              Clear filter
            </Button>
          )}
        </Box>
      </Menu.Dropdown>
    </Menu>
  );
}

export function AnalysisDatabaseTable({
  rows,
  onOpen,
  onRemove,
  removing,
  openIds,
  onOpenPlot,
  onOpenFolder,
}: {
  rows: AnalysisSummary[];
  onOpen: (analysis: AnalysisSummary, background: boolean) => void;
  onRemove: (ids: number[]) => void;
  removing: boolean;
  openIds: Set<number>;
  onOpenPlot: (analysis: AnalysisSummary, plot: AnalysisSavedPlotSummary, background: boolean) => void;
  onOpenFolder: (folderId: number) => void;
}) {
  const preferences = useMemo(loadPreferences, []);
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastSelected, setLastSelected] = useState<number | null>(null);
  const [sort, setSortState] = useState<{ column: ColumnKey; direction: SortDirection }>({
    column: "modified",
    direction: "desc",
  });
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [widths, setWidths] = useState(preferences.widths);
  const [visible, setVisible] = useState(preferences.visible);
  const [samplePreview, setSamplePreview] = useState<AnalysisSamplePreview>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ widths, visible }));
  }, [visible, widths]);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => {
    const available = new Set(rows.map((row) => row.id));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [rows]);

  const folderOptions = useMemo(
    () => [...new Set(rows.map((row) => row.folder?.name ?? "No folder"))].sort(),
    [rows]
  );
  const quantityOptions = useMemo(
    () => [...new Set(rows.flatMap((row) => savedPlots(row).map((plot) => plot.quantity).filter(Boolean)))].sort(),
    [rows]
  );
  const displayed = useMemo(() => {
    const searchText = search.trim().toLocaleLowerCase();
    const titleFilter = filters.title.trim().toLocaleLowerCase();
    const filtered = rows.filter((row) => {
      if (openOnly && !openIds.has(row.id)) return false;
      if (searchText && !row.title.toLocaleLowerCase().includes(searchText)) return false;
      if (titleFilter && !row.title.toLocaleLowerCase().includes(titleFilter)) return false;
      if (filters.samplesMin !== null && sampleCount(row) < filters.samplesMin) return false;
      if (filters.samplesMax !== null && sampleCount(row) > filters.samplesMax) return false;
      if (filters.plotsMin !== null && savedPlots(row).length < filters.plotsMin) return false;
      if (filters.plotsMax !== null && savedPlots(row).length > filters.plotsMax) return false;
      if (filters.folders.length && !filters.folders.includes(row.folder?.name ?? "No folder")) return false;
      if (
        filters.quantities.length &&
        !savedPlots(row).some((plot) => filters.quantities.includes(plot.quantity))
      ) return false;
      if (!dateMatches(row.created_at, filters.createdFrom, filters.createdTo)) return false;
      return dateMatches(row.modified_at, filters.modifiedFrom, filters.modifiedTo);
    });
    return [...filtered].sort((left, right) => {
      const a = sortValue(left, sort.column);
      const b = sortValue(right, sort.column);
      const comparison = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [filters, openIds, openOnly, rows, search, sort]);

  const visibleColumns = (Object.keys(DEFAULT_WIDTHS) as ColumnKey[]).filter((key) => visible[key]);
  const displayedIds = displayed.map((row) => row.id);
  const allDisplayedSelected = displayedIds.length > 0 && displayedIds.every((id) => selected.has(id));
  const someDisplayedSelected = displayedIds.some((id) => selected.has(id));

  const setSort = (column: ColumnKey, direction: SortDirection) => setSortState({ column, direction });
  const toggleSelection = (id: number, range: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (range && lastSelected !== null) {
        const start = displayedIds.indexOf(lastSelected);
        const end = displayedIds.indexOf(id);
        if (start >= 0 && end >= 0) {
          const shouldSelect = !current.has(id);
          displayedIds.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((rowId) => {
            if (shouldSelect) next.add(rowId); else next.delete(rowId);
          });
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelected(id);
  };
  const toggleAllDisplayed = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allDisplayedSelected) displayedIds.forEach((id) => next.delete(id));
      else displayedIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const beginResize = (column: ColumnKey, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[column];
    const move = (moveEvent: PointerEvent) => {
      setWidths((current) => ({
        ...current,
        [column]: Math.max(MIN_WIDTHS[column], startWidth + moveEvent.clientX - startX),
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      resizeCleanup.current = null;
    };
    resizeCleanup.current?.();
    resizeCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center" wrap="nowrap">
        <TextInput
          leftSection={<IconSearch size={14} />}
          placeholder="Search titles"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          w="min(420px, 100%)"
        />
        <Group gap="xs" wrap="nowrap">
          <Button
            variant={openOnly ? "light" : "default"}
            color={openOnly ? "var(--mantine-primary-color-6)" : "gray"}
            leftSection={<IconLayoutSidebarRight size={16} />}
            onClick={() => setOpenOnly((current) => !current)}
          >
            Open only
          </Button>
          <Menu closeOnItemClick={false} withinPortal position="bottom-end" shadow="md">
            <Menu.Target>
              <Button variant="default" leftSection={<IconColumns3 size={16} />}>Columns</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Visible columns</Menu.Label>
              {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((column) => (
                <Menu.Item key={column} onClick={() => setVisible((current) => ({ ...current, [column]: !current[column] }))}>
                  <Checkbox
                    size="xs"
                    label={COLUMN_LABELS[column]}
                    checked={visible[column]}
                    readOnly
                  />
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={selected.size === 0}
            loading={removing}
            onClick={() => onRemove([...selected])}
          >
            Remove selected{selected.size ? ` (${selected.size})` : ""}
          </Button>
        </Group>
      </Group>

      <ScrollArea type="auto">
        <Table highlightOnHover withTableBorder miw={700} style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 44 }} />
            {visibleColumns.map((column) => <col key={column} style={{ width: widths[column] }} />)}
            <col style={{ width: 50 }} />
          </colgroup>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Checkbox
                  size="sm"
                  aria-label="Select all filtered analyses"
                  checked={allDisplayedSelected}
                  indeterminate={someDisplayedSelected && !allDisplayedSelected}
                  onChange={toggleAllDisplayed}
                />
              </Table.Th>
              {visibleColumns.map((column) => (
                <Table.Th key={column} pos="relative" style={{ overflow: "visible" }}>
                  <HeaderMenu
                    column={column}
                    sort={sort}
                    filters={filters}
                    folderOptions={folderOptions}
                    quantityOptions={quantityOptions}
                    setFilters={setFilters}
                    setSort={setSort}
                  />
                  <Box
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={(event) => beginResize(column, event)}
                    style={{
                      position: "absolute",
                      top: 0,
                      right: -4,
                      width: 8,
                      height: "100%",
                      cursor: "col-resize",
                      zIndex: 2,
                    }}
                  />
                </Table.Th>
              ))}
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {displayed.map((analysis) => (
              <Table.Tr
                key={analysis.id}
                onClick={(event) => onOpen(analysis, event.ctrlKey || event.metaKey)}
                style={{
                  cursor: "pointer",
                  background: analysis.sources_changed ? "rgba(18, 184, 134, 0.045)" : undefined,
                }}
              >
                <Table.Td onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    size="sm"
                    aria-label={`Select ${analysis.title}`}
                    checked={selected.has(analysis.id)}
                    onChange={() => undefined}
                    onClick={(event) => toggleSelection(analysis.id, event.shiftKey)}
                  />
                </Table.Td>
                {visible.title && (
                  <Table.Td>
                    <Group gap={8} wrap="nowrap">
                      {analysis.sources_changed && (
                        <Tooltip label="A source file changed. Open the analysis to review the refreshed results.">
                          <Box
                            aria-label="Sources updated"
                            w={7}
                            h={7}
                            bg="var(--mantine-primary-color-6)"
                            style={{ borderRadius: "50%", flexShrink: 0 }}
                          />
                        </Tooltip>
                      )}
                      <Text size="sm" fw={analysis.sources_changed ? 700 : 500} truncate>
                        {analysis.title}
                      </Text>
                      {openIds.has(analysis.id) ? (
                        <Tooltip label="Open in analysis workspace">
                          <IconLayoutSidebarRight
                            aria-label="Open analysis"
                            size={15}
                            color="var(--mantine-primary-color-6)"
                            style={{ flexShrink: 0 }}
                          />
                        </Tooltip>
                      ) : null}
                    </Group>
                  </Table.Td>
                )}
                {visible.samples && <Table.Td><SampleSummary analysis={analysis} onPreview={setSamplePreview} /></Table.Td>}
                {visible.plots && <Table.Td><PlotSummary analysis={analysis} onOpenPlot={onOpenPlot} /></Table.Td>}
                {visible.folder && (
                  <Table.Td>
                    {analysis.folder ? (
                      <UnstyledButton
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenFolder(analysis.folder!.id);
                        }}
                        style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "100%" }}
                      >
                        <IconFolder size={14} color="var(--mantine-primary-color-6)" />
                        <Text size="sm" td="underline" truncate>{analysis.folder.name}</Text>
                      </UnstyledButton>
                    ) : <Text size="sm" c="dimmed">No folder</Text>}
                  </Table.Td>
                )}
                {visible.created && <Table.Td><Text size="xs" c="dimmed">{formatDate(analysis.created_at)}</Text></Table.Td>}
                {visible.modified && <Table.Td><Text size="xs" c="dimmed">{formatDate(analysis.modified_at)}</Text></Table.Td>}
                <Table.Td onClick={(event) => event.stopPropagation()}>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${analysis.title}`}>
                        <IconDotsVertical size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => onRemove([analysis.id])}>
                        Remove
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {displayed.length === 0 && (
        <Text size="sm" c="dimmed" ta="center" py="lg">No analyses match the current filters.</Text>
      )}
      <AnalysisSamplePreviewModal selection={samplePreview} onClose={() => setSamplePreview(null)} />
    </Stack>
  );
}
