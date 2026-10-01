import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

/** Exercise the production presentation without loading a catalog or media. */
function harness(reducedMotion = false) {
  const slots: any[] = []; let cursor = 0; let closes = 0; let choices = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": { useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: any) => slots[i] = typeof next === "function" ? next(slots[i]) : next]; } },
    "@mantine/core": { Accordion: Object.assign("Accordion", { Item: "AccordionItem", Control: "AccordionControl", Panel: "AccordionPanel" }), List: Object.assign("List", { Item: "ListItem" }), Alert: "Alert", Button: "Button", Group: "Group", Highlight: "Highlight", Paper: "Paper", Stack: "Stack", Text: "Text", Title: "Title" },
    "@tabler/icons-react": new Proxy({}, { get: (_, key) => key }),
    "./SearchIntroduction.module.css": { default: new Proxy({}, { get: (_, key) => key }) },
  };
  const source = ts.transpileModule(readFileSync(new URL("../src/components/SearchIntroduction.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(source, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
  const render = () => { cursor = 0; return exports.SearchIntroduction({ onClose: () => closes++, onChooseFolders: () => choices++, reducedMotion }); };
  const all = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
  const find = (tree: any, type: string, text?: string) => all(tree).find((node) => node.type === type && (text === undefined || node.props.children === text));
  return { render, all, find, counts: () => ({ closes, choices }) };
}

test("minimal introduction explains a filename match and has no unsolicited media or fake input", () => {
  const app = harness(), tree = app.render();
  assert.equal(app.find(tree, "Title").props.children, "Find files. Skip the folder hunt.");
  const filename = app.find(tree, "Highlight");
  assert.equal(filename.props.children, "LPMoL_512_Alava_cycling.ndax");
  assert.equal(filename.props.highlight, "Alava");
  assert.ok(app.find(tree, "AccordionControl", "Full guide"));
  assert.equal(app.find(tree, "video"), undefined);
  assert.equal(app.find(tree, "input"), undefined);
  assert.equal(app.find(tree, "Button", "See how it works").props["aria-expanded"], false);
});

test("explicit walkthrough has bundled captions, failure recovery and independent footer actions", () => {
  const app = harness(); let tree = app.render();
  app.find(tree, "Button", "See how it works").props.onClick(); tree = app.render();
  const video = app.find(tree, "video");
  assert.equal(video.props.src, "/whats-new/indexed-search.mp4");
  assert.equal(video.props.autoPlay, true);
  assert.equal(video.props.controls, true);
  assert.equal(app.find(tree, "track").props.src, "/whats-new/indexed-search.vtt");
  video.props.onError(); tree = app.render(); assert.ok(app.find(tree, "Alert"));
  assert.ok(app.find(tree, "AccordionControl", "Full guide"));
  app.find(tree, "Button", "Back to example").props.onClick(); tree = app.render();
  assert.equal(app.find(tree, "video"), undefined); assert.equal(app.find(tree, "Alert"), undefined);
  app.find(tree, "Button", "Later").props.onClick();
  app.find(tree, "Button", "Choose search folders").props.onClick();
  assert.deepEqual(app.counts(), { closes: 1, choices: 1 });
});

test("reduced motion keeps requested video paused until native playback is requested", () => {
  const app = harness(true); let tree = app.render();
  app.find(tree, "Button", "See how it works").props.onClick(); tree = app.render();
  assert.equal(app.find(tree, "video").props.autoPlay, false);
});
