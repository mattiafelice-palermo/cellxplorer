import type { AnalysisSpec } from "../../../../../api";
import { timeCapacityPreviewMaxPoints, type TimeCapacityCycleRange } from "./timeCapacityCycleNavigationPolicy.ts";
import { timeCapacityScientificRequestSpec } from "../../policies/timeCapacityQueryPolicy.ts";
import { timeCapacityUsesContinuousTime } from "../../policies/timeCapacityQueryPolicy.ts";

export const TIME_CAPACITY_COMMITTED_VIEWPORT_WIDTH = 1200;
export const NAVIGATION_WARMUP_IDLE_MS = 1500;
// Capture explicit input even when a control stops propagation. Hover is not input.
export const WARMUP_INTERACTION_EVENTS = [
  "pointerdown", "click", "keydown", "wheel", "touchstart",
] as const;

export function navigationWarmupCanAdmit(now: number, lastActivity: number, running: boolean): boolean {
  return !running && now - lastActivity >= NAVIGATION_WARMUP_IDLE_MS;
}

/** Shared across mounted cards and preparation generations; HTTP cancellation is not CPU cancellation. */
export class NavigationWarmupSlots {
  running = 0;
  readonly limit = 1;
  acquire(): (() => void) | null {
    if (this.running >= this.limit) return null;
    this.running++;
    let released = false;
    return () => { if (!released) { released = true; this.running--; } };
  }
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

export function timeCapacityPreparationBody(
  spec: AnalysisSpec, config: NonNullable<AnalysisSpec["computation"]["time_capacity"]>,
) {
  return {
    spec: timeCapacityScientificRequestSpec(timeCapacityRangeSpec(
      spec, config, { start: 1, end: 1 }, "full", 4000,
    )),
  };
}

export function timeCapacityPreparationUnsupportedReason(
  spec: AnalysisSpec, config: NonNullable<AnalysisSpec["computation"]["time_capacity"]>,
): string {
  const filter = spec.computation.protocol_filter;
  const channels = config.voltage_channels ?? [config.voltage_channel ?? "voltage"];
  if (timeCapacityUsesContinuousTime(config)) return "Continuous mode uses ordinary reads.";
  if (config.cycles.length) return "Explicit cycle lists use ordinary reads.";
  if (config.x_axis !== "time" || config.view !== "voltage_current" || config.display_mode !== "consecutive" ||
      channels.length !== 1 || channels[0] !== "voltage" ||
      filter?.excluded_segment_ids.length || filter?.only_segment_ids.length) {
    return "This plot configuration uses ordinary reads; no window sweep is generated.";
  }
  return "";
}
