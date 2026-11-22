import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Node = { type: any; props: Record<string, any> };
function harness() {
  const slots: any[] = [];
  let cursor = 0;
  let closes = 0;
  let choices = 0;
  const jsx = (type: any, props: any): Node => ({ type, props });
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState: (initial: any) => {
        const i = cursor++;
        if (!(i in slots)) slots[i] = initial;
        return [slots[i], (next: any) => {
          slots[i] = typeof next === "function" ? next(slots[i]) : next;
        }];
      },
      useMemo: (fn: () => any) => fn(),
    },
    "@mantine/core": new Proxy({}, { get: (_, key) => key }),
    "@tabler/icons-react": new Proxy({}, { get: (_, key) => key }),
    "./Plot": { default: "Plot" },
    "./cellPreviewPlotModel": {
      cellPreviewVoltageTraces: (series: unknown) => series,
    },
    "./SearchIntroduction": { SearchIntroduction: "SearchIntroduction" },
    "../features/analyses/editor/plotting/plotStyle": {
      DEFAULT_PLOT_STYLE: {
        line_width: 2.5,
        tick_font_size: 12,
        axis_title_size: 14,
        legend_font_size: 12,
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
      },
      PALETTE: ["#12b886", "#2E86AB"],
    },
    "../features/analyses/editor/plotting/plotLayout": {
      plotAxisStyle: () => ({}),
      hoverLabelLayout: () => ({}),
    },
    "./ReleaseIntroduction.module.css": {
      default: new Proxy({}, { get: (_, key) => key }),
    },
  };
  const source = ts.transpileModule(
    readFileSync(new URL("../src/components/ReleaseIntroduction.tsx", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports: any = {};
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, "No API or native dependency: " + name);
      return modules[name];
    },
  });
  const render = () => {
    cursor = 0;
    return exports.ReleaseIntroduction({
      onClose: () => closes++,
      onChooseFolders: () => choices++,
      reducedMotion: true,
    });
  };
  const all = (node: any): Node[] =>
    !node || typeof node !== "object"
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : [node, ...all(node.props?.children)];
  const textContent = (node: any): string =>
    typeof node === "string" || typeof node === "number"
      ? String(node)
      : Array.isArray(node)
        ? node.map(textContent).join("")
        : node && typeof node === "object"
          ? textContent(node.props?.children)
          : "";
  const find = (tree: Node, type: string, text?: string) =>
    all(tree).find((node) => node.type === type && (text === undefined || node.props.children === text))!;
  const button = (tree: Node, text: string) => find(tree, "Button", text);
  return { render, all, find, button, textContent, cards: exports.RELEASE_CARDS, counts: () => ({ closes, choices }) };
}

test("five release cards retain Previous, Next/Done and direct navigation", () => {
  const app = harness();
  let tree = app.render();
  assert.equal(app.cards.length, 5);
  assert.deepEqual(
    Array.from(app.cards, (card: any) => card.id),
    ["maccor", "analysis", "imports", "biologic", "platform"],
  );
  assert.equal(app.button(tree, "Previous").props.disabled, true);
  for (const card of app.cards) {
    assert.equal(app.find(tree, "Title").props.children, card.title);
    app.button(tree, card.id === "platform" ? "Done" : "Next").props.onClick();
    tree = app.render();
  }
  assert.equal(app.counts().closes, 1);
  app.button(tree, "Previous").props.onClick();
  tree = app.render();
  assert.equal(app.find(tree, "Title").props.children, app.cards[3].title);
  const first = app.all(tree).find((node) => node.type === "UnstyledButton" && node.props["aria-label"] === app.cards[0].title)!;
  first.props.onClick();
  tree = app.render();
  assert.equal(app.button(tree, "Previous").props.disabled, true);
  app.button(tree, "Skip tour").props.onClick();
  assert.equal(app.counts().closes, 2);
});

