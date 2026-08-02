import type { BackgroundJob } from "./api";

export type ImportProgressStage = "scan" | "inspect" | "register";
export type ImportProgressMode = "determinate" | "indeterminate";
export type ImportProgressPhase =
  | "sampling"
  | "starting_workers"
  | "reading"
  | "finalizing"
  | "completed";

export function importJobPollInterval(
  job: BackgroundJob | null | undefined,
): number | false {
  // The first token lookup can race job creation. Keep polling when the server
  // has not created the job yet; stopping here strands the modal at "Working".
  if (job === null || job?.status === "running") {
    const phase = job?.phase;
    return phase === "sampling" || phase === "starting_workers" || phase === "finalizing"
      ? 250
      : 500;
  }
  return false;
}

export function newImportJobToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function importRegistrationUiState(
  accepted: boolean,
  status: BackgroundJob["status"] | undefined,
  savePending = false,
): { showContinue: boolean; editingLocked: boolean } {
  return {
    showContinue: accepted && status === "running",
    editingLocked: savePending || (accepted && status !== "failed"),
  };
}

export function importStageTitle(stage: ImportProgressStage): string {
  return {
    scan: "Discovering selected sources",
    inspect: "Inspecting import files",
    register: "Registering Cells",
  }[stage];
}

export function importStageExplanation(stage: ImportProgressStage): string {
  return {
    scan: "Finding supported Neware files and reading their sizes. File identity is not opened yet.",
    inspect: "Reading one file first to choose serial or multiprocessing, then checking file identity and Neware metadata.",
    register: "Validating the reviewed drafts and committing the Cell registration as one transaction.",
  }[stage];
}

export function importProgressMode(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
): ImportProgressMode {
  if (stage === "scan" || !job || job.total <= 0) return "indeterminate";
  return "determinate";
}

export function importProgressPercent(job: BackgroundJob | null | undefined): number | null {
  if (!job) return null;
  if (job.status === "completed") return 100;
  if (Number.isFinite(job.progress_percent)) {
    return Math.max(0, Math.min(99, job.progress_percent ?? 0));
  }
  const count = importProgressCount(job);
  if (count.total <= 0) return null;
  return Math.max(0, Math.min(99, (count.current / count.total) * 100));
}

export type ImportProgressCount = {
  current: number;
  total: number;
};

/**
 * Return the count users should see for every import-progress surface.
 * Registration advances its phase before individual jobs are marked complete,
 * so completed/total would otherwise remain misleadingly at 0/N.
 */
export function importProgressCount(
  job: BackgroundJob | null | undefined,
): ImportProgressCount {
  if (!job) return { current: 0, total: 0 };
  if (job.status === "completed") {
    return { current: Math.max(0, job.total), total: Math.max(0, job.total) };
  }
  const phaseIsCounted = job.phase === "validation" || job.phase === "registration";
  const phaseTotal = Number(job.phase_total);
  const phaseCurrent = Number(job.phase_current);
  if (phaseIsCounted && Number.isFinite(phaseTotal) && phaseTotal > 0 && Number.isFinite(phaseCurrent)) {
    return {
      current: Math.max(0, Math.min(phaseTotal, phaseCurrent)),
      total: phaseTotal,
    };
  }
  const total = Math.max(0, job.total);
  return {
    current: Math.max(0, Math.min(total, job.completed)),
    total,
  };
}

export function importProgressCountText(job: BackgroundJob | null | undefined): string {
  const count = importProgressCount(job);
  return `${count.current} / ${count.total}`;
}

export type BackgroundImportRefreshPlan = {
  registrationCommitted: boolean;
  cacheAdvanced: boolean;
  cacheTerminal: boolean;
  snapshots: Map<number, string>;
  lastCacheRefreshAt: number;
};

function backgroundJobSnapshot(job: BackgroundJob): string {
  return `${job.status}:${job.completed}:${job.phase ?? ""}:${job.phase_current ?? ""}:${job.progress_percent ?? ""}`;
}

