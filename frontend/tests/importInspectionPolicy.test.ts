import assert from "node:assert/strict";
import test from "node:test";

import {
  importInspectionCandidateMatchesSearch,
  importInspectionFailurePathSet,
  mergeImportInspectionFailures,
  importSelectableInspectionPaths,
} from "../src/importInspectionPolicy.ts";

const failures = [{ path: "C:/data/Broken.xlsx", filename: "Broken.xlsx", error: "Unreadable" }];

test("failed inspection paths are case-insensitive and remain identifiable", () => {
  assert.deepEqual([...importInspectionFailurePathSet(failures)], ["c:/data/broken.xlsx"]);
  assert.deepEqual(
    importSelectableInspectionPaths(
      ["C:/data/good.xlsx", "c:/data/broken.xlsx"],
      failures,
    ),
    ["C:/data/good.xlsx"],
  );
});

test("failed rows remain searchable by filename or relative path", () => {
  assert.equal(importInspectionCandidateMatchesSearch("Broken.xlsx", "batch/Broken.xlsx", "broken"), true);
  assert.equal(importInspectionCandidateMatchesSearch("Broken.xlsx", "batch/Broken.xlsx", "batch"), true);
});

test("sequential inspection retries accumulate exclusions without duplicates", () => {
  const next = mergeImportInspectionFailures(
    failures,
    [{ path: "C:/data/SECOND.xlsx", filename: "SECOND.xlsx", error: "Changed" },
      { path: "c:/data/broken.xlsx", filename: "broken.xlsx", error: "Different message" }],
  );
  assert.deepEqual(next.map((failure) => failure.path), ["C:/data/Broken.xlsx", "C:/data/SECOND.xlsx"]);
});

test("a retry removes only failed selected rows and preserves intentional deselections", () => {
  assert.deepEqual(
    importSelectableInspectionPaths(
      ["C:/data/first.xlsx", "C:/data/second.xlsx"],
      [{ path: "C:/data/second.xlsx", filename: "second.xlsx", error: "Unreadable" }],
    ),
    ["C:/data/first.xlsx"],
  );
});
