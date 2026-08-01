import type { BackgroundJob } from "./api";

export type ImportProgressStage = "scan" | "inspect" | "register";
export type ImportProgressMode = "determinate" | "indeterminate";

export function newImportJobToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    inspect: "Checking file identity and reading Neware metadata before the review step.",
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
  if (job.total <= 0) return null;
  return Math.max(0, Math.min(99, (job.completed / job.total) * 100));
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
  const unit = stage === "register" ? "cell" : "file";
  return `${job.completed} of ${job.total} ${unit}${job.total === 1 ? "" : "s"}`;
}

export function importProgressCurrentLabel(
  stage: ImportProgressStage,
  job: BackgroundJob | null | undefined,
): string | null {
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
};

export function importRemainingEstimate(
  job: BackgroundJob | null | undefined,
  nowMs = Date.now(),
): ImportRemainingEstimate | null {
  if (!job || job.status !== "running" || job.completed < 3) return null;
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
  };
}
