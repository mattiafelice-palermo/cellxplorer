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

/**
 * Build a series shaped like a real protocol: normal cycles at a steady
 * duration, with a short diagnostic block every `period` cycles.
 */
function protocolSeries(
  count: number,
  { period = 83, blockSize = 5, normal = 4.0, diagnostic = 0.02 } = {}
) {
  const cycles: number[] = [];
  const durations: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    cycles.push(i);
    const intoPeriod = i % period;
    durations.push(intoPeriod > 0 && intoPeriod <= blockSize ? diagnostic : normal);
  }
  return { cycles, durations };
}

test("flags short diagnostic blocks and nothing else", () => {
  const { cycles, durations } = protocolSeries(300);
  const flagged = findDiagnosticCycles(cycles, durations);

  const expected = cycles.filter((c) => c % 83 > 0 && c % 83 <= 5);
  assert.deepEqual([...flagged].sort((a, b) => a - b), expected);
});

test("a genuinely degraded cell is never hidden", () => {
  // Capacity collapses to a tenth, but the cell still discharges for a normal
  // length of time. A capacity threshold would hide this; duration must not.
  const cycles: number[] = [];
  const durations: number[] = [];
  for (let i = 1; i <= 200; i += 1) {
    cycles.push(i);
    durations.push(i > 120 ? 3.7 : 4.0);
  }
  assert.equal(findDiagnosticCycles(cycles, durations).size, 0);
});

test("tolerates slow fade, which shifts the baseline over time", () => {
  const cycles: number[] = [];
  const durations: number[] = [];
  for (let i = 1; i <= 400; i += 1) {
    cycles.push(i);
    // 40% shorter by the end — a rolling baseline must absorb this.
    durations.push(4.0 * (1 - 0.4 * (i / 400)));
  }
  assert.equal(findDiagnosticCycles(cycles, durations).size, 0);
});

test("still finds diagnostics while the cell fades underneath them", () => {
  const cycles: number[] = [];
  const durations: number[] = [];
  for (let i = 1; i <= 300; i += 1) {
    cycles.push(i);
    const base = 4.0 * (1 - 0.3 * (i / 300));
    durations.push(i % 83 > 0 && i % 83 <= 4 ? 0.02 : base);
  }
  const flagged = findDiagnosticCycles(cycles, durations);
  const expected = cycles.filter((c) => c % 83 > 0 && c % 83 <= 4);
  assert.deepEqual([...flagged].sort((a, b) => a - b), expected);
});

test("nulls are unknown, not evidence", () => {
  const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const durations: (number | null)[] = cycles.map(() => 4.0);
  durations[10] = null;
  durations[11] = null;
  assert.equal(findDiagnosticCycles(cycles, durations).size, 0);
});

test("short series are left alone for want of a baseline", () => {
  const cycles = [1, 2, 3, 4, 5];
  assert.equal(findDiagnosticCycles(cycles, [4, 4, 0.01, 4, 4]).size, 0);
  // Once long enough, the same outlier is caught.
  const longer = Array.from({ length: 40 }, (_, i) => i + 1);
  const durations = longer.map((_, i) => (i === 20 ? 0.01 : 4));
  assert.deepEqual([...findDiagnosticCycles(longer, durations)], [21]);
});

test("a constant-zero series yields no scale and is left alone", () => {
  const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.equal(findDiagnosticCycles(cycles, cycles.map(() => 0)).size, 0);
});

test("the union across series keeps every quantity in step", () => {
  const a = {
    x: Array.from({ length: 40 }, (_, i) => i + 1),
    quantities: { discharge_time_h: Array.from({ length: 40 }, (_, i) => (i === 9 ? 0.01 : 4)) },
  };
  const b = {
    x: Array.from({ length: 40 }, (_, i) => i + 1),
    quantities: { discharge_time_h: Array.from({ length: 40 }, (_, i) => (i === 29 ? 0.01 : 4)) },
  };
  // Cycle 10 is diagnostic in one cell and 30 in the other; hiding the union
  // keeps replicates comparable rather than ragged.
  assert.deepEqual([...findDiagnosticCyclesAcross([a, b])].sort((x, y) => x - y), [10, 30]);
});

