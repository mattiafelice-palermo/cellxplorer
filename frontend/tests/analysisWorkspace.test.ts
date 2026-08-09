import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_WORKSPACE_STORAGE_KEY,
  parseAnalysisWorkspace,
  saveAnalysisWorkspace,
} from "../src/features/analyses/workspace/analysisWorkspace.ts";

test("analysis workspace parser rejects invalid persisted data", () => {
  assert.deepEqual(parseAnalysisWorkspace(null), { version: 1, tabs: [], closedTabs: [] });
  assert.deepEqual(parseAnalysisWorkspace("not json"), { version: 1, tabs: [], closedTabs: [] });
  assert.deepEqual(parseAnalysisWorkspace(JSON.stringify({ version: 2, tabs: [] })), {
    version: 1,
    tabs: [],
    closedTabs: [],
  });
});

test("analysis workspace parser keeps unique valid analysis tabs", () => {
  const snapshot = parseAnalysisWorkspace(
    JSON.stringify({
      version: 1,
      tabs: [
        { id: 4, title: "First", path: "/analyses/4" },
        { id: 4, title: "Duplicate", path: "/analyses/4?tab=cycles" },
        { id: 7, title: "Second", path: "/analyses/7?plot=abc" },
        { id: -1, title: "Invalid", path: "/analyses/-1" },
        { id: 9, title: "Wrong route", path: "/projects" },
      ],
    }),
  );

  assert.deepEqual(snapshot.tabs, [
    { id: 4, title: "First", path: "/analyses/4" },
    { id: 7, title: "Second", path: "/analyses/7?plot=abc" },
  ]);
  assert.deepEqual(snapshot.closedTabs, []);
});

test("analysis workspace excludes open tabs from chronological closed history", () => {
  const snapshot = parseAnalysisWorkspace(JSON.stringify({
    version: 1,
    tabs: [{ id: 4, title: "Open", path: "/analyses/4" }],
    closedTabs: [
      { id: 7, title: "Newest", path: "/analyses/7" },
      { id: 4, title: "Duplicate open", path: "/analyses/4" },
      { id: 8, title: "Older", path: "/analyses/8" },
    ],
  }));
  assert.deepEqual(snapshot.closedTabs, [
    { id: 7, title: "Newest", path: "/analyses/7" },
    { id: 8, title: "Older", path: "/analyses/8" },
  ]);
});

test("analysis workspace persistence is inert without a browser window", () => {
  assert.doesNotThrow(() =>
    saveAnalysisWorkspace([{ id: 1, title: "Analysis", path: "/analyses/1" }]),
  );
  assert.equal(typeof ANALYSIS_WORKSPACE_STORAGE_KEY, "string");
});
