import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("analysis editor delegates route destinations to its adapters", () => {
  const editor = source("../src/features/analyses/editor/AnalysisEditor.tsx");
  const page = source("../src/pages/AnalysisPage.tsx");
  const workspace = source("../src/features/analyses/workspace/AnalysisWorkspaceContent.tsx");

  assert.doesNotMatch(editor, /useNavigate/);
  assert.doesNotMatch(editor, /navigate\s*\(/);
  assert.doesNotMatch(editor, /["'`]\/analyses(?:\/|["'`])/);
  assert.match(editor, /onOpenAnalysis\(a\.id\)/);
  assert.match(editor, /onOpenAnalysisDatabase\(\)/);
  assert.match(editor, /onClick=\{onOpenAnalysisDatabase\}/);

  assert.match(page, /navigate\(`\/analyses\/\$\{id\}`\)/);
  assert.match(page, /navigate\("\/analyses"\)/);
  assert.match(page, /onOpenAnalysis=\{onOpenAnalysis\}/);
  assert.match(page, /onOpenAnalysisDatabase=\{onOpenAnalysisDatabase\}/);

  assert.match(workspace, /navigate\(`\/analyses\/\$\{analysisId\}`\)/);
  assert.match(workspace, /onOpenAnalysis=\{onOpenAnalysis\}/);
  assert.match(workspace, /onOpenAnalysisDatabase=\{onOpenAnalysisDatabase\}/);
});
