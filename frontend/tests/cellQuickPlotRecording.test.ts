import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as previewModel from "../src/components/cellPreviewPlotModel.ts";

/** Exercise the production Overview component and its real voltage trace builder. */
function harness(cycles: any, recording: any = { data: { quantity: "voltage", x_label: "Time (s)", segments: [] } }) {
  const calls: any[] = [];
  const requests: string[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const core = new Proxy({
    useComputedColorScheme: () => "dark",
    useMantineTheme: () => ({ colors: { dark: Array(10).fill("#222"), gray: Array(10).fill("#ddd") }, white: "#fff", black: "#000" }),
  }, { get: (target: any, name) => target[name] ?? name });
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (value: any) => [value, () => {}] },
    "@mantine/core": core,
    "@tanstack/react-query": { useQuery: (options: any) => { calls.push(options); return options.queryKey[0] === "cell-cycles" && options.queryKey.length === 2 ? cycles : recording; } },
    "../api": { get: (path: string) => { requests.push(path); return Promise.resolve({}); } },
    "./Plot": { default: "Plot" },
    "./CellPreviewPlot": { CellPreviewPlot: "CellPreviewPlot" },
    "./cellPreviewPlotModel": previewModel,
  };
  const compiled = ts.transpileModule(readFileSync(new URL("../src/components/CellQuickPlot.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
  let tree = exports.CellQuickPlot({ cellId: 42, cellName: "Rest recording" });
  // React mounts the dedicated raw-recording child only for an empty successful cycle table.
  if (typeof tree?.type === "function") tree = tree.type(tree.props);
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && predicate(node)) return node;
    for (const child of Array.isArray(node) ? node : [node.props?.children]) { const found = find(child, predicate); if (found) return found; }
  };
  return { tree, calls, requests, find };
}

const emptyCycles = { data: { rows: [], segments: [], missing: [] } };

test("Overview plots zero-cycle voltage records and preserves native clocks and breaks", async () => {
  const app = harness(emptyCycles, { data: { quantity: "voltage", x_label: "Time (s)", segments: [{ filename: "sample.mpr", x: [20, 30, 10, 20], y: [3, 3.1, 3.2, 3.3], current_ma: [null, null, null, null], display_break_before: [2] }] } });
  assert.equal(app.calls.length, 2);
  assert.deepEqual(Array.from(app.calls[1].queryKey), ["cell-cycles", 42, "recorded-voltage"], "source-update invalidation must reach cycle tables and recorded-voltage previews together");
  await app.calls[1].queryFn();
  assert.deepEqual(app.requests, ["/api/cells/42/voltage-preview"]);
  const plot = app.find(app.tree, (node) => node.type === "CellPreviewPlot");
  assert.ok(plot);
  assert.deepEqual(Array.from(plot.props.data[0].x), [20, 30, null, 10, 20]);
  assert.deepEqual(Array.from(plot.props.data[0].y), [3, 3.1, null, 3.2, 3.3]);
  assert.equal(plot.props.data.length, 1, "unknown current must not become a fabricated zero-current trace");
  assert.equal(plot.props.layout.xaxis.title.text, "Time (s)");
  assert.equal(plot.props.surfaceMode, "theme");
});

test("existing complete-cycle Overview stays on its ordinary capacity/CE plot", () => {
  const app = harness({ data: { rows: [{ cycle: 1, discharge_capacity_mah: 3 }], segments: [], missing: [] } });
  assert.equal(app.calls.length, 1);
  assert.ok(app.find(app.tree, (node) => node.type === "Plot"));
  assert.equal(app.find(app.tree, (node) => node.type === "CellPreviewPlot"), undefined);
});

test("missing records, loading and failed source reads have truthful separate feedback", () => {
  const absent = harness(emptyCycles);
  assert.equal(absent.tree.type, "Alert");
  assert.match(absent.tree.props.children, /No complete cycles or available voltage records/);
  const pending = harness(emptyCycles, { isLoading: true });
  assert.ok(pending.find(pending.tree, (node) => node.type === "Loader"));
  const failed = harness(emptyCycles, { isError: true, error: new Error("Source offline") });
  assert.equal(failed.tree.type, "Alert");
  assert.equal(failed.tree.props.color, "red");
  const metadata = harness({ data: { rows: [], capability: { metadata_only: true, message: "Unsupported layout" } } });
  assert.equal(metadata.calls.length, 1);
  assert.equal(metadata.tree.props.children, "Unsupported layout");
});
