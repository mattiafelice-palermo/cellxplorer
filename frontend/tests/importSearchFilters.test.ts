import assert from "node:assert/strict";
import test from "node:test";
import { activeSearchFilters, filterChips, removeSearchFilter, searchableFilterCategories } from "../src/importSearchFilters.ts";

test("filter discovery includes field aliases and never mutates active filters", () => {
  assert.ok(searchableFilterCategories("cycles").some((c) => c.id === "cycling"));
  assert.ok(searchableFilterCategories("filename").some((c) => c.id === "text"));
  assert.ok(searchableFilterCategories("analysis").some((c) => c.id === "app"));
  assert.equal(searchableFilterCategories("nonexistent").length, 0);
});
test("chips remove precisely one range or condition and preserve other filters", () => {
  const value = { ranges: { size: { min: 1048576 }, cycle_count: { unknown: "only" as const } }, conditions: [{ field: "filename", operator: "contains", value: "BQV" }], registered: "yes" };
  assert.equal(filterChips(value).length, 4);
  const next = removeSearchFilter(value, "range:size");
  assert.ok(next.ranges?.cycle_count);
  assert.ok(!next.ranges?.size);
  assert.equal(removeSearchFilter(next, "condition:0").conditions?.length, 0);
  assert.equal(value.conditions.length, 1);
});
test("draft text is not applied but explicit missing tests are", () => {
  const filters = activeSearchFilters({ conditions: [{ field: "filename", operator: "contains", value: "" }, { field: "barcode", operator: "missing", value: "" }], ranges: { size: {}, cycle_count: { unknown: "only" } } });
  assert.equal(filters.conditions?.length, 1);
  assert.equal(Object.keys(filters.ranges ?? {}).length, 1);
});
test("applied chips retain draft indices when removing a later condition", () => {
  const filters = { conditions: [{ field: "filename", operator: "contains", value: "" }, { field: "filename", operator: "contains", value: "BQV" }] };
  const chips = filterChips(filters);
  assert.equal(chips[0].key, "condition:1");
  assert.equal(activeSearchFilters(removeSearchFilter(filters, chips[0].key)).conditions?.length, 0);
});
