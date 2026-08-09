import assert from "node:assert/strict";
import test from "node:test";

import { buildDelimitedText } from "../src/features/analyses/editor/plotting/plotCsv.ts";

test("CSV text starts with a UTF-8 BOM, not visible mojibake", () => {
  const text = buildDelimitedText(
    [{ header: "Voltage (V)", values: [3.1415926] }],
    "standard",
    "point",
    "comma",
  );

  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(
    [...new TextEncoder().encode(text).slice(0, 3)],
    [0xef, 0xbb, 0xbf],
  );
  assert.equal(text.startsWith("ï»¿"), false);
  assert.equal(text.slice(1), "Voltage (V)\r\n3.14159");
});
