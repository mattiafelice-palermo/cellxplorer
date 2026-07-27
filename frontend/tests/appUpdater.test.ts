import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_APP_UPDATE_PREFERENCES,
  UPDATE_NOTIFIED_VERSION_KEY,
  UPDATE_NOTIFICATION_KIND,
  UPDATE_NOTIFICATION_TAG,
  UPDATE_PREFERENCES_KEY,
  accumulateDownloadProgress,
  appUpdateIntervalMs,
  appUpdateReducer,
  canDismissUpdateModal,
  compareSemver,
  computeDownloadProgress,
  getUpdateMenuLabel,
  isProtectedUpdateFlow,
  isUpdateMenuDisabled,
  isValidUpdateNotificationActivation,
  loadAppUpdatePreferences,
  mergeCheckResult,
  mockRelease,
  normalizeUpdaterError,
  notificationActivationAction,
  parseDevUpdateMock,
  parseReleaseNoteLines,
  failurePhaseForLocalUpdatePhase,
  explainUpdateCheckFailure,
  readNotifiedVersion,
  renderReleaseNotes,
  resolveEffectiveCheckSource,
  resolveUpdateDiscoveryFeedback,
  shouldNotifyForVersion,
  shouldPersistUpdateBadge,
  shouldShowUpdateUi,
  shouldSkipAutomaticCheck,
  saveAppUpdatePreferences,
  writeNotifiedVersion,
} from "../src/appUpdater.ts";

test("automatic versus manual no-update behavior", () => {
  assert.deepEqual(
    appUpdateReducer(
      { status: "checking", source: "automatic" },
      { type: "check_success", source: "automatic", release: null },
    ),
    { status: "idle" },
  );
  assert.deepEqual(
    appUpdateReducer(
      { status: "checking", source: "manual" },
      { type: "check_success", source: "manual", release: null },
    ),
    { status: "idle" },
  );
  assert.equal(
    appUpdateReducer(
      { status: "checking", source: "manual" },
      { type: "check_error", source: "manual", message: "offline" },
    ).status,
    "error",
  );
});

test("automatic checks preserve available and recovery state", () => {
  const release = mockRelease("0.16.0");
  const available = { status: "available" as const, release };
  assert.deepEqual(
    appUpdateReducer(available, { type: "check_started", source: "automatic" }),
    available,
  );
  assert.deepEqual(
    appUpdateReducer(available, {
      type: "check_error",
      source: "automatic",
      message: "offline",
    }),
    available,
  );

  const installError = {
    status: "error" as const,
    phase: "install" as const,
    message: "launch failed",
    release,
    lifecycleMayNeedRestart: true,
  };
  assert.deepEqual(
    appUpdateReducer(installError, { type: "check_started", source: "automatic" }),
    installError,
  );
  assert.equal(shouldSkipAutomaticCheck(installError, false), true);
  assert.equal(shouldSkipAutomaticCheck(available, true), true);
  assert.equal(canDismissUpdateModal(installError), false);
});

test("semver comparison and older check results do not replace current release", () => {
  assert.equal(compareSemver("0.16.0", "0.15.0"), 1);
  assert.equal(compareSemver("0.15.0", "0.16.0"), -1);
  assert.equal(compareSemver("v0.15.0", "0.15.0"), 0);

  const current = { status: "available" as const, release: mockRelease("0.16.0") };
  assert.deepEqual(mergeCheckResult(current, mockRelease("0.15.0")), current.release);
  assert.deepEqual(mergeCheckResult(current, mockRelease("0.16.0")), current.release);
  assert.deepEqual(mergeCheckResult(current, mockRelease("0.17.0")), mockRelease("0.17.0"));
});

test("once-per-version notification rule", () => {
  assert.equal(shouldNotifyForVersion("0.15.0", null), true);
  assert.equal(shouldNotifyForVersion("0.15.0", "0.15.0"), false);
  assert.equal(shouldNotifyForVersion("0.16.0", "0.15.0"), true);
});

test("progress accumulation and percentage calculation", () => {
  let progress = accumulateDownloadProgress(
    { downloadedBytes: 0, totalBytes: null },
    { event: "started", data: { contentLength: 1000 } },
  );
  assert.equal(progress.totalBytes, 1000);
  progress = accumulateDownloadProgress(progress, {
    event: "progress",
    data: { chunkLength: 250 },
  });
  assert.equal(progress.downloadedBytes, 250);
  assert.deepEqual(computeDownloadProgress(250, 1000), {
    percent: 25,
    label: "25% · 250 B / 1000 B",
  });
});

