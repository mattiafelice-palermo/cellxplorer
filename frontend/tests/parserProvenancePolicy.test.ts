import assert from "node:assert/strict";
import test from "node:test";

import { parserSourceBreakdown } from "../src/features/analyses/editor/policies/parserProvenancePolicy.ts";
import type { Provenance } from "../src/api.ts";

test("no provenance yields no breakdown entries", () => {
  assert.deepEqual(parserSourceBreakdown(undefined), []);
});

test("a single-identity provenance still reports its one source", () => {
  const sources: Provenance["sources"] = [
    {
      cell_id: 1,
      file_hashes: ["a".repeat(64)],
      source_descriptors: [
        {
          source_position: 1,
          filename: "cycles_time_steps.ndax",
          source_hash: "a".repeat(64),
          tracked_tail: true,
          local_cycle_start: 1,
          local_cycle_end: 10,
          local_cycle_count: 10,
          global_cycle_start: 1,
          global_cycle_end: 10,
        },
      ],
      files: [{ hash: "a".repeat(64), position: 1, parser_version: "nb:v2026.06.11:r1" }],
    },
  ];

  assert.deepEqual(parserSourceBreakdown(sources), [
    { position: 1, filename: "cycles_time_steps.ndax", parserVersion: "nb:v2026.06.11:r1" },
  ]);
});

test("a mixed-format Cell reports each source's own filename and identity", () => {
  const sources: Provenance["sources"] = [
    {
      cell_id: 7,
      file_hashes: ["a".repeat(64), "b".repeat(64)],
      source_descriptors: [
        {
          source_position: 1,
          filename: "binary_segment.ndax",
          source_hash: "a".repeat(64),
          tracked_tail: false,
          local_cycle_start: 1,
          local_cycle_end: 5,
          local_cycle_count: 5,
          global_cycle_start: 1,
          global_cycle_end: 5,
        },
        {
          source_position: 2,
          filename: "excel_continuation.xlsx",
          source_hash: "b".repeat(64),
          tracked_tail: true,
          local_cycle_start: 1,
          local_cycle_end: 2,
          local_cycle_count: 2,
          global_cycle_start: 6,
          global_cycle_end: 7,
        },
      ],
      files: [
        { hash: "a".repeat(64), position: 1, parser_version: "nb:v2026.06.11:r1" },
        { hash: "b".repeat(64), position: 2, parser_version: "nx:6:r1" },
      ],
    },
  ];

  assert.deepEqual(parserSourceBreakdown(sources), [
    { position: 1, filename: "binary_segment.ndax", parserVersion: "nb:v2026.06.11:r1" },
    { position: 2, filename: "excel_continuation.xlsx", parserVersion: "nx:6:r1" },
  ]);
});

test("a source with no matching descriptor falls back to a null filename rather than throwing", () => {
  const sources: Provenance["sources"] = [
    {
      cell_id: 3,
      file_hashes: ["c".repeat(64)],
      files: [{ hash: "c".repeat(64), position: 1, parser_version: "nb:v2026.06.11:r1" }],
    },
  ];

  assert.deepEqual(parserSourceBreakdown(sources), [
    { position: 1, filename: null, parserVersion: "nb:v2026.06.11:r1" },
  ]);
});

test("a source entry with no files array is skipped without error", () => {
  const sources: Provenance["sources"] = [{ cell_id: 9, file_hashes: [] }];

  assert.deepEqual(parserSourceBreakdown(sources), []);
});
