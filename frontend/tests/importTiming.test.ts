import assert from "node:assert/strict";
import test from "node:test";

import {
  IMPORT_TIMING_STORAGE_KEY,
  addImportTimingSample,
  estimateImportTiming,
  readImportTimingHistory,
  writeImportTimingHistory,
} from "../src/importTiming.ts";

function sample(recordedAt: string, fileCount: number, totalBytes: number, blockingSeconds: number) {
  return { recordedAt, fileCount, totalBytes, blockingSeconds };
}

test("invalid history is ignored and history is capped at ten samples", () => {
  let history = addImportTimingSample(null, sample("2026-01-01T00:00:00Z", 1, 0, 2));
  history = addImportTimingSample(history, sample("2026-01-01T00:00:01Z", 0, 2, 2));
  for (let index = 1; index <= 12; index += 1) {
    history = addImportTimingSample(history, sample(`2026-01-01T00:00:${String(index).padStart(2, "0")}Z`, index, index, index));
  }
  assert.equal(history.version, 1);
  assert.equal(history.samples.length, 10);
  assert.equal(history.samples[0].fileCount, 3);
});

test("estimate requires two samples and uses robust median rates", () => {
  const one = addImportTimingSample(null, sample("2026-01-01T00:00:00Z", 10, 1024 ** 3, 100));
  assert.equal(estimateImportTiming(10, 1024 ** 3, one), null);
  const history = addImportTimingSample(one, sample("2026-01-02T00:00:00Z", 10, 1024 ** 3, 120));
  const estimate = estimateImportTiming(10, 1024 ** 3, history);
  assert.ok(estimate);
  assert.equal(estimate.centralSeconds, 220);
  assert.equal(estimate.minimumLabel, "3 minutes");
  assert.equal(estimate.maximumLabel, "5 minutes");
});

test("versioned local storage parsing fails safely", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } as Storage;
  values.set(IMPORT_TIMING_STORAGE_KEY, JSON.stringify({ version: 99, samples: [] }));
  assert.deepEqual(readImportTimingHistory(storage), { version: 1, samples: [] });
  const history = addImportTimingSample(null, sample("2026-01-01T00:00:00Z", 2, 2, 3));
  writeImportTimingHistory(history, storage);
  assert.equal(readImportTimingHistory(storage).samples.length, 1);
});
