import assert from "node:assert/strict";
import test from "node:test";

import type { BackgroundJob } from "../src/api.ts";
import {
  importProgressCountLabel,
  importProgressCurrentLabel,
  importProgressMode,
  importProgressPercent,
  importJobPollInterval,
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

test("inspection progress explains sampling, worker startup, and finalization", () => {
  assert.equal(
    importProgressCountLabel(
      "inspect",
      job({ phase: "sampling", phase_current: 0, phase_total: 1 }),
    ),
    "Reading the first file to estimate the inspection time",
  );
  assert.equal(
    importProgressCountLabel(
      "inspect",
      job({ phase: "starting_workers", phase_current: 2, phase_total: 4 }),
    ),
    "Starting processing core 2 of 4",
  );
  assert.equal(
    importProgressCountLabel(
      "inspect",
      job({ phase: "finalizing", phase_current: 9, phase_total: 10 }),
    ),
    "Finalizing import review 9 of 10",
  );
  assert.equal(importProgressPercent(job({ progress_percent: 90 })), 90);
  assert.equal(importProgressCurrentLabel("inspect", job({ phase: "finalizing", phase_detail: "Combining metadata" })), "Combining metadata");
});

test("inspection estimate is explicitly presented as a sampled total", () => {
  const estimate = importRemainingEstimate(
    job({ estimated_total_seconds: 12, estimate_scope: "total", completed: 1 }),
    Date.parse("2026-08-01T00:00:01Z"),
  );
  assert.ok(estimate);
  assert.equal(estimate.scope, "total");
  assert.equal(Math.round(estimate.minimumSeconds), 9);
});

test("job polling survives the token-creation race", () => {
  assert.equal(importJobPollInterval(null), 500);
  assert.equal(importJobPollInterval(job({ phase: "starting_workers" })), 250);
  assert.equal(importJobPollInterval(job({ status: "completed" })), false);
});
