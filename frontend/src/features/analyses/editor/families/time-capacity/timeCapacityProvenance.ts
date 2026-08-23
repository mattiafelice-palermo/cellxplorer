import type { TimeCapacityTrace } from "../../../../../api";

export type TimeCapacitySourcePoint = {
  position: number | null;
  filename: string | null;
  hash: string | null;
};

/**
 * Resolve one plotted row's source without rebuilding the pre-050.15
 * duplicated provenance arrays. The fallback keeps old non-compact/legacy
 * payloads readable while compact ordinary responses use only the table and
 * row index.
 */
export function timeCapacitySourceAt(
  trace: TimeCapacityTrace,
  pointIndex: number,
): TimeCapacitySourcePoint {
  const sourceIndex = trace.source_index?.[pointIndex];
  if (
    sourceIndex !== undefined &&
    Number.isInteger(sourceIndex) &&
    sourceIndex !== null &&
    sourceIndex >= 0 &&
    sourceIndex < (trace.sources?.length ?? 0)
  ) {
    const source = trace.sources![sourceIndex];
    return {
      position: source.position,
      filename: source.filename,
      hash: source.hash,
    };
  }
  return {
    position: trace.source_position?.[pointIndex] ?? null,
    filename: trace.source_filename?.[pointIndex] ?? null,
    hash: trace.source_hash?.[pointIndex] ?? null,
  };
}

export function timeCapacitySourcesForRange(
  trace: TimeCapacityTrace,
  start: number,
  end: number,
): TimeCapacitySourcePoint[] {
  const points: TimeCapacitySourcePoint[] = [];
  for (let index = start; index < end; index += 1) {
    points.push(timeCapacitySourceAt(trace, index));
  }
  return points;
}