test("rapid back-to-back download events accumulate inside the reducer", () => {
  const release = mockRelease("0.16.0");
  let state = appUpdateReducer(
    { status: "available", release },
    { type: "download_started", release },
  );
  state = appUpdateReducer(state, {
    type: "download_event",
    release,
    event: { event: "started", data: { contentLength: 1000 } },
  });
  state = appUpdateReducer(state, {
    type: "download_event",
    release,
    event: { event: "progress", data: { chunkLength: 250 } },
  });
  state = appUpdateReducer(state, {
    type: "download_event",
    release,
    event: { event: "progress", data: { chunkLength: 400 } },
  });
  state = appUpdateReducer(state, {
    type: "download_event",
    release,
    event: { event: "progress", data: { chunkLength: 350 } },
  });
  assert.equal(state.status, "downloading");
  if (state.status === "downloading") {
    assert.equal(state.downloadedBytes, 1000);
    assert.equal(state.totalBytes, 1000);
  }
});

test("stale download events from another version are ignored", () => {
  const release = mockRelease("0.16.0");
  const other = mockRelease("0.17.0");
  let state = appUpdateReducer(
    { status: "available", release },
    { type: "download_started", release },
  );
  state = appUpdateReducer(state, {
    type: "download_event",
    release: other,
    event: { event: "progress", data: { chunkLength: 999 } },
  });
  assert.equal(state.status, "downloading");
  if (state.status === "downloading") {
    assert.equal(state.downloadedBytes, 0);
  }
});

test("unknown content length uses indeterminate progress semantics", () => {
  const result = computeDownloadProgress(512_000, null);
  assert.equal(result.percent, null);
  assert.match(result.label, /downloaded$/);
});

test("protected update flows ignore newer check results", () => {
  const release = mockRelease("0.16.0");
  const downloading = {
    status: "downloading" as const,
    release,
    downloadedBytes: 100,
    totalBytes: 1000,
  };
  assert.equal(isProtectedUpdateFlow(downloading), true);
  assert.deepEqual(mergeCheckResult(downloading, mockRelease("0.17.0")), release);
  assert.deepEqual(mergeCheckResult(downloading, null), release);
  assert.deepEqual(
    appUpdateReducer(downloading, {
      type: "check_success",
      source: "automatic",
      release: mockRelease("0.17.0"),
    }),
    downloading,
  );
});

test("download failure returns to retryable state", () => {
  const release = mockRelease("0.16.0");
  const next = appUpdateReducer(
    {
      status: "downloading",
      release,
      downloadedBytes: 100,
      totalBytes: 1000,
    },
    { type: "download_error", release, message: "network" },
  );
  assert.equal(next.status, "error");
  if (next.status === "error") {
    assert.equal(next.phase, "download");
    assert.equal(next.release?.version, "0.16.0");
    assert.notEqual(next.lifecycleMayNeedRestart, true);
  }
});

test("installation failure marks lifecycleMayNeedRestart", () => {
  const release = mockRelease("0.16.0");
  const next = appUpdateReducer(
    { status: "launching", release },
    {
      type: "install_error",
      release,
      message: "installer failed",
      lifecycleMayNeedRestart: true,
    },
  );
  assert.equal(next.status, "error");
  if (next.status === "error") {
    assert.equal(next.phase, "install");
    assert.equal(next.lifecycleMayNeedRestart, true);
  }
});

test("safe release-note parsing preserves mixed text and bullets", () => {
  assert.deepEqual(parseReleaseNoteLines(null), [
    { kind: "text", text: "This release includes improvements and bug fixes." },
  ]);
  assert.deepEqual(parseReleaseNoteLines("- Faster plots\n* Better filters"), [
    { kind: "bullet", text: "Faster plots" },
    { kind: "bullet", text: "Better filters" },
  ]);
  assert.deepEqual(
    parseReleaseNoteLines("Important note\n- Fixed updater\n- Improved progress"),
    [
      { kind: "text", text: "Important note" },
      { kind: "bullet", text: "Fixed updater" },
      { kind: "bullet", text: "Improved progress" },
    ],
  );
  assert.deepEqual(renderReleaseNotes("<b>raw</b>\n- item"), ["<b>raw</b>", "item"]);
});

