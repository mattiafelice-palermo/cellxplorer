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
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import Plotly from "plotly.js-dist-min";
import { useCallback, useMemo, useRef, useState } from "react";

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
  type PlotStyle,
  type ProtocolSegment,
  type SeriesStyleOverride,
  type SeriesStyleRule,
} from "../../../../../api";
import {
  axisTitleFont,
  plotAxisStyle,
  plotLayoutStyle,
} from "../../plotting/plotLayout";
import {
  downloadDataExport,
  downloadStyledPlotExport,
  styledPlotExportPreview,
  tracesToColumns,
} from "../../plotting/plotExport";
import { PlotHeader } from "../../plotting/PlotHeader";
import { PlotStylePanel } from "../../plotting/PlotStylePanel";
import { usePlotSizeSync } from "../../plotting/plotRuntime";
import {
  currentPlotStyle,
  markerSymbol,
  plotPalette,
} from "../../plotting/plotStyle";
import {
  isAnalysisSegmentHidden,
  isCellHiddenInAnalysis,
  isSeriesHidden,
} from "../../policies/analysisVisibility";
import {
  decimatePreviewTraces,
  resolveSeriesStyle,
  seriesLegendRanks,
  seriesPlotlyMode,
  seriesPlotlySymbol,
  type SeriesDescriptor,
} from "../../plotting/seriesStyling";
import {
  clearRecognitionToken,
  newRecognitionToken,
  setRecognitionToken,
  useDelayedRecognitionProgress,
  useSharedRecognitionToken,
} from "../../recognition/recognitionProgress";
import { paletteColorAt, paletteOverflowMode } from "../../plotting/paletteDraft";
import Plot from "../../../../../components/Plot";
import {
  ProtocolSegmentsPanel,
  type ProtocolSegmentSuggestion,
} from "../../protocol/ProtocolSegmentsPanel";
import { RecognitionProgress } from "../../recognition/RecognitionProgress.tsx";
import { groupSuggestionsByFamily } from "../../protocol/suggestionGrouping";
import { groupCellsByApplicability } from "./suggestionGrouping";

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
  data_signature?: string;
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

/**
 * The series that actually draw: they have measurements and none of the three
 * visibility layers (cell hidden in the sidebar, DCIR segment hidden, or this
 * line individually hidden) is switched off. The plot and the sidebar row
 * swatches both palette over this list so their colours stay in lock-step.
 */
export function dcirVisibleSeries(
  result: DcirResult,
  spec: AnalysisSpec,
): DcirResultSeries[] {
  return (result.cell_series ?? []).filter(
    (item) =>
      item.n_measurements > 0 &&
      !isCellHiddenInAnalysis(spec, item.cell_id) &&
      !isAnalysisSegmentHidden(spec, item.segment_id) &&
      !isSeriesHidden(spec, item.series_id)
  );
}

/**
 * Per-series appearance descriptors for the style editor. Maps DCIR result
 * series to their stable keys and display labels.
 */
export function dcirSeriesDescriptors(items: DcirResultSeries[]): SeriesDescriptor[] {
  return items.map((item) => ({
    key: `dcir-${item.series_id}`,
    kind: "cell",
    label: item.label,
    cellName: item.cell_name,
    groupName: null,
  }));
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
  const visibleSeries = dcirVisibleSeries(result, spec);
  const descriptors = dcirSeriesDescriptors(visibleSeries);
  const legendRanks = seriesLegendRanks(descriptors, style.series_order);
  const paletteOverflow = paletteOverflowMode(style.palette_overflow_mode);
  return visibleSeries
    .map((item, index) => {
      const descriptor = descriptors[index];
      const color =
        style.custom_colors[`dcir-${item.series_id}`] ??
        paletteColorAt(palette, index, paletteOverflow);
      const baseStyle = {
        color,
        lineWidth: style.line_width,
        lineDash: style.line_dash,
        markerMode: style.marker_mode,
        markerSymbol: style.marker_symbol,
        markerSize: style.marker_size,
        markerOpen: style.marker_open,
        opacity: 1,
      };
      const resolved = resolveSeriesStyle(
        baseStyle,
        descriptor,
        style.series_rules,
        style.series_overrides
      );
      if (resolved.hidden) return null;
      const x =
        view.x_axis === "cycle"
          ? item.x_cycle
          : view.x_axis === "time"
            ? item.x_time
            : item.x_occurrence;
      return {
        type: "scatter",
        mode: seriesPlotlyMode(resolved),
        x,
        y: item.quantities[yColumn],
        name: resolved.name,
        showlegend: resolved.showInLegend,
        legendrank: legendRanks.get(descriptor.key),
        opacity: resolved.opacity,
        line: { color: resolved.color, width: resolved.lineWidth, dash: resolved.lineDash, shape: resolved.lineShape },
        marker: { color: resolved.color, size: resolved.markerSize, symbol: seriesPlotlySymbol(resolved) },
        customdata: x.map(() => [item.direction, item.c_rate, item.current_ma]),
        hovertemplate:
          `%{fullData.name}<br>${defaultXTitle}: %{x}<br>${yTitle}: %{y:.4g}` +
          "<extra></extra>",
      } as Plotly.Data;
    })
    .filter((trace): trace is Plotly.Data => trace !== null);
}

