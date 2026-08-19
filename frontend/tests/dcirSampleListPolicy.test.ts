import assert from "node:assert/strict";
import test from "node:test";

import {
  dcirSampleEntryKey,
  dcirSampleKeysInRange,
  filterAndSortDcirSampleItems,
  type DcirSampleListItem,
} from "../src/features/analyses/editor/families/dcir/dcirSampleListPolicy.ts";

function item(
  name: string,
  visible: boolean,
  ref_id: number,
): DcirSampleListItem {
  const entry = { kind: "cell" as const, ref_id };
  return {
    key: dcirSampleEntryKey(entry),
    label: name,
    visible,
    entry,
  };
}

const samples = [
  item("BQV_2372", false, 2),
  item("BQV_2370", true, 1),
  item("BQV_2371", true, 3),
];

test("DCIR sample keys distinguish entry kind and reference", () => {
  assert.equal(dcirSampleEntryKey({ kind: "cell", ref_id: 7 }), "cell:7");
  assert.equal(dcirSampleEntryKey({ kind: "replicate_group", ref_id: 7 }), "replicate_group:7");
});

test("DCIR sample filtering matches names case-insensitively", () => {
  assert.deepEqual(
    filterAndSortDcirSampleItems(samples, "2371", "name_asc").map((sample) => sample.label),
    ["BQV_2371"],
  );
});

test("DCIR name sorting supports both directions", () => {
  assert.deepEqual(
    filterAndSortDcirSampleItems(samples, "", "name_asc").map((sample) => sample.label),
    ["BQV_2370", "BQV_2371", "BQV_2372"],
  );
  assert.deepEqual(
    filterAndSortDcirSampleItems(samples, "", "name_desc").map((sample) => sample.label),
    ["BQV_2372", "BQV_2371", "BQV_2370"],
  );
});

test("DCIR visible-first sorting groups visible entries before hidden entries", () => {
  assert.deepEqual(
    filterAndSortDcirSampleItems(samples, "", "visible_first_asc").map((sample) => sample.label),
    ["BQV_2370", "BQV_2371", "BQV_2372"],
  );
  assert.deepEqual(
    filterAndSortDcirSampleItems(samples, "", "visible_first_desc").map((sample) => sample.label),
    ["BQV_2371", "BQV_2370", "BQV_2372"],
  );
});

test("DCIR range selection follows the current sorted and filtered order", () => {
  const ordered = filterAndSortDcirSampleItems(samples, "", "name_asc");
  assert.deepEqual(
    dcirSampleKeysInRange(ordered, dcirSampleEntryKey(samples[0].entry), dcirSampleEntryKey(samples[1].entry)),
    ["cell:1", "cell:3", "cell:2"],
  );
});

test("DCIR range selection falls back to the clicked sample when the anchor is not shown", () => {
  const ordered = filterAndSortDcirSampleItems(samples, "2371", "name_asc");
  assert.deepEqual(
    dcirSampleKeysInRange(ordered, "cell:2", "cell:3"),
    ["cell:3"],
  );
});