test("maccor, analysis and biologic examples use production Plot without fabricated SVG or navigation", () => {
  const app = harness();
  let tree = app.render();

  // Card 1: Maccor
  const maccorChart = app.all(tree).find((node) => typeof node.type === "function" && node.type.name === "MaccorExample")!;
  const maccorPlot = app.find(maccorChart.type(maccorChart.props), "Plot");
  assert.equal(maccorPlot.props.data[1].y[0], 5);
  assert.ok(maccorPlot.props.layout.height <= 200);
  const maccorSegment = app.all(tree).find((node) => node.type === "SegmentedControl" && node.props["aria-label"] === "Maccor format")!;
  maccorSegment.props.onChange("text");
  tree = app.render();
  const maccorTextChart = app.all(tree).find((node) => typeof node.type === "function" && node.type.name === "MaccorExample")!;
  assert.equal(app.find(maccorTextChart.type(maccorTextChart.props), "Plot").props.data[1].y[0], 4.2);

  // Synthetic navigation guard
  const paper = app.all(tree).find((node) => node.type === "Paper" && node.props.onClickCapture)!;
  let prevented = 0;
  const event = { target: { closest: () => ({}) }, preventDefault: () => prevented++, stopPropagation() {} };
  paper.props.onClickCapture(event);
  paper.props.onAuxClickCapture(event);
  assert.equal(prevented, 2);

  // Card 2: Analysis (pairing, Days axis, earlier-cycle jump)
  app.button(tree, "Next").props.onClick();
  tree = app.render();
  const unitSegment = app.all(tree).find((node) => node.type === "SegmentedControl" && node.props["aria-label"] === "Time axis unit")!;
  unitSegment.props.onChange("days");
  tree = app.render();
  app.button(tree, "Show cycles 1–12").props.onClick();
  tree = app.render();
  const analysisChart = app.all(tree).find((node) => typeof node.type === "function" && node.type.name === "CyclingExample")!;
  const analysisPlot = app.find(analysisChart.type(analysisChart.props), "Plot");
  assert.equal(analysisPlot.props.layout.xaxis.title.text, "Time (days)");
  assert.equal(analysisPlot.props.data.length, 2);
  assert.ok(analysisPlot.props.layout.height <= 200);

  // Card 3: Imports (per-phase progress + Cancel)
  app.button(tree, "Next").props.onClick();
  tree = app.render();
  const phasesComp = app.all(tree).find((node) => typeof node.type === "function" && node.type.name === "ImportPhasesExample")!;
  const phaseBars = app.all(phasesComp.type(phasesComp.props)).filter((node) => node.type === "Progress");
  assert.equal(phaseBars.length, 3);
  app.button(tree, "Cancel").props.onClick();
  tree = app.render();
  assert.equal(app.counts().closes, 0);

  // Card 4: BioLogic (recorded mass + gap-preserving VoltageExample)
  app.button(tree, "Next").props.onClick();
  tree = app.render();
  const bioChart = app.all(tree).find((node) => typeof node.type === "function" && node.type.name === "VoltageExample")!;
  const bioPlot = app.find(bioChart.type(bioChart.props), "Plot");
  const breaks = Array.from(bioPlot.props.data[0].breakBefore as number[]);
  assert.equal(breaks.length, 1);
  assert.ok(breaks[0] > 10 && breaks[0] < bioPlot.props.data[0].x.length);
  assert.ok(bioPlot.props.layout.height <= 200);
  const massSegment = app.all(tree).find((node) => node.type === "SegmentedControl" && node.props["aria-label"] === "EC-Lab specimen mass")!;
  massSegment.props.onChange("total");
  tree = app.render();
  assert.match(app.textContent(tree), /122\.8 mAh\/g/);

  // Card 5: Platform (default-ON auto-update switch + installer size bars)
  app.button(tree, "Next").props.onClick();
  tree = app.render();
  const autoSwitch = app.find(tree, "Switch");
  assert.equal(autoSwitch.props.checked, true);
  assert.equal(app.all(tree).filter((node) => node.type === "Progress").length, 2);
  assert.equal(app.find(tree, "svg"), undefined, "No fabricated chart/interface SVG");
  assert.deepEqual(app.counts(), { closes: 0, choices: 0 });
});

test("bundled search guide stays available; return preserves the current card", () => {
  const app = harness();
  let tree = app.render();
  app.button(tree, "Next").props.onClick();
  tree = app.render();
  app.all(tree).find((node) => node.props["aria-label"] === "File search guide")!.props.onClick();
  tree = app.render();
  const guide = app.find(tree, "SearchIntroduction");
  assert.equal(guide.props.reducedMotion, true);
  guide.props.onChooseFolders();
  assert.equal(app.counts().choices, 1);
  app.button(tree, "Back to release cards").props.onClick();
  tree = app.render();
  assert.equal(app.find(tree, "Title").props.children, app.cards[1].title);
});

test("composition keeps compact cards, separate category, quiet dot navigation and non-sensitive copy", () => {
  const app = harness();
  const tree = app.render();
  assert.ok(app.all(tree).some((node) => node.type === "header" && node.props.className === "intro"));
  assert.equal(app.all(tree).filter((node) => node.props.className === "footer").length, 1);
  const dots = app.all(tree).filter((node) => node.type === "UnstyledButton");
  assert.equal(dots.length, 5);
  assert.ok(dots.every((node) => node.props.children.type === "span" && node.props.children.props.children == null));
  assert.ok(app.cards.every((card: any) => card.category && card.description.length < 180));
  const rawSource = readFileSync(new URL("../src/components/ReleaseIntroduction.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(rawSource, /faraday|cice|organizacion/i);
});
