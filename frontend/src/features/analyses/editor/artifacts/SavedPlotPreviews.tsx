import { Center, Loader, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import PlotlyLib from "plotly.js-dist-min";

import {
  ApiError,
  post,
  type AnalysisSpec,
  type AnalysisTabKey,
  type BackgroundJob,
  type CacheWarmupTask,
  type ComputeResult,
  type SavedAnalysisPlot,
  type TimeCapacityResult,
} from "../../../../api";
import {
  cyclePlotLayout,
  cycleTracesForResult,
} from "../families/cycles/CyclePlotCard";
import {
  dcirLayoutForSpec,
  dcirTracesForResult,
  type DcirResult,
} from "../families/dcir/DcirPlotCard";
import {
  chargeabilityLayoutForSpec,
  chargeabilityTracesForResult,
  type ChargeabilityResult,
} from "../families/chargeability/ChargeabilityPlotCard";
import {
  rateCapabilityLayoutForSpec,
  rateCapabilityTracesForResult,
  type RateCapabilityResult,
} from "../families/rate-capability/RateCapabilityPlotCard";
import {
  stepsLayoutForSpec,
  stepsTracesForResult,
  type StepsResult,
} from "../families/steps/StepsPlotCard";
import {
  timeCapacityConfig,
  timeCapacityLayout,
  timeCapacityTracesForResult,
} from "../families/time-capacity/TimeCapacityPlotCard";
import {
  savedPlotPreviewSignature,
  specForSavedPlotView,
} from "../policies/analysisPlotPolicy";
import {
  voltageChannelUnavailable,
  voltageChannelUnavailableMessage,
} from "../policies/voltageChannelPolicy";
import { timeCapacityPreviewResult } from "../policies/timeCapacityPreviewPolicy";
import {
  artifactDataSignatureForWrite,
  portableResultDataSignature,
  previewQueryRootForPlot,
  serverArtifactMatchesExpectedData,
} from "../policies/plotArtifactPolicy";
import { isDraftPreviewPlotId } from "../policies/analysisDraftPolicy";
import {
  afterPaint,
  useDelayedFlag,
} from "../plotting/plotRuntime";
import { textFromDataUrl } from "../plotting/plotExport";
import { resolveWarmup } from "./warmupCompletion";

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export type PortableFigure = {
  data: unknown[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
};

type PortableSummaryRow = { label: string; cycles: number | null; status: string };

export type PlotArtifact = {
  signature: string;
  data_signature?: string;
  svg: string;
  thumbnail?: string | null;
  preview_thumbnail?: string | null;
  figure: PortableFigure;
  summary: PortableSummaryRow[];
};

type PlotThumbnail = {
  signature: string;
  thumbnail: string;
  preview_thumbnail?: string | null;
};

function invalidateFailedArtifactQueries(
  qc: ReturnType<typeof useQueryClient>,
  analysisId: number,
  plotId: string,
  previewSignature: string,
  previewRoot: ReturnType<typeof previewQueryRootForPlot>,
) {
  // A server-side 409 means the figure was rendered from an obsolete source
  // identity. Remove every local artifact variant, including warmup-scoped
  // keys, so stale content cannot suppress the next current render.
  qc.removeQueries({
    queryKey: ["plot-thumbnail", analysisId, plotId, previewSignature],
  });
  qc.removeQueries({
    queryKey: ["plot-artifact", analysisId, plotId, previewSignature],
  });
  const previewQueryKey = [previewRoot, analysisId, plotId, previewSignature] as const;
  qc.removeQueries({ queryKey: previewQueryKey });
  void qc.invalidateQueries({
    queryKey: previewQueryKey,
  });
}

function warmupQueryScope(
  warmup: boolean,
  warmupTask?: CacheWarmupTask,
): string | undefined {
  if (!warmup) return undefined;
  return `warmup:${warmupTask?.id ?? "pending"}:${warmupTask?.expected_data_signature ?? ""}`;
}

function scopedQueryKey(
  base: readonly unknown[],
  scope: string | undefined,
): readonly unknown[] {
  return scope ? [...base, scope] : base;
}

async function lookupPlotThumbnail(
  analysisId: number,
  plotId: string,
  signature: string
): Promise<PlotThumbnail | null> {
  // Draft previews are session-only; never hit the saved-plot artifact API.
  if (isDraftPreviewPlotId(plotId)) return null;
  try {
    return await post<PlotThumbnail>(
      `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/thumbnail/lookup`,
      { signature }
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function lookupPlotArtifact(
  analysisId: number,
  plotId: string,
  signature: string,
): Promise<PlotArtifact | null> {
  if (isDraftPreviewPlotId(plotId)) return null;
  try {
    return await post<PlotArtifact>(
      `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}/lookup`,
      { signature },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
  warmup = false,
  warmupTask,
  onWarmupComplete,
  allowGeneration = true,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
  warmup?: boolean;
  warmupTask?: CacheWarmupTask;
  onWarmupComplete?: (
    error?: string,
    detail?: string,
    disposition?: "ready" | "skipped",
  ) => void;
  allowGeneration?: boolean;
}) {
  const previewSpec = useMemo(() => specForSavedPlotView(baseSpec, plot), [baseSpec, plot]);
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const qc = useQueryClient();
  const draftPreview = isDraftPreviewPlotId(plot.id);
  const [generationFailed, setGenerationFailed] = useState(false);
  const warmupReported = useRef(false);
  const renderedFresh = useRef(false);
  const rebuiltThumbnail = useRef(false);
  const queryScope = warmupQueryScope(warmup, warmupTask);
  const thumbnailQueryKey = scopedQueryKey(
    ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryScope,
  );
  const artifactQueryKey = scopedQueryKey(
    ["plot-artifact", analysisId, plot.id, previewSignature],
    queryScope,
  );
  const previewQueryKey = scopedQueryKey(
    ["saved-plot-preview", analysisId, plot.id, previewSignature, warmup ? "warmup" : "visible"],
    queryScope,
  );
  const thumbnail = useQuery({
    queryKey: thumbnailQueryKey,
    queryFn: async () => {
      if (draftPreview) {
        // Keep any client-rendered draft thumbnail; never ask the server.
        return (
          qc.getQueryData<PlotThumbnail>([
            ...thumbnailQueryKey,
          ]) ?? null
        );
      }
      return lookupPlotThumbnail(analysisId, plot.id, previewSignature);
    },
    staleTime: draftPreview ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const thumbnailPairReady = Boolean(
    thumbnail.data?.thumbnail && thumbnail.data?.preview_thumbnail
  );
  const artifact = useQuery({
    queryKey: artifactQueryKey,
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotArtifact>([
            ...artifactQueryKey,
          ]) ?? null
        );
      }
      return lookupPlotArtifact(analysisId, plot.id, previewSignature);
    },
    enabled:
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)),
    staleTime: draftPreview ? Infinity : 5 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const preview = useQuery<
    | ComputeResult
    | DcirResult
    | StepsResult
    | ChargeabilityResult
    | RateCapabilityResult
  >({
    queryKey: previewQueryKey,
    queryFn: () =>
      plot.tab === "steps"
        ? post<StepsResult>(`/api/analyses/${analysisId}/steps`, {
            spec: previewSpec,
            background: warmup,
          })
        : plot.tab === "dcir"
        ? post<DcirResult>(`/api/analyses/${analysisId}/dcir`, {
            spec: previewSpec,
            background: warmup,
          })
        : plot.tab === "chargeability"
        ? post<ChargeabilityResult>(
            `/api/analyses/${analysisId}/chargeability`,
            {
              spec: previewSpec,
              background: warmup,
            }
          )
        : plot.tab === "crate"
        ? post<RateCapabilityResult>(
            `/api/analyses/${analysisId}/rate-capability`,
            {
              spec: previewSpec,
              background: warmup,
            }
          )
        : post<ComputeResult>(`/api/analyses/${analysisId}/compute`, {
            spec: previewSpec,
            background: warmup,
          }),
    // Warmup must not recompute plots that are already cached: the compute
    // only runs when neither a thumbnail nor a full artifact exists, exactly
    // like the visible path.
    enabled:
      (warmup || allowGeneration) &&
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)) &&
      artifact.isSuccess &&
      artifact.data === null,
    staleTime: 5 * 60_000,
  });
  const traces = useMemo(
    () =>
      preview.data
        ? plot.tab === "steps"
          ? stepsTracesForResult(preview.data as StepsResult, previewSpec)
          : plot.tab === "dcir"
          ? dcirTracesForResult(preview.data as DcirResult, previewSpec)
          : plot.tab === "chargeability"
          ? chargeabilityTracesForResult(
              preview.data as ChargeabilityResult,
              previewSpec
            )
          : plot.tab === "crate"
          ? rateCapabilityTracesForResult(
              preview.data as RateCapabilityResult,
              previewSpec
            )
          : cycleTracesForResult(preview.data as ComputeResult, previewSpec)
        : [],
    [plot.tab, preview.data, previewSpec]
  );

  useEffect(() => {
    if (
      (warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) ||
      artifact.data ||
      !preview.data ||
      traces.length === 0
    ) return;
    let cancelled = false;
    setGenerationFailed(false);
    const layout =
      plot.tab === "steps"
        ? stepsLayoutForSpec(previewSpec)
        : plot.tab === "dcir"
        ? dcirLayoutForSpec(previewSpec)
        : plot.tab === "chargeability"
        ? chargeabilityLayoutForSpec(
            previewSpec,
            preview.data as ChargeabilityResult
          )
        : plot.tab === "crate"
        ? rateCapabilityLayoutForSpec(
            previewSpec,
            preview.data as RateCapabilityResult
          )
        : cyclePlotLayout(preview.data as ComputeResult, previewSpec, traces);
    const figure = portableFigure(traces, layout);
    if (!figure) return;
    const summary =
      plot.tab === "steps"
        ? (preview.data as StepsResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.n_blocks,
            status: series.n_blocks > 0 ? "Visible" : "No matching blocks",
          }))
        : plot.tab === "dcir"
        ? (preview.data as DcirResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.n_measurements,
            status: series.n_measurements > 0 ? "Visible" : "No measurements",
          }))
        : plot.tab === "chargeability"
        ? (preview.data as ChargeabilityResult).cells.map((cell) => ({
            label: cell.cell_name,
            cycles: cell.match_count,
            status:
              cell.match_count > 0
                ? "Matched"
                : cell.status === "no_candidates"
                  ? "No candidates"
                  : "No matching event",
          }))
        : plot.tab === "crate"
        ? (preview.data as RateCapabilityResult).cells.map((cell) => {
            const points =
              cell.families.charge.point_count +
              cell.families.discharge.point_count;
            return {
              label: cell.cell_name,
              cycles: points,
              status: points > 0 ? "Matched" : "No sweep detected",
            };
          })
        : (preview.data as ComputeResult).cell_series.map((series) => ({
            label: series.label,
            cycles: series.metrics?.n_cycles ?? series.x.length,
            status: series.excluded ? "Hidden" : "Visible",
          }));
    queuedPortableArtifactImages(figure)
      .then(({ svg, thumbnail, preview_thumbnail }) => {
        const generated: PlotArtifact = {
          signature: previewSignature,
          data_signature: preview.data?.data_signature,
          svg,
          thumbnail,
          preview_thumbnail,
          figure,
          summary,
        };
        renderedFresh.current = true;
        return storePlotArtifactWithRetry(analysisId, plot.id, generated, warmupTask);
      })
      .then((stored) => {
        if (!cancelled) {
          if (stored.thumbnail) {
            qc.setQueryData(thumbnailQueryKey, {
              signature: previewSignature,
              thumbnail: stored.thumbnail,
              preview_thumbnail: stored.preview_thumbnail,
            });
          }
          qc.setQueryData(artifactQueryKey, stored);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGenerationFailed(true);
          invalidateFailedArtifactQueries(
            qc,
            analysisId,
            plot.id,
            previewSignature,
            previewQueryRootForPlot(plot.tab),
          );
        }
        console.warn("Could not persist the saved plot preview", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, plot.tab, preview.data, previewSignature, previewSpec, qc, thumbnail.data, thumbnailPairReady, traces, warmup, warmupTask]);

  useEffect(() => {
    const current = artifact.data;
    if ((warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) || !current) return;
    let cancelled = false;
    // The thumbnail embedded in an older full artifact belongs to that
    // artifact's renderer generation. A miss in the dedicated versioned
    // thumbnail cache means it must be rebuilt from the canonical SVG even
    // when the legacy artifact happens to contain an image.
    queuedPortableThumbnails(current.svg, current.figure)
      .then(({ thumbnail, preview_thumbnail }) => {
        const enriched = { ...current, thumbnail, preview_thumbnail };
        rebuiltThumbnail.current = true;
        return storePlotArtifactWithRetry(analysisId, plot.id, enriched, warmupTask);
      })
      .then((stored) => {
        if (!cancelled && stored.thumbnail) {
          qc.setQueryData(thumbnailQueryKey, {
            signature: previewSignature,
            thumbnail: stored.thumbnail,
            preview_thumbnail: stored.preview_thumbnail,
          });
          qc.setQueryData(artifactQueryKey, stored);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGenerationFailed(true);
          invalidateFailedArtifactQueries(
            qc,
            analysisId,
            plot.id,
            previewSignature,
            previewQueryRootForPlot(plot.tab),
          );
        }
        console.warn("Could not cache the plot thumbnail", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, previewSignature, qc, thumbnail.data, thumbnailPairReady, warmup, warmupTask]);

  const previewImage = thumbnail.data?.thumbnail ?? artifact.data?.thumbnail ??
    (artifact.data ? svgDataUrl(artifact.data.svg) : null);
  const generationDeferred =
    !warmup &&
    !allowGeneration &&
    thumbnail.isSuccess &&
    thumbnail.data === null &&
    artifact.isSuccess &&
    artifact.data === null;
  const previewPending =
    thumbnail.isLoading ||
    artifact.isLoading ||
    preview.isLoading ||
    generationDeferred ||
    (traces.length > 0 && !generationFailed);
  const showPreviewLoader = useDelayedFlag(previewPending);
  useEffect(() => {
    if (!warmup || warmupReported.current || !onWarmupComplete) return;
    // Shared resolver: a failed thumbnail/artifact lookup leaves the compute
    // query disabled, so without an explicit terminal state for it the task
    // never reports and stalls the whole warmup queue. See warmupCompletion.ts.
    const resolution = resolveWarmup({
      generationFailed,
      thumbnailPairReady,
      thumbnailErrored: thumbnail.isError,
      thumbnailError: thumbnail.error,
      artifactErrored: artifact.isError,
      artifactError: artifact.error,
      previewErrored: preview.isError,
      previewError: preview.error,
      previewSucceeded: preview.isSuccess,
      traceCount: traces.length,
      renderedFresh: renderedFresh.current,
      rebuiltThumbnail: rebuiltThumbnail.current,
    });
    if (resolution.status !== "done") return;
    warmupReported.current = true;
    onWarmupComplete(
      resolution.error,
      resolution.detail,
      resolution.disposition,
    );
  }, [
    artifact.error,
    artifact.isError,
    generationFailed,
    onWarmupComplete,
    preview.error,
    preview.isError,
    preview.isSuccess,
    thumbnail.error,
    thumbnail.isError,
    thumbnailPairReady,
    traces.length,
    warmup,
  ]);
  if (previewImage) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={previewImage}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }

  if (previewPending) {
    // A grid of saved plots would otherwise flash twenty loaders at once on a
    // warm cache. Hold the row height; only admit to loading if it drags.
    return <Center h={120}>{showPreviewLoader ? <Loader size={18} /> : null}</Center>;
  }
  if (traces.length === 0 || generationFailed) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          Preview unavailable
        </Text>
      </Center>
    );
  }
  return null;
}

export function SavedTimeCapacityPreview({
  analysisId,
  baseSpec,
  plot,
  warmup = false,
  warmupTask,
  onWarmupComplete,
  allowGeneration = true,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
  warmup?: boolean;
  warmupTask?: CacheWarmupTask;
  onWarmupComplete?: (
    error?: string,
    detail?: string,
    disposition?: "ready" | "skipped",
  ) => void;
  allowGeneration?: boolean;
}) {
  const previewSpec = useMemo(() => specForSavedPlotView(baseSpec, plot), [baseSpec, plot]);
  const previewSignature = useMemo(() => savedPlotPreviewSignature(baseSpec, plot), [baseSpec, plot]);
  const qc = useQueryClient();
  const draftPreview = isDraftPreviewPlotId(plot.id);
  const [generationFailed, setGenerationFailed] = useState(false);
  const warmupReported = useRef(false);
  const renderedFresh = useRef(false);
  const rebuiltThumbnail = useRef(false);
  const queryScope = warmupQueryScope(warmup, warmupTask);
  const thumbnailQueryKey = scopedQueryKey(
    ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryScope,
  );
  const artifactQueryKey = scopedQueryKey(
    ["plot-artifact", analysisId, plot.id, previewSignature],
    queryScope,
  );
  const previewQueryKey = scopedQueryKey(
    ["saved-time-preview", analysisId, plot.id, previewSignature, warmup ? "warmup" : "visible"],
    queryScope,
  );
  const thumbnail = useQuery({
    queryKey: thumbnailQueryKey,
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotThumbnail>([
            ...thumbnailQueryKey,
          ]) ?? null
        );
      }
      return lookupPlotThumbnail(analysisId, plot.id, previewSignature);
    },
    staleTime: draftPreview ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const thumbnailPairReady = Boolean(
    thumbnail.data?.thumbnail && thumbnail.data?.preview_thumbnail
  );
  const artifact = useQuery({
    queryKey: artifactQueryKey,
    queryFn: async () => {
      if (draftPreview) {
        return (
          qc.getQueryData<PlotArtifact>([
            ...artifactQueryKey,
          ]) ?? null
        );
      }
      return lookupPlotArtifact(analysisId, plot.id, previewSignature);
    },
    enabled:
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)),
    staleTime: draftPreview ? Infinity : 5 * 60_000,
    refetchOnWindowFocus: !draftPreview,
    refetchOnReconnect: !draftPreview,
    retry: draftPreview ? false : 1,
  });
  const preview = useQuery({
    queryKey: previewQueryKey,
    queryFn: () =>
      post<TimeCapacityResult>(`/api/analyses/${analysisId}/time-capacity`, {
        spec: previewSpec,
        viewport_width: 1200,
        precision: "standard",
        compact: true,
        background: warmup,
      }),
    // Warmup must not recompute plots that are already cached: the compute
    // only runs when neither a thumbnail nor a full artifact exists, exactly
    // like the visible path.
    enabled:
      (warmup || allowGeneration) &&
      thumbnail.isSuccess &&
      (thumbnail.data === null || (warmup && !thumbnailPairReady)) &&
      artifact.isSuccess &&
      artifact.data === null,
    staleTime: 5 * 60_000,
  });
  const previewVoltageChannel = timeCapacityConfig(previewSpec).voltage_channel;
  const previewResult = timeCapacityPreviewResult(preview.data, previewSpec);
  const selectedVoltageUnavailable = voltageChannelUnavailable(
    previewVoltageChannel,
    preview.data?.voltage_channels
  );
  const traces = useMemo(
    () =>
      previewResult
        ? timeCapacityTracesForResult(previewResult, previewSpec)
        : [],
    [previewResult, previewSpec]
  );

  useEffect(() => {
    if (
      (warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) ||
      artifact.data ||
      !preview.data ||
      traces.length === 0
    ) return;
    let cancelled = false;
    setGenerationFailed(false);
    const layout = timeCapacityLayout(preview.data, previewSpec, traces);
    const figure = portableFigure(traces, layout);
    if (!figure) return;
    const summary = preview.data.cell_traces.map((trace) => ({
      label: trace.label,
      cycles: new Set(trace.cycle.filter((cycle) => cycle !== null)).size,
      status: trace.excluded ? "Hidden" : "Visible",
    }));
    queuedPortableArtifactImages(figure)
      .then(({ svg, thumbnail, preview_thumbnail }) => {
        const generated: PlotArtifact = {
          signature: previewSignature,
          data_signature: preview.data?.data_signature,
          svg,
          thumbnail,
          preview_thumbnail,
          figure,
          summary,
        };
        renderedFresh.current = true;
        return storePlotArtifactWithRetry(analysisId, plot.id, generated, warmupTask);
      })
      .then((stored) => {
        if (!cancelled) {
          if (stored.thumbnail) {
            qc.setQueryData(thumbnailQueryKey, {
              signature: previewSignature,
              thumbnail: stored.thumbnail,
              preview_thumbnail: stored.preview_thumbnail,
            });
          }
          qc.setQueryData(artifactQueryKey, stored);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGenerationFailed(true);
          invalidateFailedArtifactQueries(
            qc,
            analysisId,
            plot.id,
            previewSignature,
            previewQueryRootForPlot(plot.tab),
          );
        }
        console.warn("Could not persist the saved time/capacity preview", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, preview.data, previewSignature, previewSpec, qc, thumbnail.data, thumbnailPairReady, traces, warmup, warmupTask]);

  useEffect(() => {
    const current = artifact.data;
    if ((warmup ? thumbnailPairReady : Boolean(thumbnail.data?.thumbnail)) || !current) return;
    let cancelled = false;
    // See SavedPlotPreview: an artifact thumbnail is not proof that the
    // current dedicated thumbnail generation has been persisted.
    queuedPortableThumbnails(current.svg, current.figure)
      .then(({ thumbnail, preview_thumbnail }) => {
        const enriched = { ...current, thumbnail, preview_thumbnail };
        rebuiltThumbnail.current = true;
        return storePlotArtifactWithRetry(analysisId, plot.id, enriched, warmupTask);
      })
      .then((stored) => {
        if (!cancelled && stored.thumbnail) {
          qc.setQueryData(thumbnailQueryKey, {
            signature: previewSignature,
            thumbnail: stored.thumbnail,
            preview_thumbnail: stored.preview_thumbnail,
          });
          qc.setQueryData(artifactQueryKey, stored);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGenerationFailed(true);
          invalidateFailedArtifactQueries(
            qc,
            analysisId,
            plot.id,
            previewSignature,
            previewQueryRootForPlot(plot.tab),
          );
        }
        console.warn("Could not cache the time/capacity thumbnail", error);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, artifact.data, plot.id, previewSignature, qc, thumbnail.data, thumbnailPairReady, warmup, warmupTask]);

  const previewImage = thumbnail.data?.thumbnail ?? artifact.data?.thumbnail ??
    (artifact.data ? svgDataUrl(artifact.data.svg) : null);
  const generationDeferred =
    !warmup &&
    !allowGeneration &&
    thumbnail.isSuccess &&
    thumbnail.data === null &&
    artifact.isSuccess &&
    artifact.data === null;
  const previewPending =
    thumbnail.isLoading ||
    artifact.isLoading ||
    preview.isLoading ||
    generationDeferred ||
    (traces.length > 0 && !generationFailed);
  const showPreviewLoader = useDelayedFlag(previewPending);
  useEffect(() => {
    if (!warmup || warmupReported.current || !onWarmupComplete) return;
    // Shared resolver: a failed thumbnail/artifact lookup leaves the compute
    // query disabled, so without an explicit terminal state for it the task
    // never reports and stalls the whole warmup queue. See warmupCompletion.ts.
    const resolution = resolveWarmup({
      generationFailed,
      thumbnailPairReady,
      thumbnailErrored: thumbnail.isError,
      thumbnailError: thumbnail.error,
      artifactErrored: artifact.isError,
      artifactError: artifact.error,
      previewErrored: preview.isError,
      previewError: preview.error,
      previewSucceeded: preview.isSuccess,
      traceCount: traces.length,
      renderedFresh: renderedFresh.current,
      rebuiltThumbnail: rebuiltThumbnail.current,
    });
     if (resolution.status !== "done") return;
     warmupReported.current = true;
     onWarmupComplete(
       resolution.error,
       selectedVoltageUnavailable
         ? voltageChannelUnavailableMessage(previewVoltageChannel)
         : resolution.detail,
       selectedVoltageUnavailable ? "skipped" : resolution.disposition,
     );
  }, [
    artifact.error,
    artifact.isError,
    generationFailed,
    onWarmupComplete,
    preview.error,
    preview.isError,
    preview.isSuccess,
    previewVoltageChannel,
    selectedVoltageUnavailable,
    thumbnail.error,
    thumbnail.isError,
    thumbnailPairReady,
    traces.length,
    warmup,
  ]);
  if (previewImage) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={previewImage}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }

  if (previewPending) {
    // A grid of saved plots would otherwise flash twenty loaders at once on a
    // warm cache. Hold the row height; only admit to loading if it drags.
    return <Center h={120}>{showPreviewLoader ? <Loader size={18} /> : null}</Center>;
  }
  if (traces.length === 0 || generationFailed) {
    return (
      <Center h={120}>
        <Text size="xs" c="dimmed">
          {selectedVoltageUnavailable
            ? voltageChannelUnavailableMessage(previewVoltageChannel)
            : "Preview unavailable"}
        </Text>
      </Center>
    );
  }
  return null;
}

export function CachedSavedPlotPreview({
  analysisId,
  baseSpec,
  plot,
}: {
  analysisId: number;
  baseSpec: AnalysisSpec;
  plot: SavedAnalysisPlot;
}) {
  const previewSignature = useMemo(
    () => savedPlotPreviewSignature(baseSpec, plot),
    [baseSpec, plot]
  );
  const thumbnail = useQuery({
    queryKey: ["plot-thumbnail", analysisId, plot.id, previewSignature],
    queryFn: () => lookupPlotThumbnail(analysisId, plot.id, previewSignature),
    staleTime: 60 * 60_000,
    retry: false,
  });

  if (thumbnail.data) {
    return (
      <Center className="cx-plot-thumbnail-frame" h={130}>
        <img
          className="cx-plot-thumbnail"
          src={thumbnail.data.thumbnail}
          alt=""
          style={{ maxWidth: "100%", maxHeight: 130, display: "block" }}
        />
      </Center>
    );
  }
  return (
    <Center h={120}>
      {thumbnail.isLoading ? (
        <Loader size={18} />
      ) : (
        <Text size="xs" c="dimmed">
          Preview will be prepared on export
        </Text>
      )}
    </Center>
  );
}

type PortablePlotSnapshot = {
  id: string;
  name: string;
  subtitle: string;
  description: string | null;
  tab: AnalysisTabKey;
  figure: PortableFigure | null;
  svg: string | null;
  summary: PortableSummaryRow[];
  /** Server-owned identity of the exact scientific data in this snapshot. */
  data_signature: string | null;
  /** Saved-plot revision used to bind the snapshot to the requested view. */
  plot_revision: string | null;
};

function requireDataSignature(result: { data_signature?: string }): string {
  return portableResultDataSignature(result.data_signature);
}

function snapshotPlotRevision(
  view: { modified_at?: string } | Record<string, unknown>,
): string | null {
  return typeof view.modified_at === "string" ? view.modified_at : null;
}

function portableFigure(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>
): PortablePlotSnapshot["figure"] {
  const responsiveLayout = { ...layout, autosize: true } as Record<string, unknown>;
  delete responsiveLayout.width;
  return JSON.parse(
    JSON.stringify({
      data: traces,
      layout: responsiveLayout,
      config: { displaylogo: false, responsive: true },
    })
  ) as NonNullable<PortablePlotSnapshot["figure"]>;
}

async function portableSvg(
  figure: NonNullable<PortablePlotSnapshot["figure"]>,
  options: { width?: number; height?: number; hideLegend?: boolean } = {}
): Promise<string> {
  const width = options.width ?? 1200;
  const height = options.height ?? 720;
  const sourceLayout = figure.layout as Record<string, unknown>;
  const sourceMargin = (sourceLayout.margin ?? {}) as Record<string, number>;
  const renderFigure = options.hideLegend
    ? {
        ...figure,
        layout: {
          ...sourceLayout,
          autosize: false,
          width,
          height,
          showlegend: false,
          margin: {
            ...sourceMargin,
            l: Math.max(70, Math.min(sourceMargin.l ?? 80, 110)),
            r: Math.max(55, Math.min(sourceMargin.r ?? 70, 110)),
            t: Math.max(28, Math.min(sourceMargin.t ?? 40, 70)),
            b: Math.max(62, Math.min(sourceMargin.b ?? 75, 100)),
          },
        },
      }
    : figure;
  const toImage = (
    PlotlyLib as unknown as { toImage: (fig: unknown, options: unknown) => Promise<string> }
  ).toImage;
  const dataUrl = await toImage(renderFigure, {
    format: "svg",
    width,
    height,
  });
  return textFromDataUrl(dataUrl);
}

async function rasterThumbnail(
  svg: string,
  width: number,
  height: number,
  sourceFontFloor: number,
): Promise<string> {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  documentNode.querySelectorAll("g.legend").forEach((node) => node.remove());
  documentNode.querySelectorAll("text").forEach((node) => {
    const current = Number.parseFloat(node.style.fontSize || node.getAttribute("font-size") || "12");
    node.style.fontSize = `${Math.max(sourceFontFloor, current * 1.5)}px`;
  });
  documentNode.querySelectorAll(".scatterlayer path.js-line").forEach((node) => {
    const path = node as SVGPathElement;
    const rawWidth = path.style.strokeWidth || path.getAttribute("stroke-width");
    const current = rawWidth ? Number.parseFloat(rawWidth) : Number.NaN;
    const rawOpacity = path.style.strokeOpacity || path.getAttribute("stroke-opacity");
    const opacity = rawOpacity ? Number.parseFloat(rawOpacity) : 1;
    if (
      !Number.isFinite(current) ||
      current <= 0 ||
      (Number.isFinite(opacity) && opacity <= 0) ||
      path.style.stroke === "none" ||
      path.getAttribute("stroke") === "none"
    ) {
      return;
    }
    path.style.strokeWidth = `${Math.max(2.5, current * 1.4)}px`;
  });
  documentNode
    .querySelectorAll("path.xlines-above, path.ylines-above, path.xlines-below, path.ylines-below")
    .forEach((node) => {
      (node as SVGPathElement).style.strokeWidth = "3.5px";
    });
  const thumbnailSvg = new XMLSerializer().serializeToString(documentNode.documentElement);
  const url = URL.createObjectURL(
    new Blob([thumbnailSvg], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Could not render the cached SVG preview."));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the thumbnail canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const sourceWidth = image.naturalWidth || 1200;
    const sourceHeight = image.naturalHeight || 720;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(
      image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
    const webp = canvas.toDataURL("image/webp", 0.84);
    return webp.startsWith("data:image/webp;base64,")
      ? webp
      : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function savedRowThumbnail(svg: string): Promise<string> {
  // The saved-plot list is deliberately compact and wide. It is derived from
  // the canonical portable SVG, so this path is cheap when only the small
  // row image needs rebuilding.
  return rasterThumbnail(svg, 480, 288, 28);
}

async function hoverPreviewThumbnail(
  figure: NonNullable<PortablePlotSnapshot["figure"]>
): Promise<string> {
  // A wide plot scaled into a 4:3 bitmap remains a wide plot with whitespace.
  // Re-layout Plotly at 4:3 first so the hover panel receives a true preview.
  const svg = await portableSvg(figure, { width: 640, height: 480, hideLegend: true });
  return rasterThumbnail(svg, 480, 360, 18);
}

// Plotly image export is synchronous-heavy even though it returns a promise.
// Serializing thumbnail work prevents several saved plots from blocking the UI
// at the same time when a tab is opened for the first time.
let portableSvgQueue: Promise<void> = Promise.resolve();

function queuedPortableArtifactImages(
  figure: NonNullable<PortablePlotSnapshot["figure"]>
): Promise<{ svg: string; thumbnail: string; preview_thumbnail: string }> {
  const task = portableSvgQueue.then(async () => {
    await afterPaint();
    const svg = await portableSvg(figure);
    const thumbnail = await savedRowThumbnail(svg);
    const preview_thumbnail = await hoverPreviewThumbnail(figure);
    return { svg, thumbnail, preview_thumbnail };
  });
  portableSvgQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function queuedPortableThumbnails(
  svg: string,
  figure: NonNullable<PortablePlotSnapshot["figure"]>,
): Promise<{ thumbnail: string; preview_thumbnail: string }> {
  const task = portableSvgQueue.then(async () => {
    await afterPaint();
    return {
      thumbnail: await savedRowThumbnail(svg),
      preview_thumbnail: await hoverPreviewThumbnail(figure),
    };
  });
  portableSvgQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function storePlotArtifactWithRetry(
  analysisId: number,
  plotId: string,
  artifact: PlotArtifact,
  warmupTask?: CacheWarmupTask,
): Promise<PlotArtifact> {
  // Draft cards keep thumbnails in React Query only; posting `__draft__:*`
  // always 404s (not in saved_plots) and previously retry-stormed the API.
  if (isDraftPreviewPlotId(plotId)) return artifact;
  const expectedDataSignature = artifactDataSignatureForWrite(
    artifact.data_signature,
    warmupTask?.expected_data_signature,
  );
  const delays = [0, 800, 1600, 2600];
  let lastError: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      const stored = await post<PlotArtifact>(
        `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(plotId)}`,
        {
          ...artifact,
          warmup_task_id: warmupTask?.id,
          expected_data_signature: expectedDataSignature,
          expected_analysis_modified_at: warmupTask?.analysis_modified_at,
        }
      );
      if (!serverArtifactMatchesExpectedData(expectedDataSignature, stored.data_signature)) {
        throw new Error("The server returned a mismatched scientific artifact identity.");
      }
      return stored;
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  throw lastError;
}

export async function buildPortablePlotSnapshots(
  analysisId: number,
  baseSpec: AnalysisSpec,
  analysisTitle: string,
  selectedPlotIds: string[],
  onProgress?: (completed: number, total: number, stage: string) => void,
): Promise<PortablePlotSnapshot[]> {
  const saved = baseSpec.saved_plots ?? [];
  const views =
    saved.length > 0
      ? saved.filter((plot) => selectedPlotIds.includes(plot.id))
      : [
          {
            id: "current",
            tab: "cycles" as AnalysisTabKey,
            name: analysisTitle,
            subtitle: "Current analysis view",
            description: null,
          },
        ].filter((plot) => selectedPlotIds.includes(plot.id));

  const snapshots: PortablePlotSnapshot[] = [];
  for (let index = 0; index < views.length; index += 1) {
      const view = views[index];
      onProgress?.(index, views.length, `Preparing ${view.name}`);
      const viewSpec =
        "selection" in view
          ? specForSavedPlotView(baseSpec, view as SavedAnalysisPlot)
          : clone(baseSpec);
      const artifactSignature =
        "selection" in view
          ? savedPlotPreviewSignature(baseSpec, view as SavedAnalysisPlot)
          : null;
      let cachedArtifact: PlotArtifact | null = null;
      if (artifactSignature) {
        try {
          cachedArtifact = await post<PlotArtifact>(
            `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}/lookup`,
            { signature: artifactSignature }
          );
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
      }
      if (cachedArtifact) {
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure: cachedArtifact.figure,
          svg: cachedArtifact.svg,
          summary: cachedArtifact.summary,
          data_signature: cachedArtifact.data_signature ?? null,
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "time_capacity") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "time_capacity",
          spec: viewSpec,
        });
        const result = await post<TimeCapacityResult>(
          `/api/analyses/${analysisId}/time-capacity`,
          {
            spec: viewSpec,
            job_id: job.id,
            viewport_width: 1200,
            precision: "standard",
            compact: true,
          }
        );
        const previewResult = timeCapacityPreviewResult(result, viewSpec);
        const traces = previewResult
          ? timeCapacityTracesForResult(previewResult, viewSpec)
          : [];
        const layout = timeCapacityLayout(result, viewSpec, traces);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_traces.map((trace) => ({
          label: trace.label,
          cycles: new Set(trace.cycle.filter((cycle) => cycle !== null)).size,
          status: trace.excluded ? "Hidden" : "Visible",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "cycles") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "cycles",
          spec: viewSpec,
        });
        const result = await post<ComputeResult>(
          `/api/analyses/${analysisId}/compute`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = cycleTracesForResult(result, viewSpec);
        const layout = cyclePlotLayout(result, viewSpec, traces);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.metrics?.n_cycles ?? series.x.length,
          status: series.excluded ? "Hidden" : "Visible",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "steps") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "steps",
          spec: viewSpec,
        });
        const result = await post<StepsResult>(
          `/api/analyses/${analysisId}/steps`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = stepsTracesForResult(result, viewSpec);
        const layout = stepsLayoutForSpec(viewSpec);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.n_blocks,
          status: series.n_blocks > 0 ? "Visible" : "No matching blocks",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "dcir") {
        const job = await post<BackgroundJob>(`/api/analyses/${analysisId}/compute-jobs`, {
          kind: "dcir",
          spec: viewSpec,
        });
        const result = await post<DcirResult>(
          `/api/analyses/${analysisId}/dcir`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = dcirTracesForResult(result, viewSpec);
        const layout = dcirLayoutForSpec(viewSpec);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cell_series.map((series) => ({
          label: series.label,
          cycles: series.n_measurements,
          status: series.n_measurements > 0 ? "Visible" : "No measurements",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "chargeability") {
        const job = await post<BackgroundJob>(
          `/api/analyses/${analysisId}/compute-jobs`,
          {
            kind: "chargeability",
            spec: viewSpec,
          }
        );
        const result = await post<ChargeabilityResult>(
          `/api/analyses/${analysisId}/chargeability`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = chargeabilityTracesForResult(result, viewSpec);
        const layout = chargeabilityLayoutForSpec(viewSpec, result);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cells.map((cell) => ({
          label: cell.cell_name,
          cycles: cell.match_count,
          status:
            cell.match_count > 0
              ? "Matched"
              : cell.status === "no_candidates"
                ? "No candidates"
                : "No matching event",
        }));
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      if (view.tab === "crate") {
        const job = await post<BackgroundJob>(
          `/api/analyses/${analysisId}/compute-jobs`,
          {
            kind: "rate_capability",
            spec: viewSpec,
          }
        );
        const result = await post<RateCapabilityResult>(
          `/api/analyses/${analysisId}/rate-capability`,
          { spec: viewSpec, job_id: job.id }
        );
        const traces = rateCapabilityTracesForResult(result, viewSpec);
        const layout = rateCapabilityLayoutForSpec(viewSpec, result);
        const figure = traces.length ? portableFigure(traces, layout) : null;
        const images = figure ? await queuedPortableArtifactImages(figure) : null;
        const svg = images?.svg ?? null;
        const summary = result.cells.map((cell) => {
          const points =
            cell.families.charge.point_count +
            cell.families.discharge.point_count;
          return {
            label: cell.cell_name,
            cycles: points,
            status: points > 0 ? "Matched" : "No sweep detected",
          };
        });
        if (svg && figure && artifactSignature) {
          try {
            await post<PlotArtifact>(
              `/api/analyses/${analysisId}/plot-artifacts/${encodeURIComponent(view.id)}`,
              {
                signature: artifactSignature,
                expected_data_signature: requireDataSignature(result),
                svg,
                thumbnail: images?.thumbnail ?? null,
                preview_thumbnail: images?.preview_thumbnail ?? null,
                figure,
                summary,
              }
            );
          } catch (error) {
            throw error;
          }
        }
        snapshots.push({
          id: view.id,
          name: view.name,
          subtitle: view.subtitle,
          description: view.description,
          tab: view.tab,
          figure,
          svg,
          summary,
          data_signature: requireDataSignature(result),
          plot_revision: snapshotPlotRevision(view),
        });
        onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
        continue;
      }
      snapshots.push({
        id: view.id,
        name: view.name,
        subtitle: view.subtitle,
        description: view.description,
        tab: view.tab,
        figure: null,
        svg: null,
        summary: [],
        data_signature: null,
        plot_revision: snapshotPlotRevision(view),
      });
      onProgress?.(index + 1, views.length, `Prepared ${view.name}`);
  }
  return snapshots;
}
