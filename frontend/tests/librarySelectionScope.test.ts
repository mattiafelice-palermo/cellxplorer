import assert from "node:assert/strict";
import test from "node:test";

import {
  getLibrarySelectionScope,
  hasActiveCellLibraryFilters,
  selectAllMatchingCellIds,
} from "../src/librarySelectionScope.ts";

test("full page selection prompts when more matching cells exist", () => {
  const scope = getLibrarySelectionScope([1, 2], [1, 2, 3, 4], new Set([1, 2]));
  assert.deepEqual(scope, {
    allPageSelected: true,
    allMatchingSelected: false,
    showSelectAllMatchingPrompt: true,
  });
});

test("partial pages, one-page results, and complete matches do not prompt", () => {
  assert.equal(getLibrarySelectionScope([1, 2], [1, 2, 3], new Set([1])).showSelectAllMatchingPrompt, false);
  assert.equal(getLibrarySelectionScope([1, 2], [1, 2], new Set([1, 2])).showSelectAllMatchingPrompt, false);
  assert.equal(getLibrarySelectionScope([1, 2], [1, 2, 3], new Set([1, 2, 3])).showSelectAllMatchingPrompt, false);
  assert.equal(getLibrarySelectionScope([], [1, 2], new Set()).showSelectAllMatchingPrompt, false);
});

test("short final pages use their actual row count", () => {
  const scope = getLibrarySelectionScope([4], [1, 2, 3, 4], new Set([4]));
  assert.equal(scope.showSelectAllMatchingPrompt, true);
});

test("select all matching replaces selection with filtered ids", () => {
  assert.deepEqual([...selectAllMatchingCellIds([2, 4, 6])], [2, 4, 6]);
});

test("active search and column filters are distinguished from the unfiltered state", () => {
  assert.equal(hasActiveCellLibraryFilters("term", {}), true);
  assert.equal(hasActiveCellLibraryFilters("", { statuses: ["Ready"] }), true);
  assert.equal(hasActiveCellLibraryFilters("", { cellText: "", min: null, statuses: [] }), false);
});
