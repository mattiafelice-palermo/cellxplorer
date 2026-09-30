import assert from "node:assert/strict";
import test from "node:test";
import { loadNotificationPreferences, saveNotificationPreferences, readToastBaseline, saveToastBaseline } from "../src/notificationPreferences.ts";
import { isAnalysisNotificationActivation } from "../src/notificationPreferences.ts";
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("notification channels default on and persist independently", () => {
  const store = storage();
  assert.deepEqual(loadNotificationPreferences(store), { inAppEnabled: true, windowsDataUpdatesEnabled: true });
  saveNotificationPreferences(store, { inAppEnabled: false, windowsDataUpdatesEnabled: true });
  assert.deepEqual(loadNotificationPreferences(store), { inAppEnabled: false, windowsDataUpdatesEnabled: true });
  assert.deepEqual(loadNotificationPreferences({ getItem: () => "broken", setItem: () => {} }), { inAppEnabled: true, windowsDataUpdatesEnabled: true });
});
test("native baseline is scoped, bounded, and counts each batch only once", () => {
  const store = storage();
  assert.equal(readToastBaseline(store, "a"), null);
  saveToastBaseline(store, "a", [1, 1, 2]);
  assert.deepEqual(readToastBaseline(store, "a"), [2, 1]);
  assert.equal(readToastBaseline(store, "b"), null);
  saveToastBaseline(store, "a", Array.from({ length: 150 }, (_, i) => i + 1));
  assert.equal(readToastBaseline(store, "a")?.length, 100);
  assert.doesNotThrow(() => saveToastBaseline({ getItem: () => { throw Error(); }, setItem: () => { throw Error(); } }, "a", [1]));
});
test("native activation rejects other event identities and empty databases", () => {
  assert.equal(isAnalysisNotificationActivation({ kind: "cellxplorer-analysis-update", databaseId: "db-123" }), true);
  for (const value of [null, {}, {kind: "app-update", databaseId: "db"}, {kind: "cellxplorer-analysis-update", databaseId: " "}]) {
    assert.equal(isAnalysisNotificationActivation(value), false);
  }
});
