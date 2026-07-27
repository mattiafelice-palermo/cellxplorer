import assert from "node:assert/strict";
import test from "node:test";

import type { BetaBootstrapStatus } from "../src/api.ts";
import {
  betaBootstrapGateOpen,
  copyStableLibraryDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  resolveBetaBootstrapSetupState,
  shouldRetryExistingStage,
  shouldShowBetaBootstrapUi,
} from "../src/betaBootstrapPolicy.ts";

const availableStatus: BetaBootstrapStatus = {
  channel: "beta",
  setupState: "choice-required",
  decision: null,
  needsChoice: true,
  betaPristine: true,
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
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=unknown", true), null);
});

test("bootstrap UI is beta-only and requires Tauri or dev mock", () => {
  assert.equal(shouldShowBetaBootstrapUi("stable", true, null), false);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, null), false);
  assert.equal(shouldShowBetaBootstrapUi("beta", true, null), true);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, "available"), true);
});

test("installed Beta stays gated while status loads or errors", () => {
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
  assert.equal(betaBootstrapGateOpen("loading"), true);
  assert.equal(betaBootstrapGateOpen("blocked-error"), true);
  assert.equal(betaBootstrapGateOpen("complete"), false);
  assert.equal(betaBootstrapGateOpen("inactive"), false);
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

test("outstanding stage tokens are lower-hex only", () => {
  assert.equal(shouldRetryExistingStage("0123456789abcdef0123456789abcdef"), true);
  assert.equal(shouldRetryExistingStage("ABCDEF0123456789ABCDEF0123456789"), false);
  assert.equal(shouldRetryExistingStage(null), false);
});

test("stable never enables bootstrap UI", () => {
  assert.equal(shouldShowBetaBootstrapUi("stable", true, "available"), false);
});
