import assert from "node:assert/strict";
import test from "node:test";

import type { ImportPreview } from "../src/api.ts";
import {
  folderTrackingEligibility,
  compareFolderTrackingCandidates,
  folderTrackingPatternMatches,
  folderTrackingSummary,
  validateFolderTrackingPattern,
} from "../src/folderTrackingPolicy.ts";

function source(
  path: string,
  filename: string,
  ext = "ndax",
  sourceFormat: string | null = null,
): ImportPreview {
  return {
    staged_name: filename,
    source_path: path,
    filename,
    ext,
    source_format: sourceFormat,
  } as ImportPreview;
}

test("folderTrackingEligibility offers a default watch for one source", () => {
  const eligibility = folderTrackingEligibility([source("C:/data/part-01.ndax", "part-01.ndax")]);
  assert.equal(eligibility.eligible, true);
  assert.deepEqual(eligibility.defaultWatch, {
    enabled: true,
    folder_path: "C:\\data",
    pattern_kind: "glob",
    pattern: "*.ndax",
    extension: "ndax",
    source_format: null,
    ordering_rule: "timestamp_filename_hash",
    recursive: false,
    recursion_depth: 0,
    cadence_value: null,
    cadence_unit: null,
  });
});

test("folderTrackingEligibility accepts same-folder sources with one format", () => {
  const eligibility = folderTrackingEligibility([
    source("C:/data/part-01.ndax", "part-01.ndax", "ndax", "neware-ndax"),
    source("C:/data/part-02.ndax", "part-02.ndax", "ndax", "neware-ndax"),
  ]);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.sourceFormat, "neware-ndax");
});

test("folderTrackingEligibility rejects mixed folders and parser formats", () => {
  assert.match(
    folderTrackingEligibility([
      source("C:/data/part-01.ndax", "part-01.ndax"),
      source("C:/other/part-02.ndax", "part-02.ndax"),
    ]).reason ?? "",
    /one parent folder/,
  );
  assert.match(
    folderTrackingEligibility([
      source("C:/data/part-01.ndax", "part-01.ndax", "ndax", "format-a"),
      source("C:/data/part-02.ndax", "part-02.ndax", "ndax", "format-b"),
    ]).reason ?? "",
    /one parser format/,
  );
});

test("folder tracking validates glob and regex patterns", () => {
  assert.equal(validateFolderTrackingPattern("glob", "*.ndax"), null);
  assert.equal(validateFolderTrackingPattern("regex", "^part-\\d+\\.ndax$"), null);
  assert.match(validateFolderTrackingPattern("regex", "[") ?? "", /Invalid regular expression/);
  assert.equal(folderTrackingPatternMatches("part-01.ndax", "glob", "*.ndax"), true);
  assert.equal(folderTrackingPatternMatches("part-01.ndax", "regex", "^part-\\d+\\.ndax$"), true);
  assert.equal(folderTrackingPatternMatches("part-01.mpr", "glob", "*.ndax"), false);
});

test("folderTrackingSummary states the selected folder policy", () => {
  assert.equal(
    folderTrackingSummary({
      folder_path: "C:\\data",
      pattern: "*.ndax",
      recursive: false,
      ordering_rule: "timestamp_filename_hash",
    }),
    "C:\\data · *.ndax · files directly in this folder · source start time, then filename",
  );
});

test("folder tracking candidate ordering matches timestamp then natural filename then hash", () => {
  const candidates = [
    { filename: "part-10.ndax", start_time: "2026-08-20T10:00:00", hash: "b" },
    { filename: "part-2.ndax", start_time: "2026-08-20T10:00:00", hash: "c" },
    { filename: "part-1.ndax", start_time: "2026-08-20T09:00:00", hash: "a" },
  ];
  assert.deepEqual(
    [...candidates].sort((left, right) => compareFolderTrackingCandidates(left, right)).map((item) => item.filename),
    ["part-1.ndax", "part-2.ndax", "part-10.ndax"],
  );
  assert.equal(
    compareFolderTrackingCandidates(
      { filename: "same.ndax", start_time: null, hash: "a" },
      { filename: "same.ndax", start_time: null, hash: "b" },
    ) < 0,
    true,
  );
});
