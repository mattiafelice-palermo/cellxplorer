import assert from "node:assert/strict";
import test from "node:test";

import {
  betaInstallReducer,
  mergeBetaCheckResult,
  readBetaNotifiedVersion,
  resolveBetaDiscoveryFeedback,
  shouldNotifyForBetaVersion,
  shouldRunBetaAvailabilityCheck,
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
