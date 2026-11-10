import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Node = { type: any; props: Record<string, any> };
function harness() {
  const slots: any[] = []; let cursor = 0; let closes = 0; let choices = 0;
  const jsx = (type: any, props: any): Node => ({ type, props });
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
      useMemo: (fn: () => any) => fn(),
    },
    "@mantine/core": new Proxy({}, { get: (_, key) => key }),
    "@tabler/icons-react": new Proxy({}, { get: (_, key) => key }),
    "./AnalysisSourceLimitations": { AnalysisSourceLimitations: "AnalysisSourceLimitations" },
    "./ImportedSourceIdentity": { ImportedSourceIdentity: "ImportedSourceIdentity" },
    "./Plot": { default: "Plot" },
    "./cellPreviewPlotModel": {
      cellPreviewVoltageTraces: (series: unknown) => series,
    },
    "./SearchIntroduction": { SearchIntroduction: "SearchIntroduction" },
    "../features/analyses/editor/plotting/plotStyle": { DEFAULT_PLOT_STYLE: { line_width: 2.5, tick_font_size: 12, axis_title_size: 14, legend_font_size: 12, paper_bgcolor: "#fff", plot_bgcolor: "#fff" }, PALETTE: ["teal", "blue"] },
    "../features/analyses/editor/plotting/plotLayout": { plotAxisStyle: () => ({}), hoverLabelLayout: () => ({}) },
    "./ReleaseIntroduction.module.css": { default: new Proxy({}, { get: (_, key) => key }) },
  };
  const source = ts.transpileModule(readFileSync(new URL("../src/components/ReleaseIntroduction.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(source, { exports, require: (name: string) => { assert.ok(name in modules, "No API or native dependency: " + name); return modules[name]; } });
  const render = () => { cursor = 0; return exports.ReleaseIntroduction({ onClose: () => closes++, onChooseFolders: () => choices++, reducedMotion: true }); };
  const all = (node: any): Node[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
  const find = (tree: Node, type: string, text?: string) => all(tree).find(node => node.type === type && (text === undefined || node.props.children === text))!;
  const button = (tree: Node, text: string) => find(tree, "Button", text);
  return { render, all, find, button, cards: exports.RELEASE_CARDS, counts: () => ({ closes, choices }) };
}

test("four scientific cards retain Previous, Next/Done and direct navigation", () => {
  const app = harness(); let tree = app.render();
  assert.equal(app.cards.length, 4);
  assert.deepEqual(Array.from(app.cards, (card: any) => card.id), ["history", "fec", "identity", "warnings"]);
  assert.equal(app.button(tree, "Previous").props.disabled, true);
  for (const card of app.cards) {
    assert.equal(app.find(tree, "Title").props.children, card.title);
    app.button(tree, card.id === "warnings" ? "Done" : "Next").props.onClick();
    tree = app.render();
  }
  assert.equal(app.counts().closes, 1);
  app.button(tree, "Previous").props.onClick(); tree = app.render();
  assert.equal(app.find(tree, "Title").props.children, app.cards[2].title);
  const first = app.all(tree).find(node => node.type === "UnstyledButton" && node.props["aria-label"] === app.cards[0].title)!;
  first.props.onClick(); tree = app.render();
  assert.equal(app.button(tree, "Previous").props.disabled, true);
  app.button(tree, "Skip tour").props.onClick();
  assert.equal(app.counts().closes, 2);
});

test("examples use production plot and identity/limitation components without real Cell navigation", () => {
  const app = harness(); let tree = app.render();
  const chart = app.all(tree).find(node => typeof node.type === "function" && node.type.name === "CyclingExample")!;
  const plot = app.find(chart.type(chart.props), "Plot");
  assert.equal(plot.type, "Plot");
  assert.equal(plot.props.data[0].x.length, 200);
  assert.deepEqual(Array.from(plot.props.layout.xaxis.range), [0, 200]);
  assert.equal(plot.props.layout.shapes[0].x0, 80);
  assert.equal(plot.props.layout.shapes[0].x1, 140);
  assert.ok(plot.props.data[0].y[79] > plot.props.data[0].y[0]);
  app.button(tree, "Next").props.onClick(); tree = app.render();
  app.button(tree, "Next").props.onClick(); tree = app.render();
  assert.equal(app.find(tree, "ImportedSourceIdentity").props.cells[0].id, -1);
  const paper = app.all(tree).find(node => node.type === "Paper" && node.props.onClickCapture)!; let prevented = 0;
  const event = { target: { closest: () => ({}) }, preventDefault: () => prevented++, stopPropagation() {} };
  paper.props.onClickCapture(event); paper.props.onAuxClickCapture(event);
  assert.equal(prevented, 2);
  app.button(tree, "Next").props.onClick(); tree = app.render();
  const limitations = app.find(tree, "AnalysisSourceLimitations");
  assert.equal(limitations.props.badges[0].scientific_interpretation, "exploratory");
  assert.equal(limitations.props.badges[0].cell_id, -1);
  assert.ok(app.all(tree).some(node => typeof node.type === "function" && node.type.name === "VoltageExample"));
  assert.equal(app.find(tree, "svg"), undefined, "No fabricated chart/interface SVG");
});

test("FEC example changes the actual plot axis without dismissing or writing data", () => {
  const app = harness(); let tree = app.render();
  app.button(tree, "Next").props.onClick(); tree = app.render();
  const segment = app.find(tree, "SegmentedControl");
  segment.props.onChange("fec"); tree = app.render();
  const chart = app.all(tree).find(node => typeof node.type === "function" && node.type.name === "CyclingExample")!;
  const plot = app.find(chart.type(chart.props), "Plot");
  assert.equal(plot.props.layout.xaxis.title.text, "Equivalent full cycles");
  assert.equal(plot.props.data[1].line.dash, "dash");
  assert.deepEqual(app.counts(), { closes: 0, choices: 0 });
});

test("bundled search guide stays available; return preserves the current card", () => {
  const app = harness(); let tree = app.render();
  app.button(tree, "Next").props.onClick(); tree = app.render();
  app.all(tree).find(node => node.props["aria-label"] === "File search guide")!.props.onClick(); tree = app.render();
  const guide = app.find(tree, "SearchIntroduction");
  assert.equal(guide.props.reducedMotion, true);
  guide.props.onChooseFolders();
  assert.equal(app.counts().choices, 1);
  app.button(tree, "Back to release cards").props.onClick(); tree = app.render();
  assert.equal(app.find(tree, "Title").props.children, app.cards[1].title);
});

test("initial-style composition keeps compact plots, separate category and quiet dot navigation", () => {
  const app = harness(); const tree = app.render();
  assert.ok(app.all(tree).some(node => node.type === "header" && node.props.className === "intro"));
  assert.equal(app.all(tree).filter(node => node.props.className === "footer").length, 1);
  const dots = app.all(tree).filter(node => node.type === "UnstyledButton");
  assert.equal(dots.length, 4);
  assert.ok(dots.every(node => node.props.children.type === "span" && node.props.children.props.children == null));
  assert.ok(app.cards.every((card: any) => card.category && card.description.length < 180));
  const chart = app.all(tree).find(node => typeof node.type === "function" && node.type.name === "CyclingExample")!;
  assert.ok(app.find(chart.type(chart.props), "Plot").props.layout.height <= 200);
});