test("catches slow-rate checks, which run LONGER and read higher", () => {
  // Modelled on a real block: cycles 87-88 discharged for 2.774h against a
  // 0.801h baseline and read 142 mAh/g against a 123 mAh/g band. A "too short"
  // rule cannot see these at all.
  const cycles = Array.from({ length: 60 }, (_, i) => i + 1);
  const durations = cycles.map((c) => (c === 30 || c === 31 ? 2.774 : 0.801));
  assert.deepEqual([...findDiagnosticCycles(cycles, durations)].sort((a, b) => a - b), [30, 31]);
});

test("catches a fast-charge probe that only its charge time betrays", () => {
  // Normal discharge throughout, so discharge_time_h alone sees nothing.
  const x = Array.from({ length: 60 }, (_, i) => i + 1);
  const series = {
    x,
    quantities: {
      discharge_time_h: x.map(() => 0.801),
      charge_time_h: x.map((c) => (c === 40 ? 0.925 : 2.4)),
    },
  };
  assert.equal(findDiagnosticCycles(x, series.quantities.discharge_time_h).size, 0);
  assert.deepEqual([...findDiagnosticCyclesInSeries(series)], [40]);
});

test("reproduces a real diagnostic block end to end", () => {
  // Cycles 82-100 of NG_20251127_LFP_LP_MoL_378_FM_CY_FC, verbatim.
  const x: number[] = [];
  const dis: number[] = [];
  const chg: number[] = [];
  const push = (c: number, d: number, g: number) => { x.push(c); dis.push(d); chg.push(g); };
  for (let c = 60; c <= 86; c += 1) push(c, 0.801, 2.4);
  push(87, 2.774, 0.925);
  push(88, 2.781, 2.876);
  push(89, 1.399, 2.871);
  push(90, 0.033, 0.033);
  push(91, 0.026, 0.026);
  push(92, 0.008, 0.016);
  push(93, 0.862, 1.428);
  for (let c = 94; c <= 120; c += 1) push(c, 0.801, 2.4);

  const flagged = findDiagnosticCyclesInSeries({
    x,
    quantities: { discharge_time_h: dis, charge_time_h: chg },
  });
  // The whole block, and only the block.
  assert.deepEqual([...flagged].sort((a, b) => a - b), [87, 88, 89, 90, 91, 92, 93]);
});

test("a series without the duration quantity contributes nothing", () => {
  const s = { x: [1, 2, 3], quantities: {} as Record<string, (number | null)[]> };
  assert.equal(findDiagnosticCyclesAcross([s]).size, 0);
});

test("hidden cycles are reported as compact runs", () => {
  assert.deepEqual(cycleRanges([90, 87, 88, 89, 92, 91, 93]), [[87, 93]]);
  assert.deepEqual(cycleRanges([3, 1, 7, 2, 8]), [[1, 3], [7, 8]]);
  assert.deepEqual(cycleRanges([]), []);

  assert.equal(formatCycleRanges([87, 88, 89, 170, 171]), "87–89, 170–171");
  assert.equal(formatCycleRanges([5]), "5");
  // Long reports stay readable rather than running to hundreds of numbers.
  assert.equal(formatCycleRanges([1, 5, 9, 13], 2), "1, 5, and 2 more");
});

test("the summary reports both what went and what stayed", () => {
  const all = Array.from({ length: 100 }, (_, i) => i + 1);
  const hidden = new Set([10, 11, 12, 50]);
  const summary = summarizeHidden(all, hidden);

  assert.equal(summary.hiddenCount, 4);
  assert.equal(summary.shownCount, 96);
  assert.equal(summary.hiddenCount + summary.shownCount, all.length);
  assert.deepEqual(summary.ranges, [[10, 12], [50, 50]]);
});

test("the summary ignores flagged cycles the series does not contain", () => {
  // The hidden set is a union across series; a short series must not report
  // negative or inflated counts because of cycles it never had.
  const summary = summarizeHidden([1, 2, 3], new Set([2, 900, 901]));
  assert.equal(summary.hiddenCount, 1);
  assert.equal(summary.shownCount, 2);
});
