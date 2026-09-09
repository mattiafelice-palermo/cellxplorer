import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post, type AnalysisSpec } from "../../../../../api";
import {
  navigationWarmupCanAdmit, WARMUP_INTERACTION_EVENTS,
  TimeCapacityWarmupSweep, timeCapacityRangeSpec, timeCapacityWarmupBody,
} from "./timeCapacityWarmupPolicy";
import { normalizeCycleRangeForNavigation } from "./timeCapacityCycleNavigationPolicy";
import { timeCapacityUsesContinuousTime } from "../../policies/timeCapacityQueryPolicy";

// Survives card unmounts: abandoning an HTTP observer does not cancel backend CPU.
let speculativeRequestRunning = false;

export function useTimeCapacityProgressiveWarmup(options: {
  analysisId: number;
  spec: AnalysisSpec;
  config: NonNullable<AnalysisSpec["computation"]["time_capacity"]>;
  maximum: number | null;
  enabled: boolean;
  blocked: boolean;
  foregroundBusy: () => boolean;
  sourceIdentity?: string;
  plotIdentity?: string | number;
}) {
  const queryClient = useQueryClient();
  const latest = useRef(options);
  latest.current = options;
  const progress = useRef<{ identity: string; sweep: TimeCapacityWarmupSweep } | null>(null);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    let pointerHeld = false;
    let disposed = false;
    const markActive = () => { lastActivity.current = Date.now(); };
    const down = () => { pointerHeld = true; markActive(); };
    const up = () => { pointerHeld = false; markActive(); };
    WARMUP_INTERACTION_EVENTS.forEach(event =>
      window.addEventListener(event, markActive, { capture: true, passive: true }));
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up, true);
    document.addEventListener("visibilitychange", up);
    const timer = window.setInterval(async () => {
      const current = latest.current;
      const { config, maximum } = current;
      if (!current.enabled || current.blocked || current.foregroundBusy() || pointerHeld ||
          document.visibilityState !== "visible" || !maximum ||
          !current.sourceIdentity || !current.spec.selection.entries.length ||
          config.cycles.length > 0 || timeCapacityUsesContinuousTime(config)) {
        markActive();
        return;
      }
      // Polling activity/status queries do not starve scientific preparation.
      if (queryClient.isFetching({ predicate: query =>
        /^(time-capacity|compute|dcir|chargeability|rate-capability|steps)$/.test(String(query.queryKey[0]))
      })) { markActive(); return; }
      const range = normalizeCycleRangeForNavigation(config.cycle_start, config.cycle_end, maximum);
      const width = range.end - range.start + 1;
      const identity = JSON.stringify({
        analysis: current.analysisId, plot: current.plotIdentity,
        source: current.sourceIdentity, maximum,
        spec: timeCapacityWarmupBody(timeCapacityRangeSpec(current.spec, config, { start: 1, end: width })).spec,
      });
      if (progress.current?.identity !== identity) {
        progress.current = { identity, sweep: new TimeCapacityWarmupSweep(width, maximum, range.start) };
        markActive();
      }
      if (!navigationWarmupCanAdmit(Date.now(), lastActivity.current, speculativeRequestRunning)) return;
      const task = progress.current.sweep.next();
      if (!task) return;
      speculativeRequestRunning = true;
      try {
        // No React Query insertion, job token, recipe mutation, or cancellation.
        await post(`/api/analyses/${current.analysisId}/time-capacity`, timeCapacityWarmupBody(
          timeCapacityRangeSpec(current.spec, config, task.range, task.resolution),
        ));
      } catch {
        // An unavailable source/server stops this sweep; no automatic retry loop.
        if (!disposed && progress.current?.identity === identity) progress.current = {
          identity, sweep: new TimeCapacityWarmupSweep(0, 0, 1),
        };
      } finally {
        speculativeRequestRunning = false;
      }
    }, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      WARMUP_INTERACTION_EVENTS.forEach(event => window.removeEventListener(event, markActive, true));
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up, true);
      document.removeEventListener("visibilitychange", up);
    };
  }, [queryClient]);
}
