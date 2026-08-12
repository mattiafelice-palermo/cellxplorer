import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { groupSuggestionsByFamily } from "../src/features/analyses/editor/protocol/suggestionGrouping.ts";
import { groupCellsByApplicability } from "../src/features/analyses/editor/families/dcir/suggestionGrouping.ts";

type CellSelectItem = {
  value: string;
  label: string;
  disabled?: boolean;
};

type CellSelectGroup = {
  group: string;
  items: CellSelectItem[];
};

function itemAt(data: ReadonlyArray<unknown>, index: number): CellSelectItem {
  const item = data[index];
  assert.ok(
    item &&
      typeof item === "object" &&
      "value" in item &&
      "label" in item,
    `expected item at index ${index}`
  );
  return item as CellSelectItem;
}

function groupAt(data: ReadonlyArray<unknown>, index: number): CellSelectGroup {
  const item = data[index];
  assert.ok(
    item &&
      typeof item === "object" &&
      "group" in item &&
      "items" in item &&
      Array.isArray(item.items),
    `expected group at index ${index}`
  );
  return item as CellSelectGroup;
}

describe("suggestionGrouping", () => {
  describe("groupSuggestionsByFamily", () => {
    it("groups suggestions by signature and protocol number", () => {
      const suggestions = [
        {
          id: "s1",
          label: "Charge 1C · steps 3 → 4",
          protocolNumber: 1,
          signature: "sig-a",
          cellNames: ["Cell_376"],
        },
        {
          id: "s2",
          label: "Discharge 1C · steps 5 → 6",
          protocolNumber: 1,
          signature: "sig-a",
          cellNames: ["Cell_376"],
        },
        {
          id: "s3",
          label: "Charge 0.5C · steps 2 → 3",
          protocolNumber: 2,
          signature: "sig-b",
          cellNames: ["Cell_491"],
        },
      ];

      const result = groupSuggestionsByFamily(suggestions);

      assert.equal(result.length, 2, "should have 2 groups");
      assert.equal(
        result[0].group,
        "Protocol 1 · Cell_376",
        "first group should be Protocol 1"
      );
      assert.equal(result[0].items.length, 2, "first group should have 2 items");
      assert.equal(
        result[1].group,
        "Protocol 2 · Cell_491",
        "second group should be Protocol 2"
      );
    });

    it("handles multiple cells in a family with +N more suffix", () => {
      const suggestions = [
        {
          id: "s1",
          label: "Charge 1C · steps 3 → 4",
          protocolNumber: 1,
          signature: "sig-a",
          cellNames: ["Cell_A", "Cell_B", "Cell_C"],
        },
      ];

      const result = groupSuggestionsByFamily(suggestions);

      assert.equal(
        result[0].group,
        "Protocol 1 · Cell_A +2 more",
        "should show first cell name and +N more"
      );
    });

    it("sorts groups by protocol number", () => {
      const suggestions = [
        {
          id: "s1",
          label: "Item 1",
          protocolNumber: 3,
          signature: "sig-c",
          cellNames: ["Cell_C"],
        },
        {
          id: "s2",
          label: "Item 2",
          protocolNumber: 1,
          signature: "sig-a",
          cellNames: ["Cell_A"],
        },
        {
          id: "s3",
          label: "Item 3",
          protocolNumber: 2,
          signature: "sig-b",
          cellNames: ["Cell_B"],
        },
      ];

      const result = groupSuggestionsByFamily(suggestions);

      assert.equal(result[0].group, "Protocol 1 · Cell_A");
      assert.equal(result[1].group, "Protocol 2 · Cell_B");
      assert.equal(result[2].group, "Protocol 3 · Cell_C");
    });

    it("handles null protocol numbers", () => {
      const suggestions = [
        {
          id: "s1",
          label: "Item 1",
          protocolNumber: null,
          signature: "sig-unknown",
          cellNames: ["Cell_Unknown"],
        },
      ];

      const result = groupSuggestionsByFamily(suggestions);

      assert.equal(result[0].group, "Protocol — · Cell_Unknown");
    });

    it("handles empty cell names list", () => {
      const suggestions = [
        {
          id: "s1",
          label: "Item 1",
          protocolNumber: 1,
          signature: "sig-a",
          cellNames: [],
        },
      ];

      const result = groupSuggestionsByFamily(suggestions);

      assert.equal(result[0].group, "Protocol 1 · no cells");
    });
  });

  describe("groupCellsByApplicability", () => {
    it("separates cells with and without applicable segments", () => {
      const cells = [
        { id: 1, name: "Cell_A" },
        { id: 2, name: "Cell_B" },
        { id: 3, name: "Cell_C" },
      ];
      const applicableCounts = new Map<number, number>([
        [1, 2],
        [2, 0],
        [3, 1],
      ]);

      const result = groupCellsByApplicability(cells, applicableCounts);

      // Should have 3 options: 2 applicable items and one non-applicable group.
      assert.equal(result.length, 3);

      // First two should be applicable (no group)
      const first = itemAt(result, 0);
      assert.equal(first.value, "1");
      assert.equal(first.label, "Cell_A");
      assert.equal("group" in first, false);
      assert.equal(first.disabled, undefined);

      const second = itemAt(result, 1);
      assert.equal(second.value, "3");
      assert.equal(second.label, "Cell_C");
      assert.equal("group" in second, false);

      // Last should be a Mantine group containing the non-applicable option.
      const nonApplicableGroup = groupAt(result, 2);
      assert.equal(
        nonApplicableGroup.group,
        "Cells with no DCIR segment",
        "non-applicable cells should be grouped"
      );
      assert.equal("value" in nonApplicableGroup, false);
      assert.equal(nonApplicableGroup.items.length, 1);
      const nonApplicable = nonApplicableGroup.items[0];
      assert.equal(nonApplicable.value, "2");
      assert.equal(nonApplicable.label, "Cell_B");
      assert.equal(nonApplicable.disabled, true, "non-applicable cell should be disabled");
    });

    it("handles all cells applicable", () => {
      const cells = [
        { id: 1, name: "Cell_A" },
        { id: 2, name: "Cell_B" },
      ];
      const applicableCounts = new Map<number, number>([
        [1, 1],
        [2, 1],
      ]);

      const result = groupCellsByApplicability(cells, applicableCounts);

      assert.equal(result.length, 2);
      assert.equal("group" in itemAt(result, 0), false);
      assert.equal("group" in itemAt(result, 1), false);
    });

    it("handles no cells applicable", () => {
      const cells = [
        { id: 1, name: "Cell_A" },
        { id: 2, name: "Cell_B" },
      ];
      const applicableCounts = new Map<number, number>();

      const result = groupCellsByApplicability(cells, applicableCounts);

      assert.equal(result.length, 1);
      const group = groupAt(result, 0);
      assert.equal(group.group, "Cells with no DCIR segment");
      assert.equal(group.items.length, 2);
      assert.equal(group.items[0].disabled, true);
      assert.equal(group.items[1].disabled, true);
    });

    it("handles empty cells list", () => {
      const cells: Array<{ id: number; name: string }> = [];
      const applicableCounts = new Map<number, number>();

      const result = groupCellsByApplicability(cells, applicableCounts);

      assert.equal(result.length, 0);
    });
  });
});
