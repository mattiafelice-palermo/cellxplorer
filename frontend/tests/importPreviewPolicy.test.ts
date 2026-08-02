import assert from "node:assert/strict";
import test from "node:test";

import type { ImportPreviewResult } from "../src/api.ts";
import {
  importPreviewQueryKey,
  importPreviewRequest,
  importPreviewStateFromResult,
  importPreviewStateMessage,
  importDraftWindow,
  shouldRequestImportPreview,
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

test("preview generation requires an explicit selection and only starts from idle", () => {
  const idle = { ...draft, preview_state: { status: "idle" as const } };
  assert.equal(shouldRequestImportPreview(idle, false), false);
  assert.equal(shouldRequestImportPreview(idle, true), true);
  assert.equal(
    shouldRequestImportPreview({ ...idle, preview_state: { status: "loading" } }, true),
    false,
  );
  assert.equal(
    shouldRequestImportPreview({ ...idle, preview_state: { status: "ready", preview: result() } }, true),
    false,
  );
});

test("large import draft windows stay bounded", () => {
  const window = importDraftWindow(1000, 148 * 400);
  assert.ok(window.start >= 394);
  assert.ok(window.end <= 414);
  assert.ok(window.end - window.start <= 20);
});
