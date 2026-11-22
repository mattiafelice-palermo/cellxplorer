import type { BackgroundJob } from "./api";
import { formatImportBytes } from "./importSelectionSummary.ts";

export type ImportProgressStage = "scan" | "inspect" | "register";
export type ImportProgressMode = "determinate" | "indeterminate";
export type ImportProgressPhaseStatus = "pending" | "active" | "completed" | "failed";
export type ImportProgressPhaseRow = {
  id: string;
  label: string;
  status: ImportProgressPhaseStatus;
  mode: ImportProgressMode;
  percent: number | null;
  detail: string | null;
};
export type ImportProgressPhase =
  | "sampling"
  | "starting_workers"
  | "reading"
  | "finalizing"
  | "screening"
  | "completed";

export function importJobPollInterval(
  job: BackgroundJob | null | undefined,
): number | false {
  if (job?.kind === "import_register" && job.status !== "failed" && job.cache_handoff_complete === false) return 250;
  // The first token lookup can race job creation. Keep polling when the server
  // has not created the job yet; stopping here strands the modal at "Working".
  if (job === null || job?.status === "running") {
    const phase = job?.phase;
    return phase === "sampling" || phase === "starting_workers" || phase === "finalizing" || phase === "screening"
      ? 250
      : 500;
  }
  return false;
}

/** Completion must be proven by this registration's handoff, never a global cached list. */
export function importPreparationState(
  registration: BackgroundJob | null | undefined,
  preparation: BackgroundJob | null | undefined,
): "unknown" | "active" | "ready" | "failed" {
  if (registration?.cache_handoff_complete !== true) return "unknown";
  if (registration.cache_job_id == null) return "ready";
  if (!preparation || preparation.id !== registration.cache_job_id || preparation.kind !== "import_cache") return "unknown";
  if (preparation.status === "completed") {
    return preparation.completed === preparation.total
      && preparation.counters?.ready === preparation.total
      && preparation.items?.length === preparation.total
      && preparation.items.every(item => item.status === "ready") ? "ready" : "failed";
  }
  if (preparation.status === "failed") return "failed";
  return "active";
}

export function newImportJobToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type ImportSourceCapability = {
  canonical_cycling: boolean;
  metadata_only: boolean;
};

export function importRegistrationSuccessMessage(
  submittedCells: number,
  sources: readonly ImportSourceCapability[],
): string {
  const importedLabel = `${submittedCells} cell${submittedCells === 1 ? "" : "s"}`;
  const hasMetadataOnlySources = sources.some((source) => source.metadata_only);
  const hasCanonicalSources = sources.some(
    (source) => source.canonical_cycling && !source.metadata_only,
  );

  if (!hasCanonicalSources) {
    return `${importedLabel} accepted. Registration is being committed; no cycling data preparation is queued.`;
  }
  if (!hasMetadataOnlySources) {
    return `${importedLabel} accepted. Registration is being committed; cycling data will be prepared in the background if needed.`;
  }
  return `${importedLabel} accepted. Registration is being committed; cycling data will be prepared for canonical sources in the background if needed.`;
}

export function importRegistrationUiState(
  accepted: boolean,
  status: BackgroundJob["status"] | undefined,
  savePending = false,
  registrationCommitted = false,
  cachePreparationActive = false,
): { showContinue: boolean; showDone: boolean; editingLocked: boolean; closeLocked: boolean } {
  const registrationFailed = status === "failed";
  const registrationFinished = registrationCommitted || status === "completed";

  // showDone only when registration is finished AND cache preparation is no longer running.
  // Note: registrationCommitted and status="completed" both become true in the SAME instant
  // for every successful import (small or large). The registration job finishing does NOT mean
  // the import is complete — a separate import_cache background job handles scientific data
  // preparation and can take much longer. Only show Done when that cache job is no longer active.
  const showDone = accepted && !registrationFailed && registrationFinished && !cachePreparationActive;

  // showContinue: when registration is finished but either cache prep is still running or Done hasn't triggered yet.
  const showContinue = accepted && !registrationFailed && registrationFinished && !showDone;

  return {
    showContinue,
    showDone,
    editingLocked: savePending || (accepted && !registrationFailed),
    // Detaching is safe only after the relational registration transaction has
    // committed. Cache generation is the work that may continue after detach.
    closeLocked: savePending || (accepted && !registrationFailed && !registrationFinished),
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
    scan: "Finding supported cycler files, reading their sizes, and checking compatibility.",
    inspect: "Reading one file first to choose serial or multiprocessing, then checking file identity and source metadata.",
    register: "Validating the reviewed drafts and committing the Cell registration as one transaction.",
  }[stage];
}

