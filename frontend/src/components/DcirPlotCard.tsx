import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Collapse,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import Plotly from "plotly.js-dist-min";
import { useMemo, useState } from "react";

import {
  post,
  type AnalysisSpec,
  type CellSummary,
  type DcirSegment,
  type DcirSegmentTarget,
  type DcirSeriesSpec,
  type DcirViewSpec,
  type FileProtocol,
  type PlotExportFormat,
  type ProtocolSegment,
} from "../api";
import { saveDownload } from "../downloads";
import {
  currentPlotStyle,
  downloadDataExport,
  plotPalette,
  PlotHeader,
  PlotStylePanel,
  tracesToColumns,
} from "../pages/AnalysisPage";
import Plot from "./Plot";
import {
  ProtocolSegmentsPanel,
  type ProtocolSegmentSuggestion,
} from "./ProtocolSegmentsPanel";

interface DcirCandidate extends DcirSegmentTarget {
  id: string;
  label: string;
  rest_pulse_ratio: number;
  compatible_cell_ids: number[];
  compatible_cell_names: string[];
}

interface DcirProtocolFamily {
  signature: string;
  protocol: FileProtocol;
  cell_ids: number[];
  cell_names: string[];
  files: { cell_id: number; cell_name: string; filename: string }[];
}

interface DcirProtocolResult {
  protocols: DcirProtocolFamily[];
  candidates: DcirCandidate[];
}

export interface DcirResultSeries {
  series_id: string;
  cell_id: number;
  cell_name: string;
  segment_id: string;
  segment_name: string;
  label: string;
  direction: "charge" | "discharge" | null;
  c_rate: number | null;
  current_ma: number | null;
  x_occurrence: number[];
  x_cycle: (number | null)[];
  x_time: (number | null)[];
  quantities: {
    dcir_mohm: (number | null)[];
    dcir_change_pct: (number | null)[];
  };
  n_measurements: number;
}

export interface DcirResult {
  cell_series: DcirResultSeries[];
  badges: { kind: string; series_id?: string; detail: string }[];
}

const DEFAULT_VIEW: DcirViewSpec = {
  quantity: "absolute",
  x_axis: "occurrence",
  candidate_filter: {
    min_rest_s: 600,
    max_pulse_s: 120,
    min_ratio: 10,
  },
};

function uid(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random()}`;
}

export function dcirViewFor(spec: AnalysisSpec): DcirViewSpec {
  return {
    ...DEFAULT_VIEW,
    ...(spec.presentation.dcir_view ?? {}),
    candidate_filter: {
      ...DEFAULT_VIEW.candidate_filter,
      ...(spec.presentation.dcir_view?.candidate_filter ?? {}),
    },
  };
}

function seriesFor(spec: AnalysisSpec): DcirSeriesSpec[] {
  return Array.isArray(spec.computation.dcir?.series)
    ? spec.computation.dcir!.series
    : [];
}

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown duration";
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Number(seconds.toPrecision(4))} s`;
}

export function dcirXTitle(axis: DcirViewSpec["x_axis"]) {
  if (axis === "cycle") return "Cycle";
  if (axis === "time") return "Elapsed time at rest start (h)";
  return "DCIR occurrence";
}

export function dcirTracesForResult(
  result: DcirResult,
  spec: AnalysisSpec,
): Plotly.Data[] {
  const view = dcirViewFor(spec);
  const style = currentPlotStyle(spec, "dcir");
  const palette = plotPalette(style);
  const yColumn = view.quantity === "relative" ? "dcir_change_pct" : "dcir_mohm";
  const yTitle = view.quantity === "relative" ? "DCIR change from first (%)" : "DCIR (mΩ)";
  const defaultXTitle = dcirXTitle(view.x_axis);
  const mode =
    style.marker_mode === "none"
      ? "lines"
      : style.marker_mode === "points"
        ? "markers"
        : "lines+markers";
  return (result.cell_series ?? [])
    .filter((item) => item.n_measurements > 0)
    .map((item, index) => {
      const color =
        style.custom_colors[`dcir-${item.series_id}`] ??
        palette[index % palette.length];
      const x =
        view.x_axis === "cycle"
          ? item.x_cycle
          : view.x_axis === "time"
            ? item.x_time
            : item.x_occurrence;
      return {
        type: "scatter",
        mode,
        x,
        y: item.quantities[yColumn],
        name: item.label,
        line: { color, width: style.line_width, dash: style.line_dash },
        marker: { color, size: style.marker_size },
        customdata: x.map(() => [item.direction, item.c_rate, item.current_ma]),
        hovertemplate:
          `%{fullData.name}<br>${defaultXTitle}: %{x}<br>${yTitle}: %{y:.4g}` +
          "<extra></extra>",
      } as Plotly.Data;
    });
}

