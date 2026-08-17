import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolFamilyGroup } from "../src/api.ts";
import {
  normalizeProtocolGroups,
  protocolGroupForMembership,
  protocolGroupMembershipKey,
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

test("normalization removes singleton groups and keeps the first duplicate membership", () => {
  const normalized = normalizeProtocolGroups([
    group("singleton", ["protocol-a"]),
    group("first", ["protocol-b", "protocol-a"]),
    group("duplicate", ["protocol-a", "protocol-b"]),
  ]);

  assert.deepEqual(normalized.map((item) => item.id), ["first"]);
  assert.deepEqual(normalized[0].family_signatures, ["protocol-b", "protocol-a"]);
});

test("an existing membership is reused regardless of proposal order", () => {
  const existing = group("group-1", ["protocol-a", "protocol-b"]);
  assert.equal(
    protocolGroupForMembership([existing], ["protocol-b", "protocol-a"])?.id,
    "group-1",
  );
});
