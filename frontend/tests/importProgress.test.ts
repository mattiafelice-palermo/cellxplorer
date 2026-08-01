import assert from "node:assert/strict";
import test from "node:test";

import type { BackgroundJob } from "../src/api.ts";
import {
  importProgressCountLabel,
  importProgressMode,
  importProgressPercent,
  importRemainingEstimate,
  importStageExplanation,
  importStageTitle,
} from "../src/importProgress.ts";

function job(patch: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 1,
    kind: "import_inspect",
    title: "Inspecting",
    description: "Inspecting",
    status: "running",
    total: 10,
    completed: 3,
    counters: {},
    items: [],
    error: null,
    started_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    ...patch,
  };
}

test("stage copy names discovery, inspection, and registration truthfully", () => {
  assert.equal(importStageTitle("scan"), "Discovering selected sources");
  assert.match(importStageExplanation("inspect"), /identity/);
  assert.match(importStageExplanation("register"), /transaction/);
  assert.equal(importProgressCountLabel("scan", job({ total: 3, completed: 1 })), "Scanning 2 of 3 selected locations");
});

test("scan is indeterminate and active jobs never show early 100 percent", () => {
  assert.equal(importProgressMode("scan", job()), "indeterminate");
  assert.equal(importProgressMode("inspect", null), "indeterminate");
  assert.equal(importProgressPercent(job({ completed: 10, total: 10 })), 99);
  assert.equal(importProgressPercent(job({ completed: 10, total: 10, status: "completed" })), 100);
});

test("remaining ETA needs three completed items and two seconds", () => {
  assert.equal(importRemainingEstimate(job({ completed: 2 }), Date.parse("2026-08-01T00:00:10Z")), null);
  assert.equal(importRemainingEstimate(job(), Date.parse("2026-08-01T00:00:01Z")), null);
  const estimate = importRemainingEstimate(job(), Date.parse("2026-08-01T00:00:10Z"));
  assert.ok(estimate);
  assert.ok(estimate.maximumSeconds > estimate.minimumSeconds);
});

test("byte progress is preferred for ETA when available", () => {
  const estimate = importRemainingEstimate(
    job({ completed_bytes: 25, total_bytes: 100 }),
    Date.parse("2026-08-01T00:00:10Z"),
  );
  assert.ok(estimate);
  assert.equal(Math.round(estimate.minimumSeconds), 23);
});
