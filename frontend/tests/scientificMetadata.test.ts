import assert from "node:assert/strict";
import test from "node:test";

import { nominalCapacityFromMass } from "../src/scientificMetadata.ts";

test("nominal capacity converts active mass and specific capacity to mAh", () => {
  assert.equal(nominalCapacityFromMass(25, 170), 4.25);
});

test("nominal capacity is unavailable without positive scientific inputs", () => {
  assert.equal(nominalCapacityFromMass(null, 170), null);
  assert.equal(nominalCapacityFromMass(25, 0), null);
});