export function dcirLayoutForSpec(spec: AnalysisSpec): Partial<Plotly.Layout> {
  const view = dcirViewFor(spec);
  const style = currentPlotStyle(spec, "dcir");
  const yTitle = view.quantity === "relative" ? "DCIR change from first (%)" : "DCIR (mΩ)";
  const defaultXTitle = dcirXTitle(view.x_axis);
  return {
    margin: { l: 72, r: 20, t: 12, b: 56 },
    xaxis: {
      title: { text: style.x_title ?? defaultXTitle },
      showgrid: style.show_grid,
      zeroline: style.show_zero_line,
    },
    yaxis: {
      title: { text: style.y_title ?? yTitle },
      showgrid: style.show_grid,
      zeroline: style.show_zero_line,
    },
    showlegend: spec.presentation.legend,
    legend: { orientation: "h", y: -0.22 },
    hovermode: "closest",
    paper_bgcolor: style.paper_bgcolor,
    plot_bgcolor: style.plot_bgcolor,
  };
}

export function useDcirResult(
  analysisId: number,
  spec: AnalysisSpec,
) {
  const series = seriesFor(spec);
  const signature = useMemo(
    () =>
      JSON.stringify({
        selection: spec.selection,
        segments: spec.dcir_segments ?? [],
        series,
      }),
    [spec.selection, spec.dcir_segments, series]
  );
  return useQuery({
    queryKey: ["dcir", analysisId, signature],
    queryFn: () => post<DcirResult>(`/api/analyses/${analysisId}/dcir`, { spec }),
    enabled: series.length > 0,
    staleTime: 5 * 60_000,
  });
}

function useDcirProtocols(analysisId: number, spec: AnalysisSpec) {
  const filter = dcirViewFor(spec).candidate_filter;
  const signature = JSON.stringify({ selection: spec.selection, filter });
  return useQuery({
    queryKey: ["dcir-protocols", analysisId, signature],
    queryFn: () =>
      post<DcirProtocolResult>(`/api/analyses/${analysisId}/dcir-protocols`, {
        spec,
        ...filter,
      }),
    staleTime: 5 * 60_000,
  });
}

function targetFromSteps(
  family: DcirProtocolFamily,
  stepIndices: number[],
): DcirSegmentTarget | null {
  if (stepIndices.length !== 2) return null;
  const [restStep, pulseStep] = [...stepIndices].sort((a, b) => a - b);
  const rest = family.protocol.steps.find((step) => step.number === restStep);
  const pulse = family.protocol.steps.find((step) => step.number === pulseStep);
  if (!rest || !pulse || rest.direction !== "rest") return null;
  if (pulse.direction !== "charge" && pulse.direction !== "discharge") return null;
  const executable = family.protocol.steps.filter(
    (step) => step.direction !== "control"
  );
  const restPosition = executable.findIndex((step) => step.number === rest.number);
  if (restPosition < 0 || executable[restPosition + 1]?.number !== pulse.number) {
    return null;
  }
  return {
    protocol_signature: family.signature,
    rest_step_index: rest.number,
    pulse_step_index: pulse.number,
    direction: pulse.direction,
    current_ma: pulse.current_ma,
    c_rate: pulse.c_rate,
    rest_duration_s: rest.time_limit_s,
    pulse_duration_s: pulse.time_limit_s,
  };
}

/**
 * A protocol-independent identity for a rest/pulse pairing, so the same DCIR
 * pair cannot be filed twice under different segment ids (e.g. picked once from
 * the suggestions and once by hand). Order within and across targets is
 * normalised so two spellings of the same selection compare equal.
 */
