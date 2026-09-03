import assert from "node:assert/strict";
import test from "node:test";

import {
  plotlySafeText,
  normalizeVoltageChannels,
  shouldShowVoltageChannelSelector,
  shouldResetVoltageChannelAvailability,
  timeCapacityExportOptions,
  timeCapacityExportMatchesRequest,
  timeCapacityResultMatchesVoltageChannel,
  timeCapacityResultMatchesVoltageChannels,
  voltageChannelAvailabilitySignature,
  voltageChannelAvailabilityPublication,
  voltageChannelDataIdentity,
  voltageChannelLabel,
  voltageChannelSelectorOptions,
  voltageChannelUnavailable,
  voltageChannelUnavailableMessage,
  voltageChannelSelectionLabel,
  voltageChannelSelectionSummary,
  type VoltageChannelAvailability,
} from "../src/features/analyses/editor/policies/voltageChannelPolicy.ts";
import { timeCapacityPreviewResult } from "../src/features/analyses/editor/policies/timeCapacityPreviewPolicy.ts";

function availability(
  overrides: Partial<Record<"working_potential" | "counter_potential", boolean>> = {}
): VoltageChannelAvailability {
  return {
    voltage: { available: true, label: "Cell voltage (V)", role: "cell" },
    working_potential: {
      available: overrides.working_potential ?? false,
      label: "Working potential vs ref (V)",
      role: "working_vs_reference",
    },
    counter_potential: {
      available: overrides.counter_potential ?? false,
      label: "Counter potential vs ref (V)",
      role: "counter_vs_reference",
    },
  };
}

test("an ordinary two-electrode source hides the selector entirely", () => {
  const options = voltageChannelSelectorOptions("voltage", availability());

  assert.deepEqual(options, [{ value: "voltage", label: "Cell voltage (V)" }]);
  assert.equal(shouldShowVoltageChannelSelector(options), false);
});

