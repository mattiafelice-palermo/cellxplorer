import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLOT_STYLE, normalizePlotStyle } from "../src/features/analyses/editor/plotting/plotStyle.ts";
import {
  appendTimeCapacityCycleHistory,
  centerTimeCapacityCycleRange,
  cycleRangeWidth,
  cycleRangesEqual,
  cycleWindowOptions,
  normalizeCycleRangeForNavigation,
  normalizeManualTimeCapacityRange,
  normalizeTimeCapacityRange,
  resizeTimeCapacityCycleRange,
  selectedTimeCapacityCycleMax,
  selectTimeCapacityCycleHistory,
  shiftTimeCapacityCycleRange,
  timeCapacityCycleRangeAtBoundary,
  timeCapacityPreviousViewDisabled,
  timeCapacityRangeNavigationDisabled,
  timeCapacityVirginCycleRange,
  type TimeCapacityCycleRange,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityCycleNavigationPolicy.ts";

const cell = (id: number, total_cycles: number) => ({ id, total_cycles });
const group = (id: number, cell_ids: number[]) => ({ id, cell_ids });

test("single-cycle movement preserves width and clamps at both boundaries", () => {
  const range = { start: 101, end: 120 };
  assert.deepEqual(shiftTimeCapacityCycleRange(range, -1, "cycle", 720), { start: 100, end: 119 });
  assert.deepEqual(shiftTimeCapacityCycleRange(range, 1, "cycle", 720), { start: 102, end: 121 });
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 1, end: 20 }, -1, "cycle", 720), {
    start: 1,
    end: 20,
  });
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 701, end: 720 }, 1, "cycle", 720), {
    start: 701,
    end: 720,
  });
});

test("whole-window movement is non-overlapping and boundary-clamped", () => {
  assert.deepEqual(
    shiftTimeCapacityCycleRange({ start: 101, end: 120 }, 1, "window", 720),
    { start: 121, end: 140 },
  );
  assert.deepEqual(
    shiftTimeCapacityCycleRange({ start: 101, end: 120 }, -1, "window", 720),
    { start: 81, end: 100 },
  );
  assert.deepEqual(
    shiftTimeCapacityCycleRange({ start: 701, end: 720 }, 1, "window", 720),
    { start: 701, end: 720 },
  );
});

test("null-bound navigation keeps only safe single-cycle backward movement", () => {
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 10, end: 20 }, -1, "cycle", null), {
    start: 9,
    end: 19,
  });
  const lowerClamped = { start: 1, end: 20 };
  assert.deepEqual(shiftTimeCapacityCycleRange(lowerClamped, -1, "cycle", null), lowerClamped);
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 10, end: 20 }, -1, "window", null), {
    start: 10,
    end: 20,
  });
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 10, end: 20 }, 1, "cycle", null), {
    start: 10,
    end: 20,
  });
});

test("width one and all-cycle windows remain valid", () => {
  assert.equal(cycleRangeWidth({ start: 7, end: 7 }), 1);
  assert.deepEqual(shiftTimeCapacityCycleRange({ start: 7, end: 7 }, 1, "cycle", 10), {
    start: 8,
    end: 8,
  });
  assert.deepEqual(resizeTimeCapacityCycleRange({ start: 7, end: 7 }, 10, 10), {
    start: 1,
    end: 10,
  });
  assert.deepEqual(resizeTimeCapacityCycleRange({ start: 7, end: 7 }, 12, 10), {
    start: 1,
    end: 10,
  });
});

test("resizing near the upper boundary shifts left to preserve the requested width", () => {
  assert.deepEqual(resizeTimeCapacityCycleRange({ start: 95, end: 100 }, 20, 100), {
    start: 81,
    end: 100,
  });
  assert.deepEqual(normalizeCycleRangeForNavigation(95, 100, 100), { start: 95, end: 100 });
});

test("jump and slider centering use deterministic even-width centering and clamp", () => {
  const range = { start: 101, end: 120 };
  assert.deepEqual(centerTimeCapacityCycleRange(range, 300, 720), { start: 290, end: 309 });
  assert.deepEqual(centerTimeCapacityCycleRange(range, 2, 720), { start: 1, end: 20 });
  assert.deepEqual(centerTimeCapacityCycleRange(range, 719, 720), { start: 701, end: 720 });
});

test("boundary jumps preserve the current width", () => {
  const range = { start: 101, end: 120 };
  assert.deepEqual(timeCapacityCycleRangeAtBoundary(range, "first", 720), {
    start: 1,
    end: 20,
  });
  assert.deepEqual(timeCapacityCycleRangeAtBoundary(range, "last", 720), {
    start: 701,
    end: 720,
  });
  assert.deepEqual(timeCapacityCycleRangeAtBoundary(range, "last", null), range);
});

test("virgin views use the last twenty available cycles without exceeding the extent", () => {
  assert.deepEqual(timeCapacityVirginCycleRange(200), { start: 181, end: 200 });
  assert.deepEqual(timeCapacityVirginCycleRange(20), { start: 1, end: 20 });
  assert.deepEqual(timeCapacityVirginCycleRange(12), { start: 1, end: 12 });
  assert.equal(timeCapacityVirginCycleRange(null), null);
});

