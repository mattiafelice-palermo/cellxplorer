import assert from "node:assert/strict";
import test from "node:test";

import {
  cycleRanges,
  findDiagnosticCycles,
  findDiagnosticCyclesAcross,
  findDiagnosticCyclesInSeries,
  formatCycleRanges,
  summarizeHidden,
} from "../src/features/analyses/editor/families/cycles/diagnosticCycles.ts";

function capacitySeries(
  count: number,
  overrides: Record<number, [number, number]> = {},
) {
  const x = Array.from({ length: count }, (_, index) => index + 1);
  return {
    x,
    quantities: {
      charge_capacity_mah: x.map((cycle) => overrides[cycle]?.[0] ?? 1),
      discharge_capacity_mah: x.map((cycle) => overrides[cycle]?.[1] ?? 1),
    },
  };
}

test("flags the complete lower-capacity diagnostic support block", () => {
  const series = capacitySeries(120, {
    30: [1, 0.5],
    31: [0.02, 0.02],
    32: [0.02, 0.02],
    33: [0.02, 0.02],
    34: [0.5, 1],
  });

  const flagged = findDiagnosticCyclesInSeries(series, { formationCycles: 3 });
  assert.deepEqual([...flagged].sort((a, b) => a - b), [30, 31, 32, 33, 34]);
});

test("uses the lower phase capacity and only flags lower-tail values", () => {
  const series = capacitySeries(60, {
    30: [1, 0.5],
    31: [1.2, 1.2],
    32: [0.9, 0.9],
  });

  assert.deepEqual([...findDiagnosticCyclesInSeries(series)], [30]);
});

test("excludes formation cycles from both the baseline and the result", () => {
  const series = capacitySeries(40, {
    1: [0.01, 0.01],
    2: [0.01, 0.01],
    3: [0.01, 0.01],
    20: [0.01, 0.01],
  });

  assert.deepEqual(
    [...findDiagnosticCyclesInSeries(series, { formationCycles: 3 })],
    [20],
  );
});

test("tolerates gradual capacity fade with a local baseline", () => {
  const series = capacitySeries(400);
  series.quantities.charge_capacity_mah = series.x.map(
    (_, index) => 1 - 0.4 * (index / 399),
  );
  series.quantities.discharge_capacity_mah = [...series.quantities.charge_capacity_mah];

  assert.equal(findDiagnosticCyclesInSeries(series, { formationCycles: 3 }).size, 0);
});

test("missing phase capacity is unknown rather than evidence", () => {
  const series = capacitySeries(40);
  series.quantities.charge_capacity_mah[19] = null;
  series.quantities.discharge_capacity_mah[19] = 0.01;

  assert.equal(findDiagnosticCyclesInSeries(series).size, 0);
});

test("short post-formation series are left alone", () => {
  const series = capacitySeries(14, {
    4: [0.01, 0.01],
  });
  assert.equal(findDiagnosticCyclesInSeries(series, { formationCycles: 3 }).size, 0);
});

test("the union across cells keeps every quantity in step", () => {
  const a = capacitySeries(40, { 10: [1, 0.01] });
  const b = capacitySeries(40, { 30: [0.01, 1] });

  assert.deepEqual(
    [...findDiagnosticCyclesAcross([a, b])].sort((a, b) => a - b),
    [10, 30],
  );
});

test("the scalar helper applies a lower-tail local-median rule", () => {
  const cycles = Array.from({ length: 40 }, (_, index) => index + 1);
  const capacities = cycles.map((cycle) => (cycle === 21 ? 0.01 : 1));
  assert.deepEqual([...findDiagnosticCycles(cycles, capacities)], [21]);
});

test("hidden cycles are reported as compact runs", () => {
  assert.deepEqual(cycleRanges([90, 87, 88, 89, 92, 91, 93]), [[87, 93]]);
  assert.deepEqual(cycleRanges([3, 1, 7, 2, 8]), [[1, 3], [7, 8]]);
  assert.deepEqual(cycleRanges([]), []);

  assert.equal(formatCycleRanges([87, 88, 89, 170, 171]), "87–89, 170–171");
  assert.equal(formatCycleRanges([5]), "5");
  assert.equal(formatCycleRanges([1, 5, 9, 13], 2), "1, 5, and 2 more");
});

test("the summary reports both what went and what remains", () => {
  const all = Array.from({ length: 100 }, (_, index) => index + 1);
  const hidden = new Set([10, 11, 12, 50]);
  const summary = summarizeHidden(all, hidden);

  assert.equal(summary.hiddenCount, 4);
  assert.equal(summary.shownCount, 96);
  assert.equal(summary.hiddenCount + summary.shownCount, all.length);
  assert.deepEqual(summary.ranges, [[10, 12], [50, 50]]);
});

test("the summary ignores flagged cycles a series does not contain", () => {
  const summary = summarizeHidden([1, 2, 3], new Set([2, 900, 901]));
  assert.equal(summary.hiddenCount, 1);
  assert.equal(summary.shownCount, 2);
});
