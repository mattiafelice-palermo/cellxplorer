import assert from "node:assert/strict";
import test from "node:test";

import {
  UNKNOWN,
  formatCapacity,
  formatCycleCount,
  formatSpecificCapacity,
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

test("specific capacity is shown as a whole number", () => {
  // Specific capacities sit in the tens to low hundreds of mAh/g, where a decimal
  // is noise and an integer column is much easier to scan down.
  assert.equal(formatSpecificCapacity(148.6), "149");
  assert.equal(formatSpecificCapacity(0), "0");
});

test("an unknown specific capacity renders as a dash", () => {
  // A cell with no active mass recorded has no mAh/g to report.
  assert.equal(formatSpecificCapacity(null), UNKNOWN);
  assert.equal(formatSpecificCapacity(Number.NaN), UNKNOWN);
});
