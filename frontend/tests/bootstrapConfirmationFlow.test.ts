import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

import * as policy from "../src/betaBootstrapPolicy.ts";

type Node = { type: unknown; props: Record<string, any> };

/** Production component with dependency-aware hooks and an isolated API/native boundary. */
function confirmationHarness() {
  const slots: any[] = [];
  let cursor = 0;
  const requests: Array<{ url: string; body: any }> = [];
  const invocations: Array<{ command: string; args: any }> = [];
  const status = policy.mockBetaBootstrapStatus("existing", "alpha");
  const token = "0123456789abcdef0123456789abcdef";
  const changed = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous || previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]));
  const memo = (callback: () => unknown, dependencies: unknown[]) => {
    const index = cursor++;
    if (!slots[index] || changed(slots[index].dependencies, dependencies)) {
      slots[index] = { dependencies, value: callback() };
    }
    return slots[index].value;
  };
  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    },
    useMemo: memo,
    useCallback: (callback: () => unknown, dependencies: unknown[]) => memo(() => callback, dependencies),
    useEffect: () => { cursor++; },
  };
  const queryClient = { invalidateQueries: async () => undefined };
  const modules: Record<string, unknown> = {
    react,
    "react/jsx-runtime": {
      jsx: (type: unknown, props: Record<string, any>) => ({ type, props }),
      jsxs: (type: unknown, props: Record<string, any>) => ({ type, props }),
      Fragment: "Fragment",
    },
    "@mantine/core": new Proxy({}, { get: (_target, name) => String(name) }),
    "@tanstack/react-query": {
      useQueryClient: () => queryClient,
      useQuery: (options: { queryKey: string[] }) => ({
        data: options.queryKey[0] === "alpha-bootstrap-status" ? status : undefined,
        isLoading: false, isFetching: false, isError: false,
      }),
      useMutation: () => ({ isPending: false }),
    },
    "@tabler/icons-react": { IconLoader2: "IconLoader2" },
    "../api": {
      get: async () => undefined,
      post: async (url: string, body: unknown) => {
        requests.push({ url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
        return { token };
      },
    },
    "../appChannel": { APP_BRANDING: { channel: "alpha", primaryColor: "alphaPurple" } },
    "../betaBootstrapPolicy": policy,
    "../debug": { addDebugEvent: () => undefined },
    "../downloads": { isTauriApp: () => true },
    "@tauri-apps/api/core": {
      invoke: async (command: string, args: unknown) => {
        invocations.push({ command, args: JSON.parse(JSON.stringify(args)) });
        // Returned activation errors are pre-stop; no real native action runs here.
        throw new Error("Disposable activation boundary stopped before shutdown.");
      },
    },
  };
  const source = readFileSync(new URL("../src/components/BetaBootstrapCoordinator.tsx", import.meta.url), "utf8")
    .replaceAll("import.meta.env.DEV", "false");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected component dependency: ${name}`);
      return modules[name];
    },
    window: { location: { search: "" } },
  });
  const render = (): Node => {
    cursor = 0;
    return exports.BetaBootstrapCoordinator({ backendReady: true, gateRequiredOnLaunch: true });
  };
  const find = (node: any, type: string, label: string): Node | undefined => {
    if (node == null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child, type, label); if (found) return found; }
      return undefined;
    }
    if (node.type === type && node.props.children === label) return node;
    return find(node.props?.children, type, label);
  };
  const click = (label: string) => {
    const button = find(render(), "Button", label);
    assert.ok(button, `Missing button: ${label}`);
    assert.notEqual(button.props.disabled, true, `Disabled button: ${label}`);
    button.props.onClick();
  };
  return { click, requests, invocations, token };
}

for (const source of ["stable", "beta"] as const) {
  test(`existing Alpha confirms ${source} copy using current consent state and the real request path`, async () => {
    const harness = confirmationHarness();
    const product = source === "stable" ? "Stable" : "Beta";
    harness.click(`Copy ${product} library`);
    assert.equal(harness.requests.length, 0, "First click must only request confirmation");
    harness.click(`Replace with ${product}`);
    for (let step = 0; step < 5; step++) await setImmediate();
    assert.deepEqual(harness.requests.find((request) => request.url.endsWith("/stage-copy"))?.body,
      { source, confirmReplaceExistingLibrary: true });
    assert.deepEqual(harness.invocations, [{
      command: "apply_alpha_bootstrap",
      args: { token: harness.token, confirmReplaceExistingLibrary: true },
    }]);
  });
}
