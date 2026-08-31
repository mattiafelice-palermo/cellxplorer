import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_PLOT_STYLE, normalizePlotStyle } from "../src/features/analyses/editor/plotting/plotStyle.ts";
import {
  absoluteXRangeForCycleIndex,
  absoluteXRangeForCycles,
  buildTimeCapacityCycleXIndex,
  bufferMaxPoints,
  bufferNeedsRefill,
  bufferRangeForWindow,
  interpolatedXRangeForCycleIndex,
  nextTimeCapacityPanMotion,
  timeCapacityBufferOnMove,
  timeCapacityBufferOnRendered,
  timeCapacityBufferOnResponseReady,
  timeCapacityBufferPlanForWindow,
  timeCapacityBufferSchedulerInitialState,
  TIME_CAPACITY_PANNING_DEFAULT,
  yDataOutsideRange,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityViewportBuffer.ts";
import {
  appendTimeCapacityCycleHistory,
  centerTimeCapacityCycleRange,
  cycleRangeWidth,
  cycleRangesEqual,
  cycleWindowOptions,
  navigateTimeCapacityCycleRange,
  normalizeCycleRangeForNavigation,
  normalizeManualTimeCapacityRange,
  normalizeTimeCapacityRange,
  resizeTimeCapacityCycleRange,
  selectedTimeCapacityCycleMax,
  selectTimeCapacityCycleHistory,
  shiftTimeCapacityCycleRange,
  timeCapacityCycleRangeAtPointerDelta,
  timeCapacityCycleRangeAtTrackPosition,
  timeCapacityCycleStartAtPointerDelta,
  timeCapacityCycleStartAtTrackPosition,
  timeCapacityCycleRangeAtBoundary,
  timeCapacityCycleSliderGeometry,
  timeCapacityPreviousViewDisabled,
  timeCapacityPreviewCancel,
  timeCapacityPreviewFlushMoving,
  timeCapacityPreviewMaxPoints,
  timeCapacityPreviewOnMove,
  timeCapacityPreviewOnMovingRequestComplete,
  timeCapacityPreviewPromoteOnIdle,
  timeCapacityPreviewRequestIsCurrent,
  timeCapacityPreviewSchedulerInitialState,
  timeCapacityCommittedNavigationOnRange,
  timeCapacityCommittedNavigationOnRequestSettled,
  timeCapacityCommittedNavigationRequestIsCurrent,
  timeCapacityCommittedNavigationSchedulerInitialState,
  timeCapacityRangeNavigationDisabled,
  timeCapacityVirginDefaultCanApply,
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

test("pointer movement follows the highlighted segment's legal travel and preserves width", () => {
  const firstWindow = { start: 1, end: 50 };
  const lastWindow = { start: 51, end: 100 };
  const middleWindow = timeCapacityCycleRangeAtPointerDelta(firstWindow, 25, 100, 100);

  assert.deepEqual(timeCapacityCycleRangeAtPointerDelta(firstWindow, 50, 100, 100), lastWindow);
  assert.deepEqual(timeCapacityCycleRangeAtPointerDelta(lastWindow, -50, 100, 100), firstWindow);
  assert.deepEqual(middleWindow, { start: 26, end: 75 });
  assert.equal(cycleRangeWidth(middleWindow), 50);
  assert.deepEqual(timeCapacityCycleRangeAtPointerDelta(firstWindow, 500, 100, 100), lastWindow);
  assert.deepEqual(timeCapacityCycleRangeAtPointerDelta(lastWindow, -500, 100, 100), firstWindow);
});

test("pointer and track positions retain sub-cycle motion for true panning", () => {
  const range = { start: 1, end: 50 };
  assert.equal(timeCapacityCycleStartAtPointerDelta(range, 12.5, 100, 100), 13.5);
  const clicked = timeCapacityCycleStartAtTrackPosition(
    { start: 40, end: 49 },
    333,
    1000,
    100,
  );
  assert.ok(clicked > 29 && clicked < 30, String(clicked));
});

test("track clicks center the existing window and clamp at both ends", () => {
  const range = { start: 40, end: 49 };
  assert.deepEqual(timeCapacityCycleRangeAtTrackPosition(range, 500, 1000, 100), {
    start: 46,
    end: 55,
  });
  assert.deepEqual(timeCapacityCycleRangeAtTrackPosition(range, 0, 1000, 100), {
    start: 1,
    end: 10,
  });
  assert.deepEqual(timeCapacityCycleRangeAtTrackPosition(range, 1000, 1000, 100), {
    start: 91,
    end: 100,
  });
});

test("narrow windows retain a graspable visual handle without changing their range", () => {
  const one = timeCapacityCycleSliderGeometry({ start: 100, end: 100 }, 324);
  const five = timeCapacityCycleSliderGeometry({ start: 100, end: 104 }, 324);
  const thirty = timeCapacityCycleSliderGeometry({ start: 100, end: 129 }, 324);
  assert.equal(one.visualWidthCycles, 24);
  assert.equal(five.visualWidthCycles, 24);
  assert.equal(thirty.visualWidthCycles, 30);
  assert.ok(one.widthPercent > 7 && one.widthPercent < 8);

  // A very short dataset still leaves travel instead of filling the track.
  assert.equal(timeCapacityCycleSliderGeometry({ start: 2, end: 2 }, 10).visualWidthCycles, 5);

  const travelPx = (1000 * (324 - one.visualWidthCycles)) / 324;
  assert.deepEqual(
    timeCapacityCycleRangeAtPointerDelta({ start: 1, end: 1 }, travelPx, 1000, 324, one.visualWidthCycles),
    { start: 324, end: 324 },
  );
});

test("virgin views use the last twenty available cycles without exceeding the extent", () => {
  assert.deepEqual(timeCapacityVirginCycleRange(200), { start: 181, end: 200 });
  assert.deepEqual(timeCapacityVirginCycleRange(20), { start: 1, end: 20 });
  assert.deepEqual(timeCapacityVirginCycleRange(12), { start: 1, end: 12 });
  assert.equal(timeCapacityVirginCycleRange(null), null);
});

test("virgin initialization is one-time and respects edits before the maximum resolves", () => {
  assert.equal(timeCapacityVirginDefaultCanApply(true, true, false, false, null), false);
  assert.equal(timeCapacityVirginDefaultCanApply(true, true, false, false, 200), true);
  assert.equal(timeCapacityVirginDefaultCanApply(true, false, false, false, 200), false);
  assert.equal(timeCapacityVirginDefaultCanApply(true, true, true, false, 200), false);
  assert.equal(timeCapacityVirginDefaultCanApply(true, true, false, true, 200), false);
});

test("reopening a live draft does not reclassify it as a virgin Time/Capacity view", () => {
  const source = readFileSync(
    new URL("../src/features/analyses/editor/AnalysisEditor.tsx", import.meta.url),
    "utf8",
  );
  const draftStart = source.indexOf("onOpenDraft={() => {");
  const draftEnd = source.indexOf("onSaveNew", draftStart);
  assert.ok(draftStart >= 0 && draftEnd > draftStart);
  const draftSource = source.slice(draftStart, draftEnd);
  assert.doesNotMatch(draftSource, /setTimeCapacityNavigationSession|setTimeCapacityVirginNavigation/);

  const newPlotStart = source.indexOf("const startNewPlotReset");
  const newPlotEnd = source.indexOf("const startNewPlot =", newPlotStart);
  assert.ok(newPlotStart >= 0 && newPlotEnd > newPlotStart);
  assert.match(
    source.slice(newPlotStart, newPlotEnd),
    /setTimeCapacityNavigationSession[\s\S]*setTimeCapacityVirginNavigation\(true\)/,
  );
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

test("delayed moving requests are backpressured and retain only the newest range", async () => {
  const first = { start: 1, end: 20 };
  const second = { start: 2, end: 21 };
  const third = { start: 3, end: 22 };
  const fourth = { start: 4, end: 23 };
  const fifth = { start: 5, end: 24 };
  const sixth = { start: 6, end: 25 };
  const initial = timeCapacityPreviewSchedulerInitialState();

  const leading = timeCapacityPreviewOnMove(initial, first, 0, 40);
  assert.deepEqual(leading.request, { range: first, resolution: "moving", generation: 1 });
  let state = leading.state;
  let activeRequest = leading.request!;
  let completedRanges: TimeCapacityCycleRange[] = [];

  for (const [range, at] of [[second, 10], [third, 20], [fourth, 30]] as const) {
    const moved = timeCapacityPreviewOnMove(state, range, at, 40);
    assert.equal(moved.request, null);
    state = moved.state;
    assert.equal(state.inFlight, true);
    assert.deepEqual(state.pendingRange, range);
  }

  const settle = async (at: number) => {
    await Promise.resolve();
    const completed = timeCapacityPreviewOnMovingRequestComplete(state, activeRequest, at, 40);
    completedRanges.push(activeRequest.range);
    state = completed.state;
    if (completed.request) activeRequest = completed.request;
    return completed;
  };

  // Simulate a 100 ms transport/server latency, well above the 40 ms target.
  const secondRequest = await settle(100);
  assert.deepEqual(secondRequest.request?.range, fourth);
  assert.equal(state.inFlight, true);

  for (const [range, at] of [[fifth, 110], [sixth, 120]] as const) {
    const moved = timeCapacityPreviewOnMove(state, range, at, 40);
    assert.equal(moved.request, null);
    state = moved.state;
    assert.deepEqual(state.pendingRange, range);
  }

  const thirdRequest = await settle(200);
  assert.deepEqual(thirdRequest.request?.range, sixth);
  assert.equal(state.inFlight, true);
  const finalCompletion = await settle(300);
  assert.equal(finalCompletion.request, null);
  assert.equal(state.inFlight, false);
  assert.deepEqual(completedRanges, [first, fourth, sixth]);

  const flushed = timeCapacityPreviewFlushMoving(state, 340, 40);
  assert.equal(flushed.request, null);
  assert.equal(state.pendingRange, null);
  const canonical = { max_points_per_cell: 4000 };
  assert.equal(timeCapacityPreviewMaxPoints(canonical.max_points_per_cell, "moving"), 3000);
  assert.equal(timeCapacityPreviewMaxPoints(800, "moving"), 800);
  assert.equal(timeCapacityPreviewMaxPoints(4000, "full"), 4000);
  assert.deepEqual(canonical, { max_points_per_cell: 4000 });
});

test("committed navigation keeps one request active and promotes only the latest pending range", () => {
  const first = { start: 1, end: 20 };
  const second = { start: 2, end: 21 };
  const third = { start: 3, end: 22 };

  const leading = timeCapacityCommittedNavigationOnRange(
    timeCapacityCommittedNavigationSchedulerInitialState(),
    first,
    "context-a",
  );
  assert.deepEqual(leading.request, {
    range: first,
    generation: 1,
    contextSignature: "context-a",
  });

  let state = leading.state;
  const firstRequest = leading.request!;
  const queued = timeCapacityCommittedNavigationOnRange(state, second, "context-a");
  state = queued.state;
  assert.equal(queued.request, null);
  assert.equal(state.inFlight, true);
  assert.deepEqual(state.pendingRange, second);

  const replaced = timeCapacityCommittedNavigationOnRange(state, third, "context-a");
  state = replaced.state;
  assert.equal(replaced.request, null);
  assert.deepEqual(state.pendingRange, third);
  assert.equal(timeCapacityCommittedNavigationRequestIsCurrent(state, firstRequest), true);

  const promoted = timeCapacityCommittedNavigationOnRequestSettled(state, firstRequest);
  assert.deepEqual(promoted.request?.range, third);
  assert.equal(promoted.request?.generation, 4);
  assert.equal(promoted.state.inFlight, true);
  assert.equal(
    timeCapacityCommittedNavigationRequestIsCurrent(promoted.state, promoted.request!),
    true,
  );
  assert.equal(
    timeCapacityCommittedNavigationOnRequestSettled(promoted.state, firstRequest).request,
    null,
  );

  const complete = timeCapacityCommittedNavigationOnRequestSettled(
    promoted.state,
    promoted.request!,
  );
  assert.equal(complete.request, null);
  assert.equal(complete.state.active, false);
  assert.equal(complete.state.inFlight, false);
  assert.equal(complete.state.publishedRequest, null);
});

test("committed navigation admits a new request when the plot context changes", () => {
  const first = { start: 1, end: 20 };
  const second = { start: 2, end: 21 };
  const leading = timeCapacityCommittedNavigationOnRange(
    timeCapacityCommittedNavigationSchedulerInitialState(),
    first,
    "context-a",
  );
  const changed = timeCapacityCommittedNavigationOnRange(
    leading.state,
    second,
    "context-b",
  );

  assert.deepEqual(changed.request?.range, second);
  assert.equal(changed.state.contextSignature, "context-b");
  assert.equal(timeCapacityCommittedNavigationRequestIsCurrent(changed.state, leading.request!), false);
  assert.equal(
    timeCapacityCommittedNavigationRequestIsCurrent(changed.state, changed.request!),
    true,
  );
});

test("idle promotion sharpens the same range and renewed movement obsoletes it immediately", () => {
  const first = { start: 10, end: 29 };
  const second = { start: 11, end: 30 };
  const third = { start: 12, end: 31 };
  const moving = timeCapacityPreviewOnMove(
    timeCapacityPreviewSchedulerInitialState(),
    first,
    0,
    40,
  );
  const pending = timeCapacityPreviewOnMove(moving.state, second, 10, 40);
  const idle = timeCapacityPreviewPromoteOnIdle(pending.state, pending.state.generation, 60, 50);
  assert.deepEqual(idle.request, {
    range: second,
    resolution: "full",
    generation: pending.state.generation,
  });
  assert.equal(timeCapacityPreviewRequestIsCurrent(idle.state, idle.request!), true);
  assert.equal(timeCapacityPreviewRequestIsCurrent(idle.state, moving.request!), false);
  assert.equal(
    timeCapacityPreviewOnMovingRequestComplete(idle.state, moving.request!, 70, 40).request,
    null,
  );

  const resumed = timeCapacityPreviewOnMove(idle.state, third, 61, 40);
  assert.deepEqual(resumed.request, {
    range: third,
    resolution: "moving",
    generation: idle.state.generation + 1,
  });
  assert.equal(timeCapacityPreviewRequestIsCurrent(resumed.state, idle.request!), false);
  assert.equal(timeCapacityPreviewRequestIsCurrent(resumed.state, resumed.request!), true);
  assert.equal(timeCapacityPreviewRequestIsCurrent(
    timeCapacityPreviewCancel(resumed.state),
    resumed.request!,
  ), false);
});

test("null-bound Ctrl+first is a no-op while normal backward movement stays safe", () => {
  const range = { start: 10, end: 20 };
  assert.deepEqual(navigateTimeCapacityCycleRange(range, -1, "cycle", null), {
    start: 9,
    end: 19,
  });
  assert.equal(navigateTimeCapacityCycleRange(range, -1, "cycle", null, "first"), null);
  assert.deepEqual(navigateTimeCapacityCycleRange(range, -1, "cycle", 100, "first"), {
    start: 1,
    end: 11,
  });
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

// Spec 052.3 Stage 5 evidence gate.
//
// Stage 5 proposed cooperative server-side abandonment of superseded requests.
// Its premise was a growing queue of uncancellable computations during a drag.
// This test simulates a realistic drag against the real scheduler policy and
// counts how many admitted requests are actually superseded, so the decision to
// implement (or not) rests on a measured number rather than an assumption.
test("a realistic drag supersedes at most one admitted request", () => {
  const backendLatencyMs = 84; // measured Spec 052.3 post-change moving preview
  const pointerIntervalMs = 8; // ~120 Hz pointer stream
  const dragDurationMs = 3000;

  let state = timeCapacityPreviewSchedulerInitialState();
  let admitted = 0;
  let completed = 0;
  let superseded = 0;
  let inFlightSettlesAt: number | null = null;
  let inFlightRequest: ReturnType<typeof timeCapacityPreviewOnMove>["request"] = null;

  const admit = (request: typeof inFlightRequest, now: number) => {
    if (!request) return;
    if (inFlightRequest !== null) superseded += 1;
    admitted += 1;
    inFlightRequest = request;
    inFlightSettlesAt = now + backendLatencyMs;
  };

  for (let now = 0; now <= dragDurationMs + 400; now += pointerIntervalMs) {
    if (inFlightSettlesAt !== null && now >= inFlightSettlesAt) {
      const settled = inFlightRequest!;
      inFlightRequest = null;
      inFlightSettlesAt = null;
      completed += 1;
      if (settled.resolution === "moving") {
        const done = timeCapacityPreviewOnMovingRequestComplete(state, settled, now, 40);
        state = done.state;
        admit(done.request, now);
      }
    }

    if (now <= dragDurationMs) {
      const start = 1 + Math.floor(now / 20);
      const moved = timeCapacityPreviewOnMove(state, { start, end: start + 9 }, now, 40);
      state = moved.state;
      admit(moved.request, now);
      continue;
    }

    const idle = timeCapacityPreviewPromoteOnIdle(state, state.generation, now, 50);
    state = idle.state;
    admit(idle.request, now);
  }

  // Backpressure holds the drag to roughly one request per round trip rather
  // than one per pointer event, and only the idle promotion at the end of the
  // drag can overtake a still-open moving request.
  assert.ok(admitted > 1, `expected the drag to issue requests, got ${admitted}`);
  assert.ok(
    admitted <= Math.ceil(dragDurationMs / backendLatencyMs) + 2,
    `backpressure failed: ${admitted} requests for a ${dragDurationMs} ms drag`,
  );
  assert.ok(
    superseded <= 1,
    `expected at most one superseded request per drag, got ${superseded}`,
  );
  assert.ok(completed >= 1);
});

// ---- Spec 052.7: buffered viewport panning ---------------------------------

test("buffered panning stays disabled after shared-axis phase divergence", () => {
  assert.equal(TIME_CAPACITY_PANNING_DEFAULT, false);
});

test("a buffer spans a useful slice of the range, not just a multiple of a narrow window", () => {
  // Three cycles out of 324: a pure window multiple would give ~15 cycles of
  // context, which a moving pointer leaves immediately. The extent floor is
  // what makes panning survive an actual drag.
  const buffer = bufferRangeForWindow({ start: 100, end: 102 }, 324);
  assert.ok(buffer.end - buffer.start + 1 >= 60, `buffer too narrow: ${JSON.stringify(buffer)}`);
  assert.ok(buffer.start <= 100 && buffer.end >= 102);

  // Clamped at the extents rather than running past the data.
  const atStart = bufferRangeForWindow({ start: 1, end: 3 }, 324);
  assert.equal(atStart.start, 1);
  const atEnd = bufferRangeForWindow({ start: 322, end: 324 }, 324);
  assert.equal(atEnd.end, 324);
});

test("refill triggers before the viewport reaches the buffer edge, but not at the data extents", () => {
  const buffer = { start: 50, end: 150 };
  assert.equal(bufferNeedsRefill(null, { start: 100, end: 102 }, 324), true);
  // Comfortably inside: no refill.
  assert.equal(bufferNeedsRefill(buffer, { start: 100, end: 102 }, 324), false);
  // Outside the buffer entirely: refill.
  assert.equal(bufferNeedsRefill(buffer, { start: 200, end: 202 }, 324), true);
  // Near the upper edge: refill before the data runs out.
  assert.equal(bufferNeedsRefill(buffer, { start: 149, end: 150 }, 324), true);
  // A buffer already clamped to the extent is not "near an edge" there --
  // otherwise it would refetch the same range forever.
  assert.equal(bufferNeedsRefill({ start: 1, end: 100 }, { start: 1, end: 3 }, 324), false);
  assert.equal(bufferNeedsRefill({ start: 200, end: 324 }, { start: 322, end: 324 }, 324), false);
});

test("resident buffers prefetch after half of their original spare context is consumed", () => {
  const buffer = { start: 67, end: 135 };
  const anchor = { start: 100, end: 102 };
  // The old viewport-width margin would wait until cycle 133. The scheduler
  // has enough context to start the replacement while the resident data still
  // covers another fifteen cycles.
  assert.equal(bufferNeedsRefill(buffer, { start: 110, end: 112 }, 324, 0.5, anchor), false);
  assert.equal(bufferNeedsRefill(buffer, { start: 118, end: 120 }, 324, 0.5, anchor), true);
});

test("buffer point budget scales so the visible window keeps its density", () => {
  const window = { start: 100, end: 102 };
  const buffer = { start: 70, end: 132 };
  const scaled = bufferMaxPoints(1000, window, buffer);
  // 63 cycles of buffer against 3 visible: ~21x the points.
  assert.ok(scaled >= 20000, `expected ~21x scaling, got ${scaled}`);
  // A buffer equal to the window asks for no more than the window would.
  assert.equal(bufferMaxPoints(1000, window, window), 1000);
});

test("fast motion looks farther ahead while reducing transient point density", () => {
  const window = { start: 100, end: 102 };
  let motion = nextTimeCapacityPanMotion(null, window, 0, 324);
  motion = nextTimeCapacityPanMotion(motion, { start: 180, end: 182 }, 100, 324);
  assert.equal(motion.tier, "fast");
  assert.equal(motion.direction, 1);
  const fast = timeCapacityBufferPlanForWindow({ start: 180, end: 182 }, 324, 1000, motion);
  const slow = timeCapacityBufferPlanForWindow(window, 324, 1000, null);
  assert.ok(fast.buffer.end - 182 > 180 - fast.buffer.start, JSON.stringify(fast));
  assert.ok(fast.maxPoints <= 18000);
  assert.ok(fast.maxPoints >= 17000);
  assert.ok(fast.maxPoints < slow.maxPoints);
});

test("buffer scheduler keeps one request in flight and admits only the newest after render", () => {
  const maxCycle = 324;
  const slow = timeCapacityBufferPlanForWindow({ start: 10, end: 12 }, maxCycle, 1000, null);
  const first = timeCapacityBufferOnMove(
    timeCapacityBufferSchedulerInitialState(),
    slow,
    maxCycle,
  );
  assert.ok(first.request);
  assert.equal(first.state.phase, "fetching");

  const motion = nextTimeCapacityPanMotion(
    nextTimeCapacityPanMotion(null, { start: 10, end: 12 }, 0, maxCycle),
    { start: 220, end: 222 },
    100,
    maxCycle,
  );
  const middlePlan = timeCapacityBufferPlanForWindow(
    { start: 140, end: 142 },
    maxCycle,
    1000,
    motion,
  );
  const latestPlan = timeCapacityBufferPlanForWindow(
    { start: 220, end: 222 },
    maxCycle,
    1000,
    motion,
  );
  const middle = timeCapacityBufferOnMove(first.state, middlePlan, maxCycle);
  const latest = timeCapacityBufferOnMove(middle.state, latestPlan, maxCycle);
  assert.equal(middle.request, null);
  assert.equal(latest.request, null);
  assert.deepEqual(latest.state.pending?.window, latestPlan.window);

  const responseReady = timeCapacityBufferOnResponseReady(latest.state, first.request!);
  assert.equal(responseReady.phase, "rendering");
  // HTTP completion alone does not admit the next refill.
  assert.equal(responseReady.published?.id, first.request!.id);
  const rendered = timeCapacityBufferOnRendered(responseReady, first.request!, maxCycle);
  assert.ok(rendered.request);
  assert.deepEqual(rendered.request?.window, latestPlan.window);
});

test("the visible x span is read from loaded traces and tolerates short cells", () => {
  const traces = [
    { cycle: [1, 1, 2, 2, 3, 3], display_x: [0, 10, 20, 30, 40, 50] },
    // A shorter cell that never reaches cycle 3.
    { cycle: [1, 1, 2, 2], display_x: [0, 12, 22, 33] },
  ];
  assert.deepEqual(absoluteXRangeForCycles(traces, 2, 2), [20, 33]);
  assert.deepEqual(absoluteXRangeForCycles(traces, 1, 3), [0, 50]);
  // Cycles present in no trace leave the axis alone rather than pinning it.
  assert.equal(absoluteXRangeForCycles(traces, 90, 95), null);
  assert.equal(absoluteXRangeForCycles(undefined, 1, 3), null);
  // Nulls and non-finite values are skipped, not plotted as zero.
  assert.deepEqual(
    absoluteXRangeForCycles([{ cycle: [5, 5, 5], display_x: [null, 7, 9] }], 5, 5),
    [7, 9],
  );

  const index = buildTimeCapacityCycleXIndex(traces);
  assert.deepEqual(absoluteXRangeForCycleIndex(index, 2, 2), [20, 33]);
  assert.deepEqual(absoluteXRangeForCycleIndex(index, 1, 3), [0, 50]);
  assert.equal(absoluteXRangeForCycleIndex(index, 90, 95), null);
  // Never compress the viewport to a partial overlap while a refill catches up.
  assert.equal(absoluteXRangeForCycleIndex(index, 2, 4), null);
});

test("fractional slider positions interpolate one resident x axis continuously", () => {
  const index = buildTimeCapacityCycleXIndex([
    {
      cycle: [1, 1, 2, 2, 3, 3, 4, 4],
      display_x: [0, 10, 20, 30, 40, 50, 60, 70],
    },
  ]);
  assert.deepEqual(interpolatedXRangeForCycleIndex(index, 1, 2), [0, 30]);
  assert.deepEqual(interpolatedXRangeForCycleIndex(index, 1.5, 2), [10, 40]);
  assert.deepEqual(interpolatedXRangeForCycleIndex(index, 2, 2), [20, 50]);
});

// ---- Spec 052.8: frozen Y and the out-of-view affordance -------------------

test("out-of-view detection only considers what is inside the visible x window", () => {
  const traces = [
    { x: [0, 10, 20, 30], y: [3.0, 3.5, 9.9, 3.4] },
  ];
  // The 9.9 spike sits at x=20, outside the window: nothing to report.
  assert.equal(yDataOutsideRange(traces, [0, 15], [2.8, 3.7]), false);
  // Bring it into view and it must be reported.
  assert.equal(yDataOutsideRange(traces, [0, 25], [2.8, 3.7]), true);
});

test("out-of-view detection ignores the secondary axis and missing inputs", () => {
  // The current overlay has its own scale; refitting y would not address it.
  const secondary = [{ x: [0, 10], y: [500, 900], yaxis: "y2" }];
  assert.equal(yDataOutsideRange(secondary, [0, 10], [2.8, 3.7]), false);

  const primary = [{ x: [0, 10], y: [500, 900], yaxis: "y" }];
  assert.equal(yDataOutsideRange(primary, [0, 10], [2.8, 3.7]), true);

  assert.equal(yDataOutsideRange(undefined, [0, 10], [2.8, 3.7]), false);
  assert.equal(yDataOutsideRange(primary, null, [2.8, 3.7]), false);
  assert.equal(yDataOutsideRange(primary, [0, 10], null), false);
  // Non-finite points are skipped rather than counted as out of range.
  assert.equal(
    yDataOutsideRange([{ x: [0, 1], y: [Number.NaN, 3.2] }], [0, 1], [2.8, 3.7]),
    false,
  );
});