test("normalizeUpdaterError preserves strings and Error messages", () => {
  assert.equal(
    normalizeUpdaterError(
      "No pending update matches the requested version.",
      "fallback",
    ),
    "No pending update matches the requested version.",
  );
  assert.equal(normalizeUpdaterError(new Error("boom"), "fallback"), "boom");
  assert.equal(normalizeUpdaterError({ nested: true }, "fallback"), "fallback");
  assert.equal(normalizeUpdaterError("   ", "fallback"), "fallback");
});

test("explainUpdateCheckFailure maps transport failures to plain language", () => {
  assert.match(
    explainUpdateCheckFailure("Could not fetch a valid release JSON from the remote"),
    /could not find update information/i,
  );
  assert.match(
    explainUpdateCheckFailure("network offline"),
    /could not reach the update server/i,
  );
  assert.match(explainUpdateCheckFailure("unexpected"), /could not check for updates/i);
});

test("dismiss_check_error clears manual check failures only", () => {
  assert.deepEqual(
    appUpdateReducer(
      { status: "error", phase: "check", message: "offline" },
      { type: "dismiss_check_error" },
    ),
    { status: "idle" },
  );
  const downloadError = {
    status: "error" as const,
    phase: "download" as const,
    message: "fail",
    release: mockRelease("0.16.0"),
  };
  assert.deepEqual(
    appUpdateReducer(downloadError, { type: "dismiss_check_error" }),
    downloadError,
  );
});

test("menu label for each state", () => {
  assert.equal(getUpdateMenuLabel({ status: "idle" }), "Check for updates");
  assert.equal(
    getUpdateMenuLabel({ status: "checking", source: "manual" }),
    "Checking for updates…",
  );
  assert.equal(
    getUpdateMenuLabel({ status: "available", release: mockRelease("0.16.0") }),
    "Update to v0.16.0",
  );
  assert.equal(
    getUpdateMenuLabel({
      status: "downloading",
      release: mockRelease("0.16.0"),
      downloadedBytes: 0,
      totalBytes: null,
    }),
    "Updating to v0.16.0…",
  );
});

test("update badge is independent from paused automation", () => {
  assert.equal(shouldPersistUpdateBadge({ status: "idle" }), false);
  assert.equal(
    shouldPersistUpdateBadge({ status: "available", release: mockRelease("0.16.0") }),
    true,
  );
  assert.equal(
    shouldPersistUpdateBadge({
      status: "error",
      phase: "check",
      message: "offline",
    }),
    false,
  );
});

test("development mock parsing stays dev-only", () => {
  assert.equal(parseDevUpdateMock("?mockUpdate=available", true), "available");
  assert.equal(parseDevUpdateMock("?mockUpdate=available", false), null);
  assert.equal(shouldShowUpdateUi(false, "available"), true);
  assert.equal(shouldShowUpdateUi(false, null), false);
});

test("modal dismissal rules follow download and install phases", () => {
  assert.equal(
    canDismissUpdateModal({ status: "available", release: mockRelease("0.16.0") }),
    true,
  );
  assert.equal(
    canDismissUpdateModal({
      status: "downloading",
      release: mockRelease("0.16.0"),
      downloadedBytes: 0,
      totalBytes: 100,
    }),
    false,
  );
  assert.equal(
    canDismissUpdateModal({
      status: "error",
      phase: "install",
      message: "failed",
      release: mockRelease("0.16.0"),
      lifecycleMayNeedRestart: true,
    }),
    false,
  );
});

test("notification storage key stays stable", () => {
  assert.equal(UPDATE_NOTIFIED_VERSION_KEY, "cellxplorer-update-notified-version");
});

test("update preferences default to twelve hours with notifications enabled", () => {
  const storage = { getItem: () => null };
  assert.deepEqual(loadAppUpdatePreferences(storage), DEFAULT_APP_UPDATE_PREFERENCES);
  assert.equal(appUpdateIntervalMs(DEFAULT_APP_UPDATE_PREFERENCES), 12 * 60 * 60 * 1000);
});