export function dcirLayoutForSpec(spec: AnalysisSpec): Partial<Plotly.Layout> {
  const view = dcirViewFor(spec);
  const style = currentPlotStyle(spec, "dcir");
  const yTitle = view.quantity === "relative" ? "DCIR change from first (%)" : "DCIR (mΩ)";
  const defaultXTitle = dcirXTitle(view.x_axis);
  return {
    ...plotLayoutStyle(style, spec),
    margin: { l: 72, r: 20, t: 12, b: 56 },
    xaxis: {
      ...plotAxisStyle(style, { axis: style.x_axis }),
      title: { text: style.x_title ?? defaultXTitle, font: axisTitleFont(style) },
    },
    yaxis: {
      ...plotAxisStyle(style, { zeroLine: true, axis: style.y_axis }),
      title: { text: style.y_title ?? yTitle, font: axisTitleFont(style) },
    },
    legend: { orientation: "h", y: -0.22, font: { size: style.legend_font_size } },
    hovermode: "closest",
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
        // Only the sample set (not display-only exclusions) changes the data,
        // so hiding a line or a cell filters client-side without a recompute.
        entries: spec.selection.entries,
        segments: spec.dcir_segments ?? [],
        series,
      }),
    [spec.selection.entries, spec.dcir_segments, series]
  );
  const tokenKey = `dcir:${analysisId}:${signature}`;
  const result = useQuery({
    queryKey: ["dcir", analysisId, signature],
    queryFn: async () => {
      const token = newRecognitionToken();
      setRecognitionToken(tokenKey, token);
      try {
        return await post<DcirResult>(`/api/analyses/${analysisId}/dcir`, {
          spec,
          job_token: token,
        });
      } finally {
        window.setTimeout(() => {
          clearRecognitionToken(tokenKey, token);
        }, 300);
      }
    },
    enabled: series.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const computeToken = useSharedRecognitionToken(
    result.isLoading || result.isFetching ? tokenKey : null,
  );
  return { ...result, computeToken };
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
  const protocolSignaturesByCell = useMemo(() => {
    const signatures = new Map<number, Set<string>>();
    for (const family of protocolFamilies) {
      for (const cellId of family.cell_ids) {
        const cellSignatures = signatures.get(cellId) ?? new Set<string>();
        cellSignatures.add(family.signature);
        signatures.set(cellId, cellSignatures);
      }
    }
    return signatures;
  }, [protocolFamilies]);
  const applicableSegments = (cellId: number | null) => {
    if (cellId == null) return [];
    const signatures = protocolSignaturesByCell.get(cellId);
    if (!signatures) return [];
    return segments.filter((segment) =>
      segment.targets.some((target) => signatures.has(target.protocol_signature))
    );
  };
  const firstValidPair = () => {
    for (const cell of cells) {
      const segment = applicableSegments(cell.id)[0];
      if (segment) return { cellId: cell.id, segmentId: segment.id };
    }
    return { cellId: cells[0]?.id ?? null, segmentId: null };
  };
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
      (protocols.data?.candidates ?? []).map((candidate) => {
        // Find the protocol family to get cell names
        const family = protocolFamilies.find(
          (f) => f.signature === candidate.protocol_signature
        );
        const cellNames = family?.cell_names ?? candidate.compatible_cell_names ?? [];
        return {
          id: candidate.id,
          label: `${candidate.label} · steps ${candidate.rest_step_index} → ${candidate.pulse_step_index}`,
          pairLabel: candidate.label,
          protocolSignature: candidate.protocol_signature,
          cellNames,
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
        };
      }),
    [protocols.data?.candidates, protocolFamilies]
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

  const toggleSeriesHidden = (seriesId: string) =>
    update((draft) => {
      const hidden = new Set(draft.presentation.hidden_series_ids ?? []);
      if (hidden.has(seriesId)) hidden.delete(seriesId);
      else hidden.add(seriesId);
      draft.presentation.hidden_series_ids = [...hidden];
    });

  const [seriesCollapsed, setSeriesCollapsed] = useState(false);
  const [editor, setEditor] = useState<{
    open: boolean;
    id: string | null;
    cellId: number | null;
    segmentId: string | null;
    error: string | null;
  }>({ open: false, id: null, cellId: null, segmentId: null, error: null });

  // Colour each series row with the exact swatch the plot draws for it. The
  // plot palettes over the *visible* series (drawable and not hidden by any
  // layer), so the dot only matches if it reads that same filtered order.
  const seriesColor = useMemo(() => {
    const style = currentPlotStyle(spec, "dcir");
    const palette = plotPalette(style);
    const paletteOverflow = paletteOverflowMode(style.palette_overflow_mode);
    const map = new Map<string, string>();
    (result.data ? dcirVisibleSeries(result.data, spec) : []).forEach(
      (item, index) => {
        map.set(
          item.series_id,
          style.custom_colors[`dcir-${item.series_id}`] ??
            paletteColorAt(palette, index, paletteOverflow)
        );
      });
    return map;
  }, [result.data, spec]);

  const openSeriesEditor = (item: DcirSeriesSpec | null) => {
    const fallback = firstValidPair();
    const cellId = item?.cell_id ?? fallback.cellId;
    const validSegments = applicableSegments(cellId);
    const segmentId =
      item && validSegments.some((segment) => segment.id === item.segment_id)
        ? item.segment_id
        : validSegments[0]?.id ?? fallback.segmentId;
    setEditor({
      open: true,
      id: item?.id ?? null,
      cellId,
      segmentId,
      error: null,
    });
  };

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
        hiddenSegmentIds={spec.presentation.hidden_analysis_segment_ids ?? []}
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
        onToggleHidden={(segmentId) =>
          update((draft) => {
            const hidden = new Set(draft.presentation.hidden_analysis_segment_ids ?? []);
            if (hidden.has(segmentId)) hidden.delete(segmentId);
            else hidden.add(segmentId);
            draft.presentation.hidden_analysis_segment_ids = [...hidden];
          })
        }
        onToggleExcluded={() => undefined}
        onUseOnly={() => undefined}
        title="DCIR segments"
        subtitle="Private to this tab"
        emptyText="No DCIR segments. Add one to select a rest and pulse pair."
        showPlotControls={false}
        showVisibilityToggle
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
            disabled={
              !cells.length ||
              !segments.length ||
              protocols.isLoading ||
              !cells.some((cell) => applicableSegments(cell.id).length > 0)
            }
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
            <Box className="cx-vertical-scroll" style={{ maxHeight: 280 }}>
              <Stack gap={4} pr={4}>
                {series.map((item) => {
                  const cellName =
                    cells.find((cell) => cell.id === item.cell_id)?.name ??
                    `Cell ${item.cell_id}`;
                  const segmentName =
                    segments.find((segment) => segment.id === item.segment_id)?.name ??
                    "Unknown segment";
                  const noMatch = unmatched.has(item.id);
                  const cellHidden = isCellHiddenInAnalysis(spec, item.cell_id);
                  const segmentHidden = isAnalysisSegmentHidden(spec, item.segment_id);
                  const selfHidden = isSeriesHidden(spec, item.id);
                  const hidden = cellHidden || segmentHidden || selfHidden;
                  const forcedHidden = cellHidden || segmentHidden;
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
                        opacity: hidden ? 0.5 : 1,
                      }}
                    >
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            flexShrink: 0,
                            background: hidden
                              ? "var(--mantine-color-gray-4)"
                              : seriesColor.get(item.id) ??
                                "var(--mantine-color-gray-4)",
                          }}
                        />
                        <Tooltip
                          label={`${cellName} — ${segmentName}`}
                          openDelay={400}
                          withArrow
                          multiline
                        >
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
                        </Tooltip>
                      </Group>
                      <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                        <Tooltip
                          label={
                            forcedHidden
                              ? "Hidden with its cell or segment"
                              : hidden
                                ? "Show series"
                                : "Hide series"
                          }
                          openDelay={300}
                          withArrow
                        >
                          <ActionIcon
                            variant="subtle"
                            color={hidden ? "gray" : "var(--mantine-primary-color-6)"}
                            size="sm"
                            aria-label={hidden ? "Show DCIR series" : "Hide DCIR series"}
                            onClick={() => toggleSeriesHidden(item.id)}
                          >
                            {hidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                          </ActionIcon>
                        </Tooltip>
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
            </Box>
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
            data={
              // Before protocol data arrives (loading or failed), show flat list of all cells
              // to avoid mis-grouping every cell as "Cells with no DCIR segment" while the
              // query is in flight.
              protocols.data
                ? groupCellsByApplicability(
                    cells,
                    new Map(
                      cells.map((cell) => [
                        cell.id,
                        applicableSegments(cell.id).length,
                      ])
                    )
                  )
                : cells.map((cell) => ({
                    value: String(cell.id),
                    label: cell.name,
                  }))
            }
            value={editor.cellId != null ? String(editor.cellId) : null}
            onChange={(value) =>
              setEditor((current) => {
                const cellId = value ? Number(value) : null;
                return {
                  ...current,
                  cellId,
                  segmentId: applicableSegments(cellId)[0]?.id ?? null,
                  error: null,
                };
              })
            }
          />
          <Select
            label="DCIR segment"
            data={applicableSegments(editor.cellId).map((segment) => ({
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
            disabled={editor.cellId == null || protocols.isLoading}
            description={
              editor.cellId != null &&
              !protocols.isLoading &&
              applicableSegments(editor.cellId).length === 0
                ? "No DCIR segments apply to this cell."
                : undefined
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
  edited = false,
  onNewPlot,
  newPlotEnabled = false,
  onUpdatePlot,
  updatePlotEnabled = false,
  updatePlotLabel = "Update",
}: {
  analysisId: number;
  analysisTitle: string;
  plotName: string;
  spec: AnalysisSpec;
  update: (fn: (draft: AnalysisSpec) => void) => void;
  edited?: boolean;
  onNewPlot?: () => void;
  newPlotEnabled?: boolean;
  onUpdatePlot?: () => void;
  updatePlotEnabled?: boolean;
  updatePlotLabel?: string;
}) {
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null);
  const plotDivRef = useRef<HTMLElement | null>(null);
  const { containerRef, sync: syncPlotSize } = usePlotSizeSync(plotDivRef);
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
  const recognitionProgress = useDelayedRecognitionProgress(
    result.computeToken,
    result.isLoading,
  );
  const plotUpdating = result.isFetching && traces.length > 0;
  const rememberPlotDiv = (graphDiv: unknown) => {
    const element = graphDiv as HTMLElement;
    plotDivRef.current = element;
    const rect = element.getBoundingClientRect();
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    setPlotSize((current) =>
      current && current.width === next.width && current.height === next.height
        ? current
        : next
    );
  };

  const visibleSeriesItems = useMemo(
    () => (result.data ? dcirVisibleSeries(result.data, spec) : []),
    [result.data, spec]
  );
  const seriesDescriptors = useMemo(
    () => dcirSeriesDescriptors(visibleSeriesItems),
    [visibleSeriesItems]
  );

  const buildSeriesPreview = useCallback(
    (draft: { overrides: Record<string, SeriesStyleOverride>; rules: SeriesStyleRule[]; styleOverlay?: Partial<PlotStyle> }) => {
      if (!result.data) return { data: [] as Plotly.Data[], layout: {} as Partial<Plotly.Layout> };
      const draftSpec: AnalysisSpec = {
        ...spec,
        presentation: {
          ...spec.presentation,
          plot_styles: {
            ...(spec.presentation.plot_styles ?? {}),
            dcir: {
              ...currentPlotStyle(spec, "dcir"),
              ...(draft.styleOverlay ?? {}),
              series_overrides: draft.overrides,
              series_rules: draft.rules,
            },
          },
        },
      };
      const data = decimatePreviewTraces(dcirTracesForResult(result.data, draftSpec));
      return { data, layout: dcirLayoutForSpec(draftSpec) };
    },
    [result.data, spec],
  );

  const exportPlot = async (format: PlotExportFormat, baseName: string) => {
    try {
      await downloadStyledPlotExport(
        traces,
        layout,
        style,
        plotName,
        format,
        baseName,
        plotSize,
      );
    } catch (error) {
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : "Plot export failed.",
      });
    }
  };

  const getExportPreview = () =>
    styledPlotExportPreview(traces, layout, style, plotName, plotSize);

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
          getExportPreview={getExportPreview}
          style={style}
          edited={edited}
          onNewPlot={onNewPlot}
          newPlotEnabled={newPlotEnabled}
          onUpdatePlot={onUpdatePlot}
          updatePlotEnabled={updatePlotEnabled}
          updatePlotLabel={updatePlotLabel}
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
          viewSize={plotSize}
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
          <Center h={480}>
            {recognitionProgress.show ? (
              <RecognitionProgress
                percent={recognitionProgress.percent}
                label={recognitionProgress.label}
                waiting={recognitionProgress.active && !recognitionProgress.job}
              />
            ) : null}
          </Center>
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
            <Box
              ref={containerRef}
              style={{
                width: "100%",
                minWidth: 0,
                opacity: plotUpdating ? 0.42 : 1,
                transition: "opacity 160ms ease",
              }}
            >
              <Plot
                data={traces}
                layout={layout}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: "100%", height: 470 }}
                useResizeHandler
                onInitialized={(_, graphDiv) => {
                  rememberPlotDiv(graphDiv);
                  syncPlotSize();
                }}
                onUpdate={(_, graphDiv) => {
                  rememberPlotDiv(graphDiv);
                  syncPlotSize();
                }}
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
        seriesDescriptors={seriesDescriptors}
        buildSeriesPreview={buildSeriesPreview}
      />
    </Group>
  );
}
