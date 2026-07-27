import assert from "node:assert/strict";
import test from "node:test";

import {
  UPDATE_NOTIFIED_VERSION_KEY,
  accumulateDownloadProgress,
  appUpdateReducer,
  canDismissUpdateModal,
  computeDownloadProgress,
  getUpdateMenuLabel,
  isUpdateMenuDisabled,
  mergeCheckResult,
  mockRelease,
  parseDevUpdateMock,
  renderReleaseNotes,
  shouldNotifyForVersion,
  shouldPersistUpdateBadge,
  shouldShowUpdateUi,
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

test("unknown content length uses indeterminate progress semantics", () => {
  const result = computeDownloadProgress(512_000, null);
  assert.equal(result.percent, null);
  assert.match(result.label, /downloaded$/);
});

test("duplicate check results preserve in-flight update state", () => {
  const release = mockRelease("0.15.0");
  const downloading = {
    status: "downloading" as const,
    release,
    downloadedBytes: 100,
    totalBytes: 1000,
  };
  assert.deepEqual(
    mergeCheckResult(downloading, mockRelease("0.15.0")),
    release,
  );
  assert.deepEqual(
    mergeCheckResult(downloading, mockRelease("0.16.0")),
    mockRelease("0.16.0"),
  );
});

test("download failure returns to retryable state", () => {
  const release = mockRelease("0.15.0");
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
    assert.equal(next.release?.version, "0.15.0");
    assert.notEqual(next.lifecycleMayNeedRestart, true);
  }
});

test("installation failure marks lifecycleMayNeedRestart", () => {
  const release = mockRelease("0.15.0");
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

test("safe release-note parsing and fallback", () => {
  assert.deepEqual(renderReleaseNotes(null), [
    "This release includes improvements and bug fixes.",
  ]);
  assert.deepEqual(renderReleaseNotes("- Faster plots\n* Better filters"), [
    "Faster plots",
    "Better filters",
  ]);
});

test("menu label for each state", () => {
  assert.equal(getUpdateMenuLabel({ status: "idle" }), "Check for updates");
  assert.equal(
    getUpdateMenuLabel({ status: "checking", source: "manual" }),
    "Checking for updates…",
  );
  assert.equal(
    getUpdateMenuLabel({ status: "available", release: mockRelease("0.15.0") }),
    "Update to v0.15.0",
  );
  assert.equal(
    getUpdateMenuLabel({
      status: "downloading",
      release: mockRelease("0.15.0"),
      downloadedBytes: 0,
      totalBytes: null,
    }),
    "Updating to v0.15.0…",
  );
});

test("update badge is independent from paused automation", () => {
  assert.equal(shouldPersistUpdateBadge({ status: "idle" }), false);
  assert.equal(
    shouldPersistUpdateBadge({ status: "available", release: mockRelease("0.15.0") }),
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
    canDismissUpdateModal({ status: "available", release: mockRelease("0.15.0") }),
    true,
  );
  assert.equal(
    canDismissUpdateModal({
      status: "downloading",
      release: mockRelease("0.15.0"),
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
      release: mockRelease("0.15.0"),
      lifecycleMayNeedRestart: true,
    }),
    false,
  );
});

test("notification storage key stays stable", () => {
  assert.equal(UPDATE_NOTIFIED_VERSION_KEY, "cellxplorer-update-notified-version");
});

test("manual check errors keep the menu actionable", () => {
  assert.equal(
    isUpdateMenuDisabled({
      status: "error",
      phase: "check",
      message: "offline",
    }),
    false,
  );
});
