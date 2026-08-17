import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolFamilyGroup } from "../src/api.ts";
import {
  mergeProtocolGroups,
  normalizeProtocolGroups,
  protocolGroupDefinitionKey,
  protocolGroupForDefinition,
  protocolGroupForProvenance,
  protocolGroupMembershipKey,
  protocolGroupsForMembership,
} from "../src/features/analyses/editor/protocol/protocolGroupPolicy.ts";

function group(
  id: string,
  family_signatures: string[],
  reference_signature = family_signatures[0] ?? "",
): ProtocolFamilyGroup {
  return {
    id,
    name: id,
    family_signatures,
    reference_signature,
    comparison_mode: "workflow",
    comparison_dimensions: {
      structure: true,
      termination: false,
      rates: true,
      timing: true,
      voltage: false,
      recording: false,
    },
    ignore_empty_rest_pause: true,
  };
}

test("group membership keys are order-independent and deduplicate signatures", () => {
  assert.equal(
    protocolGroupMembershipKey(["protocol-b", "protocol-a", "protocol-a"]),
    protocolGroupMembershipKey(["protocol-a", "protocol-b"]),
  );
});

test("normalization removes singleton groups and keeps the first duplicate definition", () => {
  const normalized = normalizeProtocolGroups([
    group("singleton", ["protocol-a"]),
    group("first", ["protocol-b", "protocol-a"]),
    group("duplicate", ["protocol-a", "protocol-b"], "protocol-b"),
  ]);

  assert.deepEqual(normalized.map((item) => item.id), ["first"]);
  assert.deepEqual(normalized[0].family_signatures, ["protocol-b", "protocol-a"]);
});

test("different comparison settings are distinct group definitions", () => {
  const first = group("first", ["protocol-a", "protocol-b"]);
  const second = group("second", ["protocol-b", "protocol-a"]);
  second.comparison_dimensions.voltage = true;

  assert.notEqual(protocolGroupDefinitionKey(first), protocolGroupDefinitionKey(second));
  assert.deepEqual(normalizeProtocolGroups([first, second]).map((item) => item.id), [
    "first",
    "second",
  ]);
});

test("an existing definition is reused regardless of proposal order", () => {
  const existing = group("group-1", ["protocol-a", "protocol-b"]);
  assert.equal(
    protocolGroupForDefinition([existing], {
      family_signatures: ["protocol-b", "protocol-a"],
      reference_signature: "protocol-a",
      comparison_mode: "workflow",
      comparison_dimensions: existing.comparison_dimensions,
      ignore_empty_rest_pause: true,
    })?.id,
    "group-1",
  );
});

test("merging new definitions preserves existing groups and excludes exact duplicates", () => {
  const existing = group("group-a", ["protocol-a", "protocol-b"]);
  const addition = group("group-b", ["protocol-b", "protocol-c"]);
  const duplicateWithNewId = group("duplicate", ["protocol-b", "protocol-a"], "protocol-a");

  assert.deepEqual(
    mergeProtocolGroups([existing], [addition, duplicateWithNewId]).map((item) => item.id),
    ["group-a", "group-b"],
  );
  assert.equal(
    mergeProtocolGroups([{ ...existing, name: "Renamed A" }], [addition])[0].name,
    "Renamed A",
  );
});

test("membership lookup exposes ambiguity instead of selecting the first definition", () => {
  const first = group("group-a", ["protocol-a", "protocol-b"]);
  const second = { ...group("group-b", ["protocol-b", "protocol-a"]), ignore_empty_rest_pause: false };
  assert.deepEqual(
    protocolGroupsForMembership([first, second], ["protocol-b", "protocol-a"]).map((item) => item.id),
    ["group-a", "group-b"],
  );
});

test("segment provenance does not transfer ownership after the recorded group is removed", () => {
  const first = group("group-a", ["protocol-a", "protocol-b"]);
  const second = { ...group("group-b", ["protocol-b", "protocol-a"]), ignore_empty_rest_pause: false };
  assert.equal(
    protocolGroupForProvenance([first, second], "group-a", ["protocol-a", "protocol-b"])?.id,
    "group-a",
  );
  assert.equal(
    protocolGroupForProvenance([second], "group-a", ["protocol-a", "protocol-b"]),
    undefined,
  );
  assert.equal(
    protocolGroupForProvenance([first, second], undefined, ["protocol-a", "protocol-b"]),
    undefined,
  );
});
