import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function compile(path: string, modules: Record<string, any>, globals: Record<string, any> = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("import.meta.env.DEV", "false"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, ...globals });
  return exports;
}
const policy = compile("../src/whatsNew.ts", { "./appChannel": { APP_CHANNEL: "alpha" } });
test("new tour has its own channel-scoped dismissal and release threshold", () => {
  assert.equal(policy.isAfterReleaseIntroBaseline("0.28.0-alpha.25"), false);
  assert.equal(policy.isAfterReleaseIntroBaseline("0.29.0-alpha.0"), false);
  assert.equal(policy.isAfterReleaseIntroBaseline("0.29.0-alpha.1"), true);
  assert.equal(policy.isAfterReleaseIntroBaseline("0.29.0-alpha.10"), true);
  assert.equal(policy.isAfterReleaseIntroBaseline("0.29.0"), true);
  assert.equal(policy.isAfterReleaseIntroBaseline("invalid"), false);
  const values = new Map([["cellxplorer:alpha:whats-new:indexed-source-search-v1", "seen"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(policy.releaseIntroWasSeen(storage), false);
  policy.markReleaseIntroSeen(storage);
  assert.equal(policy.releaseIntroWasSeen(storage), true);
  assert.match(policy.WHATS_NEW_STORAGE_KEY, /^cellxplorer:alpha:whats-new:cycling-analysis-v1$/);
  assert.doesNotThrow(() => policy.markReleaseIntroSeen({ setItem() { throw Error("disabled storage"); } }));
  assert.equal(policy.releaseIntroWasSeen({ getItem() { throw Error("disabled storage"); } }), false);
});

function coordinator(options: { setup?: boolean; update?: boolean; ready?: boolean; seen?: boolean; dialog?: boolean; desktop?: boolean; version?: string; opened?: boolean } = {}) {
  let opens = 0, closes = 0, searches = 0, marked = 0, existingDialog = options.dialog ?? false;
  let timer: (() => void) | undefined, observer: (() => void) | undefined;
  const component = compile("../src/components/WhatsNewCoordinator.tsx", {
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    react: { useRef: (current: any) => ({ current }), useEffect: (effect: () => void) => effect() },
    "@mantine/core": new Proxy({}, { get: (_, name) => name }), "@mantine/hooks": { useReducedMotion: () => true },
    "@tanstack/react-query": { useQuery: () => ({ data: { setupState: options.setup === false ? "choice" : "complete", needsChoice: options.setup === false, blockingReason: null } }) },
    "../api": { get: () => { throw Error("No backend calls"); } },
    "../appChannel": { APP_CHANNEL: "alpha", APP_BRANDING: { badgeLabel: "ALPHA" } }, "../downloads": { isTauriApp: () => options.desktop !== false },
    "../whatsNew": { ...policy, releaseIntroWasSeen: () => options.seen, markReleaseIntroSeen: () => marked++ },
    "./ReleaseIntroduction": { ReleaseIntroduction: "ReleaseIntroduction" },
    "./ReleaseIntroduction.module.css": { default: {} },
    "./AppUpdateCoordinator": { useOptionalAppUpdate: () => ({ modalOpen: options.update }) },
  }, {
    window: { localStorage: {}, setTimeout: (fn: () => void) => { timer = fn; }, clearTimeout() {} },
    document: { querySelector: () => existingDialog ? {} : null, body: {} },
    MutationObserver: class { constructor(fn: () => void) { observer = fn; } observe() {} disconnect() {} },
  });
  const tree = component.WhatsNewCoordinator({ opened: options.opened ?? false, onOpen: () => opens++, onClose: () => closes++, onTrySearch: () => searches++, ready: options.ready ?? true, version: options.version ?? "0.29.0-alpha.1" });
  return { tree, runTimer: () => timer?.(), releaseDialog: () => { existingDialog = false; observer?.(); }, counts: () => ({ opens, closes, searches, marked }) };
}

test("automatic announcement waits for setup and other dialogs and stays one-time", () => {
  for (const options of [{ setup: false }, { update: true }, { ready: false }, { seen: true }, { desktop: false }, { version: "0.28.0-alpha.25" }, { opened: true }]) {
    const app = coordinator(options); app.runTimer(); assert.equal(app.counts().opens, 0);
  }
  const app = coordinator({ dialog: true }); app.runTimer(); assert.equal(app.counts().opens, 0);
  app.releaseDialog(); assert.equal(app.counts().opens, 1);
});

test("coordinator mounts the release tour only when open; every close path records dismissal", () => {
  assert.equal(coordinator().tree.props.children, false);
  const app = coordinator({ opened: true });
  assert.equal(app.tree.props.children.type, "ReleaseIntroduction");
  app.tree.props.onClose();
  app.tree.props.children.props.onChooseFolders();
  assert.deepEqual(app.counts(), { opens: 0, closes: 2, searches: 1, marked: 2 });
});
