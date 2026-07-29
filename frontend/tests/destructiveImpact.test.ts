import assert from "node:assert/strict";
import test from "node:test";

import { destructiveImpactModalVisible } from "../src/destructiveImpact.ts";

test("destructive confirmation stays hidden only while its preflight is fetching", () => {
  assert.equal(destructiveImpactModalVisible(false, false), false);
  assert.equal(destructiveImpactModalVisible(true, true), false);
  assert.equal(destructiveImpactModalVisible(true, false), true);
});
