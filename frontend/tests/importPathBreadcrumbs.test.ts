import assert from "node:assert/strict";
import test from "node:test";

import {
  importPathEditAction,
  importPathsEqual,
  parseImportPathBreadcrumbs,
  shouldEnterImportPathEdit,
} from "../src/importPathBreadcrumbs.ts";

test("drive root is one breadcrumb targeting the drive root", () => {
  assert.deepEqual(parseImportPathBreadcrumbs("C:\\"), [{ label: "C:", targetPath: "C:\\" }]);
});

test("nested drive paths have cumulative targets and no trailing empty segment", () => {
  assert.deepEqual(parseImportPathBreadcrumbs("C:/Users//Mattia/"), [
    { label: "C:", targetPath: "C:\\" },
    { label: "Users", targetPath: "C:\\Users" },
    { label: "Mattia", targetPath: "C:\\Users\\Mattia" },
  ]);
});

test("UNC paths keep the server/share root together", () => {
  assert.deepEqual(parseImportPathBreadcrumbs("\\\\server/share/folder"), [
    { label: "\\\\server\\share", targetPath: "\\\\server\\share" },
    { label: "folder", targetPath: "\\\\server\\share\\folder" },
  ]);
});

test("relative paths use a safe single breadcrumb", () => {
  assert.deepEqual(parseImportPathBreadcrumbs("experiments/cycling"), [
    { label: "experiments\\cycling", targetPath: "experiments\\cycling" },
  ]);
});

test("path equality ignores separator direction and trailing separators", () => {
  assert.equal(importPathsEqual("C:/Data/", "c:\\data"), true);
  assert.equal(importPathsEqual("C:/Data/a", "C:/Data/b"), false);
});

test("edit mode handles Enter, Escape, and blank input", () => {
  assert.equal(importPathEditAction("Enter", "C:\\data"), "navigate");
  assert.equal(importPathEditAction("Enter", "  "), null);
  assert.equal(importPathEditAction("Escape", "typed path"), "cancel");
  assert.equal(importPathEditAction("Tab", "typed path"), null);
});

test("Ctrl+L enters path editing except from another text input", () => {
  assert.equal(shouldEnterImportPathEdit("l", true, false), true);
  assert.equal(shouldEnterImportPathEdit("L", true, true), false);
  assert.equal(shouldEnterImportPathEdit("l", false, false), false);
});