test("the canonical virgin plot style remains line-only", () => {
  assert.equal(DEFAULT_PLOT_STYLE.marker_mode, "none");
  assert.equal(normalizePlotStyle(undefined).marker_mode, "none");
});

test("manual From/To commits clamp and move the opposite endpoint when fields cross", () => {
  const current = { start: 10, end: 20 };
  assert.deepEqual(normalizeManualTimeCapacityRange(current, { start: 25 }, 100), {
    start: 25,
    end: 25,
  });
  assert.deepEqual(normalizeManualTimeCapacityRange(current, { end: 5 }, 100), {
    start: 5,
    end: 5,
  });
  assert.deepEqual(normalizeManualTimeCapacityRange(current, { start: 98 }, 50), {
    start: 50,
    end: 50,
  });
});

test("defensive range normalization ignores invalid values and rounds to integers", () => {
  assert.deepEqual(normalizeTimeCapacityRange(Number.NaN, 2.6, 10), { start: 1, end: 3 });
  assert.deepEqual(normalizeTimeCapacityRange(-4.4, Number.POSITIVE_INFINITY), { start: 1, end: 3 });
  assert.deepEqual(normalizeManualTimeCapacityRange({ start: 4, end: 8 }, { start: "bad" }, 20), {
    start: 4,
    end: 8,
  });
});

test("window options filter known-impossible presets but retain the current width", () => {
  assert.deepEqual(cycleWindowOptions(3, 20), [1, 3, 5, 10, 20]);
  assert.deepEqual(cycleWindowOptions(720, 720), [1, 5, 10, 20, 50, 100, 720]);
  assert.deepEqual(cycleWindowOptions(20, null), [1, 5, 10, 20, 50, 100]);
});

test("history appends unique previous ranges and remains bounded", () => {
  const first: TimeCapacityCycleRange = { start: 1, end: 3 };
  const second: TimeCapacityCycleRange = { start: 2, end: 4 };
  assert.deepEqual(appendTimeCapacityCycleHistory([], first), [first]);
  assert.deepEqual(appendTimeCapacityCycleHistory([first], first), [first]);
  assert.deepEqual(appendTimeCapacityCycleHistory([first], second), [first, second]);
  assert.equal(appendTimeCapacityCycleHistory([first, second], first, 2).length, 2);
  assert.deepEqual(appendTimeCapacityCycleHistory([first, second], first), [second, first]);
  assert.equal(cycleRangesEqual(first, { start: 1, end: 3 }), true);
});

test("history selection restores an older entry and drops newer back-stack entries", () => {
  const first = { start: 1, end: 3 };
  const second = { start: 10, end: 12 };
  const third = { start: 20, end: 22 };
  assert.deepEqual(selectTimeCapacityCycleHistory([first, second, third], 1), {
    range: second,
    history: [first],
  });
  assert.equal(selectTimeCapacityCycleHistory([first], 3), null);
});

test("selected maximum resolves direct cells, groups, mixed entries, and duplicates", () => {
  const cells = [cell(1, 30), cell(2, 120), cell(3, 60)];
  const groups = [group(9, [1, 2])];
  assert.equal(selectedTimeCapacityCycleMax([{ kind: "cell", ref_id: 1 }], cells, groups), 30);
  assert.equal(
    selectedTimeCapacityCycleMax(
      [
        { kind: "cell", ref_id: 1 },
        { kind: "cell", ref_id: 3 },
      ],
      cells,
      groups,
    ),
    60,
  );
  assert.equal(selectedTimeCapacityCycleMax([{ kind: "replicate_group", ref_id: 9 }], cells, groups), 120);
  assert.equal(
    selectedTimeCapacityCycleMax(
      [
        { kind: "cell", ref_id: 2 },
        { kind: "replicate_group", ref_id: 9 },
      ],
      cells,
      groups,
    ),
    120,
  );
});

test("selected maximum ignores invalid summaries and returns null without a reliable bound", () => {
  const cells = [cell(1, 0), cell(2, Number.NaN), cell(3, Number.POSITIVE_INFINITY), cell(4, 2.9)];
  assert.equal(
    selectedTimeCapacityCycleMax(
      [
        { kind: "cell", ref_id: 1 },
        { kind: "cell", ref_id: 2 },
        { kind: "cell", ref_id: 3 },
      ],
      cells,
      [],
    ),
    null,
  );
  assert.equal(selectedTimeCapacityCycleMax([{ kind: "cell", ref_id: 4 }], cells, []), 2);
  assert.equal(selectedTimeCapacityCycleMax([{ kind: "cell", ref_id: 99 }], cells, []), null);
  assert.equal(selectedTimeCapacityCycleMax([{ kind: "cell", ref_id: 1 }], undefined, []), null);
});

test("explicit cycles disable range navigation without changing the retained range", () => {
  assert.equal(timeCapacityRangeNavigationDisabled([]), false);
  assert.equal(timeCapacityRangeNavigationDisabled([1, 4, 9]), true);
  assert.equal(timeCapacityPreviousViewDisabled([], 1), false);
  assert.equal(timeCapacityPreviousViewDisabled([], 0), true);
  assert.equal(timeCapacityPreviousViewDisabled([1, 4, 9], 1), true);
});
