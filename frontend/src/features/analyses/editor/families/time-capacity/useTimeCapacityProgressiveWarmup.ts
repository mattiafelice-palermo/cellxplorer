import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post, type AnalysisSpec } from "../../../../../api";
import {
  navigationWarmupCanAdmit, WARMUP_INTERACTION_EVENTS, NavigationWarmupSlots,
  timeCapacityPreparationBody, timeCapacityPreparationUnsupportedReason,
} from "./timeCapacityWarmupPolicy";
import { EMPTY_WARMUP_DEBUG, publishWarmupDebug, removeWarmupDebug, type WarmupDebug } from "./timeCapacityWarmupDebug";

// A single admitted batch survives unmounts until backend work actually finishes.
const preparationSlot = new NavigationWarmupSlots();

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
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    let pointerHeld = false;
    let disposed = false;
    let running = false;
    let progress: { identity: string; done: boolean } | null = null;
    let failure = "";
    const owner = Symbol("navigation-preparation");
    let details = { ...EMPTY_WARMUP_DEBUG };
    const report = (state: WarmupDebug["state"], reason: string) => {
      if (disposed) return;
      const current = latest.current;
      publishWarmupDebug(owner, {
        ...details, state, reason, active: current.active,
        analysisId: current.analysisId, plot: String(current.plotIdentity ?? "draft"),
        inFlight: running, running: running ? 1 : 0,
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
      const blocked = !current.active ? "Time/Capacity plot is not active." :
        document.visibilityState !== "visible" ? "Window is hidden." :
        !current.spec.selection.entries.length ? "No samples selected." :
        timeCapacityPreparationUnsupportedReason(current.spec, current.config) ||
        (!current.maximum ? "Waiting for the available cycle extent." :
        !current.enabled ? "Waiting for a successful, current plot result." :
        !current.sourceIdentity ? "Waiting for source identity." :
        pointerHeld ? "Pointer or slider gesture is still held." :
        current.blocked || current.foregroundBusy() ? "Foreground plot work is active." : "");
      if (blocked) { report("Paused", blocked); return; }
      if (queryClient.isFetching({ predicate: query => query.meta?.cacheOnly !== true &&
        /^(time-capacity|compute|dcir|chargeability|rate-capability|steps)$/.test(String(query.queryKey[0]))
      })) { report("Paused", "A foreground scientific query is running."); return; }
      const body = timeCapacityPreparationBody(current.spec, current.config);
      const identity = JSON.stringify({
        analysis: current.analysisId, plot: current.plotIdentity,
        source: current.sourceIdentity, maximum: current.maximum, spec: body.spec,
      });
      if (progress?.identity !== identity) {
        progress = { identity, done: false };
        details = { ...EMPTY_WARMUP_DEBUG };
        failure = "";
        markActive();
      }
      if (failure) { report("Error", failure); return; }
      if (progress.done) {
        report("Complete", details.skipped
          ? "Preparation checked all Cells; unsupported or budget-limited Cells use ordinary reads."
          : "Reusable Cell data is ready. Navigation assembles windows on demand.");
        return;
      }
      if (!navigationWarmupCanAdmit(Date.now(), lastActivity.current, preparationSlot.running > 0)) {
        report(running ? "Running" : "Waiting", preparationSlot.running
          ? "Finishing the admitted Cell-preparation batch."
          : "Waiting for 1.5 seconds without explicit interaction.");
        return;
      }
      const release = preparationSlot.acquire()!;
      const admitted = progress;
      running = true;
      details.request = "Reusable full-resolution Cell arrays";
      const started = performance.now();
      report("Running", "Preparing Cell data once; no overlapping window results are generated.");
      void (async () => {
        try {
          const result = await post<{ status: string; total: number; prepared: number; reused: number; skipped: number }>(
            `/api/analyses/${current.analysisId}/time-capacity/prepare`, body);
          if (!disposed && progress === admitted) {
            admitted.done = true;
            details.total = result.total;
            details.completed = result.total;
            details.hits = result.reused;
            details.misses = result.prepared;
            details.skipped = result.skipped || (result.status === "unsupported" ? 1 : 0);
            details.lastMs = performance.now() - started;
          }
        } catch (error) {
          if (!disposed && progress === admitted) {
            failure = `Preparation stopped: ${error instanceof Error ? error.message : String(error)}`;
          }
        } finally {
          release();
          running = false;
          if (disposed) removeWarmupDebug(owner);
          else pump();
        }
      })();
    };
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
