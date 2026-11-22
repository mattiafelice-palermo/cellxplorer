import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeLazyImportAction,
  lazyImportLauncherInitialState,
  triggerLazyImportAction,
} from "../src/lazyImportLauncherPolicy.ts";

test("lazy import launcher records initial click until committed consumer clears it", () => {
  const initial = lazyImportLauncherInitialState();
  assert.deepEqual(initial, { mounted: false, pendingAction: null });

  const triggered = triggerLazyImportAction(initial, "open");
  assert.deepEqual(triggered, { mounted: true, pendingAction: "open" });

  // Re-triggering while suspended overwrites with the latest intent cleanly.
  const replaced = triggerLazyImportAction(triggered, "indexed");
  assert.deepEqual(replaced, { mounted: true, pendingAction: "indexed" });

  const consumed = consumeLazyImportAction(replaced);
  assert.deepEqual(consumed, { mounted: true, pendingAction: null });

  // Consuming again is a referential no-op.
  assert.equal(consumeLazyImportAction(consumed), consumed);
});
