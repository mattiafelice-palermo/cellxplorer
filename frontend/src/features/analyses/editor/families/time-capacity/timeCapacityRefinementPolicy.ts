import type {
  AnalysisSpec,
  TimeCapacityRefinementResult,
  TimeCapacityResult,
  TimeCapacityTrace,
} from "../../../../../api";

export type TimeCapacityViewport = { min: number; max: number };
export type TimeCapacityCycleRange = { start: number; end: number };

/** Publish the first few cycles quickly, then use at most four follow-up batches. */
export function timeCapacityRefinementChunks(range: TimeCapacityCycleRange): TimeCapacityCycleRange[] {
  const chunks: TimeCapacityCycleRange[] = [];
  let start = range.start;
  const firstEnd = Math.min(range.end, start + 3);
  chunks.push({ start, end: firstEnd });
  start = firstEnd + 1;
  const remaining = Math.max(0, range.end - start + 1);
  const chunkSize = Math.max(8, Math.ceil(remaining / 4));
  while (start <= range.end) {
    const end = Math.min(range.end, start + chunkSize - 1);
    chunks.push({ start, end });
    start = end + 1;
  }
  return chunks;
}

function traceIdentity(trace: TimeCapacityTrace): string {
  return `${trace.cell_id}:${trace.group_id ?? ""}:${trace.label}`;
}

