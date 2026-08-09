import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Menu,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconChevronDown, IconFileExport, IconShare3 } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import {
  AnalysisFull,
  AnalysisSpec,
  AnalysisTabKey,
  ApiError,
  CellSummary,
  get,
  PortableAnalysisEstimate,
  PortableSourcePreflight,
  PortableSourceUpdateResult,
  ReplicateGroupSummary,
  SavedAnalysisPlot,
  post,
  postBlob,
  put,
} from "../../../../api";
import { saveDownload, shareDownload } from "../../../../downloads";
import { sanitizeExportFilename } from "../../../../exportFilenames";
import { invalidateAnalysisQueries } from "../../workspace/analysisQueryCache";
import {
  CachedSavedPlotPreview,
  buildPortablePlotSnapshots,
  type PlotArtifact,
} from "../artifacts/SavedPlotPreviews";
import { specForSavedPlotView } from "../policies/analysisPlotPolicy";
import {
  multiSourceAnalysisPolicy,
  type SourceCountCell,
} from "../policies/multiSourceAnalysisPolicy";

export interface PortableReportFlowProps {
  analysisId: number;
  title: string;
  spec: AnalysisSpec | null;
  analysis?: AnalysisFull;
  availableCells?: Pick<CellSummary, "id" | "name" | "n_files">[];
  availableGroups?: ReplicateGroupSummary[];
  sourceCompatibilityPending: boolean;
  normalizeSpec: (input: AnalysisSpec) => AnalysisSpec;
  persistSpec: () => AnalysisSpec | null;
}

function formatPortableBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

const TAB_LABELS: Record<string, string> = {
  time_capacity: "Time / capacity",
  cycles: "Cycles",
  steps: "Steps",
  crate: "C-rate",
  chargeability: "Chargeability",
  dcir: "DCIR",
  recap: "Recap",
  settings: "Settings",
};

function tabLabel(tab: AnalysisTabKey): string {
  return TAB_LABELS[tab] ?? tab;
}

