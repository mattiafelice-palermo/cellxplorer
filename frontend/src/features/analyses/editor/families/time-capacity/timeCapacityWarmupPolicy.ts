import type { AnalysisSpec } from "../../../../../api";
import { timeCapacityPreviewMaxPoints, type TimeCapacityCycleRange } from "./timeCapacityCycleNavigationPolicy.ts";
import { timeCapacityScientificRequestSpec } from "../../policies/timeCapacityQueryPolicy.ts";

export const TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH = 1200;
export const NAVIGATION_WARMUP_IDLE_MS = 1500;
// Capture explicit input even when a control stops propagation. Hover is not input.
export const WARMUP_INTERACTION_EVENTS = [
  "pointerdown", "click", "keydown", "wheel", "touchstart", "focus",
] as const;

export function navigationWarmupCanAdmit(now: number, lastActivity: number, running: boolean): boolean {
  return !running && now - lastActivity >= NAVIGATION_WARMUP_IDLE_MS;
}

export function timeCapacityRangeSpec(
  spec: AnalysisSpec,
  config: NonNullable<AnalysisSpec["computation"]["time_capacity"]>,
  range: TimeCapacityCycleRange,
  resolution: "moving" | "full" = "full",
  maxPointsOverride?: number,
): AnalysisSpec {
  return {
    ...spec,
    computation: {
      ...spec.computation,
      time_capacity: {
        ...config,
        cycle_start: range.start,
        cycle_end: range.end,
        max_points_per_cell: maxPointsOverride ??
          timeCapacityPreviewMaxPoints(config.max_points_per_cell, resolution),
      },
    },
  };
}

export function timeCapacityWarmupBody(spec: AnalysisSpec) {
  return {
    spec: timeCapacityScientificRequestSpec(spec),
    viewport_width: TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH,
    precision: "standard" as const,
    compact: true,
    background: true,
    persist: true,
  };
}

/** Constant-space, finite sweep. Navigation does not reset its cursor. */
export class TimeCapacityWarmupSweep {
  private cursor = 0;
  readonly count: number;
  readonly width: number;
  readonly first: number;
  constructor(width: number, maximum: number, first: number) {
    this.width = width;
    this.first = first;
    this.count = Number.isSafeInteger(width) && Number.isSafeInteger(maximum) &&
      width > 0 && maximum >= width ? maximum - width + 1 : 0;
  }
  next(): { range: TimeCapacityCycleRange; resolution: "moving" | "full" } | null {
    if (this.cursor >= this.count * 2) return null;
    const start = ((Math.max(1, Math.min(this.count, this.first)) - 1 +
      Math.floor(this.cursor / 2)) % this.count) + 1;
    const resolution = this.cursor++ % 2 === 0 ? "moving" : "full";
    return { range: { start, end: start + this.width - 1 }, resolution };
  }
}
