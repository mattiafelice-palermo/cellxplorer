import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VIEW_PREFERENCES,
  loadViewPreferences,
  saveViewPreferences,
  sectionCount,
  sectionStateKey,
  visibleSections,
  type SectionableFolder,
} from "../src/folderSections.ts";

const folder = (cells: number, groups: number, analyses: number): SectionableFolder => ({
  cells: Array.from({ length: cells }, (_, i) => i),
  replicate_groups: Array.from({ length: groups }, (_, i) => i),
  analyses: Array.from({ length: analyses }, (_, i) => i),
});

test("samples-first puts samples before analyses", () => {
  assert.deepEqual(visibleSections(folder(1, 0, 1), "samples-first"), ["samples", "analyses"]);
});

test("analyses-first puts analyses before samples", () => {
  assert.deepEqual(visibleSections(folder(1, 0, 1), "analyses-first"), ["analyses", "samples"]);
});

test("an empty section is omitted rather than shown with a zero count", () => {
  assert.deepEqual(visibleSections(folder(2, 1, 0), "samples-first"), ["samples"]);
  assert.deepEqual(visibleSections(folder(0, 0, 3), "samples-first"), ["analyses"]);
});

test("an empty folder has no sections at all", () => {
  assert.deepEqual(visibleSections(folder(0, 0, 0), "analyses-first"), []);
});

test("replicate groups count as samples alongside cells", () => {
  assert.equal(sectionCount(folder(2, 3, 0), "samples"), 5);
  assert.equal(sectionCount(folder(2, 3, 4), "analyses"), 4);
});

test("section state keys are unique per folder and section", () => {
  assert.notEqual(sectionStateKey(1, "analyses"), sectionStateKey(1, "samples"));
  assert.notEqual(sectionStateKey(1, "analyses"), sectionStateKey(2, "analyses"));
});

test("preferences round-trip through storage", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  saveViewPreferences(storage, { sectioned: true, order: "analyses-first" });
  assert.deepEqual(loadViewPreferences(storage), {
    sectioned: true,
    order: "analyses-first",
    showMetrics: true,
  });
});

test("nothing stored yields the historical flat, samples-first view", () => {
  assert.deepEqual(
    loadViewPreferences({ getItem: () => null }),
    DEFAULT_VIEW_PREFERENCES
  );
  assert.equal(DEFAULT_VIEW_PREFERENCES.sectioned, false);
});

test("malformed stored JSON falls back to the defaults", () => {
  assert.deepEqual(
    loadViewPreferences({ getItem: () => "{not json" }),
    DEFAULT_VIEW_PREFERENCES
  );
  assert.deepEqual(loadViewPreferences({ getItem: () => "42" }), DEFAULT_VIEW_PREFERENCES);
});

test("a partial stored value keeps the fields it does have", () => {
  // A half-written preference must not silently reset the other field.
  assert.deepEqual(loadViewPreferences({ getItem: () => '{"sectioned":true}' }), {
    sectioned: true,
    order: "samples-first",
    showMetrics: true,
  });
  assert.deepEqual(loadViewPreferences({ getItem: () => '{"order":"analyses-first"}' }), {
    sectioned: false,
    order: "analyses-first",
    showMetrics: true,
  });
  // Metrics default on, so an older stored preference gains the columns.
  assert.deepEqual(loadViewPreferences({ getItem: () => '{"showMetrics":false}' }), {
    sectioned: false,
    order: "samples-first",
    showMetrics: false,
  });
});

test("an unknown order value falls back rather than rendering nothing", () => {
  assert.deepEqual(loadViewPreferences({ getItem: () => '{"order":"cells-first"}' }), {
    sectioned: false,
    order: "samples-first",
    showMetrics: true,
  });
});

test("a throwing storage does not break the tree", () => {
  assert.deepEqual(
    loadViewPreferences({
      getItem: () => {
        throw new Error("denied");
      },
    }),
    DEFAULT_VIEW_PREFERENCES
  );
  assert.doesNotThrow(() =>
    saveViewPreferences(
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      DEFAULT_VIEW_PREFERENCES
    )
  );
});
