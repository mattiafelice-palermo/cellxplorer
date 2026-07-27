import assert from "node:assert/strict";
import test from "node:test";

import type { BetaBootstrapStatus } from "../src/api.ts";
import {
  betaBootstrapModalOpen,
  copyStableLibraryDisabled,
  mockBetaBootstrapStatus,
  parseDevBetaBootstrapMock,
  shouldShowBetaBootstrapUi,
} from "../src/betaBootstrapPolicy.ts";

const availableStatus: BetaBootstrapStatus = {
  channel: "beta",
  decision: null,
  needsChoice: true,
  betaPristine: true,
  stableDatabaseExists: true,
  stableDatabaseCompatible: true,
  stableDatabasePath: "C:\\Users\\example\\.cellxplorer\\cellxplorer.db",
  blockingReason: null,
};

test("dev mock query parsing is development-only", () => {
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=available", false), null);
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=available", true), "available");
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=blocked", true), "blocked");
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=copy-error", true), "copy-error");
  assert.equal(parseDevBetaBootstrapMock("?mockBetaBootstrap=unknown", true), null);
});

test("bootstrap UI is beta-only and requires Tauri or dev mock", () => {
  assert.equal(shouldShowBetaBootstrapUi("stable", true, null), false);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, null), false);
  assert.equal(shouldShowBetaBootstrapUi("beta", true, null), true);
  assert.equal(shouldShowBetaBootstrapUi("beta", false, "available"), true);
});

test("modal opens only when Beta needs a choice or a dev mock is active", () => {
  assert.equal(betaBootstrapModalOpen(undefined, null), false);
  assert.equal(betaBootstrapModalOpen({ ...availableStatus, needsChoice: false }, null), false);
  assert.equal(betaBootstrapModalOpen(availableStatus, null), true);
  assert.equal(betaBootstrapModalOpen(undefined, "blocked"), true);
});

test("blocked copy keeps Start empty enabled but disables copy", () => {
  const blocked = mockBetaBootstrapStatus("blocked");
  assert.equal(copyStableLibraryDisabled(blocked, false, "blocked"), true);
  assert.equal(copyStableLibraryDisabled(blocked, false, null), true);
  assert.equal(copyStableLibraryDisabled(availableStatus, true, null), true);
  assert.equal(copyStableLibraryDisabled(availableStatus, false, null), false);
});
