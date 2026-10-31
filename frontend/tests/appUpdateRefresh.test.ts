import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as updater from "../src/appUpdater.ts";

const release = (sequence: number): updater.AppUpdateRelease => ({
  version: `0.28.0-alpha.${sequence}`, currentVersion: "0.28.0-alpha.15", notes: null, publishedAt: null,
});

/** Execute the production provider, keeping real reducer/policy and only mocking native IO. */
function harness() {
  const slots: any[] = [];
  let cursor = 0, effect = 0;
  const calls: string[] = [];
  const checks: Array<{ resolve: (value: updater.AppUpdateRelease | null) => void; reject: (error: Error) => void }> = [];
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value: any) => { slots[i] = value; }]; },
    useReducer(reducer: any, initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (action: any) => { slots[i] = reducer(slots[i], action); }]; },
    useRef(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (callback: any) => { cursor++; return callback; },
    useMemo: (callback: any) => { cursor++; return callback(); },
    // Sync the two production state refs. Skip mount-only native listeners and timers.
    useEffect: (callback: any) => { cursor++; if (effect++ < 2) callback(); },
  };
  const modules: Record<string, any> = {
    react,
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "@mantine/modals": { modals: {} }, "@mantine/notifications": { notifications: { show: () => {} } },
    "../api": { post: async () => { calls.push("session"); } },
    "../appChannel": { APP_CHANNEL: "alpha" },
    "../features/analyses/workspace/analysisWorkspace": { hasDirtyAnalysisWorkspaceEditors: () => false },
    "../appUpdater": {
      ...updater,
      checkAppUpdateTauri: () => { calls.push("check"); return new Promise((resolve, reject) => checks.push({ resolve, reject })); },
      stageLocalAppUpdateTauri: async () => { calls.push("stage"); return { ...release(20), localInstaller: true }; },
      discardLocalAppUpdateTauri: async () => { calls.push("discard"); },
      downloadAppUpdateTauri: async () => { calls.push("download"); },
      installAppUpdateTauri: async () => { calls.push("install"); },
    },
    "../debug": { addDebugEvent: () => {} }, "../downloads": { isTauriApp: () => true },
    "../updateNotifications": {}, "./AppUpdateModal": { AppUpdateModal: "Modal" },
  };
  const source = readFileSync(new URL("../src/components/AppUpdateCoordinator.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  runInNewContext(js, { exports, require: (name: string) => {
    assert.ok(name in modules, `Unexpected import ${name}`); return modules[name];
  }, Event, window: { localStorage: { getItem: () => null, setItem: () => {} }, dispatchEvent: () => {}, location: { search: "" } } });
  return { calls, checks, render() { cursor = 0; effect = 0; return exports.AppUpdateProvider({ children: null }).props.value; } };
}

test("opening an available update refreshes Alpha A to B and keeps A visible while checking/failing", async () => {
  const app = harness();
  const initial = app.render().checkForUpdate("manual");
  await setImmediate(); app.checks[0].resolve(release(16)); await initial;
  assert.equal(app.render().state.release.version, release(16).version);
  app.render().closeUpdateModal();
  app.render().openUpdateModal();
  await setImmediate();
  assert.equal(app.render().refreshing, true);
  assert.equal(app.render().state.release.version, release(16).version);
  app.checks[1].resolve(release(17)); await setImmediate();
  assert.equal(app.render().state.release.version, release(17).version);
  const retry = app.render().checkForUpdate("manual");
  await setImmediate(); app.checks[2].reject(new Error("Network offline")); await retry;
  assert.equal(app.render().state.release.version, release(17).version);
  assert.equal(app.render().refreshError, "Network offline");
  assert.equal(app.render().refreshing, false);
});

test("manual dialog open joins an automatic check without dropping its newer result", async () => {
  const app = harness();
  const automatic = app.render().checkForUpdate("automatic");
  await setImmediate(); app.render().openUpdateModal(); app.render().openUpdateModal();
  await setImmediate();
  assert.equal(app.calls.filter((call) => call === "check").length, 1);
  assert.equal(app.render().modalOpen, true);
  app.checks[0].resolve(release(18)); await automatic; await setImmediate();
  assert.equal(app.render().state.release.version, release(18).version);
  assert.equal(app.render().modalOpen, true);
});

test("a staged local installer cannot be refreshed or replaced by a remote result", async () => {
  const app = harness();
  await app.render().stageLocalInstaller("C:\\fixture.exe", "C:\\fixture.sig");
  app.render().openUpdateModal();
  await app.render().checkForUpdate("manual");
  assert.equal(app.calls.includes("check"), false);
  assert.equal(app.render().state.release.localInstaller, true);
  assert.equal(app.calls.includes("install"), false);
});

test("closing during refresh keeps discovery working without reopening the dialog", async () => {
  const app = harness();
  const first = app.render().checkForUpdate("manual");
  await setImmediate(); app.checks[0].resolve(release(16)); await first;
  const refreshed = app.render().checkForUpdate("manual");
  await setImmediate(); app.render().closeUpdateModal(); app.render();
  app.checks[1].resolve(release(17)); await refreshed;
  assert.equal(app.render().state.release.version, release(17).version);
  assert.equal(app.render().modalOpen, false);
});

test("local staging supersedes an in-flight manual result before changing pending ownership", async () => {
  const app = harness();
  const first = app.render().checkForUpdate("manual");
  await setImmediate(); app.checks[0].resolve(release(16)); await first;
  const refresh = app.render().checkForUpdate("manual");
  await setImmediate();
  const local = app.render().stageLocalInstaller("C:\\fixture.exe", "C:\\fixture.sig");
  app.checks[1].resolve(release(30)); await refresh; await local;
  assert.equal(app.render().state.release.version, release(20).version);
  assert.equal(app.render().state.release.localInstaller, true);
  assert.equal(app.calls.includes("install"), false);
});

test("full SemVer ordering includes numeric prerelease identifiers and release precedence", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.9", "1.0.0-alpha.10", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(updater.compareSemver(ordered[i - 1], ordered[i]), -1);
    assert.equal(updater.compareSemver(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(updater.compareSemver("v0.28.0-alpha.16+build.1", "0.28.0-alpha.16+build.2"), 0);
  assert.equal(updater.compareSemver("1.0.0-alpha.99999999999999999999", "1.0.0-alpha.99999999999999999998"), 1);
  const local = { status: "available", release: { ...release(20), localInstaller: true } } as const;
  assert.equal(updater.canRefreshAppUpdate(local), false);
  assert.equal(updater.canRefreshAppUpdate({ status: "downloading", release: release(20), downloadedBytes: 0, totalBytes: null }), false);
});
