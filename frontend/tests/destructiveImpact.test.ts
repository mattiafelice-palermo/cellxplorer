import assert from "node:assert/strict";
import test from "node:test";

import { deferredDestructiveConfirm } from "../src/destructiveImpact.ts";

test("deferred confirmation keeps the callback captured before parent state clears", () => {
  const calls: string[] = [];
  let current = () => calls.push("original");
  const confirm = deferredDestructiveConfirm(current, {
    deleteEmptyAnalyses: false,
    emptyAfterCandidateIds: [],
  });

  current = () => calls.push("replacement");
  confirm();

  assert.deepEqual(calls, ["original"]);
});
