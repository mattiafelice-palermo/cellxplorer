import assert from "node:assert/strict";
import test from "node:test";

import { shiftPreviewCycleWindow } from "../src/analysisCellPreviewPolicy.ts";

test("cycle preview windows move by their span and clamp at either end", () => {
  assert.deepEqual(shiftPreviewCycleWindow({ start: 5, end: 10 }, 100, -1), { start: 1, end: 5 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 10, end: 15 }, 100, -1), { start: 5, end: 10 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 5, end: 10 }, 100, 1), { start: 10, end: 15 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 85, end: 95 }, 100, 1), { start: 95, end: 100 });
  assert.deepEqual(shiftPreviewCycleWindow({ start: 1, end: 1 }, 0, 1), { start: 0, end: 0 });
});