function selectedSourceCountCells(
  analysis: AnalysisFull,
  candidateSpec: AnalysisSpec,
  availableCells: Pick<CellSummary, "id" | "name" | "n_files">[] = [],
  availableGroups: ReplicateGroupSummary[] = [],
): SourceCountCell[] {
  const direct = new Map<number, SourceCountCell>(
    analysis.selection_cells.map((cell) => [cell.id, cell]),
  );
  for (const cell of availableCells) {
    if (!direct.has(cell.id)) {
      direct.set(cell.id, { id: cell.id, name: cell.name, source_count: cell.n_files });
    }
  }
  const groups = new Map<number, { cells: SourceCountCell[] }>();
  for (const group of analysis.selection_groups) {
    for (const cell of group.cells) {
      if (!direct.has(cell.id)) direct.set(cell.id, cell);
    }
    groups.set(group.id, { cells: group.cells });
  }
  for (const group of availableGroups) {
    groups.set(group.id, {
      cells: group.cells.map((cell) => {
        const resolved = direct.get(cell.id);
        return resolved ?? { id: cell.id, name: cell.name, source_count: null };
      }),
    });
  }
  const selected = new Map<number, SourceCountCell>();
  for (const entry of candidateSpec.selection.entries ?? []) {
    if (entry.kind === "cell") {
      const cell = direct.get(entry.ref_id) ?? {
        id: entry.ref_id,
        name: `Cell #${entry.ref_id}`,
        source_count: null,
      };
      selected.set(cell.id, cell);
      continue;
    }
    if (entry.kind === "replicate_group") {
      const group = groups.get(entry.ref_id);
      if (!group) {
        selected.set(-entry.ref_id, {
          id: -entry.ref_id,
          name: `Replicate group #${entry.ref_id}`,
          source_count: null,
        });
        continue;
      }
      for (const cell of group.cells) {
        const resolved = direct.get(cell.id) ?? cell;
        selected.set(resolved.id, resolved);
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.id - right.id);
}

function portableSpecForPlot(
  baseSpec: AnalysisSpec,
  plot: SavedAnalysisPlot,
  normalizeSpec: (input: AnalysisSpec) => AnalysisSpec,
): AnalysisSpec {
  return specForSavedPlotView(normalizeSpec(baseSpec), plot);
}

export function PortableReportFlow({
  analysisId,
  title,
  spec,
  analysis,
  availableCells,
  availableGroups,
  sourceCompatibilityPending,
  normalizeSpec,
  persistSpec,
}: PortableReportFlowProps) {
  const qc = useQueryClient();
  const [portableExportOpen, setPortableExportOpen] = useState(false);
  const [portableExportAction, setPortableExportAction] = useState<"download" | "share">("download");
  const [preparedPortableShare, setPreparedPortableShare] = useState<{
    blob: Blob;
    filename: string;
    title: string;
  } | null>(null);
  const [preparedShareBusy, setPreparedShareBusy] = useState(false);
  const [includePortableOriginals, setIncludePortableOriginals] = useState(false);
  const [portablePlotIds, setPortablePlotIds] = useState<string[]>([]);
  const [portableSourceDecision, setPortableSourceDecision] =
    useState<PortableSourcePreflight | null>(null);
  const [pendingPortableExport, setPendingPortableExport] = useState<{
    action: "download" | "share";
  } | null>(null);
  const [portableProgress, setPortableProgress] = useState<{
    completed: number;
    total: number;
    stage: string;
    phase: "plots" | "packing" | "done";
  } | null>(null);

  const portableEstimate = useQuery({
    queryKey: ["portable-analysis-estimate", analysisId],
    queryFn: () =>
      get<PortableAnalysisEstimate>(`/api/analyses/${analysisId}/portable-estimate`),
    enabled: portableExportOpen,
    staleTime: 30_000,
  });
  const portableSourcePreflight = useMutation({
    mutationFn: () =>
      post<PortableSourcePreflight>(
        `/api/analyses/${analysisId}/portable-source-preflight`,
        {},
      ),
  });

  const portableSavedPlots = spec?.saved_plots ?? [];
  const portablePlotOptions = portableSavedPlots.length
    ? portableSavedPlots
    : [
        {
          id: "current",
          name: title || "Current analysis",
          subtitle: "Current analysis view",
          tab: "cycles" as AnalysisTabKey,
        },
      ];
  const portablePlotPolicy = (plot: (typeof portablePlotOptions)[number]) => {
    if (!analysis || !spec) {
      return multiSourceAnalysisPolicy(plot.tab, []);
    }
    const plotSpec =
      "selection" in plot ? portableSpecForPlot(spec, plot, normalizeSpec) : spec;
    return multiSourceAnalysisPolicy(
      plot.tab,
      selectedSourceCountCells(analysis, plotSpec, availableCells, availableGroups),
    );
  };
  const portablePlotPolicies = portablePlotOptions.map((plot) => ({
    plot,
    policy: portablePlotPolicy(plot),
  }));
  const guardedPortablePlots = portablePlotPolicies.filter(
    ({ policy }) => policy.family && !policy.supported,
  );
  const exportablePortablePlotIds = portablePlotPolicies
    .filter(({ policy }) => !policy.family || policy.supported)
    .map(({ plot }) => plot.id);

  const portableExport = useMutation({
    mutationFn: async ({
      action,
      includeOriginalFiles,
    }: {
      action: "download" | "share";
      includeOriginalFiles: boolean;
    }) => {
      if (!spec) throw new Error("The analysis is not ready.");
      if (portablePlotIds.length === 0) throw new Error("Select at least one saved plot.");
      setPortableProgress({
        completed: 0,
        total: portablePlotIds.length,
        stage: "Preparing plots",
        phase: "plots",
      });
      const views = await buildPortablePlotSnapshots(
        analysisId,
        spec,
        title,
        portablePlotIds,
        (completed, total, stage) =>
          setPortableProgress({ completed, total, stage, phase: "plots" }),
        (plotId, signature) =>
          qc.getQueryData<PlotArtifact>([
            "plot-artifact",
            analysisId,
            plotId,
            signature,
          ]) ?? null,
      );
      setPortableProgress({
        completed: portablePlotIds.length,
        total: portablePlotIds.length,
        stage: includeOriginalFiles ? "Packing report and source files" : "Packing report",
        phase: "packing",
      });
      const blob = await postBlob(`/api/analyses/${analysisId}/portable-export`, {
        include_original_files: includeOriginalFiles,
        views,
      });
      setPortableProgress({
        completed: portablePlotIds.length,
        total: portablePlotIds.length,
        stage: "Report ready",
        phase: "done",
      });
      const filename = `${sanitizeExportFilename(title) || "CellXplorer analysis"}.html`;
      if (action === "share") {
        setPreparedPortableShare({
          blob,
          filename,
          title: title || "CellXplorer analysis",
        });
        return {
          cancelled: false,
          usedDefaultFolder: false,
          shared: false,
          prepared: true,
        };
      }
      return { ...(await saveDownload(blob, filename)), shared: false };
    },
    onSuccess: (result) => {
      setPortableProgress(null);
      if ("prepared" in result && result.prepared) {
        notifications.show({
          message: "Portable analysis ready. Open the Windows share sheet to continue.",
          color: "teal",
        });
        return;
      }
      if (!result.cancelled) {
        setPortableExportOpen(false);
        setPortableSourceDecision(null);
        setPendingPortableExport(null);
        notifications.show({
          message: result.shared
            ? "Portable analysis shared."
            : "shareFallback" in result && result.shareFallback
              ? "Windows sharing is unavailable, so the portable analysis was saved instead."
              : "Portable analysis exported.",
          color: "teal",
        });
      }
    },
    onError: (
      error: Error,
      variables: { action: "download" | "share"; includeOriginalFiles: boolean },
    ) => {
      setPortableProgress(null);
      if (
        variables.includeOriginalFiles &&
        error instanceof ApiError &&
        error.status === 409
      ) {
        setPendingPortableExport({ action: variables.action });
        void portableSourcePreflight
          .mutateAsync()
          .then(setPortableSourceDecision)
          .catch((preflightError: Error) =>
            notifications.show({ message: preflightError.message, color: "red" }),
          );
      }
      notifications.show({ message: error.message, color: "red" });
    },
  });

  const updatePortableSources = useMutation({
    mutationFn: (preflight: PortableSourcePreflight) =>
      post<PortableSourceUpdateResult>(
        `/api/analyses/${analysisId}/portable-source-update`,
        {
          sources: preflight.sources
            .filter(
              (source) =>
                source.status === "changed" &&
                source.expected_size !== null &&
                source.expected_mtime_ns !== null,
            )
            .map((source) => ({
              source_id: source.source_id,
              expected_size: source.expected_size,
              expected_mtime_ns: source.expected_mtime_ns,
            })),
        },
      ),
    onError: (error: Error) =>
      notifications.show({ message: error.message, color: "red" }),
  });

  const openPortableExport = (action: "download" | "share" = "download") => {
    if (sourceCompatibilityPending) {
      notifications.show({
        message:
          "Checking source compatibility. Portable export will be available when the selection is resolved.",
        color: "blue",
      });
      return;
    }
    setPortableExportAction(action);
    setPreparedPortableShare(null);
    setPreparedShareBusy(false);
    setPortableSourceDecision(null);
    setPendingPortableExport(null);
    setPortablePlotIds(exportablePortablePlotIds);
    setPortableExportOpen(true);
  };

  useEffect(() => {
    setPreparedPortableShare(null);
  }, [analysisId, includePortableOriginals, portablePlotIds.join("|"), title]);

  const sharePreparedPortable = () => {
    const prepared = preparedPortableShare;
    if (!prepared || preparedShareBusy) return;

    // Calling shareDownload directly in this click handler is intentional:
    // Windows WebView requires navigator.share() to retain this user gesture.
    const shareRequest = shareDownload(
      prepared.blob,
      prepared.filename,
      prepared.title,
      "CellXplorer portable battery analysis",
    );
    setPreparedShareBusy(true);
    void shareRequest
      .then(async (result) => {
        if (result === "cancelled") return;
        if (result === "unsupported") {
          const saved = await saveDownload(prepared.blob, prepared.filename);
          if (saved.cancelled) return;
          notifications.show({
            message: "Windows sharing is unavailable, so the portable analysis was saved instead.",
            color: "teal",
          });
        } else {
          notifications.show({ message: "Portable analysis shared.", color: "teal" });
        }
        setPortableExportOpen(false);
        setPreparedPortableShare(null);
      })
      .catch((error: Error) =>
        notifications.show({ message: error.message, color: "red" }),
      )
      .finally(() => setPreparedShareBusy(false));
  };

  const beginPortableExport = async (action: "download" | "share") => {
    if (!spec || portablePlotIds.length === 0) return;
    const blockedSelected = portablePlotPolicies.filter(
      ({ plot, policy }) =>
        portablePlotIds.includes(plot.id) && policy.family && !policy.supported,
    );
    if (blockedSelected.length > 0) {
      setPortablePlotIds((current) =>
        current.filter((id) => !blockedSelected.some(({ plot }) => plot.id === id)),
      );
      notifications.show({
        message:
          "The selected portable plots are not source-compatible yet. Choose only the enabled plots.",
        color: "yellow",
      });
      return;
    }
    try {
      const stableSpec = persistSpec();
      if (!stableSpec) return;
      await put<AnalysisFull>(`/api/analyses/${analysisId}`, {
        title,
        spec: stableSpec,
      });
      if (!includePortableOriginals) {
        setPortableSourceDecision(null);
        setPendingPortableExport(null);
        portableExport.mutate({ action, includeOriginalFiles: false });
        return;
      }
      setPendingPortableExport({ action });
      const preflight = await portableSourcePreflight.mutateAsync();
      if (!preflight.ready) {
        setPortableSourceDecision(preflight);
        return;
      }
      setPortableSourceDecision(null);
      setPendingPortableExport(null);
      portableExport.mutate({ action, includeOriginalFiles: true });
    } catch (error) {
      notifications.show({
        message: error instanceof Error ? error.message : "Could not prepare the export.",
        color: "red",
      });
    }
  };

  const continuePortableWithoutSources = () => {
    const pending = pendingPortableExport;
    if (!pending) return;
    setPortableSourceDecision(null);
    setPendingPortableExport(null);
    portableExport.mutate({
      action: pending.action,
      includeOriginalFiles: false,
    });
  };

  const updatePortableSourcesAndContinue = async () => {
    const decision = portableSourceDecision;
    const pending = pendingPortableExport;
    if (!decision || !pending) return;
    try {
      const result = await updatePortableSources.mutateAsync(decision);
      result.errors.forEach((error) =>
        notifications.show({
          message: `${error.filename}: ${error.error}`,
          color: "red",
        }),
      );
      const affectedIds = new Set([
        ...decision.affected_analysis_ids,
        ...result.preflight.affected_analysis_ids,
        analysisId,
      ]);
      for (const affectedAnalysisId of affectedIds) {
        for (const root of [
          "saved-plot-preview",
          "saved-time-preview",
          "plot-thumbnail",
          "plot-artifact",
        ]) {
          qc.removeQueries({ queryKey: [root, affectedAnalysisId] });
        }
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cells"] }),
        qc.invalidateQueries({ queryKey: ["cell"] }),
        qc.invalidateQueries({ queryKey: ["cell-cycles"] }),
        qc.invalidateQueries({ queryKey: ["replicate-groups"] }),
        qc.invalidateQueries({ queryKey: ["replicate-preview"] }),
        qc.invalidateQueries({ queryKey: ["files"] }),
        qc.invalidateQueries({ queryKey: ["tree"] }),
        qc.invalidateQueries({ queryKey: ["analyses"] }),
        qc.invalidateQueries({ queryKey: ["activity"] }),
        invalidateAnalysisQueries(qc, analysisId),
      ]);
      if (!result.preflight.ready) {
        setPortableSourceDecision(result.preflight);
        return;
      }
      setPortableSourceDecision(null);
      setPendingPortableExport(null);
      notifications.show({
        message: `Updated ${result.updated} source file${result.updated === 1 ? "" : "s"}; rebuilding the selected plots for export.`,
        color: "teal",
      });
      portableExport.mutate({
        action: pending.action,
        includeOriginalFiles: true,
      });
    } catch {
      // The mutation displays the error and keeps the decision available.
    }
  };

  const portableExportBusy =
    portableExport.isPending ||
    portableSourcePreflight.isPending ||
    updatePortableSources.isPending ||
    preparedShareBusy;
  const portableSourceBlockers =
    portableSourceDecision?.sources.filter((source) => source.status !== "current") ?? [];
  const canUpdatePortableSources = Boolean(
    portableSourceDecision &&
      portableSourceDecision.changed > 0 &&
      portableSourceDecision.unavailable === 0 &&
      portableSourceDecision.changing === 0 &&
      portableSourceDecision.error === 0,
  );
  const portableEstimatedBytes = portableEstimate.data
    ? portableEstimate.data.runtime_embedded_bytes +
      portableEstimate.data.report_shell_bytes +
      portablePlotIds.length * portableEstimate.data.estimated_per_plot_bytes +
      (includePortableOriginals
        ? Math.ceil((portableEstimate.data.original_bytes * 4) / 3)
        : 0)
    : null;

  return (
    <>
      <Button.Group>
        <Tooltip label="Create a standalone, re-importable HTML analysis">
          <Button
            variant="default"
            leftSection={<IconFileExport size={16} />}
            disabled={sourceCompatibilityPending}
            onClick={() => openPortableExport("download")}
          >
            Portable report
          </Button>
        </Tooltip>
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon
              variant="default"
              size={36}
              aria-label="Portable report actions"
              disabled={sourceCompatibilityPending}
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
            >
              <IconChevronDown size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconShare3 size={16} />}
              onClick={() => openPortableExport("share")}
            >
              Share to app
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Button.Group>

      <Modal
        opened={portableExportOpen}
        onClose={() => {
          if (!portableExportBusy) {
            setPortableExportOpen(false);
            setPreparedPortableShare(null);
            setPortableSourceDecision(null);
            setPendingPortableExport(null);
          }
        }}
        title={portableExportAction === "share" ? "Share portable analysis" : "Export portable analysis"}
        size="xl"
        closeOnClickOutside={!portableExportBusy}
        closeOnEscape={!portableExportBusy}
      >
        <Stack>
          <Text size="sm">
            Creates one HTML file that opens as an interactive report in a browser and can be
            imported into CellXplorer later.
          </Text>
          <Paper withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <div>
                <Text size="sm" fw={700}>
                  Plots to include
                </Text>
                <Text size="xs" c="dimmed">
                  {portablePlotIds.length} of {portablePlotOptions.length} selected
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setPortablePlotIds(exportablePortablePlotIds)}
                >
                  Select all supported
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => setPortablePlotIds([])}
                >
                  Clear
                </Button>
              </Group>
            </Group>
            <ScrollArea.Autosize mah={430}>
              <Stack gap="xs">
                {portablePlotOptions.map((plot) => {
                  const selected = portablePlotIds.includes(plot.id);
                  const policy = portablePlotPolicies.find(
                    ({ plot: candidate }) => candidate.id === plot.id,
                  )?.policy;
                  const blocked = Boolean(policy?.family && !policy.supported);
                  const toggle = () =>
                    !blocked &&
                    setPortablePlotIds((current) =>
                      selected
                        ? current.filter((id) => id !== plot.id)
                        : [...current, plot.id],
                    );
                  return (
                    <Paper
                      key={plot.id}
                      withBorder
                      p="xs"
                      bg={
                        selected
                          ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
                          : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                      }
                      style={{
                        borderColor: selected
                          ? "var(--mantine-primary-color-3)"
                          : "var(--mantine-color-gray-2)",
                        cursor: blocked ? "not-allowed" : "pointer",
                      }}
                      onClick={blocked ? undefined : toggle}
                    >
                      <Group wrap="nowrap" align="center">
                        <Checkbox
                          checked={selected}
                          disabled={blocked}
                          onChange={toggle}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Include ${plot.name}`}
                        />
                        <Box
                          w={210}
                          style={{ flexShrink: 0, pointerEvents: "none" }}
                        >
                          {"selection" in plot ? (
                            plot.tab === "time_capacity" ||
                            plot.tab === "cycles" ||
                            plot.tab === "recap" ||
                            plot.tab === "dcir" ||
                            plot.tab === "steps" ||
                            plot.tab === "chargeability" ||
                            plot.tab === "crate" ? (
                              <CachedSavedPlotPreview
                                analysisId={analysisId}
                                baseSpec={spec as AnalysisSpec}
                                plot={plot as SavedAnalysisPlot}
                              />
                            ) : (
                              <Center h={130}>
                                <Text size="xs" c="dimmed">
                                  {tabLabel(plot.tab)}
                                </Text>
                              </Center>
                            )
                          ) : (
                            <Center h={130}>
                              <Text size="xs" c="dimmed">
                                Current view
                              </Text>
                            </Center>
                          )}
                        </Box>
                        <Stack gap={3} style={{ minWidth: 0, flex: 1 }}>
                          <Badge
                            size="xs"
                            variant="light"
                            color={selected ? "var(--mantine-primary-color-6)" : "gray"}
                          >
                            {tabLabel(plot.tab)}
                          </Badge>
                          <Text size="sm" fw={700} lineClamp={2}>
                            {plot.name}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            {plot.subtitle || tabLabel(plot.tab)}
                          </Text>
                          {blocked && (
                            <Text size="xs" c="orange" lineClamp={2}>
                              {policy?.pending
                                ? `Checking source compatibility: ${policy.unresolvedCells.map((cell) => cell.name).join(", ")}`
                                : `Protocol mapping required: ${policy?.unsupportedCells.map((cell) => cell.name).join(", ")}`}
                            </Text>
                          )}
                        </Stack>
                      </Group>
                    </Paper>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          </Paper>
          {guardedPortablePlots.length > 0 && (
            <Alert color="yellow" title="Some saved plots cannot be included">
              <Stack gap={4}>
                <Text size="sm">
                  These plots remain visible so the omission is explicit. They are disabled until
                  their source compatibility is resolved.
                </Text>
                {guardedPortablePlots.map(({ plot, policy }) => (
                  <Text key={plot.id} size="sm">
                    <Text span fw={700}>
                      {plot.name}
                    </Text>{" "}
                    {policy.pending
                      ? `checking ${policy.unresolvedCells.map((cell) => cell.name).join(", ")}`
                      : `protocol mapping required for ${policy.unsupportedCells.map((cell) => cell.name).join(", ")}`}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          {portableEstimate.isError ? (
            <Alert color="red">Could not estimate the export size.</Alert>
          ) : (
            <Paper
              withBorder
              p="sm"
              bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
            >
              <Group justify="space-between" align="start">
                <div>
                  <Text size="sm" fw={700}>
                    {portableEstimate.data?.cells ?? "..."} cells ·{" "}
                    {portableEstimate.data?.sources ?? "..."} source files
                  </Text>
                  <Text size="xs" c="dimmed">
                    Embedded Plotly runtime after compression:{" "}
                    {portableEstimate.data
                      ? formatPortableBytes(portableEstimate.data.runtime_embedded_bytes)
                      : "calculating..."}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Rough HTML estimate:{" "}
                    {portableEstimatedBytes !== null
                      ? formatPortableBytes(portableEstimatedBytes)
                      : "calculating..."}
                  </Text>
                </div>
                <Text size="xs" c="dimmed" maw={260}>
                  Metadata, settings and provenance are always included. Plot data varies with
                  point density, so this estimate is intentionally approximate.
                </Text>
              </Group>
            </Paper>
          )}
          <Switch
            checked={includePortableOriginals}
            onChange={(event) => setIncludePortableOriginals(event.currentTarget.checked)}
            disabled={portableExportBusy}
            label="Include original .nda/.ndax files"
            description={
              portableEstimate.data
                ? `${formatPortableBytes(portableEstimate.data.original_bytes)} before compression. Embedded sources are gzip-compressed and decoded only when extracted or imported.`
                : "Original Neware files can make the HTML substantially larger."
            }
          />
          {includePortableOriginals && portableEstimate.data?.missing_originals ? (
            <Alert color="orange">
              {portableEstimate.data.missing_originals} original source{" "}
              {portableEstimate.data.missing_originals === 1 ? "is" : "are"} unavailable and
              cannot be embedded. CellXplorer will check again before export and let you continue
              without source files.
            </Alert>
          ) : null}
          <Alert color="gray">
            Reports without original files remain fully viewable. On import, CellXplorer reconnects
            sources by checksum or recorded path; missing sources remain offline until relinked.
          </Alert>
          {portableExport.isPending && portableProgress ? (
            <Paper withBorder p="sm">
              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="sm" fw={600}>
                    {portableProgress.stage}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {portableProgress.phase === "plots"
                      ? `${portableProgress.completed} of ${portableProgress.total} plots`
                      : portableProgress.phase === "packing"
                        ? "Finalizing file"
                        : "Complete"}
                  </Text>
                </Group>
                <Progress
                  animated
                  value={
                    portableProgress.phase === "plots"
                      ? portableProgress.total > 0
                        ? (portableProgress.completed / portableProgress.total) * 85
                        : 0
                      : portableProgress.phase === "packing"
                        ? 92
                        : 100
                  }
                />
              </Stack>
            </Paper>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={portableExportBusy}
              onClick={() => {
                setPortableExportOpen(false);
                setPreparedPortableShare(null);
                setPortableSourceDecision(null);
                setPendingPortableExport(null);
              }}
            >
              Cancel
            </Button>
            <Button
              leftSection={<IconFileExport size={16} />}
              loading={portableExportBusy}
              disabled={portablePlotIds.length === 0}
              onClick={() =>
                preparedPortableShare
                  ? sharePreparedPortable()
                  : void beginPortableExport(portableExportAction)
              }
            >
              {preparedPortableShare
                ? "Open share sheet"
                : portableExportAction === "share"
                  ? "Prepare HTML"
                  : "Export HTML"}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={portableSourceDecision !== null}
        onClose={() => {
          if (!updatePortableSources.isPending) {
            setPortableSourceDecision(null);
            setPendingPortableExport(null);
          }
        }}
        title="Source files changed"
        size="lg"
        closeOnClickOutside={!updatePortableSources.isPending}
        closeOnEscape={!updatePortableSources.isPending}
      >
        <Stack>
          <Alert color="orange" title="The requested source files cannot be embedded yet">
            CellXplorer compared the current file bytes with the versions used by the analysis.
            Export has paused before rebuilding any plots, so it cannot silently omit a changed
            file.
          </Alert>
          <ScrollArea.Autosize mah={320}>
            <Stack gap="xs">
              {portableSourceBlockers.map((source) => (
                <Paper key={source.source_id} withBorder p="sm">
                  <Group justify="space-between" align="start" wrap="nowrap">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={700} truncate>
                        {source.filename}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {source.cell_name}
                      </Text>
                    </div>
                    <Badge
                      color={
                        source.status === "changed"
                          ? "orange"
                          : source.status === "changing"
                            ? "yellow"
                            : "red"
                      }
                      variant="light"
                    >
                      {source.status === "changed"
                        ? "Changed"
                        : source.status === "changing"
                          ? "Still changing"
                          : source.status === "unavailable"
                            ? "Unavailable"
                            : "Read error"}
                    </Badge>
                  </Group>
                  <Text size="xs" mt={6}>
                    {source.message}
                  </Text>
                </Paper>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {canUpdatePortableSources ? (
            <Alert color="var(--mantine-primary-color-6)">
              Updating adopts the new stable file version, rebuilds its scientific cache, and
              invalidates {portableSourceDecision?.affected_analyses ?? 0} dependent{" "}
              {(portableSourceDecision?.affected_analyses ?? 0) === 1
                ? "analysis"
                : "analyses"}. The selected plots are then regenerated before the report is
              packaged.
            </Alert>
          ) : (
            <Alert color="gray">
              Automatic update is available once every source is present, readable, and no longer
              being written. You can cancel and retry later, or export a fully viewable report
              without the original source files.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={updatePortableSources.isPending}
              onClick={() => {
                setPortableSourceDecision(null);
                setPendingPortableExport(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="light"
              color="gray"
              disabled={updatePortableSources.isPending}
              onClick={continuePortableWithoutSources}
            >
              Export without .nda/.ndax
            </Button>
            <Button
              loading={updatePortableSources.isPending}
              disabled={!canUpdatePortableSources}
              onClick={() => void updatePortableSourcesAndContinue()}
            >
              Update sources, refresh plots & export
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
