import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as searchPolicy from "../src/importSearch.ts";
import * as filtersPolicy from "../src/importSearchFilters.ts";
import * as readModePolicy from "../src/mprReadMode.ts";
import * as readabilityPolicy from "../src/importSourceReadability.ts";

/** Exercise actual result handlers; stubs represent controls, not interaction policy. */
function harness(overrides: Record<string, any> = {}, readModes = {}) {
  const slots: any[] = [];
  let cursor = 0;
  let previews = 0;
  let selections = 0;
  let retries = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const file = { kind: "file", canonical: "c:\\source.ndax", path: "C:\\source.ndax", name: "source.ndax", relative_path: "source.ndax", root_path: "C:\\", root_id: "root", root_status: "ready", recognition: "recognized", metadata_state: "ready", metadata: {}, registered: false, extension: ".ndax", supplier: "Neware" };
  Object.assign(file, overrides);
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": {
      useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: any) => slots[i] = typeof next === "function" ? next(slots[i]) : next]; },
      useRef: (initial: any) => { const i = cursor++; return slots[i] ??= { current: initial }; },
      useEffect: () => {},
    },
    "react-dom": { createPortal: (child: any) => child },
    "@mantine/core": new Proxy({}, { get: (_, key) => key }),
    "@tabler/icons-react": new Proxy({}, { get: (_, key) => key }),
    "@mantine/hooks": { useDebouncedValue: (value: any) => [value], useResizeObserver: () => [{ current: null }, { height: 600 }] },
    "@tanstack/react-query": { useQuery: ({ queryKey }: any) => queryKey[0] === "file-search-settings" ? { data: { config: { roots: [{ id: "root", path: "C:\\", enabled: true }], formats: [".ndax"], metadata_enabled: true }, roots: [{ id: "root", path: "C:/", status: file.root_status }] } } : { data: { items: [{ ...file }], total: 1 }, refetch: () => {} } },
    "../api": {}, "react-router-dom": { Link: "Link" },
    "../importSourceReadability": readabilityPolicy,
    "../mprReadMode": readModePolicy,
    "./SavedSearchMenu": { SavedSearchMenu: "SavedSearchMenu" },
    "./IndexedSearchFilters": { IndexedSearchFilters: "IndexedSearchFilters" },
    "./FileSearchSettings": {}, "../importSearchFilters": filtersPolicy, "../importSearch": searchPolicy,
    "../importPathBreadcrumbs": { importPathsEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase() },
    "../importBrowserSelection": { toggleImportFileSelection: (_file: any, _available: any, selected: Map<string, any>) => ({ selected: new Map(selected).set(file.path, file) }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("../src/components/IndexedSourceSearch.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, setTimeout, clearTimeout, requestAnimationFrame: () => {}, HTMLElement: class {} });
  const render = () => {
    cursor = 0;
    return exports.IndexedSourceSearch({ active: true, readModes, onTryPermissive: () => retries++, selected: new Map(), onPreview: () => previews++, onSelection: () => selections++, onDialogChange: () => {}, onReveal: () => {}, onFilterCount: () => {}, onOpenFilters: () => {}, onOpenEntity: () => {}, filterContainer: null });
  };
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && predicate(node)) return node;
    for (const child of Array.isArray(node) ? node : [node.props?.children]) { const result = find(child, predicate); if (result) return result; }
  };
  return { render, find, counts: () => ({ previews, selections }), retries: () => retries };
}

test("checkbox inclusion and result refresh never activate Preview; row and Enter do", () => {
  const app = harness();
  let tree = app.render();
  const checkbox = app.find(tree, (node) => node.type === "Checkbox");
  let stopped = false;
  checkbox.props.onClick({ stopPropagation: () => stopped = true });
  checkbox.props.onChange();
  assert.equal(stopped, true);
  assert.deepEqual(app.counts(), { previews: 0, selections: 1 });
  tree = app.render(); // Equivalent background query result.
  assert.equal(app.counts().previews, 0);
  const row = app.find(tree, (node) => node.props?.role === "option");
  row.props.onClick({ shiftKey: false, ctrlKey: false, metaKey: false });
  const target = {};
  row.props.onKeyDown({ key: "Enter", target, currentTarget: target, preventDefault: () => {} });
  assert.deepEqual(app.counts(), { previews: 2, selections: 1 });
});


