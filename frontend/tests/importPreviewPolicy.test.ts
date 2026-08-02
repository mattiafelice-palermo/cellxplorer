import assert from "node:assert/strict";
import test from "node:test";

import type { ImportPreviewResult } from "../src/api.ts";
import {
  importPreviewQueryKey,
  importPreviewRequest,
  importPreviewStateFromResult,
  importPreviewStateMessage,
} from "../src/importPreviewPolicy.ts";

function result(patch: Partial<ImportPreviewResult> = {}): ImportPreviewResult {
  return {
    capacity_preview: null,
    preview_error: null,
    ...patch,
  };
}

const draft = {
  staged_name: "source.ndax",
  source_path: "C:/data/source.ndax",
  hash: "ABCDEF",
  size: 99,
  inspection: { hash: "ABCDEF", size: 123, mtime_ns: 456 },
};

test("preview requests carry the inspected content fingerprint", () => {
  assert.deepEqual(importPreviewRequest(draft), {
    staged_name: "source.ndax",
    source_path: "C:/data/source.ndax",
    expected_hash: "ABCDEF",
    expected_size: 123,
    expected_mtime_ns: 456,
  });
});

test("preview cache identity is content-based, not path-based", () => {
  assert.deepEqual(importPreviewQueryKey("ABCDEF"), ["import-capacity-preview", "abcdef"]);
  assert.deepEqual(importPreviewQueryKey("abcdef"), importPreviewQueryKey("ABCDEF"));
  assert.notDeepEqual(importPreviewQueryKey("different-content"), importPreviewQueryKey("ABCDEF"));
});

test("preview results distinguish ready and retryable error states", () => {
  const ready = importPreviewStateFromResult(result({ verified_hash: "abcdef" }));
  assert.deepEqual(ready, { status: "ready", preview: result({ verified_hash: "abcdef" }) });
  assert.equal(importPreviewStateMessage(ready), null);

  const failed = importPreviewStateFromResult(result({ preview_error: "Source changed" }));
  assert.deepEqual(failed, { status: "error", message: "Source changed" });
  assert.equal(importPreviewStateMessage(failed), "Source changed");
});
