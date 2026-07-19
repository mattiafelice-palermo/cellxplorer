import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type AnalysisFull,
  type CacheSettings,
  type CacheWarmupTask,
} from "../api";
import { isTauriApp } from "../downloads";
import { AnalysisCacheWarmupRenderer } from "../pages/AnalysisPage";

async function mainWindowIsHidden(): Promise<boolean> {
  if (!isTauriApp()) return document.visibilityState === "hidden";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return !(await invoke<boolean>("is_main_window_visible"));
  } catch {
    return document.visibilityState === "hidden";
  }
}

export const WARMUP_NOW_EVENT = "cellxplorer:warmup-now";

export function CacheWarmupCoordinator({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const lastInteraction = useRef(Date.now());
  const busy = useRef(false);
  const lastPoll = useRef(0);
  const pauseRequested = useRef(false);
  const forceRun = useRef(false);
  const [task, setTask] = useState<CacheWarmupTask | null>(null);
  const settings = useQuery({
    queryKey: ["cache-settings"],
    queryFn: () => get<CacheSettings>("/api/cache/settings"),
    enabled,
    staleTime: 60_000,
  });
  const analysis = useQuery({
    queryKey: ["analysis-cache-warmup", task?.analysis_id],
    queryFn: () => get<AnalysisFull>(`/api/analyses/${task!.analysis_id}`),
    enabled: task !== null,
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    const markActive = () => {
      lastInteraction.current = Date.now();
      if (pauseRequested.current) return;
      pauseRequested.current = true;
      void post("/api/cache/warmup/pause")
        .catch(() => undefined)
        .finally(() => queryClient.invalidateQueries({ queryKey: ["background-jobs"] }));
    };
    const events: (keyof WindowEventMap)[] = [
      "pointermove",
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
      "focus",
    ];
    events.forEach((event) => window.addEventListener(event, markActive, { passive: true }));
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") markActive();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      events.forEach((event) => window.removeEventListener(event, markActive));
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [queryClient]);

  // Manual "refresh cache now" from Settings: run a preparation pass at once,
  // bypassing the idle and hidden-window gates for the next tick.
  useEffect(() => {
    const runNow = () => {
      forceRun.current = true;
      lastPoll.current = 0;
    };
    window.addEventListener(WARMUP_NOW_EVENT, runNow);
    return () => window.removeEventListener(WARMUP_NOW_EVENT, runNow);
  }, []);

  useEffect(() => {
    if (!enabled || !settings.data?.warmup_enabled) return;
    const timer = window.setInterval(async () => {
      const forced = forceRun.current;
      if (busy.current || task || Date.now() - lastPoll.current < 1500) return;
      if (!forced && Date.now() - lastInteraction.current < settings.data!.idle_seconds * 1000) return;
      if (!forced && settings.data!.only_when_hidden && !(await mainWindowIsHidden())) return;
      busy.current = true;
      lastPoll.current = Date.now();
      forceRun.current = false;
      try {
        if (pauseRequested.current || forced) {
          await post("/api/cache/warmup/resume");
          pauseRequested.current = false;
        }
        await post("/api/cache/warmup/start");
        const response = await get<{ task: CacheWarmupTask | null }>("/api/cache/warmup/next");
        if (response.task) {
          setTask(response.task);
        } else {
          busy.current = false;
          lastPoll.current = Date.now() + 30_000;
        }
        queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      } catch {
        busy.current = false;
        lastPoll.current = Date.now() + 30_000;
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [enabled, queryClient, settings.data, task]);

  const plot = useMemo(
    () => analysis.data?.spec.saved_plots?.find((candidate) => candidate.id === task?.plot_id),
    [analysis.data, task?.plot_id],
  );

  const finish = useCallback(async (error?: string, detail?: string) => {
    if (!task) return;
    try {
      await post("/api/cache/warmup/complete", {
        task_id: task.id,
        status: error ? "failed" : "ready",
        detail: error ? undefined : detail ?? "Cached plot and thumbnail ready",
        error,
      });
    } finally {
      setTask(null);
      busy.current = false;
      lastPoll.current = Date.now();
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
    }
  }, [queryClient, task]);

  useEffect(() => {
    if (!task || !analysis.isError) return;
    void finish(analysis.error instanceof Error ? analysis.error.message : "Analysis could not be loaded");
  }, [analysis.error, analysis.isError, finish, task]);

  useEffect(() => {
    if (analysis.isSuccess && task && !plot) void finish("Saved plot no longer exists");
  }, [analysis.isSuccess, finish, plot, task]);

  if (!task || !analysis.data || !plot) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        left: -10000,
        top: 0,
        width: 520,
        height: 180,
        opacity: 0.001,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <AnalysisCacheWarmupRenderer
        analysis={analysis.data}
        plot={plot}
        task={task}
        onComplete={finish}
      />
    </div>
  );
}
