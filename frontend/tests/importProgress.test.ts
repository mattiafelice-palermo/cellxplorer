import assert from "node:assert/strict";
import test from "node:test";

import type { BackgroundJob } from "../src/api.ts";
import {
  backgroundImportRefreshPlan,
  importProgressCount,
  importProgressCountText,
  importProgressCountLabel,
  importProgressCurrentLabel,
  importProgressMode,
  importProgressPercent,
  importProgressPhases,
  importJobPollInterval,
  importRegistrationSuccessMessage,
  importRegistrationUiState,
  importPreparationState,
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

test("metadata-only import success does not claim a cycling-preparation job", () => {
  assert.equal(
    importRegistrationSuccessMessage(1, [
      { canonical_cycling: false, metadata_only: true },
    ]),
    "1 cell accepted. Registration is being committed; no cycling data preparation is queued.",
  );
});

test("canonical import success keeps preparation feedback conditional", () => {
  assert.equal(
    importRegistrationSuccessMessage(2, [
      { canonical_cycling: true, metadata_only: false },
    ]),
    "2 cells accepted. Registration is being committed; cycling data will be prepared in the background if needed.",
  );
});

test("mixed import success names canonical sources with conditional preparation feedback", () => {
  assert.equal(
    importRegistrationSuccessMessage(1, [
      { canonical_cycling: true, metadata_only: false },
      { canonical_cycling: false, metadata_only: true },
    ]),
    "1 cell accepted. Registration is being committed; cycling data will be prepared for canonical sources in the background if needed.",
  );
});

test("scan is indeterminate during discovery and determinate during compatibility screening", () => {
  assert.equal(importProgressMode("scan", job()), "indeterminate");
  assert.equal(
    importProgressMode("scan", job({ phase: "screening", phase_current: 2, phase_total: 5 })),
    "determinate",
  );
  assert.equal(
    importJobPollInterval(job({ phase: "screening", phase_current: 2, phase_total: 5 })),
    250,
  );
  assert.deepEqual(
    importProgressCount(job({ phase: "screening", phase_current: 3, phase_total: 8, completed: 0, total: 1 })),
    { current: 3, total: 8 },
  );
  assert.equal(
    importProgressCountLabel("scan", job({ phase: "screening", phase_current: 3, phase_total: 8 })),
    "Checking compatibility 3 of 8 files",
  );
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

test("registration progress distinguishes validation from durable commit", () => {
  assert.equal(
    importProgressCountLabel(
      "register",
      job({ phase: "validation", phase_current: 2, phase_total: 10, completed: 0 }),
    ),
    "Validating 2 of 10 selected cells",
  );
  assert.equal(
    importProgressCountLabel(
      "register",
      job({ phase: "registration", phase_current: 4, phase_total: 10, completed: 0 }),
    ),
    "Registering 4 of 10 selected cells",
  );
});

test("shared progress count uses registration phase progress everywhere", () => {
  const current = job({
    phase: "validation",
    phase_current: 620,
    phase_total: 1000,
    completed: 0,
  });
  assert.deepEqual(importProgressCount(current), { current: 620, total: 1000 });
  assert.equal(importProgressCountText(current), "620 / 1000");
  assert.equal(importProgressPercent(current), 62);
});

test("background refresh policy handles detached registration and throttled cache progress", () => {
  const register = job({ kind: "import_register", status: "completed", completed: 10, total: 10 });
  const first = backgroundImportRefreshPlan(new Map(), [register], 1000, 0);
  assert.equal(first.registrationCommitted, true);

  const cacheRunning = job({ kind: "import_cache", completed: 1, total: 10 });
  const previous = new Map([[cacheRunning.id, "running:0::::0"]]);
  const throttled = backgroundImportRefreshPlan(previous, [cacheRunning], 1500, 1000);
  assert.equal(throttled.cacheAdvanced, false);
  const refreshed = backgroundImportRefreshPlan(previous, [cacheRunning], 2100, 1000);
  assert.equal(refreshed.cacheAdvanced, true);

  const cacheFailed = { ...cacheRunning, status: "failed" as const };
  const terminal = backgroundImportRefreshPlan(refreshed.snapshots, [cacheFailed], 2200, 2100);
  assert.equal(terminal.cacheTerminal, true);
  assert.equal(terminal.cacheAdvanced, true);
});

test("explicit registration commit marker refreshes while the job is still running", () => {
  const before = job({
    kind: "import_register",
    status: "running",
    registration_committed: false,
  });
  const initial = backgroundImportRefreshPlan(new Map(), [before], 1000, 0);
  assert.equal(initial.registrationCommitted, false);

  const committed = { ...before, registration_committed: true };
  const changed = backgroundImportRefreshPlan(initial.snapshots, [committed], 1200, 0);
  assert.equal(changed.registrationCommitted, true);

  const repeated = backgroundImportRefreshPlan(changed.snapshots, [committed], 1400, 0);
  assert.equal(repeated.registrationCommitted, false);
});

test("the first post-commit cache job appearance refreshes Cell rows", () => {
  const cache = job({
    id: 44,
    kind: "import_cache",
    status: "running",
    completed: 0,
    total: 1000,
    phase: "queued",
  });
  const plan = backgroundImportRefreshPlan(new Map(), [cache], 2000, 0);
  assert.equal(plan.cacheAdvanced, true);
  assert.equal(plan.cacheTerminal, false);
});

test("registration controls unlock from the explicit commit marker before cache completion", () => {
  // When registration is committed but cache is still running, show Continue in background
  assert.deepEqual(
    importRegistrationUiState(true, "running", false, true, true),
    { showContinue: true, showDone: false, editingLocked: true, closeLocked: false },
  );
  assert.deepEqual(
    importRegistrationUiState(true, "failed", false, true, false),
    { showContinue: false, showDone: false, editingLocked: false, closeLocked: false },
  );
});

test("Done shows when registration finished AND cache preparation is idle", () => {
  // Cache preparation is a separate job that continues after registration commits.
  // Only show Done when BOTH registration is finished AND cache is not running.
  assert.deepEqual(
    importRegistrationUiState(true, "completed", false, true, false),
    { showContinue: false, showDone: true, editingLocked: true, closeLocked: false },
  );
});

test("Continue shows when registration finished BUT cache preparation is still active", () => {
  // Even though registration is done, cache preparation is still running.
  // Show Continue to avoid closing the modal while work continues.
  assert.deepEqual(
    importRegistrationUiState(true, "completed", false, true, true),
    { showContinue: true, showDone: false, editingLocked: true, closeLocked: false },
  );
});

test("neither button shows if registration failed", () => {
  assert.deepEqual(
    importRegistrationUiState(true, "failed", false, true, false),
    { showContinue: false, showDone: false, editingLocked: false, closeLocked: false },
  );
});

test("neither button shows if registration still running", () => {
  assert.deepEqual(
    importRegistrationUiState(true, "running", false, false, false),
    { showContinue: false, showDone: false, editingLocked: true, closeLocked: true },
  );
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


test("automatic completion waits for its own explicit cache handoff and success", () => {
  const registration = {kind: "import_register", id: 1, status: "completed", registration_committed: true, cache_handoff_complete: false} as BackgroundJob;
  assert.equal(importPreparationState(registration, undefined), "unknown");
  assert.equal(importJobPollInterval(registration), 250);
  assert.equal(importRegistrationUiState(true, "completed", false, true, importPreparationState(registration, undefined) !== "ready").showDone, false);
  registration.cache_handoff_complete = true;
  registration.cache_job_id = 2;
  assert.equal(importPreparationState(registration, {id: 99, status: "completed"} as BackgroundJob), "unknown");
  assert.equal(importPreparationState(registration, {id: 2, kind: "import_register", status: "completed"} as BackgroundJob), "unknown");
  const preparation = {id: 2, kind: "import_cache", total: 1, completed: 1, counters: {ready: 1}, items: [{status: "ready"}]} as BackgroundJob;
  assert.equal(importPreparationState(registration, {...preparation, status: "running"}), "active");
  assert.equal(importPreparationState(registration, {...preparation, status: "failed"}), "failed");
  assert.equal(importPreparationState(registration, {...preparation, status: "completed"}), "ready");
  for (const status of ["failed", "stale", "missing", "queued"]) {
    assert.equal(importPreparationState(registration, {...preparation, status: "completed", counters: {[status]: 1}, items: [{status} as BackgroundJob["items"][number]]}), "failed");
  }
  registration.cache_job_id = null;
  assert.equal(importPreparationState(registration, undefined), "ready");
});

test("importProgressPhases exposes every scan sub-phase with its own progress bar state", () => {
  assert.deepEqual(importProgressPhases("scan", null), [
    {
      id: "discover",
      label: "Scanning selected locations",
      status: "active",
      mode: "indeterminate",
      percent: null,
      detail: "Working…",
    },
  ]);

  const multiDiscover = importProgressPhases(
    "scan",
    job({ kind: "import_scan", total: 120, completed: 30, discovered_files: 250 }),
  );
  assert.equal(multiDiscover.length, 1);
  assert.equal(multiDiscover[0].status, "active");
  assert.equal(multiDiscover[0].mode, "determinate");
  assert.equal(multiDiscover[0].percent, 25);
  assert.equal(multiDiscover[0].detail, "31 of 120 locations · 250 files found");

  const screening = importProgressPhases(
    "scan",
    job({
      kind: "import_scan",
      total: 120,
      completed: 120,
      discovered_files: 610,
      phase: "screening",
      phase_current: 15,
      phase_total: 45,
      phase_detail: "580 supported · 0 skipped",
    }),
  );
  assert.equal(screening.length, 2);
  assert.deepEqual(screening[0], {
    id: "discover",
    label: "Scanning selected locations",
    status: "completed",
    mode: "determinate",
    percent: 100,
    detail: "120 locations · 610 files found",
  });
  assert.equal(screening[1].id, "screen");
  assert.equal(screening[1].status, "active");
  assert.equal(screening[1].mode, "determinate");
  assert.ok(Math.abs((screening[1].percent ?? 0) - (15 / 45) * 100) < 0.01);
});

test("importProgressPhases shows sampling, optional workers, identity reading with bytes, and finalizing during inspect", () => {
  const sampling = importProgressPhases(
    "inspect",
    job({ phase: "sampling", phase_current: 0, phase_total: 1, total: 100, completed: 0 }),
  );
  assert.deepEqual(sampling.map((row) => [row.id, row.status]), [
    ["sampling", "active"],
    ["reading", "pending"],
    ["finalizing", "pending"],
  ]);

  const readingMultiprocess = importProgressPhases(
    "inspect",
    job({
      phase: "reading",
      strategy: "multiprocessing",
      worker_count: 4,
      total: 100,
      completed: 40,
      total_bytes: 10485760,
      completed_bytes: 5242880,
    }),
  );
  assert.deepEqual(readingMultiprocess.map((row) => [row.id, row.status]), [
    ["sampling", "completed"],
    ["starting_workers", "completed"],
    ["reading", "active"],
    ["finalizing", "pending"],
  ]);
  assert.equal(readingMultiprocess[2].percent, 40);
  assert.equal(readingMultiprocess[2].detail, "40 of 100 files · 5 MB / 10 MB");

  const threadedFinalizing = importProgressPhases(
    "inspect",
    job({
      phase: "finalizing",
      strategy: "threaded",
      total: 100,
      completed: 100,
      phase_current: 25,
      phase_total: 100,
    }),
  );
  assert.deepEqual(threadedFinalizing.map((row) => [row.id, row.status]), [
    ["sampling", "completed"],
    ["reading", "completed"],
    ["finalizing", "active"],
  ]);
  assert.equal(threadedFinalizing[2].percent, 25);
});

test("importProgressPhases shows validation, registration, and cycling data preparation sub-phases", () => {
  const validating = importProgressPhases(
    "register",
    job({ kind: "import_register", phase: "validation", phase_current: 2, phase_total: 10, total: 10 }),
  );
  assert.deepEqual(validating.map((row) => [row.id, row.status]), [
    ["validation", "active"],
    ["registration", "pending"],
    ["preparation", "pending"],
  ]);

  const committing = importProgressPhases(
    "register",
    job({ kind: "import_register", phase: "registration", phase_current: 5, phase_total: 10, total: 10 }),
  );
  assert.deepEqual(committing.map((row) => [row.id, row.status]), [
    ["validation", "completed"],
    ["registration", "active"],
    ["preparation", "pending"],
  ]);

  const regDone = job({
    kind: "import_register",
    status: "completed",
    phase: "completed",
    total: 10,
    completed: 10,
    registration_committed: true,
    cache_handoff_complete: true,
    cache_job_id: 2,
  });
  const prepQueued = importProgressPhases(
    "register",
    regDone,
    job({ id: 2, kind: "import_cache", status: "running", phase: "queued", phase_detail: "Queued after Cell registration", total: 10, completed: 0 }),
  );
  assert.equal(prepQueued[2].status, "active");
  assert.equal(prepQueued[2].mode, "indeterminate");

  const prepRunning = importProgressPhases(
    "register",
    regDone,
    job({ id: 2, kind: "import_cache", status: "running", phase: "processing", total: 10, completed: 6 }),
  );
  assert.equal(prepRunning[2].status, "active");
  assert.equal(prepRunning[2].mode, "determinate");
  assert.equal(prepRunning[2].percent, 60);
  assert.equal(prepRunning[2].detail, "6 of 10 files");

  const prepDone = importProgressPhases(
    "register",
    regDone,
    job({ id: 2, kind: "import_cache", status: "completed", total: 10, completed: 10, counters: { ready: 10 }, items: Array.from({ length: 10 }, () => ({ id: "f", label: "f", status: "ready", detail: null, error: null })) }),
  );
  assert.equal(prepDone[2].status, "completed");
  assert.equal(prepDone[2].percent, 100);

  const prepFailed = importProgressPhases(
    "register",
    regDone,
    job({ id: 2, kind: "import_cache", status: "failed", error: "worker crashed", total: 10, completed: 3 }),
  );
  assert.equal(prepFailed[2].status, "failed");
  assert.equal(prepFailed[2].detail, "worker crashed");

  const metadataOnlyDone = importProgressPhases(
    "register",
    job({
      kind: "import_register",
      status: "completed",
      phase: "completed",
      total: 2,
      completed: 2,
      registration_committed: true,
      cache_handoff_complete: true,
      cache_job_id: null,
    }),
  );
  assert.deepEqual(metadataOnlyDone.map((row) => row.id), ["validation", "registration"]);
});
