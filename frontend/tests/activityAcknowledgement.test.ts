import assert from "node:assert/strict";
import test from "node:test";

import {
  readAcknowledgedFailedJobId,
  writeAcknowledgedFailedJobId,
  shouldShowActivityFailed,
} from "../src/activityAcknowledgement.ts";

// Mock storage for testing
function createMockStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

test("no failed jobs means button should not be red", () => {
  assert.equal(shouldShowActivityFailed([], null), false);
  assert.equal(shouldShowActivityFailed([], 5), false);
});

test("unacknowledged failed job makes button red", () => {
  assert.equal(shouldShowActivityFailed([10], null), true);
  assert.equal(shouldShowActivityFailed([10], 5), true);
});

test("acknowledged failed job does not make button red if no newer failures", () => {
  assert.equal(shouldShowActivityFailed([10], 10), false);
  assert.equal(shouldShowActivityFailed([5], 10), false);
});

test("newer failed job makes button red even after acknowledgement", () => {
  // Acknowledged job 10, but job 15 failed afterwards
  assert.equal(shouldShowActivityFailed([15], 10), true);
});

test("multiple failed jobs, highest unacknowledged makes button red", () => {
  // Multiple failed jobs, highest is 20, acknowledged is 15
  assert.equal(shouldShowActivityFailed([5, 10, 20], 15), true);
  // All failed jobs acknowledged
  assert.equal(shouldShowActivityFailed([5, 10, 20], 20), false);
});

test("read/write acknowledged ID persists across storage operations", () => {
  const storage = createMockStorage();
  assert.equal(readAcknowledgedFailedJobId(storage), null);

  writeAcknowledgedFailedJobId(storage, 42);
  assert.equal(readAcknowledgedFailedJobId(storage), 42);

  writeAcknowledgedFailedJobId(storage, 100);
  assert.equal(readAcknowledgedFailedJobId(storage), 100);
});

test("corrupt or absent stored value returns null", () => {
  assert.equal(readAcknowledgedFailedJobId({ getItem: (key: string) => null }), null);
  assert.equal(readAcknowledgedFailedJobId({ getItem: (key: string) => "not-a-number" }), null);
  assert.equal(readAcknowledgedFailedJobId({ getItem: (key: string) => "-42" }), null);
  assert.equal(readAcknowledgedFailedJobId({ getItem: (key: string) => "" }), null);
});

test("acknowledgement workflow: failure -> red -> acknowledge -> not red -> new failure -> red", () => {
  const storage = createMockStorage();

  // No failures
  assert.equal(shouldShowActivityFailed([1], null), true);

  // Acknowledge job 1
  writeAcknowledgedFailedJobId(storage, 1);
  const ack1 = readAcknowledgedFailedJobId(storage);
  assert.equal(shouldShowActivityFailed([1], ack1), false);

  // New failure arrives
  assert.equal(shouldShowActivityFailed([1, 5], ack1), true);

  // Acknowledge the new failure
  writeAcknowledgedFailedJobId(storage, 5);
  const ack2 = readAcknowledgedFailedJobId(storage);
  assert.equal(shouldShowActivityFailed([1, 5], ack2), false);
});
