import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupStagedReplicateGroups,
  continuedImportIsBlocked,
  exactDuplicateCount,
  includedSeparateCellDrafts,
  latePreviewBelongsToStagedDraft,
  removeAllRegisteredDuplicates,
  removeStagedDraft,
  separateImportRequestEntries,
} from "../src/importDraftPolicy.ts";

function draft(staged_name: string, kind: "duplicate" | "update" | "ready" = "ready") {
  return {
    staged_name,
    source_path: `C:/data/${staged_name}`,
    filename: staged_name,
    import_match:
      kind === "duplicate"
        ? { kind: "exact_duplicate" as const, registered: true }
        : kind === "update"
          ? { kind: "possible_update" as const, registered: true }
          : null,
  };
}

const groups = [
  { id: "g", name: "Replicates", description: "", staged_names: ["a", "b", "c"] },
  { id: "h", name: "One", description: "", staged_names: ["b", "d"] },
];

test("registered exact duplicates are excluded but possible updates remain", () => {
  const drafts = [draft("a", "duplicate"), draft("b", "update"), draft("c")];
  assert.equal(exactDuplicateCount(drafts), 1);
  assert.deepEqual(includedSeparateCellDrafts(drafts).map((item) => item.staged_name), ["b", "c"]);
  assert.deepEqual(separateImportRequestEntries(drafts), [
    { staged_name: "b", source_path: "C:/data/b", filename: "b" },
    { staged_name: "c", source_path: "C:/data/c", filename: "c" },
  ]);
});

test("remove active first, middle, last, and only rows chooses nearest row", () => {
  assert.equal(removeStagedDraft([draft("a"), draft("b"), draft("c")], [], 0, "a").activeIndex, 0);
  assert.equal(removeStagedDraft([draft("a"), draft("b"), draft("c")], [], 1, "b").activeIndex, 1);
  assert.equal(removeStagedDraft([draft("a"), draft("b"), draft("c")], [], 2, "c").activeIndex, 1);
  assert.equal(removeStagedDraft([draft("a")], [], 0, "a").activeIndex, null);
});

test("removal preserves other drafts and cleans one-member groups", () => {
  const result = removeStagedDraft([draft("a"), draft("b"), draft("c")], groups, 1, "a");
  assert.deepEqual(result.drafts.map((item) => item.staged_name), ["b", "c"]);
  assert.deepEqual(result.groups.map((group) => group.staged_names), [["b", "c"]]);
});

test("remove all only removes registered duplicates", () => {
  const result = removeAllRegisteredDuplicates(
    [draft("a", "duplicate"), draft("b", "update"), draft("c", "duplicate"), draft("d")],
    groups,
    2,
  );
  assert.deepEqual(result.drafts.map((item) => item.staged_name), ["b", "d"]);
  assert.deepEqual(result.groups.map((group) => group.staged_names), [["b", "d"]]);
  assert.equal(removeAllRegisteredDuplicates([draft("a")], [], 0).drafts.length, 1);
});

test("continued mode blocks duplicate identity and late preview cannot restore removed row", () => {
  const drafts = [draft("a", "duplicate"), draft("b")];
  assert.equal(continuedImportIsBlocked(drafts), true);
  assert.equal(latePreviewBelongsToStagedDraft(drafts, "a"), true);
  assert.equal(latePreviewBelongsToStagedDraft([draft("b")], "a"), false);
  assert.deepEqual(cleanupStagedReplicateGroups(groups, new Set(["a"])), []);
});
