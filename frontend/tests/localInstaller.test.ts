import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as updater from "../src/appUpdater.ts";

const local: updater.AppUpdateRelease = { version: "0.28.0-alpha.16", currentVersion: "0.28.0-alpha.15", notes: null, publishedAt: null, localInstaller: true };

function harness(stageError?: Error) {
  const slots: any[] = [];
  let cursor = 0;
  const calls: any[] = [];
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (value: any) => { slots[index] = value; }]; },
    useReducer(reducer: any, initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (action: any) => { slots[index] = reducer(slots[index], action); }]; },
    useRef(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback: (callback: any) => { cursor++; return callback; },
    useMemo: (callback: any) => { cursor++; return callback(); },
    useEffect: () => { cursor++; },
  };
  const modules: Record<string, any> = {
    react,
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "@mantine/modals": { modals: {} }, "@mantine/notifications": { notifications: { show: () => {} } },
    "../api": { post: async () => { calls.push(["session"]); } },
    "../appChannel": { APP_CHANNEL: "alpha" },
    "../features/analyses/workspace/analysisWorkspace": { hasDirtyAnalysisWorkspaceEditors: () => false },
    "../appUpdater": {
      ...updater,
      stageLocalAppUpdateTauri: async (...args: any[]) => { calls.push(["stage", ...args]); if (stageError) throw stageError; return local; },
      installAppUpdateTauri: async (...args: any[]) => { calls.push(["install", ...args]); },
      downloadAppUpdateTauri: async () => { calls.push(["download"]); },
      checkAppUpdateTauri: async () => { calls.push(["check"]); return null; },
      discardLocalAppUpdateTauri: async () => { calls.push(["discard"]); },
    },
    "../debug": { addDebugEvent: () => {} }, "../downloads": { isTauriApp: () => true },
    "../updateNotifications": {}, "./AppUpdateModal": { AppUpdateModal: "Modal" },
  };
  const source = readFileSync(new URL("../src/components/AppUpdateCoordinator.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  runInNewContext(js, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, Event, window: { localStorage: { getItem: () => null, setItem: () => {} }, dispatchEvent: () => {}, location: { search: "" } } });
  return { calls, render() { cursor = 0; return exports.AppUpdateProvider({ children: null }).props.value; } };
}

test("native local source is preserved when mapped and automatic discovery pauses", () => {
  assert.equal(updater.mapTauriRelease(local).localInstaller, true);
  assert.equal(updater.shouldSkipAutomaticCheck({ status: "available", release: local }, false), true);
  assert.equal(updater.canUseLocalInstaller({ status: "launching", release: local }), false);
  assert.equal(updater.canUseLocalInstaller({ status: "error", phase: "install", release: local, message: "unknown" }), false);
});

test("verify stages without installation; explicit action uses standard install without download", async () => {
  const app = harness();
  await app.render().stageLocalInstaller("C:\\candidate.exe", "C:\\candidate.exe.sig");
  assert.deepEqual(app.calls.map(call => call[0]), ["stage"]);
  const verified = app.render();
  assert.equal(verified.state.release.localInstaller, true);
  assert.equal(verified.modalOpen, true);
  await verified.checkForUpdate("automatic");
  assert.equal(app.calls.some(call => call[0] === "check"), false);
  await verified.downloadAndLaunchInstaller();
  assert.deepEqual(app.calls.filter(call => call[0] === "install"), [["install", local.version]]);
  assert.equal(app.calls.some(call => call[0] === "download"), false);
  assert.equal(app.render().state.status, "launching");
});

test("failed verification keeps previous state and never installs", async () => {
  const app = harness(new Error("Invalid signature"));
  await assert.rejects(app.render().stageLocalInstaller("C:\\candidate.exe", "C:\\candidate.sig"), /Invalid signature/);
  assert.equal(app.render().state.status, "idle");
  assert.equal(app.calls.some(call => call[0] === "install"), false);
});

test("discard removes a local candidate and permits normal discovery again", async () => {
  const app = harness();
  await app.render().stageLocalInstaller("C:\\candidate.exe", "C:\\candidate.sig");
  await app.render().discardLocalInstaller();
  const cleared = app.render();
  assert.equal(cleared.state.status, "idle");
  await cleared.checkForUpdate("manual");
  assert.equal(app.calls.some(call => call[0] === "check"), true);
  assert.equal(app.calls.some(call => call[0] === "install"), false);
});
