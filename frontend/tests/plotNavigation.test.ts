import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  panPlotRange,
  plotWheelMode,
  zoomPlotRange,
} from "../src/features/analyses/editor/plotting/plotNavigationPolicy.ts";

const wheel = (
  overrides: Partial<{
    ctrlKey: boolean;
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    timeStamp: number;
  }> = {},
) => ({
  ctrlKey: false,
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  timeStamp: 1_000,
  ...overrides,
});

test("wheel and touchpad gestures resolve to stable navigation modes", () => {
  assert.equal(plotWheelMode(wheel({ deltaY: 100 })), "zoom");
  assert.equal(plotWheelMode(wheel({ deltaY: 8 })), "pan");
  assert.equal(plotWheelMode(wheel({ deltaX: 3, deltaY: 80 })), "pan");
  assert.equal(plotWheelMode(wheel({ ctrlKey: true, deltaY: 8 })), "zoom");
  assert.equal(plotWheelMode(wheel({ deltaMode: 1, deltaY: 3 })), "zoom");

  const panBurst = { mode: "pan" as const, at: 950 };
  assert.equal(plotWheelMode(wheel({ deltaY: 100 }), panBurst), "pan");
  assert.equal(
    plotWheelMode(wheel({ deltaY: 100, timeStamp: 1_200 }), panBurst),
    "zoom",
  );
});

test("plot range transforms preserve anchors, span direction, and invalid-input safety", () => {
  assert.deepEqual(panPlotRange([0, 10], 25, 100), [2.5, 12.5]);
  assert.deepEqual(panPlotRange([10, 0], 25, 100), [7.5, -2.5]);
  assert.deepEqual(panPlotRange([0, 10], 25, 0), [0, 10]);

  assert.deepEqual(zoomPlotRange([0, 10], 0.5, 0.5), [2.5, 7.5]);
  assert.deepEqual(zoomPlotRange([0, 10], 0, 2), [0, 20]);
  assert.deepEqual(zoomPlotRange([10, 0], 0.5, 0.5), [7.5, 2.5]);
  assert.deepEqual(zoomPlotRange([0, 10], 0.5, -1), [0, 10]);
});

test("the shared Plot wrapper owns navigation and viewport-aware families are armed", () => {
  const sharedPlot = readFileSync(new URL("../src/components/Plot.tsx", import.meta.url), "utf8");
  const cycles = readFileSync(
    new URL("../src/features/analyses/editor/families/cycles/CyclePlotCard.tsx", import.meta.url),
    "utf8",
  );
  const timeCapacity = readFileSync(
    new URL("../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sharedPlot, /installPlotNavigation\(graphDiv as HTMLElement, onViewportIntent\)/);
  assert.match(sharedPlot, /disposePlotNavigation\(graphDiv as HTMLElement\)/);
  assert.match(cycles, /onViewportIntent=\{zoom\.armOnPointerDown\}/);
  assert.match(timeCapacity, /onViewportIntent=\{zoom\.armOnPointerDown\}/);
});
