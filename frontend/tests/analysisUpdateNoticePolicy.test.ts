import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeUpdates, readSeenUpdates, unreadUpdates, updateSummary } from "../src/analysisUpdateNoticePolicy.ts";
import type { AnalysisUpdateNotice } from "../src/api.ts";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function notice(id: number, version = "first"): AnalysisUpdateNotice {
  return { id, message: "Analyses received new data", created_at: "now", finished_at: version, cell_count: 1,
    analyses: [{ id: 1, title: "Cycling", cell_ids: [1], cells: [{id: 1, name: "Cell"}], added_cycles: 5, status: "ready" }] };
}
test("acknowledgement is durable and isolated by database instance", () => {
  const store = storage();
  acknowledgeUpdates(store, "a", [notice(1)]);
  assert.equal(unreadUpdates([notice(1)], readSeenUpdates(store, "a")).length, 0);
  assert.equal(unreadUpdates([notice(1)], readSeenUpdates(store, "b")).length, 1);
});
test("further updates to the same live batch become unread again", () => {
  const store = storage();
  acknowledgeUpdates(store, "a", [notice(1)]);
  assert.equal(unreadUpdates([notice(1, "second")], readSeenUpdates(store, "a")).length, 1);
});
test("summary deduplicates overlapping analyses and Cells across notices", () => {
  assert.deepEqual(updateSummary([notice(1), notice(2)]), {analyses: 1, cells: 1});
});
test("read state is bounded and tolerates corrupt or unavailable storage", () => {
  const store = storage();
  acknowledgeUpdates(store, "a", Array.from({length: 150}, (_, i) => notice(i + 1)));
  assert.equal(Object.keys(readSeenUpdates(store, "a")).length, 100);
  assert.deepEqual(readSeenUpdates({ getItem: () => "[]", setItem: () => {} }, "a"), {});
  assert.doesNotThrow(() => acknowledgeUpdates({ getItem: () => { throw Error(); }, setItem: () => { throw Error(); } }, "a", [notice(1)]));
});