/** Merge successive cycle batches without changing the plotted overview axes. */
export function mergeTimeCapacityRefinementChunks(
  chunks: readonly TimeCapacityRefinementResult[],
): TimeCapacityRefinementResult | null {
  if (!chunks.length) return null;
  const base = chunks[0];
  const traces = new Map(base.cell_traces.map((trace) => [traceIdentity(trace), { ...trace }]));
  for (const part of chunks.slice(1)) {
    for (const incoming of part.cell_traces) {
      const key = traceIdentity(incoming);
      const current = traces.get(key);
      if (!current) { traces.set(key, { ...incoming }); continue; }
      const rowOffset = current.cycle.length;
      const merged = { ...current } as TimeCapacityTrace & Record<string, unknown>;
      const sources = [...(current.sources ?? [])];
      const sourceIndexes = new Map(sources.map((source, index) => [source.hash, index]));
      for (const source of incoming.sources ?? []) {
        if (sourceIndexes.has(source.hash)) continue;
        sourceIndexes.set(source.hash, sources.length);
        sources.push(source);
      }
      for (const [field, value] of Object.entries(incoming)) {
        if (field === "segments" || field === "source_descriptors" || field === "sources") continue;
        if (field === "source_index" && Array.isArray(value)) {
          const incomingSources = incoming.sources ?? [];
          merged.source_index = value.map((sourceIndex) => {
            if (typeof sourceIndex !== "number" || !Number.isInteger(sourceIndex)) return null;
            const source = incomingSources[sourceIndex];
            if (!source) return null;
            return sourceIndexes.get(source.hash) ?? null;
          });
          merged.source_index = [
            ...(current.source_index ?? []),
            ...merged.source_index,
          ];
        } else if (field === "source_boundary_indices" && Array.isArray(value)) {
          merged.source_boundary_indices = [
            ...(current.source_boundary_indices ?? []),
            ...value.map((index) => Number(index) + rowOffset),
          ];
        } else if (field === "voltage_v_by_channel" && value && typeof value === "object") {
          const left = current.voltage_v_by_channel ?? {};
          const right = value as NonNullable<TimeCapacityTrace["voltage_v_by_channel"]>;
          merged.voltage_v_by_channel = Object.fromEntries(
            [...new Set([...Object.keys(left), ...Object.keys(right)])].map((channel) => [channel, [
              ...((left as Record<string, (number | null)[]>)[channel] ?? []),
              ...((right as Record<string, (number | null)[]>)[channel] ?? []),
            ]]),
          ) as TimeCapacityTrace["voltage_v_by_channel"];
        } else if (field === "display_only_cycle") {
          const currentValues = (current as Record<string, unknown>).display_only_cycle;
          const incomingValues = value;
          (merged as Record<string, unknown>).display_only_cycle = [
            ...(Array.isArray(currentValues)
              ? currentValues
              : Array.from({ length: rowOffset }, () => false)),
            ...(Array.isArray(incomingValues)
              ? incomingValues
              : Array.from({ length: incoming.cycle.length }, () => false)),
          ];
        } else if (Array.isArray(value)) {
          (merged as Record<string, unknown>)[field] = [
            ...(Array.isArray((current as Record<string, unknown>)[field])
              ? (current as Record<string, unknown>)[field] as unknown[] : []),
            ...value,
          ];
        } else if (field === "display_x_cycle_origins" && value && typeof value === "object") {
          (merged as Record<string, unknown>)[field] = {
            ...(((current as Record<string, unknown>)[field] as Record<string, unknown> | undefined) ?? {}),
            ...(value as Record<string, unknown>),
          };
        }
      }
      // The backend omits this optional marker array when a batch has no
      // display-only rows. Keep omitted batches row-aligned as explicit false.
      if (!Object.prototype.hasOwnProperty.call(incoming, "display_only_cycle")) {
        const currentValues = (current as Record<string, unknown>).display_only_cycle;
        if (Array.isArray(currentValues)) {
          (merged as Record<string, unknown>).display_only_cycle = [
            ...currentValues,
            ...Array.from({ length: incoming.cycle.length }, () => false),
          ];
        }
      }
      if (incoming.segments?.length) {
        const segments = new Map((current.segments ?? []).map((segment) => [`${segment.file_hash}:${segment.segment}`, { ...segment }]));
        for (const segment of incoming.segments) {
          const segmentKey = `${segment.file_hash}:${segment.segment}`;
          const previous = segments.get(segmentKey);
          if (!previous) segments.set(segmentKey, { ...segment });
          else segments.set(segmentKey, {
            ...previous,
            cycle_start: previous.cycle_start === null ? segment.cycle_start : segment.cycle_start === null ? previous.cycle_start : Math.min(previous.cycle_start, segment.cycle_start),
            cycle_end: previous.cycle_end === null ? segment.cycle_end : segment.cycle_end === null ? previous.cycle_end : Math.max(previous.cycle_end, segment.cycle_end),
            display_only_source_cycles: [...new Set([...(previous.display_only_source_cycles ?? []), ...(segment.display_only_source_cycles ?? [])])],
          });
        }
        merged.segments = [...segments.values()];
      }
      if (incoming.source_descriptors?.length) {
        const descriptors = new Map((current.source_descriptors ?? []).map((item) => [item.source_hash, item]));
        incoming.source_descriptors.forEach((item) => {
          const previous = descriptors.get(item.source_hash);
          if (!previous) descriptors.set(item.source_hash, item);
          else descriptors.set(item.source_hash, {
            ...previous,
            local_cycle_start: previous.local_cycle_start === null ? item.local_cycle_start : item.local_cycle_start === null ? previous.local_cycle_start : Math.min(previous.local_cycle_start, item.local_cycle_start),
            local_cycle_end: previous.local_cycle_end === null ? item.local_cycle_end : item.local_cycle_end === null ? previous.local_cycle_end : Math.max(previous.local_cycle_end, item.local_cycle_end),
            global_cycle_start: previous.global_cycle_start === null ? item.global_cycle_start : item.global_cycle_start === null ? previous.global_cycle_start : Math.min(previous.global_cycle_start, item.global_cycle_start),
            global_cycle_end: previous.global_cycle_end === null ? item.global_cycle_end : item.global_cycle_end === null ? previous.global_cycle_end : Math.max(previous.global_cycle_end, item.global_cycle_end),
            display_only_source_cycles: [...new Set([...(previous.display_only_source_cycles ?? []), ...(item.display_only_source_cycles ?? [])])],
          });
        });
        merged.source_descriptors = [...descriptors.values()];
      }
      if (sources.length) merged.sources = sources;
      traces.set(key, merged);
    }
  }
  const latest = chunks[chunks.length - 1];
  const merged: TimeCapacityRefinementResult = {
    ...base,
    ...latest,
    cell_traces: [...traces.values()],
  };
  if (latest.rendering) {
    merged.rendering = {
      ...latest.rendering,
      total_points: chunks.reduce((total, chunk) => total + (chunk.rendering?.total_points ?? 0), 0),
    };
  }
  return merged;
}