export function importProgressMode(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
): ImportProgressMode {
  if (stage === "scan") {
    return job?.phase === "screening" && (job.phase_total ?? 0) > 0 ? "determinate" : "indeterminate";
  }
  if (!job || job.total <= 0) return "indeterminate";
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
  const phaseIsCounted =
    job.phase === "validation" || job.phase === "registration" || job.phase === "screening";
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
  return [
    job.status,
    job.completed,
    job.phase ?? "",
    job.phase_current ?? "",
    job.progress_percent ?? "",
    job.registration_committed ? 1 : 0,
  ].join(":");
}

function snapshotHasRegistrationCommit(snapshot: string | undefined): boolean {
  return snapshot?.endsWith(":1") ?? false;
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
    const changed = !before || before !== after;
    if (
      job.kind === "import_register"
      && changed
      && (
        (Boolean(job.registration_committed) && !snapshotHasRegistrationCommit(before))
        || job.status === "completed"
      )
    ) {
      registrationCommitted = true;
    }
    if (job.kind === "import_cache") {
      // A cache job can only be created after relational registration commits.
      // Its first appearance is therefore also a safe refresh boundary, even
      // before the first scientific worker result is available.
      if (changed && job.status === "running") cacheAdvanced = true;
      if (changed && (job.status === "completed" || job.status === "failed")) {
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
    if (job.phase === "screening") {
      const count = importProgressCount(job);
      return `Checking compatibility ${count.current} of ${count.total} file${count.total === 1 ? "" : "s"}`;
    }
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

function clampedPercent(current: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(99, (current / total) * 100));
}

export function importProgressPhases(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
  preparationJob?: BackgroundJob | null,
): ImportProgressPhaseRow[] {
  if (stage === "scan") {
    if (!job) {
      return [
        {
          id: "discover",
          label: "Scanning selected locations",
          status: "active",
          mode: "indeterminate",
          percent: null,
          detail: "Working…",
        },
      ];
    }
    const isCompleted = job.status === "completed";
    const inScreening = job.phase === "screening";
    const discoverDone = isCompleted || inScreening;
    const discovered = job.discovered_files ?? 0;
    const totalLocations = Math.max(0, job.total);
    const locationsUnit = `location${totalLocations === 1 ? "" : "s"}`;
    const filesLabel = `${discovered} file${discovered === 1 ? "" : "s"} found`;
    const rows: ImportProgressPhaseRow[] = [
      discoverDone
        ? {
            id: "discover",
            label: "Scanning selected locations",
            status: "completed",
            mode: "determinate",
            percent: 100,
            detail: `${totalLocations} ${locationsUnit} · ${filesLabel}`,
          }
        : {
            id: "discover",
            label: "Scanning selected locations",
            status: "active",
            mode: totalLocations > 1 ? "determinate" : "indeterminate",
            percent: totalLocations > 1 ? clampedPercent(job.completed, totalLocations) : null,
            detail: totalLocations > 0
              ? `${Math.min(totalLocations, job.completed + 1)} of ${totalLocations} ${locationsUnit} · ${filesLabel}`
              : filesLabel,
          },
    ];
    const phaseTotal = Math.max(0, Number(job.phase_total) || 0);
    if (inScreening || phaseTotal > 0) {
      const count = importProgressCount(job);
      const screenTotal = phaseTotal > 0 ? phaseTotal : count.total;
      const screenCurrent = Math.max(0, Math.min(screenTotal, count.current));
      const countText = `${screenCurrent} of ${screenTotal} file${screenTotal === 1 ? "" : "s"}`;
      rows.push(
        isCompleted
          ? {
              id: "screen",
              label: "Checking file compatibility",
              status: "completed",
              mode: "determinate",
              percent: 100,
              detail: job.phase_detail || `${screenTotal} file${screenTotal === 1 ? "" : "s"} checked`,
            }
          : {
              id: "screen",
              label: "Checking file compatibility",
              status: "active",
              mode: screenTotal > 0 ? "determinate" : "indeterminate",
              percent: screenTotal > 0 ? clampedPercent(screenCurrent, screenTotal) : null,
              detail: `${countText}${job.phase_detail ? ` · ${job.phase_detail}` : ""}`,
            },
      );
    }
    return rows;
  }

  if (stage === "inspect") {
    const isCompleted = job?.status === "completed" || job?.phase === "completed";
    const phase = job?.phase ?? "sampling";
    const includeWorkers = Boolean(job && (phase === "starting_workers" || job.strategy === "multiprocessing"));
    const rows: ImportProgressPhaseRow[] = [];

    if (!job || (phase === "sampling" && !isCompleted)) {
      const calibrated = Boolean(job && (job.phase_current ?? 0) >= 1);
      rows.push({
        id: "sampling",
        label: "Reading first file",
        status: "active",
        mode: calibrated ? "determinate" : "indeterminate",
        percent: calibrated ? 100 : null,
        detail: calibrated ? "Calibrated" : "Estimating inspection time",
      });
    } else {
      rows.push({
        id: "sampling",
        label: "Reading first file",
        status: "completed",
        mode: "determinate",
        percent: 100,
        detail: "Calibrated",
      });
    }

    if (includeWorkers && job) {
      if (phase === "sampling" && !isCompleted) {
        rows.push({
          id: "starting_workers",
          label: "Starting processing workers",
          status: "pending",
          mode: "determinate",
          percent: 0,
          detail: null,
        });
      } else if (phase === "starting_workers" && !isCompleted) {
        const wTotal = Math.max(1, job.phase_total ?? job.worker_count ?? 1);
        const wCur = Math.max(0, Math.min(wTotal, job.phase_current ?? 0));
        rows.push({
          id: "starting_workers",
          label: "Starting processing workers",
          status: "active",
          mode: "determinate",
          percent: clampedPercent(wCur, wTotal),
          detail: `${wCur} of ${wTotal} workers`,
        });
      } else {
        const wTotal = job.worker_count ?? job.phase_total;
        rows.push({
          id: "starting_workers",
          label: "Starting processing workers",
          status: "completed",
          mode: "determinate",
          percent: 100,
          detail: wTotal ? `${wTotal} workers ready` : "Ready",
        });
      }
    }

    const totalFiles = Math.max(0, job?.total ?? 0);
    const completedFiles = Math.max(0, Math.min(totalFiles, job?.completed ?? 0));
    const totalBytes = Math.max(0, job?.total_bytes ?? 0);
    const completedBytes = Math.max(0, Math.min(totalBytes || Number.MAX_SAFE_INTEGER, job?.completed_bytes ?? 0));
    const filesUnit = `file${totalFiles === 1 ? "" : "s"}`;
    const byteProgress = totalBytes > 0
      ? ` · ${formatImportBytes(completedBytes)} / ${formatImportBytes(totalBytes)}`
      : "";

    if (!job || (!isCompleted && (phase === "sampling" || phase === "starting_workers"))) {
      rows.push({
        id: "reading",
        label: "Checking file identity and metadata",
        status: "pending",
        mode: "determinate",
        percent: 0,
        detail: totalFiles > 0 ? `${totalFiles} ${filesUnit} queued` : null,
      });
    } else if (phase === "reading" && !isCompleted) {
      rows.push({
        id: "reading",
        label: "Checking file identity and metadata",
        status: "active",
        mode: totalFiles > 0 ? "determinate" : "indeterminate",
        percent: totalFiles > 0 ? clampedPercent(completedFiles, totalFiles) : null,
        detail: `${completedFiles} of ${totalFiles} ${filesUnit}${byteProgress}`,
      });
    } else {
      const totalBytesSuffix = totalBytes > 0 ? ` · ${formatImportBytes(totalBytes)}` : "";
      rows.push({
        id: "reading",
        label: "Checking file identity and metadata",
        status: "completed",
        mode: "determinate",
        percent: 100,
        detail: `${totalFiles} of ${totalFiles} ${filesUnit}${totalBytesSuffix}`,
      });
    }

    if (isCompleted) {
      rows.push({
        id: "finalizing",
        label: "Building import review",
        status: "completed",
        mode: "determinate",
        percent: 100,
        detail: "Ready",
      });
    } else if (phase === "finalizing") {
      const fTotal = Math.max(0, job?.phase_total ?? totalFiles);
      const fCur = Math.max(0, Math.min(fTotal, job?.phase_current ?? 0));
      rows.push({
        id: "finalizing",
        label: "Building import review",
        status: "active",
        mode: fTotal > 0 ? "determinate" : "indeterminate",
        percent: fTotal > 0 ? clampedPercent(fCur, fTotal) : null,
        detail: `${fCur} of ${fTotal} file${fTotal === 1 ? "" : "s"}`,
      });
    } else {
      rows.push({
        id: "finalizing",
        label: "Building import review",
        status: "pending",
        mode: "determinate",
        percent: 0,
        detail: null,
      });
    }

    return rows;
  }

  // Stage "register": validation -> registration -> optional preparation (import_cache)
  const totalCells = Math.max(0, job?.total ?? 0);
  const cellsUnit = `cell${totalCells === 1 ? "" : "s"}`;
  const regCompleted = job?.status === "completed" || job?.phase === "completed";
  const committed = Boolean(job?.registration_committed) || regCompleted;
  const pastValidation = committed || job?.phase === "registration";
  const rows: ImportProgressPhaseRow[] = [];

  if (!job) {
    rows.push({
      id: "validation",
      label: "Validating drafts",
      status: "active",
      mode: "indeterminate",
      percent: null,
      detail: "Working…",
    });
  } else if (pastValidation) {
    rows.push({
      id: "validation",
      label: "Validating drafts",
      status: "completed",
      mode: "determinate",
      percent: 100,
      detail: `${totalCells} of ${totalCells} ${cellsUnit}`,
    });
  } else {
    const vTotal = Math.max(0, job.phase_total ?? totalCells);
    const vCur = Math.max(0, Math.min(vTotal, job.phase_current ?? 0));
    rows.push({
      id: "validation",
      label: "Validating drafts",
      status: "active",
      mode: vTotal > 0 ? "determinate" : "indeterminate",
      percent: vTotal > 0 ? clampedPercent(vCur, vTotal) : null,
      detail: vTotal > 0 ? `${vCur} of ${vTotal} cell${vTotal === 1 ? "" : "s"}` : "Working…",
    });
  }

  if (committed) {
    rows.push({
      id: "registration",
      label: "Committing Cell registration",
      status: "completed",
      mode: "determinate",
      percent: 100,
      detail: `${totalCells} ${cellsUnit} committed`,
    });
  } else if (job?.phase === "registration") {
    const rTotal = Math.max(0, job.phase_total ?? totalCells);
    const rCur = Math.max(0, Math.min(rTotal, job.phase_current ?? 0));
    rows.push({
      id: "registration",
      label: "Committing Cell registration",
      status: "active",
      mode: rTotal > 0 ? "determinate" : "indeterminate",
      percent: rTotal > 0 ? clampedPercent(rCur, rTotal) : null,
      detail: rTotal > 0 ? `${rCur} of ${rTotal} cell${rTotal === 1 ? "" : "s"}` : "Working…",
    });
  } else {
    rows.push({
      id: "registration",
      label: "Committing Cell registration",
      status: "pending",
      mode: "determinate",
      percent: 0,
      detail: totalCells > 0 ? `${totalCells} ${cellsUnit} queued` : null,
    });
  }

  const noCacheWork = job?.cache_handoff_complete === true && job?.cache_job_id == null && !preparationJob;
  if (!noCacheWork) {
    if (preparationJob) {
      const prepState = job
        ? importPreparationState(job, preparationJob)
        : preparationJob.status === "failed"
          ? "failed"
          : preparationJob.status === "completed"
            ? "ready"
            : "active";
      const pTotal = Math.max(0, preparationJob.total ?? 0);
      const pCur = Math.max(0, Math.min(pTotal, preparationJob.completed ?? 0));
      const filesUnitPrep = `file${pTotal === 1 ? "" : "s"}`;
      if (prepState === "failed") {
        rows.push({
          id: "preparation",
          label: "Preparing cycling data",
          status: "failed",
          mode: "determinate",
          percent: pTotal > 0 ? (pCur / pTotal) * 100 : 100,
          detail: preparationJob.error || preparationJob.description || "Preparation failed",
        });
      } else if (prepState === "ready") {
        rows.push({
          id: "preparation",
          label: "Preparing cycling data",
          status: "completed",
          mode: "determinate",
          percent: 100,
          detail: `${pCur} of ${pTotal} ${filesUnitPrep} ready`,
        });
      } else if (preparationJob.phase === "queued" || preparationJob.status === "paused") {
        rows.push({
          id: "preparation",
          label: "Preparing cycling data",
          status: "active",
          mode: "indeterminate",
          percent: null,
          detail: preparationJob.phase_detail || "Queued — starting cycling data preparation…",
        });
      } else {
        rows.push({
          id: "preparation",
          label: "Preparing cycling data",
          status: "active",
          mode: pTotal > 0 ? "determinate" : "indeterminate",
          percent: pTotal > 0 ? clampedPercent(pCur, pTotal) : null,
          detail: `${pCur} of ${pTotal} ${filesUnitPrep}`,
        });
      }
    } else if (committed) {
      rows.push({
        id: "preparation",
        label: "Preparing cycling data",
        status: "active",
        mode: "indeterminate",
        percent: null,
        detail: "Starting cycling data preparation…",
      });
    } else {
      rows.push({
        id: "preparation",
        label: "Preparing cycling data",
        status: "pending",
        mode: "determinate",
        percent: 0,
        detail: "Starts after registration commits",
      });
    }
  }

  return rows;
}