export function backgroundImportRefreshPlan(
  previous: ReadonlyMap<number, string>,
  jobs: readonly BackgroundJob[],
  nowMs: number,
  lastCacheRefreshAt: number,
): BackgroundImportRefreshPlan {
  const snapshots = new Map(previous);
  let registrationCommitted = false;
  let cacheAdvanced = false;
  let cacheTerminal = false;
  for (const job of jobs) {
    const before = previous.get(job.id);
    const after = backgroundJobSnapshot(job);
    if (job.kind === "import_register" && job.status === "completed" && (!before || before !== after)) {
      registrationCommitted = true;
    }
    if (job.kind === "import_cache") {
      if (before && before !== after && job.status === "running") cacheAdvanced = true;
      if ((!before || before !== after) && (job.status === "completed" || job.status === "failed")) {
        cacheTerminal = true;
      }
    }
    snapshots.set(job.id, after);
  }
  let nextLastCacheRefreshAt = lastCacheRefreshAt;
  if (cacheTerminal || (cacheAdvanced && nowMs - lastCacheRefreshAt >= 1000)) {
    nextLastCacheRefreshAt = nowMs;
  }
  return {
    registrationCommitted,
    cacheAdvanced: cacheTerminal || (cacheAdvanced && nowMs - lastCacheRefreshAt >= 1000),
    cacheTerminal,
    snapshots,
    lastCacheRefreshAt: nextLastCacheRefreshAt,
  };
}

export function importProgressCountLabel(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
): string {
  if (!job) return "Working…";
  if (stage === "scan") {
    const current = job.status === "completed" ? job.total : Math.min(job.total, job.completed + 1);
    return `Scanning ${current} of ${job.total} selected location${job.total === 1 ? "" : "s"}`;
  }
  if (stage === "inspect") {
    if (job.phase === "sampling") {
      return job.phase_current === 1
        ? "First file read; choosing the fastest safe strategy"
        : "Reading the first file to estimate the inspection time";
    }
    if (job.phase === "starting_workers") {
      return `Starting processing core ${job.phase_current ?? 0} of ${job.phase_total ?? job.worker_count ?? 0}`;
    }
    if (job.phase === "finalizing") {
      return `Finalizing import review ${job.phase_current ?? 0} of ${job.phase_total ?? job.total}`;
    }
  }
  if (stage === "register") {
    const count = importProgressCount(job);
    if (job.phase === "validation") {
      return `Validating ${count.current} of ${count.total} selected cell${count.total === 1 ? "" : "s"}`;
    }
    if (job.phase === "registration") {
      return `Registering ${count.current} of ${count.total} selected cell${count.total === 1 ? "" : "s"}`;
    }
  }
  const unit = stage === "register" ? "cell" : "file";
  return `${job.completed} of ${job.total} ${unit}${job.total === 1 ? "" : "s"}`;
}

export function importProgressCurrentLabel(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
): string | null {
  if (job?.phase === "starting_workers" || job?.phase === "finalizing") {
    return job.phase_detail ?? null;
  }
  if (job?.current_item_label) return job.current_item_label;
  if (stage === "scan" && job?.status === "completed") return null;
  return null;
}

function friendlyDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export type ImportRemainingEstimate = {
  minimumSeconds: number;
  maximumSeconds: number;
  minimumLabel: string;
  maximumLabel: string;
  scope: "total" | "remaining";
};

export function importRemainingEstimate(
  job: BackgroundJob | null | undefined,
  nowMs = Date.now(),
): ImportRemainingEstimate | null {
  if (!job || job.status !== "running") return null;
  if (
    Number.isFinite(job.estimated_total_seconds)
    && (job.estimated_total_seconds ?? 0) > 0
    && job.estimate_scope === "total"
  ) {
    const total = job.estimated_total_seconds ?? 0;
    const minimum = Math.max(1, total * 0.75);
    const maximum = Math.max(minimum + 1, total * 1.35);
    return {
      minimumSeconds: minimum,
      maximumSeconds: maximum,
      minimumLabel: friendlyDuration(minimum),
      maximumLabel: friendlyDuration(maximum),
      scope: "total",
    };
  }
  if (job.completed < 3) return null;
  const started = Date.parse(job.started_at);
  if (!Number.isFinite(started) || nowMs - started < 2000) return null;
  const elapsedSeconds = (nowMs - started) / 1000;
  let completedWork = job.completed;
  let totalWork = job.total;
  if (
    Number.isFinite(job.completed_bytes) &&
    Number.isFinite(job.total_bytes) &&
    (job.completed_bytes ?? 0) > 0 &&
    (job.total_bytes ?? 0) > 0
  ) {
    completedWork = job.completed_bytes ?? 0;
    totalWork = job.total_bytes ?? 0;
  }
  if (!Number.isFinite(completedWork) || !Number.isFinite(totalWork) || totalWork <= completedWork) return null;
  const remaining = ((totalWork - completedWork) / completedWork) * elapsedSeconds;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minimum = Math.max(1, remaining * 0.75);
  const maximum = Math.max(minimum + 1, remaining * 1.35);
  return {
    minimumSeconds: minimum,
    maximumSeconds: maximum,
    minimumLabel: friendlyDuration(minimum),
    maximumLabel: friendlyDuration(maximum),
    scope: "remaining",
  };
}