export const TIME_CAPACITY_REFINEMENT_TRANSITION_MS = 140;

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function timeCapacityOverviewExtent(
  result: TimeCapacityResult | undefined,
): TimeCapacityViewport | null {
  if (!result) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    for (const value of trace.display_x ?? []) {
      if (!finite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function timeCapacityCycleRangeForViewport(
  result: TimeCapacityResult | undefined,
  viewport: TimeCapacityViewport,
): TimeCapacityCycleRange | null {
  const visible = timeCapacityVisibleCycleRangeForViewport(result, viewport);
  if (!result || !visible) return null;
  let globalMin = Number.POSITIVE_INFINITY;
  let globalMax = Number.NEGATIVE_INFINITY;
  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    for (const cycle of trace.cycle) {
      if (typeof cycle !== "number" || !Number.isInteger(cycle)) continue;
      globalMin = Math.min(globalMin, cycle);
      globalMax = Math.max(globalMax, cycle);
    }
  }
  return {
    start: Math.max(globalMin, visible.start - 1),
    end: Math.min(globalMax, visible.end + 1),
  };
}

/** Exact cycle bounds intersecting the live Plotly x viewport. */
export function timeCapacityVisibleCycleRangeForViewport(
  result: TimeCapacityResult | undefined,
  viewport: TimeCapacityViewport,
): TimeCapacityCycleRange | null {
  if (!result) return null;
  const viewportMin = Math.min(viewport.min, viewport.max);
  const viewportMax = Math.max(viewport.min, viewport.max);
  const cycleSpans = new Map<number, TimeCapacityViewport>();
  for (const trace of result.cell_traces) {
    if (trace.excluded) continue;
    const x = trace.display_x ?? [];
    for (let index = 0; index < trace.cycle.length; index += 1) {
      const cycle = trace.cycle[index];
      const xValue = x[index];
      if (typeof cycle !== "number" || !Number.isInteger(cycle) || !finite(xValue)) continue;
      const span = cycleSpans.get(cycle);
      cycleSpans.set(cycle, {
        min: Math.min(span?.min ?? xValue, xValue),
        max: Math.max(span?.max ?? xValue, xValue),
      });
    }
  }
  let selectedMin = Number.POSITIVE_INFINITY;
  let selectedMax = Number.NEGATIVE_INFINITY;
  for (const [cycle, span] of cycleSpans) {
    if (span.max >= viewportMin && span.min <= viewportMax) {
      selectedMin = Math.min(selectedMin, cycle);
      selectedMax = Math.max(selectedMax, cycle);
    }
  }
  if (!Number.isFinite(selectedMin) || !Number.isFinite(selectedMax)) return null;
  return { start: selectedMin, end: selectedMax };
}

export function timeCapacityRefinementWorthwhile(
  overview: TimeCapacityViewport | null,
  viewport: TimeCapacityViewport,
): boolean {
  if (!overview) return false;
  const fullSpan = overview.max - overview.min;
  const visibleSpan = viewport.max - viewport.min;
  return fullSpan > 0 && visibleSpan > 0 && visibleSpan <= fullSpan * 0.5;
}

export function timeCapacityRefinementRequestIsCurrent(
  response: TimeCapacityRefinementResult,
  currentResult: TimeCapacityResult | undefined,
  generation: string,
): boolean {
  return Boolean(
    currentResult &&
      response.request_generation === generation &&
      timeCapacityRefinementResultMatchesOverview(response, currentResult),
  );
}

/**
 * A displayed refinement is not tied to the generation of the next request.
 * It is valid only while it still describes the current overview identity.
 * Request-generation matching remains the stricter rule used when accepting
 * a newly arriving response.
 */
export function timeCapacityRefinementResultMatchesOverview(
  response: TimeCapacityRefinementResult,
  currentResult: TimeCapacityResult | undefined,
): boolean {
  return Boolean(
    currentResult &&
      response.overview_data_signature === currentResult.data_signature &&
      response.data_signature === currentResult.data_signature,
  );
}

/**
 * Return whether a displayed refinement covers the next visible viewport.
 * Viewport bounds are client-only metadata; they never affect scientific or
 * persisted result identity.
 */
export function timeCapacityViewportContains(
  displayedViewport: TimeCapacityViewport | null,
  nextViewport: TimeCapacityViewport | null,
): boolean {
  if (!displayedViewport || !nextViewport) return false;
  const displayedMin = Math.min(displayedViewport.min, displayedViewport.max);
  const displayedMax = Math.max(displayedViewport.min, displayedViewport.max);
  const nextMin = Math.min(nextViewport.min, nextViewport.max);
  const nextMax = Math.max(nextViewport.min, nextViewport.max);
  if (![displayedMin, displayedMax, nextMin, nextMax].every(Number.isFinite)) {
    return false;
  }
  const tolerance = Math.max(1e-9, Math.abs(displayedMax - displayedMin) * 1e-9);
  return nextMin >= displayedMin - tolerance && nextMax <= displayedMax + tolerance;
}

/**
 * Decide whether the old refinement may remain visible while a replacement
 * request is pending. This intentionally excludes request generation: a
 * newer request invalidates old responses, but not a still-compatible view.
 */
export function timeCapacityRefinementDisplayIsCompatible(
  response: TimeCapacityRefinementResult | null,
  currentResult: TimeCapacityResult | undefined,
  displayedViewport: TimeCapacityViewport | null,
  nextViewport: TimeCapacityViewport | null,
): boolean {
  return Boolean(
    response &&
      timeCapacityRefinementResultMatchesOverview(response, currentResult) &&
      timeCapacityViewportContains(displayedViewport, nextViewport),
  );
}

export function timeCapacityRefinementTransitionDuration(
  prefersReducedMotion: boolean,
): number {
  return prefersReducedMotion ? 0 : TIME_CAPACITY_REFINEMENT_TRANSITION_MS;
}

export function timeCapacityRefinementTransitionProgress(
  elapsedMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0) return 1;
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

export function timeCapacityRefinementEligible(spec: AnalysisSpec): boolean {
  const cfg = spec.computation.time_capacity;
  const xAxis = cfg?.x_axis ?? "time";
  return (
    (cfg?.view ?? "voltage_current") === "voltage_current" &&
    (xAxis === "time" ||
      xAxis === "capacity_mah" ||
      xAxis === "capacity_mah_g" ||
      xAxis === "capacity_mah_cm2") &&
    (cfg?.display_mode ?? "consecutive") === "consecutive" &&
    !(cfg?.cycles?.length)
  );
}

/**
 * A refinement uses the same server result for flat and stacked rendering.
 * Stacking and the current-axis choices are client-side presentation, so they
 * must not invalidate an otherwise compatible high-resolution response.
 */
export function timeCapacityRefinementDisplayIsCurrent(
  response: TimeCapacityRefinementResult | null,
  currentResult: TimeCapacityResult | undefined,
  displayedCompatibilitySignature: string | null,
  compatibilitySignature: string,
): boolean {
  return Boolean(
    response &&
      displayedCompatibilitySignature === compatibilitySignature &&
      timeCapacityRefinementResultMatchesOverview(response, currentResult),
  );
}

export function timeCapacityRefinementCanSchedule(
  active: boolean,
  spec: AnalysisSpec,
): boolean {
  return active && timeCapacityRefinementEligible(spec);
}
