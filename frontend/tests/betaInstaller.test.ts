import assert from "node:assert/strict";
import test from "node:test";

import {
  betaInstallReducer,
  canDismissBetaInstallModal,
  clearBetaNotifiedVersion,
  finishSessionAndInstallBeta,
  mergeBetaCheckResult,
  readBetaNotifiedVersion,
  resolveBetaDiscoveryFeedback,
  shouldNotifyForBetaVersion,
  shouldRunBetaAvailabilityCheck,
  startBetaCheckSchedule,
  writeBetaNotifiedVersion,
} from "../src/betaInstaller.ts";
import { mockRelease } from "../src/appUpdater.ts";

const storage = new Map<string, string>();

test("beta availability checks require opt-in and no installed copy", () => {
  assert.equal(
    shouldRunBetaAvailabilityCheck({ betaUpdatesEnabled: false, betaInstalled: false }),
    false,
  );
  assert.equal(
    shouldRunBetaAvailabilityCheck({ betaUpdatesEnabled: true, betaInstalled: true }),
    false,
  );
  assert.equal(
    shouldRunBetaAvailabilityCheck({ betaUpdatesEnabled: true, betaInstalled: false }),
    true,
  );
});

test("automatic beta discovery uses native notification once per version", () => {
  const release = mockRelease("0.18.0-beta.1");
  assert.equal(
    resolveBetaDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "native-notification",
  );
  assert.equal(
    resolveBetaDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: true,
      notifiedVersion: release.version,
    }),
    "silent",
  );
});

test("manual beta discovery opens the install modal", () => {
  const release = mockRelease("0.18.0-beta.1");
  assert.equal(
    resolveBetaDiscoveryFeedback({
      source: "manual",
      release,
      notificationsEnabled: false,
      notifiedVersion: null,
    }),
    "open-modal",
  );
});

test("beta notification deduplication persists in localStorage", () => {
  storage.clear();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  assert.equal(readBetaNotifiedVersion(store), null);
  writeBetaNotifiedVersion(store, "0.18.0-beta.1");
  assert.equal(readBetaNotifiedVersion(store), "0.18.0-beta.1");
  assert.equal(shouldNotifyForBetaVersion("0.18.0-beta.1", "0.18.0-beta.1"), false);
});

test("protected beta install flow ignores stale check results", () => {
  const release = mockRelease("0.18.0-beta.1");
  const downloading = betaInstallReducer(
    { status: "available", release },
    { type: "download_started", release },
  );
  assert.equal(
    mergeBetaCheckResult(downloading, mockRelease("0.18.0-beta.2")),
    release,
  );
});

test("beta install finishes the Stable session after download and before launch", async () => {
  const calls: string[] = ["download"];
  await finishSessionAndInstallBeta({
    finishSession: async () => {
      calls.push("finish-session");
    },
    install: async () => {
      calls.push("install");
    },
    onSessionFinishError: () => {
      calls.push("finish-error");
    },
  });
  assert.deepEqual(calls, ["download", "finish-session", "install"]);
});

test("session finish failure is recorded and follows Standard install policy", async () => {
  const calls: string[] = [];
  const error = new Error("backend unavailable");
  await finishSessionAndInstallBeta({
    finishSession: async () => {
      calls.push("finish-session");
      throw error;
    },
    install: async () => {
      calls.push("install");
    },
    onSessionFinishError: (received) => {
      assert.equal(received, error);
      calls.push("finish-error");
    },
  });
  assert.deepEqual(calls, ["finish-session", "finish-error", "install"]);
});

test("manual no-release feedback is visible and dismissible", () => {
  const state = betaInstallReducer(
    { status: "checking" },
    { type: "manual_no_release" },
  );
  assert.equal(state.status, "unavailable");
  assert.equal(canDismissBetaInstallModal(state), true);
});

test("disabling opt-in clears availability but preserves protected install state", () => {
  const release = mockRelease("0.18.0-beta.1");
  assert.deepEqual(
    betaInstallReducer(
      { status: "available", release },
      { type: "preference_disabled" },
    ),
    { status: "idle" },
  );

  const downloading = betaInstallReducer(
    { status: "available", release },
    { type: "download_started", release },
  );
  assert.equal(
    betaInstallReducer(downloading, { type: "preference_disabled" }),
    downloading,
  );

  const store = {
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  storage.set("cellxplorer-beta-notified-version", release.version);
  clearBetaNotifiedVersion(store);
  assert.equal(storage.has("cellxplorer-beta-notified-version"), false);
});

test("schedule-change events cancel and reschedule recurring Beta checks", () => {
  let nextId = 1;
  const timeouts = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let now = 0;
  const host = {
    setTimeout: (callback: () => void) => {
      const id = nextId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id);
    },
    addEventListener: (_name: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_name: string, listener: () => void) => {
      listeners.delete(listener);
    },
  };
  let checks = 0;
  const stop = startBetaCheckSchedule({
    host: host as unknown as Parameters<typeof startBetaCheckSchedule>[0]["host"],
    intervalMs: 60_000,
    initialDelayMs: 1_000,
    runCheck: () => {
      checks += 1;
    },
    now: () => now,
  });

  assert.equal(timeouts.size, 1);
  // A Standard schedule event before Beta is due recreates, but does not postpone, the timer.
  for (const listener of listeners) listener();
  assert.equal(timeouts.size, 1);
  now = 1_000;
  [...timeouts.values()][0]();
  assert.equal(checks, 1);

  assert.equal(timeouts.size, 1);
  now = 61_000;
  [...timeouts.values()][0]();
  assert.equal(checks, 2);

  stop();
  assert.equal(timeouts.size, 0);
  assert.equal(listeners.size, 0);
});
