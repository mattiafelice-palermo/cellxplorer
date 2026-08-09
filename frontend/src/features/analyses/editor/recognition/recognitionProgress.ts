import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { get, type BackgroundJob } from "../../../../api";

/** Client token so the server can attach a background job only on cache miss. */
export function newRecognitionToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Tokens must be shared across duplicate React Query observers (settings panel
 * + plot card both call the same result hook). Local useState would only update
 * the observer whose queryFn instance ran.
 */
const tokenByQueryKey = new Map<string, string>();
const tokenListeners = new Set<() => void>();

function notifyTokenListeners() {
  tokenListeners.forEach((listener) => listener());
}

export function setRecognitionToken(queryKey: string, token: string | null) {
  if (token) tokenByQueryKey.set(queryKey, token);
  else tokenByQueryKey.delete(queryKey);
  notifyTokenListeners();
}

/** Clear only if this request still owns the slot (avoids races across refetches). */
export function clearRecognitionToken(queryKey: string, token: string) {
  if (tokenByQueryKey.get(queryKey) === token) {
    tokenByQueryKey.delete(queryKey);
    notifyTokenListeners();
  }
}

export function useSharedRecognitionToken(queryKey: string | null): string | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      tokenListeners.add(onStoreChange);
      return () => {
        tokenListeners.delete(onStoreChange);
      };
    },
    () => (queryKey ? tokenByQueryKey.get(queryKey) ?? null : null),
    () => null,
  );
}

function jobPercent(job: BackgroundJob | null | undefined): number {
  if (!job) return 0;
  if (job.total <= 0) return job.status === "completed" ? 100 : 0;
  return Math.max(0, Math.min(100, (job.completed / job.total) * 100));
}

/**
 * Poll a recognition/compute job opened via `job_token` while a query is in flight.
 * Returns a display percent and live stage label for the loading UI.
 */
export function useRecognitionProgress(
  token: string | null,
  enabled: boolean,
): { percent: number; label: string; active: boolean; job: BackgroundJob | null | undefined } {
  const jobQuery = useQuery({
    queryKey: ["background-job-token", token],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${token}`),
    enabled: Boolean(token) && enabled,
    // null means the compute was served from cache and never opened a job.
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 450 : false,
  });
  const job = jobQuery.data;
  const percent = jobPercent(job);
  const label =
    job?.description ||
    (enabled ? "Preparing recognition…" : "");
  return {
    percent: job ? percent : 0,
    label,
    active: Boolean(token) && enabled,
    job,
  };
}

/** Delay showing progress so warm cache hits never flash a bar. */
export function useDelayedRecognitionProgress(
  token: string | null,
  loading: boolean,
  delay = 250,
  minimum = 400,
) {
  const progress = useRecognitionProgress(token, loading);
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let timer: number | undefined;
    if (loading && !visible) {
      timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (!loading && visible) {
      const remaining = Math.max(0, minimum - (Date.now() - shownAt.current));
      if (remaining === 0) setVisible(false);
      else timer = window.setTimeout(() => setVisible(false), remaining);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loading, visible, delay, minimum]);
  return {
    ...progress,
    show: visible,
  };
}