test("blocked MPR offers an isolated permissive retry without selecting or activating the row", () => {
  const app = harness({ path: "C:/source.mpr", name: "source.mpr", readability_error: "Unsupported execution" }, { "c:\\source.mpr": "safe" });
  const tree = app.render();
  const retry = app.find(tree, (node) => node.props?.["aria-label"] === "Try Permissive reading for source.mpr");
  assert.ok(retry);
  let stopped = false;
  retry.props.onClick({ stopPropagation: () => stopped = true });
  assert.equal(stopped, true);
  assert.equal(app.retries(), 1);
  assert.deepEqual(app.counts(), { previews: 0, selections: 0 });
  assert.equal(app.find(tree, (node) => node.type === "Checkbox").props.disabled, true);
});

test("retry never applies to registered, offline, non-MPR or already permissive results", () => {
  for (const [overrides, modes] of [
    [{ path: "C:/source.mpr", registered: true }, {}],
    [{ path: "C:/source.mpr", root_status: "offline" }, {}],
    [{ path: "C:/source.ndax" }, {}],
    [{ path: "C:/source.mpr" }, { "c:\\source.mpr": "permissive" }],
  ] as const) {
    const app = harness({ name: "source.mpr", readability_error: "Unsupported execution", ...overrides }, modes);
    assert.equal(app.find(app.render(), (node) => node.props?.["aria-label"] === "Try Permissive reading for source.mpr"), undefined);
  }
});


test("production picker mode changes preserve peer modes and genuine per-mode rejection facts", () => {
  const source = readFileSync(new URL("../src/components/ImportFilesystemPickerModal.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const changeReadMode =");
  const end = source.indexOf("  const tryPermissive =", start);
  assert.ok(start >= 0 && end > start);
  const entry = { kind: "file" as const, path: "C:/source.mpr", name: "source.mpr", size: 10, modified_at: "today" };
  const peer = { ...entry, path: "C:/peer.mpr" };
  const readModesRef = { current: { "c:\\peer.mpr": "permissive" } };
  let selected = new Map([[entry.path, entry], [peer.path, peer]]);
  const rejected = new Map();
  for (const mode of ["safe", "permissive"] as const) {
    const current = { ...entry, read_mode: mode };
    const recorded = readabilityPolicy.recordImportSourceRejection(rejected, {
      path: entry.path, version: readabilityPolicy.importSourceVersion(entry),
      error: "Structurally unsupported", kind: "invalid", read_mode: mode,
    }, current);
    for (const [key, value] of recorded) rejected.set(key, value);
  }
  const compiled = ts.transpileModule(source.slice(start, end) + "\nexports.changeReadMode = changeReadMode;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  runInNewContext(compiled, {
    exports, Map, readModesRef,
    importSourcePathKey: readabilityPolicy.importSourcePathKey,
    withMprReadMode: readModePolicy.withMprReadMode,
    setReadModes: () => {},
    setRawSelected: (update: any) => selected = update(selected),
    setSourceRejections: () => assert.fail("Mode changes must not forget genuine failures"),
  });
  for (const mode of ["permissive", "safe", "permissive"]) {
    exports.changeReadMode(entry, mode);
    assert.equal(readModePolicy.mprReadModeForPath(entry.path, readModesRef.current), mode);
    assert.equal(readModePolicy.mprReadModeForPath(peer.path, readModesRef.current), "permissive");
    assert.equal((selected.get(entry.path) as any).read_mode, mode);
    assert.ok(readabilityPolicy.importSourceRejection(selected.get(entry.path)!, rejected));
  }
});
