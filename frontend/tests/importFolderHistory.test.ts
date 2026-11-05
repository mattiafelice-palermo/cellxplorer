import assert from "node:assert/strict";
import test from "node:test";
import { previousImportFolder, recordImportFolderVisit } from "../src/importFolderHistory.ts";

test("Back reverses a breadcrumb jump instead of walking to the parent", () => {
  let history: readonly string[] = [];
  for (const path of ["C:\\data", "C:\\data\\outer", "C:\\data\\outer\\inner", "C:\\"]) {
    history = recordImportFolderVisit(history, path);
  }
  assert.equal(previousImportFolder(history), "C:\\data\\outer\\inner");
  history = recordImportFolderVisit(history, previousImportFolder(history)!, previousImportFolder(history));
  assert.deepEqual(history, ["C:\\data", "C:\\data\\outer", "C:\\data\\outer\\inner"]);
  assert.equal(previousImportFolder(history), "C:\\data\\outer");
});

test("refresh and equivalent path spellings preserve history without loops", () => {
  const history = ["C:\\data", "C:\\data\\inner"];
  assert.equal(recordImportFolderVisit(history, "c:/DATA/inner/"), history);
  assert.equal(previousImportFolder([]), null);
  assert.equal(previousImportFolder(["C:\\data"]), null);
  const failedBack = recordImportFolderVisit(history, "C:\\data\\inner", "C:\\data");
  assert.equal(failedBack, history);
});

test("navigation is bounded, immutable and allows a new branch after Back", () => {
  const history = Array.from({length: 100}, (_, i) => `C:\\data\\${i}`);
  const next = recordImportFolderVisit(history, "D:\\other");
  assert.equal(next.length, 100);
  assert.equal(history[0], "C:\\data\\0");
  const back = recordImportFolderVisit(next, previousImportFolder(next)!, previousImportFolder(next));
  const branch = recordImportFolderVisit(back, "E:\\new");
  assert.equal(branch.at(-1), "E:\\new");
  assert.equal(branch.includes("D:\\other"), false);
});
