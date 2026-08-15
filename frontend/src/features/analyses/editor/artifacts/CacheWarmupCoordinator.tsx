import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  get,
  post,
  type AnalysisFull,
  type CacheSettings,
  type CacheWarmupTask,
} from "../../../../api";
import { isTauriApp } from "../../../../downloads";
import {
  warmupAnalysisQueryKey,
  warmupAnalysisRevisionsMatch,
} from "../policies/warmupIdentityPolicy";
import { AnalysisCacheWarmupRenderer } from "./AnalysisCacheWarmupRenderer";

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

/**
 * Hard ceiling on a single warmup task.
 *
 * The completion logic in warmupCompletion.ts covers every state we know of,
 * but a task that never reports leaves `busy` latched and silently stalls the
 * queue for the rest of the session. This backstop guarantees the queue always
 * advances. Deliberately generous: a cold compute that re-parses several large
 * sources can legitimately take minutes, and a false timeout is cheap — the
 * plot keeps no prepared marker, so the next pass simply queues it again.
 */
const WARMUP_TASK_TIMEOUT_MS = 5 * 60_000;

export function CacheWarmupCoordinator({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const lastInteraction = useRef(Date.now());
  const busy = useRef(false);
  const lastPoll = useRef(0);
  const pauseRequested = useRef(false);
  const forceRun = useRef(false);
  const finishedTaskId = useRef<string | null>(null);
  const [task, setTask] = useState<CacheWarmupTask | null>(null);
  const settings = useQuery({
    queryKey: ["cache-settings"],
    queryFn: () => get<CacheSettings>("/api/cache/settings"),
    enabled,
    staleTime: 60_000,
  });
  const analysis = useQuery({
    // A warmup task is a snapshot of both the scientific identity and the
    // saved-plot presentation. Include all of that identity in the query key
    // so a consecutive generation for the same analysis cannot reuse an
    // earlier AnalysisFull response from React Query's cache.
    queryKey: warmupAnalysisQueryKey(task),
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
          // Fresh activation: clear the double-finish guard. The backend hands
          // the same task id back when a previous `complete` never registered
          // (e.g. its POST failed), and that retry must be allowed to report.
          finishedTaskId.current = null;
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

  const finish = useCallback(async (
    error?: string,
    detail?: string,
    disposition: "ready" | "skipped" = "ready",
  ) => {
    // Idempotent per task: the watchdog and a late renderer callback must not
    // both report the same task.
    if (!task || finishedTaskId.current === task.id) return;
    finishedTaskId.current = task.id;
    try {
      await post("/api/cache/warmup/complete", {
        task_id: task.id,
        status: error ? "failed" : disposition,
        detail: error ? undefined : detail ?? "Cached plot and thumbnail ready",
        error,
      });
    } finally {
      setTask(null);
      busy.current = false;
      lastPoll.current = Date.now();
      queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["cache-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["analysis-database-thumbnail"] });
    }
  }, [queryClient, task]);

  // Backstop: no task may hold the queue open indefinitely. Re-armed whenever
  // the active task changes, cleared on unmount.
  useEffect(() => {
    if (!task) return;
    const timer = window.setTimeout(() => {
      void finish("Preparation timed out");
    }, WARMUP_TASK_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [finish, task]);

  useEffect(() => {
    if (!task || !analysis.isError) return;
    void finish(analysis.error instanceof Error ? analysis.error.message : "Analysis could not be loaded");
  }, [analysis.error, analysis.isError, finish, task]);

  useEffect(() => {
    if (!analysis.isSuccess || !task) return;
    if (!plot) {
      void finish("Saved plot no longer exists");
      return;
    }
    if (!warmupAnalysisRevisionsMatch(task, analysis.data, plot.modified_at)) {
      void finish("Warmup task was superseded by newer analysis settings");
    }
  }, [analysis.data?.modified_at, analysis.isSuccess, finish, plot, task]);

  const revisionsMatch = warmupAnalysisRevisionsMatch(
    task,
    analysis.data,
    plot?.modified_at,
  );
  if (
    !task ||
    !analysis.data ||
    !plot ||
    !revisionsMatch
  ) return null;
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
