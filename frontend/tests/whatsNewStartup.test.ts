import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

/** Run the production coordinator with native IO isolated, not a second policy. */
function harness() {
  let blocking = true, seen = false, dialog = false, opens = 0;
  let status: any = { setupState: "complete", needsChoice: false, blockingReason: null };
  let callback: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const shown = { current: false };
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useRef: () => shown, useEffect: (effect: () => any) => { cleanup = effect(); } },
    "@mantine/core": new Proxy({}, { get: (_, key) => key }),
    "@mantine/hooks": { useReducedMotion: () => true },
    "@tanstack/react-query": { useQuery: () => ({ data: status }) },
    "../api": { get() { throw Error("Unexpected IO"); } },
    "../appChannel": { APP_CHANNEL: "alpha", APP_BRANDING: { badgeLabel: "Alpha" } },
    "../downloads": { isTauriApp: () => true },
    "../whatsNew": { isAfterReleaseIntroBaseline: () => true, releaseIntroWasSeen: () => seen, markReleaseIntroSeen: () => { seen = true; } },
    "./ReleaseIntroduction": { ReleaseIntroduction: "ReleaseIntroduction" },
    "./ReleaseIntroduction.module.css": { default: {} },
    "./AppUpdateCoordinator": { useOptionalAppUpdate: () => null },
  };
  const source = ts.transpileModule(readFileSync(new URL("../src/components/WhatsNewCoordinator.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.DEV", "false"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  runInNewContext(source, {
    exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    document: { body: {}, querySelector: () => dialog ? {} : null },
    window: { localStorage: {}, setTimeout: (fn: () => void) => { callback = fn; return 1; }, clearTimeout: () => { callback = undefined; } },
    MutationObserver: class { constructor(fn: () => void) { callback = fn; } observe() {} disconnect() {} },
  });
  const render = () => {
    cleanup?.(); cleanup = undefined;
    return exports.WhatsNewCoordinator({ opened: false, onOpen: () => opens++, onClose() {}, onTrySearch() {}, ready: true, version: "0.29.0-alpha.2", bootstrapBlocking: blocking });
  };
  return { render, tick: () => callback?.(), opens: () => opens,
    blocking: (value: boolean) => { blocking = value; }, dialog: (value: boolean) => { dialog = value; },
    status: (value: any) => { status = value; } };
}

test("completed backend cannot bypass the actual picker/preparation gate", () => {
  const app = harness();
  app.render(); app.tick(); assert.equal(app.opens(), 0);
  app.blocking(false); app.dialog(true); app.render(); app.tick();
  assert.equal(app.opens(), 0, "wait for closing dialog transition");
  app.dialog(false); app.tick(); assert.equal(app.opens(), 1);
  app.render(); app.tick(); assert.equal(app.opens(), 1, "only once in this session");
});

test("choice, loading and recovery remain blocked even if UI gate releases", () => {
  const app = harness(); app.blocking(false);
  for (const status of [undefined, { setupState: "choice-required", needsChoice: true }, { setupState: "blocked-error", blockingReason: "recovery" }]) {
    app.status(status); app.render(); app.tick(); assert.equal(app.opens(), 0);
  }
});

test("closing persists dismissal across coordinator remounts", () => {
  const app = harness(); app.blocking(false);
  app.render().props.onClose(); app.render(); app.tick(); assert.equal(app.opens(), 0);
});