function dcirTargetKey(
  targets: { protocol_signature: string; step_indices: number[] }[],
): string {
  return targets
    .map(
      (target) =>
        `${target.protocol_signature}:${[...target.step_indices]
          .sort((a, b) => a - b)
          .join(",")}`
    )
    .sort()
    .join("|");
}

function dcirSegmentTargetKey(segment: DcirSegment): string {
  return dcirTargetKey(
    segment.targets.map((target) => ({
      protocol_signature: target.protocol_signature,
      step_indices: [target.rest_step_index, target.pulse_step_index],
    }))
  );
}

function validateDcirSegment(
  segment: ProtocolSegment,
  families: DcirProtocolFamily[],
  existing: DcirSegment[],
): string | null {
  if (segment.targets.length === 0) {
    return "Select one rest step and the pulse that follows it.";
  }
  for (const target of segment.targets) {
    const family = families.find(
      (item) => item.signature === target.protocol_signature
    );
    if (!family) {
      return "One selected protocol is no longer available.";
    }
    if (!targetFromSteps(family, target.step_indices)) {
      return (
        "Each DCIR target must contain exactly one rest step and the immediately " +
        "following charge or discharge pulse."
      );
    }
  }
  const key = dcirTargetKey(segment.targets);
  const clash = existing.find(
    (item) => item.id !== segment.id && dcirSegmentTargetKey(item) === key
  );
  if (clash) {
    return `This rest/pulse pair is already saved as "${clash.name}".`;
  }
  return null;
}

function toDcirSegment(
  segment: ProtocolSegment,
  families: DcirProtocolFamily[],
): DcirSegment | null {
  const targets = segment.targets.flatMap((target) => {
    const family = families.find(
      (item) => item.signature === target.protocol_signature
    );
    const converted = family
      ? targetFromSteps(family, target.step_indices)
      : null;
    return converted ? [converted] : [];
  });
  if (targets.length !== segment.targets.length) return null;
  return { id: segment.id, name: segment.name, targets };
}