test("update preferences support a fifteen-second interval", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const preferences = {
    intervalValue: 15,
    intervalUnit: "seconds" as const,
    notificationsEnabled: false,
  };
  saveAppUpdatePreferences(storage, preferences);
  assert.equal(values.has(UPDATE_PREFERENCES_KEY), true);
  assert.deepEqual(loadAppUpdatePreferences(storage), preferences);
  assert.equal(appUpdateIntervalMs(preferences), 15_000);
});

test("invalid update preferences fail safely to defaults", () => {
  const malformed = { getItem: () => "{not json" };
  const invalid = {
    getItem: () =>
      JSON.stringify({
        intervalValue: 0,
        intervalUnit: "weeks",
        notificationsEnabled: false,
      }),
  };
  assert.deepEqual(loadAppUpdatePreferences(malformed), DEFAULT_APP_UPDATE_PREFERENCES);
  assert.deepEqual(loadAppUpdatePreferences(invalid), DEFAULT_APP_UPDATE_PREFERENCES);
});

test("update discovery feedback is source-aware", () => {
  const release = mockRelease("0.16.0");
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "manual",
      release,
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "open-modal",
  );
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "native-notification",
  );
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: false,
      notifiedVersion: null,
    }),
    "badge-only",
  );
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: true,
      notifiedVersion: "0.16.0",
    }),
    "badge-only",
  );
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "automatic",
      release: null,
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "silent",
  );
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "manual",
      release: null,
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "open-modal",
  );
});

test("manual coalesced with automatic check is treated as manual", () => {
  assert.equal(resolveEffectiveCheckSource("automatic", "manual"), "manual");
  assert.equal(resolveEffectiveCheckSource("manual", "automatic"), "manual");
  assert.equal(resolveEffectiveCheckSource("automatic", "automatic"), "automatic");
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: resolveEffectiveCheckSource("automatic", "manual"),
      release: mockRelease("0.16.0"),
      notificationsEnabled: true,
      notifiedVersion: null,
    }),
    "open-modal",
  );
});

test("manual discovery records the version as seen", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const release = mockRelease("0.16.0");
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "manual",
      release,
      notificationsEnabled: true,
      notifiedVersion: readNotifiedVersion(storage),
    }),
    "open-modal",
  );
  writeNotifiedVersion(storage, release.version);
  assert.equal(readNotifiedVersion(storage), "0.16.0");
  assert.equal(
    resolveUpdateDiscoveryFeedback({
      source: "automatic",
      release,
      notificationsEnabled: true,
      notifiedVersion: readNotifiedVersion(storage),
    }),
    "badge-only",
  );
});

test("notification failure keeps available badge state", () => {
  const release = mockRelease("0.16.0");
  const available = appUpdateReducer(
    { status: "checking", source: "automatic" },
    { type: "check_success", source: "automatic", release },
  );
  assert.equal(available.status, "available");
  assert.equal(shouldPersistUpdateBadge(available), true);
  // A failed native notification must not clear available state or the badge.
  assert.deepEqual(available, { status: "available", release });
});

test("notification activation accepts only exact tag/kind and trimmed version", () => {
  assert.equal(
    isValidUpdateNotificationActivation({
      tag: UPDATE_NOTIFICATION_TAG,
      kind: UPDATE_NOTIFICATION_KIND,
      version: "0.16.0",
    }),
    true,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      tag: UPDATE_NOTIFICATION_TAG,
      version: "0.16.0",
    }),
    false,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      kind: UPDATE_NOTIFICATION_KIND,
      version: "0.16.0",
    }),
    false,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      tag: "other",
      kind: UPDATE_NOTIFICATION_KIND,
      version: "0.16.0",
    }),
    false,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      tag: UPDATE_NOTIFICATION_TAG,
      kind: UPDATE_NOTIFICATION_KIND,
      version: "   ",
    }),
    false,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      tag: UPDATE_NOTIFICATION_TAG,
      kind: UPDATE_NOTIFICATION_KIND,
      version: " 0.16.0 ",
    }),
    false,
  );
  assert.equal(
    isValidUpdateNotificationActivation({
      version: "0.16.0",
    }),
    false,
  );
  assert.equal(notificationActivationAction(), "open-modal");
});

test("install-phase failures stay install even if React state lags", () => {
  assert.equal(failurePhaseForLocalUpdatePhase("download"), "download");
  assert.equal(failurePhaseForLocalUpdatePhase("install"), "install");
});
