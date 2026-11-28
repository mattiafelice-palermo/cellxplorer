import assert from "node:assert/strict";
import test from "node:test";
import type { ImportBrowseEntry, ImportFolderFile } from "../src/api.ts";
import { materializeFolderSelection, reviewFolderTree, reviewFolderMembers } from "../src/importFolderTree.ts";
import { folderSelectionState } from "../src/importBrowserSelection.ts";
import { importSourcePathKey } from "../src/importSourceReadability.ts";

test("reviewing whole folders keeps nested files editable and removes implicit roots", () => {
  const root = (name: string): ImportBrowseEntry => ({ path: "O:/WP7/" + name, name, kind: "folder", size: null, modified_at: null });
  const a = root("Cell 40"), b = root("Cell 41");
  const file = (folder: ImportBrowseEntry, relative: string): ImportFolderFile => ({
    filename: relative.split("/").pop()!, size: 10, relative_path: relative,
    path: folder.path + "/" + relative, selection_root: { kind: "folder", path: folder.path, label: folder.name },
  });
  const files = [file(a, "01.mpr"), file(b, "01.mpr"), file(b, "restart/01.mpr"), file(b, "restart/02.mpr")];
  const origins = new Map(files.map(f => [importSourcePathKey(f.path!), f]));
  const selected = materializeFolderSelection(new Map([[a.path, a], [b.path, b]]), [a.path, b.path], files);
  assert.equal(selected.size, 4);
  assert.ok([...selected.values()].every(e => e.kind === "file"));
  const members = reviewFolderMembers(files).get(importSourcePathKey(b.path))!.map(f => f.path);
  assert.equal(folderSelectionState(b, selected, members), "all");
  selected.delete(files[2].path!);
  assert.equal(folderSelectionState(b, selected, members), "some");
  const roots = reviewFolderTree([...selected.values()], origins, "");
  assert.deepEqual(roots.map(n => n.name), ["Cell 40", "Cell 41"]);
  assert.deepEqual(roots[1].files.map(f => f.filename), ["01.mpr"]);
  assert.deepEqual(roots[1].children[0].files.map(f => f.filename), ["02.mpr"]);
  assert.equal(reviewFolderTree([...selected.values()], origins, "restart")[0].children[0].name, "restart");
  assert.equal(reviewFolderMembers(files).get(importSourcePathKey(b.path + "/restart"))!.length, 2);
});
