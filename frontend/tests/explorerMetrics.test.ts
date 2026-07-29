import assert from "node:assert/strict";
import test from "node:test";

import {
  UNKNOWN,
  eagerAndLazyPlots,
  formatCapacity,
  formatCycleCount,
} from "../src/explorerMetrics.ts";

test("an unknown cycle count renders as a dash, not zero", () => {
  // A cell mid-import has no total yet; showing 0 reads as data loss.
  assert.equal(formatCycleCount(null), UNKNOWN);
});

test("a real zero renders as zero", () => {
  assert.equal(formatCycleCount(0), "0");
});

test("cycle counts are grouped for readability", () => {
  assert.equal(formatCycleCount(1250), (1250).toLocaleString());
});

test("an unknown capacity renders as a dash", () => {
  assert.equal(formatCapacity(null), UNKNOWN);
});

test("capacity keeps one decimal", () => {
  assert.equal(formatCapacity(3.25), "3.3");
  assert.equal(formatCapacity(0), "0.0");
});

test("large capacities switch to thousands so the column stays narrow", () => {
  assert.equal(formatCapacity(12500), "12.5 k");
  assert.equal(formatCapacity(9999), "9999.0");
});

test("non-finite values are treated as unknown", () => {
  assert.equal(formatCycleCount(Number.NaN), UNKNOWN);
  assert.equal(formatCapacity(Number.POSITIVE_INFINITY), UNKNOWN);
});

test("plots split into an eager batch and a lazy remainder", () => {
  const plots = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(eagerAndLazyPlots(plots, 6), {
    eager: [1, 2, 3, 4, 5, 6],
    lazy: [7, 8],
  });
});

test("fewer plots than the eager count leaves nothing lazy", () => {
  assert.deepEqual(eagerAndLazyPlots([1, 2], 6), { eager: [1, 2], lazy: [] });
  assert.deepEqual(eagerAndLazyPlots([], 6), { eager: [], lazy: [] });
});

test("a negative eager count does not reverse the split", () => {
  assert.deepEqual(eagerAndLazyPlots([1, 2], -3), { eager: [], lazy: [1, 2] });
});
