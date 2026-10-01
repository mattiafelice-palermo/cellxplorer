import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx = (type: any, props: any) => ({ type, props });
function compile(file: string, modules: Record<string, any>, globals: Record<string, any> = {}) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, ...globals });
  return exports;
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node) && predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) { const result = find(child, predicate); if (result) return result; }
}
const core = { Popover: Object.assign("Popover", { Target: "Target", Dropdown: "Dropdown" }), ScrollArea: { Autosize: "Autosize" }, Button: "Button", TextInput: "TextInput", Select: "Select", Stack: "Stack", Group: "Group", Text: "Text", Alert: "Alert", Modal: "Modal", Tooltip: "Tooltip" };

test("saved-search popup reports Escape ownership and closes innermost choices first", () => {
  const slots: any[] = []; let cursor = 0; let escape: any; let popup = false;
  const effects: (() => void)[] = [];
  const component = compile("../src/components/SavedSearchMenu.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "@mantine/core": core,
    "@tabler/icons-react": { IconChevronDown: "Chevron", IconDeviceFloppy: "Save" },
    "react": { useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: any) => slots[i] = typeof next === "function" ? next(slots[i]) : next]; }, useEffect: (effect: () => void) => effects.push(effect) },
    "@tanstack/react-query": { useQueryClient: () => ({}), useQuery: () => ({ data: [], isSuccess: true }), useMutation: () => ({}) },
    "../api": {}, "../importSearchFilters": { activeSearchFilters: (value: any) => value },
  }, { window: { addEventListener: (_: string, callback: any) => escape = callback, removeEventListener: () => {} } });
  const render = () => { cursor = 0; effects.length = 0; escape = undefined; const tree = component.SavedSearchMenu({ active: true, queryText: "", filters: {}, onLoad: () => {}, onPopupChange: (value: boolean) => popup = value }); effects.forEach((effect) => effect()); return tree; };
  let tree = render();
  find(tree, (node) => node.props?.["aria-label"] === "Save search menu").props.onClick();
  tree = render(); assert.equal(popup, true); assert.equal(tree.props.trapFocus, true);
  find(tree, (node) => node.type === "Select").props.onDropdownOpen();
  tree = render(); let stopped = 0;
  const event = { key: "Escape", preventDefault: () => {}, stopImmediatePropagation: () => stopped++ };
  escape(event); tree = render();
  assert.equal(find(tree, (node) => node.type === "Select").props.dropdownOpened, false);
  assert.equal(tree.props.opened, true); assert.equal(popup, true);
  escape(event); tree = render();
  assert.equal(tree.props.opened, false); assert.equal(popup, false); assert.equal(stopped, 2);
});

test("import shell disables Escape while a nested popup owns it", () => {
  const component = compile("../src/components/ImportModalShell.tsx", { "react/jsx-runtime": { jsx, jsxs: jsx }, "@mantine/core": core, "@tabler/icons-react": { IconInfoCircle: "Info" }, "./ImportModalShell.module.css": { default: {} } });
  const props = { opened: true, onClose: () => {}, title: "Load cells", children: null };
  assert.equal(component.ImportModalShell(props).props.closeOnEscape, true);
  assert.equal(component.ImportModalShell({ ...props, escapeDisabled: true }).props.closeOnEscape, false);
  assert.equal(component.ImportModalShell({ ...props, closeDisabled: true }).props.closeOnEscape, false);
});
