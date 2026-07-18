import assert from "node:assert/strict";
import test from "node:test";

import { isTransientApiError } from "../src/apiRetryPolicy.ts";

class TestApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

test("query retry policy distinguishes startup failures from permanent errors", () => {
  assert.equal(isTransientApiError(new TypeError("connection refused")), true);
  assert.equal(isTransientApiError(new TestApiError(503, "Starting")), true);
  assert.equal(isTransientApiError(new TestApiError(500, "Database is locked")), true);
  assert.equal(isTransientApiError(new TestApiError(429, "Busy")), true);
  assert.equal(isTransientApiError(new TestApiError(404, "Missing")), false);
  assert.equal(isTransientApiError(new TestApiError(409, "Conflict")), false);
  assert.equal(isTransientApiError(new TestApiError(422, "Invalid")), false);
});