export function DcirSettings({
  analysisId,
  spec,
  cells,
  update,
}: {
  analysisId: number;
  spec: AnalysisSpec;
  cells: Pick<CellSummary, "id" | "name">[];
  update: (fn: (draft: AnalysisSpec) => void) => void;
}) {
  const view = dcirViewFor(spec);
  const segments = spec.dcir_segments ?? [];
  const series = seriesFor(spec);
  const protocols = useDcirProtocols(analysisId, spec);
  const result = useDcirResult(analysisId, spec);
  const unmatched = new Set(
    (result.data?.badges ?? [])
      .filter((badge) => badge.kind === "dcir_no_match" && badge.series_id)
      .map((badge) => badge.series_id!)
  );
  const protocolFamilies = protocols.data?.protocols ?? [];
  const protocolSegments = useMemo<ProtocolSegment[]>(
    () =>
      segments.map((segment) => ({
        id: segment.id,
        name: segment.name,
        targets: segment.targets.map((target) => ({
          protocol_signature: target.protocol_signature,
          step_indices: [target.rest_step_index, target.pulse_step_index],
        })),
      })),
    [segments]
  );
  const suggestions = useMemo<ProtocolSegmentSuggestion[]>(
    () =>
      (protocols.data?.candidates ?? []).map((candidate) => ({
        id: candidate.id,
        label: `${candidate.label} · steps ${candidate.rest_step_index} → ${candidate.pulse_step_index}`,
        description:
          `${formatDuration(candidate.rest_duration_s)} rest → ` +
          `${formatDuration(candidate.pulse_duration_s)} pulse · ` +
          `${candidate.rest_pulse_ratio.toFixed(1)}:1 · ` +
          `${candidate.compatible_cell_ids.length} matching selected ` +
          `cell${candidate.compatible_cell_ids.length === 1 ? "" : "s"}`,
        segment: {
          id: `suggested-${candidate.id}`,
          name: candidate.label,
          targets: [
            {
              protocol_signature: candidate.protocol_signature,
              step_indices: [
                candidate.rest_step_index,
                candidate.pulse_step_index,
              ],
            },
          ],
        },
      })),
    [protocols.data?.candidates]
  );

  const patchView = (patch: Partial<DcirViewSpec>) =>
    update((draft) => {
      draft.presentation.dcir_view = {
        ...DEFAULT_VIEW,
        ...(draft.presentation.dcir_view ?? {}),
        candidate_filter: {
          ...DEFAULT_VIEW.candidate_filter,
          ...(draft.presentation.dcir_view?.candidate_filter ?? {}),
          ...(patch.candidate_filter ?? {}),
        },
        ...patch,
      };
    });

  const writeSeries = (next: DcirSeriesSpec[]) =>
    update((draft) => {
      draft.computation.dcir = { series: next };
    });

  const [seriesCollapsed, setSeriesCollapsed] = useState(false);
  const [editor, setEditor] = useState<{
    open: boolean;
    id: string | null;
    cellId: number | null;
    segmentId: string | null;
    error: string | null;
  }>({ open: false, id: null, cellId: null, segmentId: null, error: null });

  // Colour each series row with the exact swatch the plot draws for it: the
  // plot palettes by the order of drawable (n_measurements > 0) result series,
  // so the dot only matches if it reads that same order rather than the spec's.
  const seriesColor = useMemo(() => {
    const style = currentPlotStyle(spec, "dcir");
    const palette = plotPalette(style);
    const map = new Map<string, string>();
    (result.data?.cell_series ?? [])
      .filter((item) => item.n_measurements > 0)
      .forEach((item, index) => {
        map.set(
          item.series_id,
          style.custom_colors[`dcir-${item.series_id}`] ??
            palette[index % palette.length]
        );
      });
    return map;
  }, [result.data, spec]);

  const openSeriesEditor = (item: DcirSeriesSpec | null) =>
    setEditor({
      open: true,
      id: item?.id ?? null,
      cellId: item?.cell_id ?? cells[0]?.id ?? null,
      segmentId: item?.segment_id ?? segments[0]?.id ?? null,
      error: null,
    });

  const closeSeriesEditor = () =>
    setEditor((current) => ({ ...current, open: false, error: null }));

  const saveSeriesEditor = () => {
    if (editor.cellId == null || !editor.segmentId) return;
    const duplicate = series.some(
      (entry) =>
        entry.id !== editor.id &&
        entry.cell_id === editor.cellId &&
        entry.segment_id === editor.segmentId
    );
    if (duplicate) {
      setEditor((current) => ({
        ...current,
        error: "This cell and DCIR segment pair is already a series.",
      }));
      return;
    }
    if (editor.id) {
      writeSeries(
        series.map((entry) =>
          entry.id === editor.id
            ? { ...entry, cell_id: editor.cellId!, segment_id: editor.segmentId! }
            : entry
        )
      );
    } else {
      writeSeries([
        ...series,
        { id: uid("dcir-series"), cell_id: editor.cellId!, segment_id: editor.segmentId! },
      ]);
    }
    closeSeriesEditor();
  };

  const applySegment = (
    segment: DcirSegment,
    compatibleCellIds: number[],
    addMatching: boolean,
    isNew: boolean,
  ) => {
    update((draft) => {
      const existing = draft.dcir_segments ?? [];
      draft.dcir_segments = existing.some((item) => item.id === segment.id)
        ? existing.map((item) => (item.id === segment.id ? segment : item))
        : [...existing, segment];
      const current = draft.computation.dcir?.series ?? [];
      if (isNew) {
        const ids = addMatching
          ? compatibleCellIds
          : compatibleCellIds.slice(0, 1);
        const additions = ids
          .filter((cellId) =>
            !current.some(
              (item) => item.cell_id === cellId && item.segment_id === segment.id
            )
          )
          .map((cellId) => ({
            id: uid("dcir-series"),
            cell_id: cellId,
            segment_id: segment.id,
          }));
        draft.computation.dcir = { series: [...current, ...additions] };
      }
    });
  };

  const saveProtocolSegment = (segment: ProtocolSegment) => {
    const converted = toDcirSegment(segment, protocolFamilies);
    if (!converted) return;
    const isNew = !segments.some((item) => item.id === segment.id);
    const compatibleCellIds = [
      ...new Set(
        converted.targets.flatMap(
          (target) =>
            protocolFamilies.find(
              (family) => family.signature === target.protocol_signature
            )?.cell_ids ?? []
        )
      ),
    ];
    if (!isNew || compatibleCellIds.length <= 1) {
      applySegment(converted, compatibleCellIds, false, isNew);
      return;
    }
    modals.openConfirmModal({
      title: "Add matching cell series?",
      children: (
        <Text size="sm">
          This protocol is shared by {compatibleCellIds.length} selected cells. Add a DCIR
          series for every matching cell?
        </Text>
      ),
      labels: { confirm: "Add all matching cells", cancel: "Add first cell only" },
      onConfirm: () => applySegment(converted, compatibleCellIds, true, true),
      onCancel: () => applySegment(converted, compatibleCellIds, false, true),
    });
  };

  return (
    <Stack gap="xs">
      <ProtocolSegmentsPanel
        cellIds={cells.map((cell) => cell.id)}
        segments={protocolSegments}
        hiddenSegmentIds={[]}
        excludedSegmentIds={[]}
        onlySegmentIds={[]}
        onSaveSegment={saveProtocolSegment}
        onDeleteSegment={(segmentId) =>
          update((draft) => {
            draft.dcir_segments = (draft.dcir_segments ?? []).filter(
              (item) => item.id !== segmentId
            );
            draft.computation.dcir = {
              series: (draft.computation.dcir?.series ?? []).filter(
                (item) => item.segment_id !== segmentId
              ),
            };
          })
        }
        onToggleHidden={() => undefined}
        onToggleExcluded={() => undefined}
        onUseOnly={() => undefined}
        title="DCIR segments"
        subtitle="Private to this tab"
        emptyText="No DCIR segments. Add one to select a rest and pulse pair."
        showPlotControls={false}
        showSuggestions
        suggestions={suggestions}
        suggestionsLoading={protocols.isLoading}
        suggestionsError={protocols.isError}
        validateSegment={(segment) =>
          validateDcirSegment(segment, protocolFamilies, segments)
        }
      />

      <Paper p="sm" withBorder>
        <Group justify="space-between" mb={seriesCollapsed ? 0 : "xs"} wrap="nowrap">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={seriesCollapsed ? "Expand series" : "Collapse series"}
              onClick={() => setSeriesCollapsed((value) => !value)}
            >
              {seriesCollapsed ? (
                <IconChevronRight size={16} />
              ) : (
                <IconChevronDown size={16} />
              )}
            </ActionIcon>
            <Text fw={700} size="sm">DCIR series</Text>
            {series.length > 0 && (
              <Badge size="xs" variant="light" color="gray">
                {series.length}
              </Badge>
            )}
          </Group>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            disabled={!cells.length || !segments.length}
            onClick={() => openSeriesEditor(null)}
          >
            Add series
          </Button>
        </Group>
        <Collapse in={!seriesCollapsed}>
          {series.length === 0 ? (
            <Text size="xs" c="dimmed">
              Each cell and DCIR segment pair becomes one independent line.
            </Text>
          ) : (
            <ScrollArea.Autosize mah={280} type="auto" offsetScrollbars>
              <Stack gap={4} pr={4}>
                {series.map((item) => {
                  const cellName =
                    cells.find((cell) => cell.id === item.cell_id)?.name ??
                    `Cell ${item.cell_id}`;
                  const segmentName =
                    segments.find((segment) => segment.id === item.segment_id)?.name ??
                    "Unknown segment";
                  const noMatch = unmatched.has(item.id);
                  return (
                    <Group
                      key={item.id}
                      gap={8}
                      wrap="nowrap"
                      justify="space-between"
                      style={{
                        border: "1px solid var(--mantine-color-gray-2)",
                        borderRadius: 6,
                        padding: "5px 8px",
                      }}
                    >
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            flexShrink: 0,
                            background:
                              seriesColor.get(item.id) ??
                              "var(--mantine-color-gray-4)",
                          }}
                        />
                        <Box style={{ minWidth: 0 }}>
                          <Text size="xs" fw={600} truncate>
                            {cellName}
                          </Text>
                          <Text
                            size="10px"
                            c={noMatch ? "red" : "dimmed"}
                            truncate
                          >
                            {segmentName}
                            {noMatch ? " · no match" : ""}
                          </Text>
                        </Box>
                      </Group>
                      <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label="Edit DCIR series"
                          onClick={() => openSeriesEditor(item)}
                        >
                          <IconPencil size={14} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="sm"
                          aria-label="Remove DCIR series"
                          onClick={() =>
                            writeSeries(series.filter((entry) => entry.id !== item.id))
                          }
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Group>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Collapse>
      </Paper>

      <Modal
        opened={editor.open}
        onClose={closeSeriesEditor}
        title={editor.id ? "Edit DCIR series" : "Add DCIR series"}
        centered
        size="sm"
      >
        <Stack gap="sm">
          <Select
            label="Cell"
            searchable
            data={cells.map((cell) => ({
              value: String(cell.id),
              label: cell.name,
            }))}
            value={editor.cellId != null ? String(editor.cellId) : null}
            onChange={(value) =>
              setEditor((current) => ({
                ...current,
                cellId: value ? Number(value) : null,
                error: null,
              }))
            }
          />
          <Select
            label="DCIR segment"
            data={segments.map((segment) => ({
              value: segment.id,
              label: segment.name,
            }))}
            value={editor.segmentId}
            onChange={(value) =>
              setEditor((current) => ({
                ...current,
                segmentId: value,
                error: null,
              }))
            }
          />
          {editor.error && (
            <Text size="xs" c="red">
              {editor.error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={closeSeriesEditor}>
              Cancel
            </Button>
            <Button
              onClick={saveSeriesEditor}
              disabled={editor.cellId == null || !editor.segmentId}
            >
              {editor.id ? "Save changes" : "Add series"}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Paper p="sm" withBorder>
        <Text fw={700} size="sm" mb="xs">Plot settings</Text>
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={500} mb={4}>Value</Text>
            <SegmentedControl
              fullWidth
              size="xs"
              value={view.quantity}
              data={[
                { value: "absolute", label: "DCIR (mΩ)" },
                { value: "relative", label: "Change (%)" },
              ]}
              onChange={(value) =>
                patchView({ quantity: value as DcirViewSpec["quantity"] })
              }
            />
          </Box>
          <Select
            label="X axis"
            value={view.x_axis}
            data={[
              { value: "occurrence", label: "Occurrence" },
              { value: "cycle", label: "Cycle" },
              { value: "time", label: "Elapsed time" },
            ]}
            onChange={(value) =>
              value && patchView({ x_axis: value as DcirViewSpec["x_axis"] })
            }
          />
          <Divider label="Candidate recognition" labelPosition="left" />
          <NumberInput
            label="Minimum rest"
            description="Seconds"
            min={1}
            value={view.candidate_filter.min_rest_s}
            onChange={(value) =>
              typeof value === "number" &&
              patchView({
                candidate_filter: {
                  ...view.candidate_filter,
                  min_rest_s: value,
                },
              })
            }
          />
          <NumberInput
            label="Maximum pulse"
            description="Seconds"
            min={0.1}
            value={view.candidate_filter.max_pulse_s}
            onChange={(value) =>
              typeof value === "number" &&
              patchView({
                candidate_filter: {
                  ...view.candidate_filter,
                  max_pulse_s: value,
                },
              })
            }
          />
          <NumberInput
            label="Minimum rest:pulse ratio"
            min={1}
            value={view.candidate_filter.min_ratio}
            onChange={(value) =>
              typeof value === "number" &&
              patchView({
                candidate_filter: {
                  ...view.candidate_filter,
                  min_ratio: value,
                },
              })
            }
          />
        </Stack>
      </Paper>

    </Stack>
  );
}

export function DcirPlotCard({
  analysisId,
  analysisTitle,
  plotName,
  spec,
  update,
}: {
  analysisId: number;
  analysisTitle: string;
  plotName: string;
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const view = dcirViewFor(spec);
  const style = currentPlotStyle(spec, "dcir");
  const result = useDcirResult(analysisId, spec);
  const series = seriesFor(spec);
  const yTitle = view.quantity === "relative" ? "DCIR change from first (%)" : "DCIR (mΩ)";
  const defaultXTitle = dcirXTitle(view.x_axis);
  const traces = useMemo(
    () => (result.data ? dcirTracesForResult(result.data, spec) : []),
    [result.data, spec]
  );
  const layout = useMemo(() => dcirLayoutForSpec(spec), [spec]);

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    if (!traces.length) return;
    try {
      const dataUrl = await (
        Plotly as unknown as {
          toImage: (figure: unknown, options: unknown) => Promise<string>;
        }
      ).toImage(
        { data: traces, layout: { ...layout, title: { text: plotName } } },
        { format: format === "pdf" ? "svg" : format, width: 1000, height: 600, scale: 2 }
      );
      const blob = await (await fetch(dataUrl)).blob();
      await saveDownload(blob, `${baseName}.${format === "pdf" ? "svg" : format}`);
    } catch (error) {
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : "Plot export failed.",
      });
    }
  };

  const dataExport = async (baseName: string) => {
    try {
      await downloadDataExport(tracesToColumns(traces, layout), style, baseName);
    } catch (error) {
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : "Data export failed.",
      });
    }
  };

  return (
    <Group align="stretch" wrap="nowrap">
      <Paper
        p="sm"
        withBorder
        style={{ minHeight: 590, position: "relative", flex: 1, minWidth: 520, overflow: "hidden" }}
      >
        <LoadingOverlay
          visible={result.isFetching && traces.length === 0}
          overlayProps={{ blur: 1.5, backgroundOpacity: 0.18 }}
          loaderProps={{ size: "sm", color: "teal" }}
        />
        <PlotHeader
          analysisTitle={analysisTitle}
          tabName="DCIR"
          plotName={plotName}
          subtitle={`${yTitle} vs ${defaultXTitle.toLowerCase()}`}
          quantityName={yTitle}
          xAxisName={style.x_title ?? defaultXTitle}
          sampleSummary={`${traces.length} ${traces.length === 1 ? "series" : "series"}`}
          onExport={exportPlot}
          onDataExport={dataExport}
          style={style}
          updateStyle={(fn) =>
            update((draft) => {
              const styles = ((draft.presentation as Record<string, unknown>).plot_styles ??=
                {}) as Record<string, unknown>;
              const current = (styles.dcir ?? {}) as Record<string, unknown>;
              fn(current as never);
              styles.dcir = current;
            })
          }
          layout={layout}
          canExport={traces.length > 0}
        />
        {result.isError && (
          <Alert color="red">
            {(result.error as Error).message || "Could not compute DCIR."}
          </Alert>
        )}
        {(result.data?.badges ?? []).some((badge) => badge.kind === "dcir_no_match") && (
          <Alert color="yellow" py="xs" mb="xs">
            {(result.data?.badges ?? []).filter((badge) => badge.kind === "dcir_no_match").length}
            {" "}series did not contain the configured adjacent rest and pulse.
          </Alert>
        )}
        {!series.length ? (
          <Center h={480}>
            <Text size="sm" c="dimmed" ta="center" maw={400}>
              Add or detect a DCIR rest/pulse segment, then pair it with a cell. Each pair
              becomes an independent resistance line.
            </Text>
          </Center>
        ) : result.isLoading ? (
          <Center h={480}><Loader size="sm" /></Center>
        ) : !traces.length ? (
          <Center h={480}>
            <Text size="sm" c="dimmed">No valid DCIR occurrences were found.</Text>
          </Center>
        ) : (
          <>
            <Text size="xs" c="dimmed" mb={4}>
              Each point uses the final rest voltage, final pulse voltage, and median absolute
              pulse current.
            </Text>
            <Box style={{ width: "100%", minWidth: 0 }}>
              <Plot
                data={traces}
                layout={layout}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: "100%", height: 470 }}
                useResizeHandler
              />
            </Box>
          </>
        )}
      </Paper>
      <PlotStylePanel
        opened={stylePanelOpen}
        spec={spec}
        result={undefined}
        update={update}
        onToggle={() => setStylePanelOpen((open) => !open)}
        axisScope="dcir"
      />
    </Group>
  );
}
