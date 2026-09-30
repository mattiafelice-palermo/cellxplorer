import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as searchPolicy from "../src/importSearch.ts";
import * as filtersPolicy from "../src/importSearchFilters.ts";

/** Exercise actual result handlers; stubs represent controls, not interaction policy. */
function harness() {
  const slots: any[] = [];
  let cursor = 0;
  let previews = 0;
  let selections = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const file = { kind: "file", canonical: "c:\\source.ndax", path: "C:\\source.ndax", name: "source.ndax", relative_path: "source.ndax", root_path: "C:\\", root_id: "root", root_status: "ready", recognition: "recognized", metadata_state: "ready", metadata: {}, registered: false, extension: ".ndax", supplier: "Neware" };
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
    "@tanstack/react-query": { useQuery: ({ queryKey }: any) => queryKey[0] === "file-search-settings" ? { data: { config: { roots: [{ id: "root", path: "C:\\", enabled: true }], formats: [".ndax"], metadata_enabled: true }, roots: [{ id: "root", status: "ready" }] } } : { data: { items: [{ ...file }], total: 1 }, refetch: () => {} } },
    "../api": {}, "react-router-dom": { Link: "Link" },
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
    return exports.IndexedSourceSearch({ active: true, selected: new Map(), onPreview: () => previews++, onSelection: () => selections++, onDialogChange: () => {}, onReveal: () => {}, onFilterCount: () => {}, onOpenFilters: () => {}, onOpenEntity: () => {}, filterContainer: null });
  };
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && predicate(node)) return node;
    for (const child of Array.isArray(node) ? node : [node.props?.children]) { const result = find(child, predicate); if (result) return result; }
  };
  return { render, find, counts: () => ({ previews, selections }) };
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
