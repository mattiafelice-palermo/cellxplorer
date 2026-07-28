import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_BRANDING,
  APP_CHANNEL,
  brandingForChannel,
  parseAppChannel,
} from "../src/appChannel.ts";

test("missing Vite channel defaults to stable in dev policy", () => {
  assert.equal(parseAppChannel(undefined), "stable");
  assert.equal(parseAppChannel(""), "stable");
  assert.equal(parseAppChannel("   "), "stable");
});

test("stable and beta map to exact locked branding", () => {
  assert.deepEqual(brandingForChannel("stable"), {
    channel: "stable",
    productName: "CellXplorer",
    shortName: "CellXplorer",
    headerTitle: "CellXplorer",
    isBeta: false,
    primaryColor: "teal",
    appIconPath: "/app-icon.png",
  });
  assert.deepEqual(brandingForChannel("beta"), {
    channel: "beta",
    productName: "CellXplorer Beta",
    shortName: "CellXplorer Beta",
    headerTitle: "CellXplorer",
    isBeta: true,
    primaryColor: "betaBlue",
    appIconPath: "/app-icon-beta.png",
  });
});

test("invalid channel values fail", () => {
  assert.throws(() => parseAppChannel("preview"), /Unsupported VITE_CELLXPLORER_CHANNEL/);
  assert.throws(() => parseAppChannel("0.16.2-beta.1"), /Unsupported VITE_CELLXPLORER_CHANNEL/);
});

test("compiled app channel matches build-time env or stable default", () => {
  assert.ok(APP_CHANNEL === "stable" || APP_CHANNEL === "beta");
  assert.equal(APP_BRANDING.channel, APP_CHANNEL);
  if (APP_CHANNEL === "stable") {
    assert.equal(APP_BRANDING.isBeta, false);
    assert.equal(APP_BRANDING.appIconPath, "/app-icon.png");
  } else {
    assert.equal(APP_BRANDING.isBeta, true);
    assert.equal(APP_BRANDING.appIconPath, "/app-icon-beta.png");
  }
});
