import test from "node:test";
import assert from "node:assert/strict";
import { groupedDisplayRates } from "../src/features/analyses/editor/families/rate-capability/rateDisplayCategories.ts";

test("nearby measured rates share the nominal category without merging distinct rates", () => {
  const values = [1, .999, .99, .98, 2, .1, .099, .098, NaN];
  const rates = groupedDisplayRates(values);
  assert.equal(rates.get(.999), 1);
  assert.equal(rates.get(.99), 1);
  assert.equal(rates.get(.98), .98);
  assert.equal(rates.get(.099), .1);
  assert.equal(rates.get(.098), .098);
  assert.equal(rates.get(2), 2);
  assert.deepEqual(groupedDisplayRates([...values].reverse()), rates);
});

test("a chain of neighbouring rates cannot bridge more than the tolerance", () => {
  const rates = groupedDisplayRates([1.016, 1.008, 1]);
  assert.equal(rates.get(1.008), 1);
  assert.equal(rates.get(1.016), 1.016);
});
