import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WARMUP_DEBUG, publishWarmupDebug, readWarmupDebug,
  removeWarmupDebug, subscribeWarmupDebug,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityWarmupDebug.ts";

test("debug status prefers the active plot and cleans up without stale progress", () => {
  const active = Symbol(), inactive = Symbol();
  let changes = 0;
  const unsubscribe = subscribeWarmupDebug(() => changes++);
  const status = { ...EMPTY_WARMUP_DEBUG, active: true, completed: 3, total: 10, analysisId: 1 };
  try {
    publishWarmupDebug(active, status);
    publishWarmupDebug(inactive, { ...EMPTY_WARMUP_DEBUG, analysisId: 2 });
    assert.equal(readWarmupDebug().analysisId, 1);
    assert.equal(readWarmupDebug().completed, 3);
    const previousChanges = changes;
    publishWarmupDebug(active, { ...status });
    assert.equal(changes, previousChanges, "unchanged polling must not rerender the header");
    publishWarmupDebug(active, { ...status, state: "Error", reason: "Unavailable" });
    assert.equal(readWarmupDebug().state, "Error");
    assert.equal(readWarmupDebug().completed, 3, "failure must not report 100 percent");
  } finally {
    removeWarmupDebug(active);
    removeWarmupDebug(inactive);
    unsubscribe();
  }
  assert.deepEqual(readWarmupDebug(), EMPTY_WARMUP_DEBUG);
});
