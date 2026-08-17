import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlotlyFactory } from "../src/components/plotFactory.ts";

test("Plotly factory interop accepts a direct function", () => {
  const factory = () => "direct";
  assert.equal(resolvePlotlyFactory(factory), factory);
});

test("Plotly factory interop unwraps a CommonJS default namespace", () => {
  const factory = () => "default";
  assert.equal(resolvePlotlyFactory({ default: factory }), factory);
});
