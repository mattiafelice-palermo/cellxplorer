import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual JSX handlers, postponing functional updates until React's
// dispatch has ended. currentTarget is null outside that dispatch even when
// SyntheticEvent pooling is disabled.
const filename = new URL("../src/features/analyses/editor/AnalysisEditor.tsx", import.meta.url);
const source = ts.createSourceFile("AnalysisEditor.tsx", readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const setters = new Set(["setSaveDraft", "setQuantityRenamePrompt", "setLeavePrompt"]);
const handlers: Array<{ setter: string; field: string; code: string }> = [];
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onChange"
      && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    const handler = node.initializer.expression;
    let setter = "";
    let field = "";
    function inspect(child: ts.Node) {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)
          && setters.has(child.expression.text)) setter = child.expression.text;
      if ((ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child))
          && ["name", "description"].includes(child.name.getText(source))) {
        field = child.name.getText(source);
      }
      ts.forEachChild(child, inspect);
    }
    inspect(handler);
    if (setter) handlers.push({ setter, field, code: handler.getText(source) });
  }
  ts.forEachChild(node, visit);
}
visit(source);

test("covers the production title/description inputs in all three save dialogs", () => {
  assert.deepEqual(handlers.map(({ setter, field }) => `${setter}.${field}`).sort(), [
    "setLeavePrompt.description", "setLeavePrompt.name", "setQuantityRenamePrompt.name",
    "setSaveDraft.description", "setSaveDraft.name",
  ]);
});

for (const { setter, field, code } of handlers) {
  test(`${setter}.${field}: replacement typing survives dispatch cleanup and preserves current state`, () => {
    const pending: Array<(state: any) => any> = [];
    const handler = runInNewContext(ts.transpileModule(`(${code})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText, { [setter]: (update: (state: any) => any) => pending.push(update) });
    let state: any = { name: "Test", description: "Original description", retained: true };
    for (const value of ["R", "Replacement plot", "", "Final title"]) {
      const input = { value };
      const event = { currentTarget: input };
      handler(event);
      event.currentTarget = null as any;
      input.value = "changed after dispatch";
      // A separate update can have changed modal state while this one waits.
      state = { ...state, concurrent: value };
      state = pending.shift()!(state);
      assert.equal(state[field], value);
      assert.equal(state.retained, true);
      assert.equal(state.concurrent, value);
      assert.equal(state[field === "name" ? "description" : "name"],
        field === "name" ? "Original description" : "Test");
    }
    handler({ currentTarget: { value: "late input after close" } });
    assert.equal(pending.shift()!(null), null, "a pending edit must not reopen a closed dialog");
  });
}
