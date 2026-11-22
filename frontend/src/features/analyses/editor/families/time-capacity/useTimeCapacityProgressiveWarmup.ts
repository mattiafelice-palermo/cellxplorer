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
  const wakeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let pointerHeld = false;
    let disposed = false;
    let running = false;
    let progress: { identity: string; done: boolean } | null = null;
    let failure = "";
    let timer: number | null = null;
    const owner = Symbol("navigation-preparation");
    let details = { ...EMPTY_WARMUP_DEBUG };
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = (delayMs: number) => {
      if (disposed) return;
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        pump();
      }, delayMs);
    };
    const report = (state: WarmupDebug["state"], reason: string) => {
      if (disposed) return;
      const current = latest.current;
      publishWarmupDebug(owner, {
        ...details, state, reason, active: current.active,
        analysisId: current.analysisId, plot: String(current.plotIdentity ?? "draft"),
        inFlight: running, running: running ? 1 : 0,
      });
    };
    const markActive = () => {
      lastActivity.current = Date.now();
      if (!progress?.done && !failure && !running && latest.current.active) {
        pump();
      }
    };
    const down = () => { pointerHeld = true; lastActivity.current = Date.now(); clearTimer(); };
    const up = () => { pointerHeld = false; lastActivity.current = Date.now(); pump(); };
    WARMUP_INTERACTION_EVENTS.forEach(event =>
      window.addEventListener(event, markActive, { capture: true, passive: true }));
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up, true);
    document.addEventListener("visibilitychange", up);
    const unsubscribeCache = queryClient.getQueryCache().subscribe(() => {
      if (!disposed && !progress?.done && !failure && !running && latest.current.active) {
        if (timer === null) schedule(150);
      }
    });
    const pump = () => {
      if (disposed) return;
      clearTimer();
      const current = latest.current;
      const foregroundBlocked = current.blocked || current.foregroundBusy();
      const blocked = !current.active ? "Time/Capacity plot is not active." :
        document.visibilityState !== "visible" ? "Window is hidden." :
        !current.spec.selection.entries.length ? "No samples selected." :
        timeCapacityPreparationUnsupportedReason(current.spec, current.config) ||
        (!current.maximum ? "Waiting for the available cycle extent." :
        !current.enabled ? "Waiting for a successful, current plot result." :
        !current.sourceIdentity ? "Waiting for source identity." :
        pointerHeld ? "Pointer or slider gesture is still held." :
        foregroundBlocked ? "Foreground plot work is active." : "");
      if (blocked) {
        report("Paused", blocked);
        // Only poll while waiting on an in-flight foreground callback;
        // inactive, hidden, pointer-held, and prop-gated states wake reactively.
        if (foregroundBlocked && current.active && document.visibilityState === "visible" && !pointerHeld) {
          schedule(300);
        }
        return;
      }
      if (queryClient.isFetching({ predicate: query => query.meta?.cacheOnly !== true &&
        /^(time-capacity|compute|dcir|chargeability|rate-capability|steps)$/.test(String(query.queryKey[0]))
      })) {
        report("Paused", "A foreground scientific query is running.");
        schedule(300);
        return;
      }
      const body = timeCapacityPreparationBody(current.spec, current.config);
      const identity = JSON.stringify({
        analysis: current.analysisId, plot: current.plotIdentity,
        source: current.sourceIdentity, maximum: current.maximum, spec: body.spec,
      });
      if (progress?.identity !== identity) {
        progress = { identity, done: false };
        details = { ...EMPTY_WARMUP_DEBUG };
        failure = "";
        lastActivity.current = Date.now();
      }
      if (failure) { report("Error", failure); return; }
      if (progress.done) {
        report("Complete", details.skipped
          ? "Preparation checked all Cells; unsupported or budget-limited Cells use ordinary reads."
          : "Reusable Cell data is ready. Navigation assembles windows on demand.");
        return;
      }
      const now = Date.now();
      if (!navigationWarmupCanAdmit(now, lastActivity.current, preparationSlot.running > 0)) {
        report(running ? "Running" : "Waiting", preparationSlot.running
          ? "Finishing the admitted Cell-preparation batch."
          : "Waiting for 1.5 seconds without explicit interaction.");
        const remainingMs = preparationSlot.running > 0
          ? 250
          : Math.max(50, 1500 - (now - lastActivity.current));
        schedule(remainingMs);
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
    wakeRef.current = pump;
    pump();
    return () => {
      disposed = true;
      wakeRef.current = null;
      removeWarmupDebug(owner);
      clearTimer();
      unsubscribeCache();
      WARMUP_INTERACTION_EVENTS.forEach(event => window.removeEventListener(event, markActive, true));
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up, true);
      document.removeEventListener("visibilitychange", up);
    };
  }, [queryClient]);

  useEffect(() => {
    wakeRef.current?.();
  }, [
    options.active,
    options.analysisId,
    options.blocked,
    options.config,
    options.enabled,
    options.maximum,
    options.plotIdentity,
    options.sourceIdentity,
    options.spec,
  ]);
}
