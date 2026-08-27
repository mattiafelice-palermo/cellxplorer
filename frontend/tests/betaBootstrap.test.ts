import assert from "node:assert/strict";
import test from "node:test";

import type { BetaBootstrapStatus } from "../src/api.ts";
import {
  betaBootstrapGateOpen,
  betaBootstrapLoadingStatus,
  alphaSourceBlockingReason,
  alphaSourceCopyDisabled,
  copyStableLibraryDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  resolveBetaBootstrapSetupState,
  scientificPreparationResourceText,
  shouldRetryExistingStage,
  shouldShowBetaBootstrapUi,
} from "../src/betaBootstrapPolicy.ts";

const availableStatus: BetaBootstrapStatus = {
  channel: "beta",
  setupState: "choice-required",
  decision: null,
  needsChoice: true,
  betaPristine: true,
  betaHasExistingLibrary: false,
  acknowledgedAppVersion: null,
  acknowledgedInstallInstanceId: null,
  stableDatabaseExists: true,
  stableDatabaseCompatible: true,
  stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
  copyBlockingReason: null,
  setupError: null,
  blockingReason: null,
  outstandingStageToken: null,
  applyFailureMessage: null,
};

test("dev mock query parsing is development-only", () => {
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=available", false), null);
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=available", true), "available");
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=loading", true), "loading");
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=corrupt-marker", true), "corrupt-marker");
  assert.equal(
    parseDevBetaBootstrapMock("?mockAlphaBootstrap=both-blocked", true, "alpha"),
    "both-blocked",
  );
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=unknown", true), null);
});

test("bootstrap UI is channel-aware and requires Tauri or dev mock", () => {
  assert.equal(shouldShowBetaBootstrapUi("stable", true, null), false);
  assert.equal(shouldShowBetaBootstrapUi("alpha", true, "available"), true);
  assert.equal(shouldShowBetaBootstrapUi("alpha", false, null), false);
  assert.equal(shouldShowBetaBootstrapUi("alpha", false, "available"), true);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, null), false);
  assert.equal(shouldShowBetaBootstrapUi("beta", true, null), true);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, "available"), true);
});

test("installed Beta checks silently while loading and gates confirmed errors or choices", () => {
  assert.equal(
    resolveBetaBootstrapSetupState({
      enabled: true,
      mock: null,
      statusLoading: true,
      statusError: false,
    }),
    "loading",
  );
  assert.equal(
    resolveBetaBootstrapSetupState({
      enabled: true,
      mock: null,
      statusLoading: false,
      statusError: true,
    }),
    "blocked-error",
  );
  assert.equal(
    resolveBetaBootstrapSetupState({
      enabled: true,
      mock: null,
      status: availableStatus,
      statusLoading: false,
      statusError: false,
    }),
    "choice-required",
  );
  assert.equal(
    resolveBetaBootstrapSetupState({
      enabled: true,
      mock: null,
      status: { ...availableStatus, setupState: "complete", needsChoice: false, decision: "empty" },
      statusLoading: false,
      statusError: false,
    }),
    "complete",
  );
  assert.equal(betaBootstrapGateOpen("loading"), false);
  assert.equal(betaBootstrapGateOpen("loading", true), true);
  assert.equal(betaBootstrapGateOpen("blocked-error"), true);
  assert.equal(betaBootstrapGateOpen("complete"), false);
  assert.equal(betaBootstrapGateOpen("inactive"), false);
});

test("bootstrap loading status explains long local checks", () => {
  assert.match(betaBootstrapLoadingStatus(false, 0).title, /Starting/);
  assert.match(betaBootstrapLoadingStatus(true, 1).title, /Reading/);
  assert.match(betaBootstrapLoadingStatus(true, 4).title, /compatibility/);
  assert.match(betaBootstrapLoadingStatus(true, 10).detail, /large database/i);
});

test("corrupt marker remains blocked", () => {
  const corrupt = mockBetaBootstrapStatus("corrupt-marker");
  assert.equal(corrupt.setupState, "blocked-error");
  assert.equal(corrupt.needsChoice, false);
  assert.ok(corrupt.setupError);
});

test("blocked copy keeps Start empty enabled but disables copy", () => {
  const blocked = mockBetaBootstrapStatus("blocked");
  assert.equal(copyStableLibraryDisabled(blocked, false, "blocked"), true);
  assert.equal(copyStableLibraryDisabled(availableStatus, true, null), true);
  assert.equal(copyStableLibraryDisabled(availableStatus, false, null), false);
});

test("Alpha copy sources are independently blocked while Start empty remains available", () => {
  const stableBlocked = mockBetaBootstrapStatus("stable-blocked", "alpha");
  assert.equal(alphaSourceCopyDisabled(stableBlocked, "stable", false, "stable-blocked"), true);
  assert.equal(alphaSourceCopyDisabled(stableBlocked, "beta", false, "stable-blocked"), false);
  assert.match(
    alphaSourceBlockingReason(stableBlocked, "stable", "stable-blocked") ?? "",
    /CellXplorer library/,
  );
  assert.equal(alphaSourceCopyDisabled(stableBlocked, "stable", true, null), true);
});

test("outstanding stage tokens are lower-hex only", () => {
  assert.equal(shouldRetryExistingStage("0123456789abcdef0123456789abcdef"), true);
  assert.equal(shouldRetryExistingStage("ABCDEF0123456789ABCDEF0123456789"), false);
  assert.equal(shouldRetryExistingStage(null), false);
});

test("stable never enables bootstrap UI", () => {
  assert.equal(shouldShowBetaBootstrapUi("stable", true, "available"), false);
});

test("scientific preparation resource text reflects foreground and drained work", () => {
  assert.match(
    scientificPreparationResourceText({
      resource_mode: "foreground",
      workers: 3,
      transition_pending: false,
    }),
    /3 files in parallel/,
  );
  assert.match(
    scientificPreparationResourceText({
      resource_mode: "foreground",
      workers: 1,
      transition_pending: false,
    }),
    /one file at normal priority/,
  );
  assert.match(
    scientificPreparationResourceText({
      resource_mode: "background",
      workers: 1,
      transition_pending: true,
    }),
    /already in progress/,
  );
  assert.match(scientificPreparationResourceText(undefined), /reduced priority/);
});
