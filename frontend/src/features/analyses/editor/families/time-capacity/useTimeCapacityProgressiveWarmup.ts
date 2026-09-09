import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post, type AnalysisSpec } from "../../../../../api";
import {
  navigationWarmupCanAdmit, WARMUP_INTERACTION_EVENTS, NavigationWarmupSlots,
  TimeCapacityWarmupSweep, timeCapacityRangeSpec, timeCapacityWarmupBody,
} from "./timeCapacityWarmupPolicy";
import { normalizeCycleRangeForNavigation } from "./timeCapacityCycleNavigationPolicy";
import { timeCapacityUsesContinuousTime } from "../../policies/timeCapacityQueryPolicy";
import { EMPTY_WARMUP_DEBUG, publishWarmupDebug, removeWarmupDebug, type WarmupDebug } from "./timeCapacityWarmupDebug";

// Survives card unmounts: abandoning an HTTP observer does not cancel backend CPU.
const speculativeSlots = new NavigationWarmupSlots();

export function useTimeCapacityProgressiveWarmup(options: {
  analysisId: number;
  spec: AnalysisSpec;
  config: NonNullable<AnalysisSpec["computation"]["time_capacity"]>;
  maximum: number | null;
  enabled: boolean;
  active: boolean;
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
    const owner = Symbol("navigation-warmup");
    let details = { ...EMPTY_WARMUP_DEBUG };
    let localRunning = 0;
    const requests = new Map<symbol, string>();
    let failure = "";
    const report = (state: WarmupDebug["state"], reason: string) => {
      if (disposed) return;
      const current = latest.current;
      publishWarmupDebug(owner, {
        ...details, state, reason, active: current.active,
        analysisId: current.analysisId, plot: String(current.plotIdentity ?? "draft"),
        inFlight: localRunning > 0, running: localRunning,
        request: requests.size ? [...requests.values()].join("; ") : details.request,
      });
    };
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
    const pump = () => {
      if (disposed) return;
      const current = latest.current;
      const { config, maximum } = current;
      const blockedReason = !current.active ? "Time/Capacity plot is not active." :
        document.visibilityState !== "visible" ? "Window is hidden." :
        !current.spec.selection.entries.length ? "No samples selected." :
        timeCapacityUsesContinuousTime(config) ? "Continuous mode does not warm cycle windows." :
        config.cycles.length > 0 ? "An explicit cycle list is selected; window warming is disabled." :
        !maximum ? "Waiting for the available cycle extent." :
        !current.enabled ? "Waiting for a successful, current plot result." :
        !current.sourceIdentity ? "Waiting for source identity." :
        pointerHeld ? "Pointer or slider gesture is still held." :
        current.blocked || current.foregroundBusy() ? "Foreground plot request, navigation, refinement, or export is active." : "";
      if (blockedReason) {
        report("Paused", blockedReason);
        return;
      }
      // Polling activity/status queries do not starve scientific preparation.
      if (queryClient.isFetching({ predicate: query =>
        query.meta?.cacheOnly !== true &&
        /^(time-capacity|compute|dcir|chargeability|rate-capability|steps)$/.test(String(query.queryKey[0]))
      })) { report("Paused", "A foreground scientific query is running."); return; }
      const range = normalizeCycleRangeForNavigation(config.cycle_start, config.cycle_end, maximum);
      const width = range.end - range.start + 1;
      const identity = JSON.stringify({
        analysis: current.analysisId, plot: current.plotIdentity,
        source: current.sourceIdentity, maximum,
        spec: timeCapacityWarmupBody(timeCapacityRangeSpec(current.spec, config, { start: 1, end: width })).spec,
      });
      if (progress.current?.identity !== identity) {
        progress.current = { identity, sweep: new TimeCapacityWarmupSweep(width, maximum!, range.start) };
        details = { ...EMPTY_WARMUP_DEBUG, total: progress.current.sweep.count * 2 };
        failure = "";
        markActive();
      }
      if (failure) { report("Error", failure); return; }
      if (!navigationWarmupCanAdmit(Date.now(), lastActivity.current, speculativeSlots.running >= speculativeSlots.limit)) {
        report(localRunning ? "Running" : "Waiting", speculativeSlots.running >= speculativeSlots.limit
          ? "All four background request slots are occupied."
          : "Waiting for 1.5 seconds without explicit interaction.");
        return;
      }
      while (speculativeSlots.running < speculativeSlots.limit) {
        const task = progress.current.sweep.next();
        if (!task) {
          report(localRunning ? "Running" : "Complete", localRunning
            ? "Finishing the remaining admitted requests."
            : "This sweep is finished. Cache eviction may remove older prepared results.");
          return;
        }
        const release = speculativeSlots.acquire()!;
        localRunning++;
        const requestId = Symbol("request");
        const admittedProgress = progress.current;
        details.request = `Cycles ${task.range.start}–${task.range.end} · ${task.resolution === "moving" ? "moving preview" : "settled plot"}`;
        requests.set(requestId, details.request);
        const started = performance.now();
        report("Running", "Preparing cycle windows in the background.");
        void (async () => {
          try {
            // No React Query insertion, job token, recipe mutation, or cancellation.
            const result = await post<{ cache_status?: string }>(`/api/analyses/${current.analysisId}/time-capacity`, timeCapacityWarmupBody(
              timeCapacityRangeSpec(current.spec, config, task.range, task.resolution),
            ));
            if (!disposed && progress.current === admittedProgress) {
              details.completed++;
              details.lastMs = performance.now() - started;
              if (result.cache_status === "hit") details.hits++;
              if (result.cache_status === "miss") details.misses++;
            }
          } catch (error) {
            // An unavailable source/server stops this sweep; no automatic retry loop.
            if (!disposed && progress.current === admittedProgress) {
              failure = `Preparation stopped: ${error instanceof Error ? error.message : String(error)}`;
            }
          } finally {
            release();
            localRunning--;
            requests.delete(requestId);
            if (disposed) removeWarmupDebug(owner);
            else pump();
          }
        })();
      }
    };
    // Timer only discovers idle/gate changes. Every completion refills immediately.
    const timer = window.setInterval(pump, 100);
    return () => {
      disposed = true;
      removeWarmupDebug(owner);
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
