export const IMPORT_TIMING_STORAGE_KEY = "cellxplorer-import-timing-v1";
export const IMPORT_TIMING_HISTORY_VERSION = 1 as const;
const MAX_SAMPLES = 10;
const GI_BYTES = 1024 ** 3;

export type ImportTimingSample = {
  recordedAt: string;
  fileCount: number;
  totalBytes: number;
  blockingSeconds: number;
};

export type ImportTimingHistoryV1 = {
  version: 1;
  samples: ImportTimingSample[];
};

export type ImportTimingEstimate = {
  minimumSeconds: number;
  maximumSeconds: number;
  centralSeconds: number;
  minimumLabel: string;
  maximumLabel: string;
};

function validSample(sample: Partial<ImportTimingSample> | null | undefined): sample is ImportTimingSample {
  const fileCount = sample?.fileCount;
  const totalBytes = sample?.totalBytes;
  const blockingSeconds = sample?.blockingSeconds;
  return Boolean(
    sample &&
      typeof sample.recordedAt === "string" &&
      typeof fileCount === "number" &&
      Number.isFinite(fileCount) &&
      fileCount >= 1 &&
      typeof totalBytes === "number" &&
      Number.isFinite(totalBytes) &&
      totalBytes >= 0 &&
      typeof blockingSeconds === "number" &&
      Number.isFinite(blockingSeconds) &&
      blockingSeconds > 0,
  );
}

export function validImportTimingSamples(history: ImportTimingHistoryV1 | null | undefined): ImportTimingSample[] {
  return (history?.version === 1 ? history.samples : []).filter(validSample);
}

export function addImportTimingSample(
  history: ImportTimingHistoryV1 | null | undefined,
  sample: Partial<ImportTimingSample>,
): ImportTimingHistoryV1 {
  const samples = validImportTimingSamples(history);
  if (validSample(sample)) samples.push({ ...sample });
  samples.sort((left, right) => {
    const a = Date.parse(left.recordedAt);
    const b = Date.parse(right.recordedAt);
    return (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
  });
  return { version: 1, samples: samples.slice(-MAX_SAMPLES) };
}

function parseHistory(raw: string | null): ImportTimingHistoryV1 {
  if (!raw) return { version: 1, samples: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid history");
    const candidate = parsed as { version?: unknown; samples?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.samples)) throw new Error("unsupported history");
    return {
      version: 1,
      samples: candidate.samples.filter((sample): sample is ImportTimingSample => validSample(sample as Partial<ImportTimingSample>)),
    };
  } catch {
    return { version: 1, samples: [] };
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readImportTimingHistory(storage: Storage | null = defaultStorage()): ImportTimingHistoryV1 {
  return parseHistory(storage?.getItem(IMPORT_TIMING_STORAGE_KEY) ?? null);
}

export function writeImportTimingHistory(
  history: ImportTimingHistoryV1,
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(IMPORT_TIMING_STORAGE_KEY, JSON.stringify({
      version: 1,
      samples: validImportTimingSamples(history).slice(-MAX_SAMPLES),
    }));
  } catch {
    // Local history is optional and must never affect importing.
  }
}

export function recordImportTimingSample(
  sample: Partial<ImportTimingSample>,
  storage: Storage | null = defaultStorage(),
): ImportTimingHistoryV1 {
  const next = addImportTimingSample(readImportTimingHistory(storage), sample);
  writeImportTimingHistory(next, storage);
  return next;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function friendlySeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  return `${Math.max(1, Math.round(seconds / 60))} minute${Math.round(seconds / 60) === 1 ? "" : "s"}`;
}

export function estimateImportTiming(
  fileCount: number,
  totalBytes: number,
  history: ImportTimingHistoryV1 | null | undefined,
): ImportTimingEstimate | null {
  if (!Number.isFinite(fileCount) || fileCount < 1 || !Number.isFinite(totalBytes) || totalBytes < 0) return null;
  const samples = validImportTimingSamples(history);
  if (samples.length < 2) return null;
  const perFile = samples.map((sample) => sample.blockingSeconds / sample.fileCount);
  const perGiB = samples.map((sample) => sample.blockingSeconds / Math.max(sample.totalBytes / GI_BYTES, 1 / GI_BYTES));
  const secondsPerFile = Math.min(3600, Math.max(0.01, median(perFile)));
  const secondsPerGiB = Math.min(30 * 24 * 3600, Math.max(0.01, median(perGiB)));
  const central = secondsPerFile * fileCount + secondsPerGiB * (totalBytes / GI_BYTES);
  if (!Number.isFinite(central) || central <= 0) return null;
  const minimum = Math.max(1, central * 0.8);
  const maximum = Math.max(minimum + 1, central * 1.25);
  return {
    minimumSeconds: minimum,
    maximumSeconds: maximum,
    centralSeconds: central,
    minimumLabel: friendlySeconds(minimum),
    maximumLabel: friendlySeconds(maximum),
  };
}