test("an available electrode potential shows the selector with the full, ordered option list", () => {
  const options = voltageChannelSelectorOptions(
    "voltage",
    availability({ working_potential: true })
  );

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("both electrode potentials available offer all three channels in primary-first order", () => {
  const options = voltageChannelSelectorOptions(
    "counter_potential",
    availability({ working_potential: true, counter_potential: true })
  );

  assert.deepEqual(
    options.map((option) => option.value),
    ["voltage", "working_potential", "counter_potential"]
  );
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("multi-selection preserves canonical order and supports select-all/deselect-all state", () => {
  assert.deepEqual(
    normalizeVoltageChannels(["counter_potential", "voltage", "working_potential"]),
    ["voltage", "working_potential", "counter_potential"],
  );
  assert.deepEqual(normalizeVoltageChannels([]), []);
  assert.equal(
    voltageChannelSelectionLabel(["voltage", "working_potential"], availability({ working_potential: true })),
    "Cell voltage + Working potential vs ref (V)",
  );
  assert.equal(
    voltageChannelSelectionSummary(["voltage", "working_potential"]),
    "2 voltage quantities selected",
  );
});

test("a saved plot pinned to a now-unavailable channel keeps that option instead of dropping it", () => {
  // The selection changed (or the source lost the channel) since the plot
  // was saved: working_potential is no longer available, but the plot's
  // persisted voltage_channel is still "working_potential".
  const options = voltageChannelSelectorOptions("working_potential", availability());

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  // The selector must still render so the user can see/change the pinned
  // (now-unavailable) selection rather than it silently vanishing.
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("counter_potential pinned but unavailable is retained the same way as working_potential", () => {
  const options = voltageChannelSelectorOptions("counter_potential", availability());

  assert.deepEqual(
    options.map((option) => option.value),
    ["voltage", "counter_potential"]
  );
});

test("no result yet (voltageChannels undefined) behaves like a two-electrode source", () => {
  const options = voltageChannelSelectorOptions("voltage", undefined);

  assert.deepEqual(options, [{ value: "voltage", label: "Cell voltage (V)" }]);
  assert.equal(shouldShowVoltageChannelSelector(options), false);
});

test("no result yet still retains a pinned electrode-potential selection rather than dropping it", () => {
  // A saved plot pinned to working_potential, opened before the live
  // Time/Capacity query has returned a result: the selector must still
  // show the pinned choice (using the fallback label) instead of silently
  // reverting the visible selection to "voltage" while data loads.
  const options = voltageChannelSelectorOptions("working_potential", undefined);

  assert.deepEqual(options, [
    { value: "voltage", label: "Cell voltage (V)" },
    { value: "working_potential", label: "Working potential vs ref (V)" },
  ]);
  assert.equal(shouldShowVoltageChannelSelector(options), true);
});

test("backend-provided reference text is used verbatim in the auxiliary label", () => {
  const channels = availability({ working_potential: true });
  channels.working_potential.reference_electrode = "Ag/AgCl";
  channels.working_potential.label = "Working potential vs Ag/AgCl (V)";

  assert.equal(
    voltageChannelLabel("working_potential", channels),
    "Working potential vs Ag/AgCl (V)"
  );
});

test("missing reference text keeps the generic truthful auxiliary label", () => {
  assert.equal(
    voltageChannelLabel("counter_potential", availability({ counter_potential: true })),
    "Counter potential vs ref (V)"
  );
});

test("a result computed for another channel is rejected during a channel switch", () => {
  const primary = { settings: { voltage_channel: "voltage" } } as any;
  assert.equal(timeCapacityResultMatchesVoltageChannel(primary, "voltage"), true);
  assert.equal(timeCapacityResultMatchesVoltageChannel(primary, "working_potential"), false);
  assert.equal(timeCapacityResultMatchesVoltageChannel(undefined, "voltage"), false);
});

test("a result computed for one voltage is not reused for a multi-voltage selection", () => {
  const result = {
    settings: {
      voltage_channel: "voltage",
      voltage_channels: ["voltage", "working_potential"],
    },
  } as any;
  assert.equal(
    timeCapacityResultMatchesVoltageChannels(result, ["voltage", "working_potential"]),
    true,
  );
  assert.equal(timeCapacityResultMatchesVoltageChannels(result, ["voltage"]), false);
  assert.equal(timeCapacityResultMatchesVoltageChannels(result, ["working_potential"]), false);
});

test("full-resolution export rejects delayed results for either auxiliary channel after a race", () => {
  for (const channel of ["working_potential", "counter_potential"] as const) {
    const result = {
      settings: { voltage_channel: channel },
      source_data_signature: "source-a",
    } as any;
    assert.equal(
      timeCapacityExportMatchesRequest("data-a", "data-a", channel, channel, result),
      true
    );
    assert.equal(
      timeCapacityExportMatchesRequest(
        "data-a",
        "data-a",
        channel,
        channel,
        result,
        "source-b"
      ),
      false
    );
    assert.equal(
      timeCapacityExportMatchesRequest("data-a", "data-a", "voltage", channel, result),
      false
    );
    assert.equal(
      timeCapacityExportMatchesRequest("data-b", "data-a", channel, channel, result),
      false
    );
  }
});

test("full-series exports tolerate a range-specific server signature when source descriptors match", () => {
  const channelAvailability = {
    voltage: { available: true, label: "Cell voltage (V)", role: "cell" },
    working_potential: {
      available: false,
      label: "Working potential vs ref (V)",
      role: "working_vs_reference",
    },
    counter_potential: {
      available: false,
      label: "Counter potential vs ref (V)",
      role: "counter_vs_reference",
    },
  };
  const resultForCurrentRange = {
    parser_version: "parser-a",
    calc_version: "calc-a",
    source_data_signature: "current-cycle-range",
    settings: { voltage_channel: "voltage" },
    voltage_channels: {
      counter_potential: channelAvailability.counter_potential,
      voltage: channelAvailability.voltage,
      working_potential: channelAvailability.working_potential,
    },
    cell_traces: [
      {
        cell_id: 4,
        source_descriptors: [
          { source_position: 1, source_hash: "hash-a", parser_version: "parser-a", status: "ready" },
        ],
      },
    ],
  } as any;
  const fullSeriesResult = {
    ...resultForCurrentRange,
    source_data_signature: "all-cycles-range",
    voltage_channels: {
      voltage: channelAvailability.voltage,
      working_potential: channelAvailability.working_potential,
      counter_potential: channelAvailability.counter_potential,
    },
  };
  const sourceIdentity = voltageChannelDataIdentity(resultForCurrentRange);

  assert.equal(voltageChannelDataIdentity(fullSeriesResult), sourceIdentity);
  assert.equal(
    timeCapacityExportMatchesRequest(
      "data-a",
      "data-a",
      "voltage",
      "voltage",
      fullSeriesResult,
      sourceIdentity,
    ),
    true,
  );

  const changedSource = {
    ...fullSeriesResult,
    cell_traces: [
      {
        cell_id: 4,
        source_descriptors: [
          { source_position: 1, source_hash: "hash-b", parser_version: "parser-a", status: "ready" },
        ],
      },
    ],
  };
  assert.notEqual(voltageChannelDataIdentity(changedSource), sourceIdentity);
});

test("source identity changes reset availability even when selection is unchanged", () => {
  const result = {
    parser_version: "mpr:1",
    calc_version: "calc:1",
    cell_traces: [
      {
        cell_id: 4,
        source_descriptors: [
          { source_position: 1, source_hash: "hash-a", status: "ready" },
        ],
      },
    ],
    voltage_channels: availability({ working_potential: true }),
  } as any;
  const changed = {
    ...result,
    cell_traces: [
      {
        ...result.cell_traces[0],
        source_descriptors: [
          { source_position: 1, source_hash: "hash-b", status: "ready" },
        ],
      },
    ],
  };
  const selection = {
    entries: [{ kind: "cell", ref_id: 4 }],
    exclusions: [],
    hidden_replicate_group_ids: [],
  } as any;
  const first = voltageChannelAvailabilitySignature(
    { selection },
    voltageChannelDataIdentity(result)
  );
  const same = voltageChannelAvailabilitySignature(
    { selection },
    voltageChannelDataIdentity(result)
  );
  const next = voltageChannelAvailabilitySignature(
    { selection },
    voltageChannelDataIdentity(changed)
  );

  assert.equal(shouldResetVoltageChannelAvailability(first, same), false);
  assert.equal(shouldResetVoltageChannelAvailability(first, next), true);
  const publication = voltageChannelAvailabilityPublication(first, next, result.voltage_channels);
  assert.equal(publication.reset, true);
  assert.strictEqual(publication.channels, result.voltage_channels);
});

test("saved-artifact and portable-preview gates never fall back to primary data", () => {
  const result = {
    settings: { voltage_channel: "working_potential" },
    cell_traces: [],
    voltage_channels: availability({ working_potential: true }),
  } as any;
  const workingSpec = {
    computation: { time_capacity: { voltage_channel: "working_potential" } },
  } as any;
  const counterSpec = {
    computation: { time_capacity: { voltage_channel: "counter_potential" } },
  } as any;
  const unavailableResult = {
    ...result,
    voltage_channels: availability({ working_potential: false }),
  };
  const primaryResult = {
    ...result,
    settings: { voltage_channel: "voltage" },
  };

  assert.equal(timeCapacityPreviewResult(result, workingSpec), result);
  assert.equal(timeCapacityPreviewResult(unavailableResult, workingSpec), undefined);
  assert.equal(timeCapacityPreviewResult(primaryResult, workingSpec), undefined);
  assert.equal(timeCapacityPreviewResult(result, counterSpec), undefined);
});

test("explicit unavailable auxiliary results produce a named state without loading fallback", () => {
  const channels = availability({ working_potential: false });
  assert.equal(voltageChannelUnavailable("working_potential", channels), true);
  assert.equal(voltageChannelUnavailable("working_potential", undefined), false);
  assert.equal(
    voltageChannelUnavailableMessage("working_potential"),
    "Working potential is unavailable for the current selection."
  );
});

test("source-controlled labels are safe for fixed Plotly templates", () => {
  assert.equal(
    plotlySafeText("Ag/AgCl %{y}<br><extra>"),
    "Ag/AgCl &#37;{y}&lt;br&gt;&lt;extra&gt;"
  );
});

test("scientific Time/Capacity exports request full precision in a transient compact payload", () => {
  assert.deepEqual(timeCapacityExportOptions(1200), {
    viewport_width: 1200,
    precision: "full",
    compact: true,
    persist: false,
  });
});

test("availability is retained across plot-only refetches but reset for selection changes", () => {
  const selection = {
    entries: [{ kind: "cell", ref_id: 1 }],
    exclusions: [],
    hidden_replicate_group_ids: [],
  } as any;
  const sameSelection = {
    entries: [{ kind: "cell", ref_id: 1 }],
    exclusions: [],
    hidden_replicate_group_ids: [],
  } as any;
  const changedSelection = {
    entries: [{ kind: "cell", ref_id: 2 }],
    exclusions: [],
    hidden_replicate_group_ids: [],
  } as any;
  const first = voltageChannelAvailabilitySignature({ selection });
  const same = voltageChannelAvailabilitySignature({ selection: sameSelection });
  const changed = voltageChannelAvailabilitySignature({ selection: changedSelection });

  assert.equal(shouldResetVoltageChannelAvailability(first, same), false);
  assert.equal(shouldResetVoltageChannelAvailability(first, changed), true);
});
