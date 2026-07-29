import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestorsOfPresentFolders,
  folderContentCount,
  folderMatchesSearch,
  placementCanApply,
  placementCheckboxState,
  placementFooterSummary,
  placementItemStatus,
  replicatePlacementFolderIds,
} from "../src/folderPlacement.ts";

test("checkbox: empty selection is none", () => {
  assert.equal(placementCheckboxState(0, 0, false), "none");
});

test("checkbox: nothing present and unstaged is empty", () => {
  assert.equal(placementCheckboxState(0, 3, false), "none");
});

test("checkbox: partial present and unstaged is mixed", () => {
  assert.equal(placementCheckboxState(1, 3, false), "some");
  assert.equal(placementCheckboxState(2, 3, false), "some");
});

test("checkbox: all present is muted complete regardless of staged", () => {
  assert.equal(placementCheckboxState(3, 3, false), "complete");
  assert.equal(placementCheckboxState(3, 3, true), "complete");
});

test("checkbox: staged projects to full even when partially present", () => {
  // Mockup inconsistency: mixed present + staged must render solid teal, not mixed.
  assert.equal(placementCheckboxState(1, 3, true), "all");
  assert.equal(placementCheckboxState(0, 3, true), "all");
});

test("item status covers already / will add / not here", () => {
  assert.equal(placementItemStatus(true, false), "already");
  assert.equal(placementItemStatus(true, true), "already");
  assert.equal(placementItemStatus(false, true), "will_add");
  assert.equal(placementItemStatus(false, false), "not_here");
});

test("footer summary pluralises independently", () => {
  assert.equal(
    placementFooterSummary({ selectionEmpty: true, itemsAdded: 0, foldersReceiving: 0 }),
    "Nothing selected",
  );
  assert.equal(
    placementFooterSummary({ selectionEmpty: false, itemsAdded: 0, foldersReceiving: 0 }),
    "No folders selected",
  );
  assert.equal(
    placementFooterSummary({ selectionEmpty: false, itemsAdded: 1, foldersReceiving: 1 }),
    "Adding 1 item to 1 folder",
  );
  assert.equal(
    placementFooterSummary({ selectionEmpty: false, itemsAdded: 3, foldersReceiving: 2 }),
    "Adding 3 items to 2 folders",
  );
  assert.equal(
    placementFooterSummary({ selectionEmpty: false, itemsAdded: 1, foldersReceiving: 2 }),
    "Adding 1 item to 2 folders",
  );
});

test("Place is enabled only when something will actually be added", () => {
  assert.equal(placementCanApply(0, 0), false);
  assert.equal(placementCanApply(2, 0), false);
  assert.equal(placementCanApply(0, 2), false);
  assert.equal(placementCanApply(3, 2), true);
});

test("replicate placement carries existing and newly staged destinations once", () => {
  assert.deepEqual(
    replicatePlacementFolderIds(new Set([2, 3]), new Set([3, 4])),
    [2, 3, 4],
  );
});

test("folder content count is direct, not recursive", () => {
  assert.equal(
    folderContentCount({
      cells: [{}, {}],
      replicate_groups: [{}],
      analyses: [{}, {}, {}],
    }),
    6,
  );
});

test("ancestors of present folders are collected for initial expand", () => {
  const roots = [
    {
      id: 1,
      parent_id: null,
      children: [
        {
          id: 2,
          parent_id: 1,
          children: [{ id: 3, parent_id: 2, children: [] }],
        },
      ],
    },
    { id: 10, parent_id: null, children: [] },
  ];
  const ancestors = ancestorsOfPresentFolders(roots, new Set([3]));
  assert.deepEqual([...ancestors].sort((a, b) => a - b), [1, 2]);
});

test("search matches folder names case-insensitively", () => {
  assert.equal(folderMatchesSearch("LFP - Pouch", "pouch"), true);
  assert.equal(folderMatchesSearch("LFP - Pouch", "NMC"), false);
  assert.equal(folderMatchesSearch("Archive", ""), true);
});
