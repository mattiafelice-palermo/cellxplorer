import type { AnalysisSpec, TimeCapacityResult } from "../../../../api";

export type VoltageChannel = NonNullable<
  NonNullable<AnalysisSpec["computation"]["time_capacity"]>["voltage_channel"]
>;

export type VoltageChannelAvailability = NonNullable<TimeCapacityResult["voltage_channels"]>;

export interface VoltageChannelOption {
  value: VoltageChannel;
  label: string;
}

/** Ordered so a channel selector's option list is always presented primary-first. */
export const VOLTAGE_CHANNEL_ORDER: VoltageChannel[] = [
  "voltage",
  "working_potential",
  "counter_potential",
];

/**
 * Normalize a saved multi-selection without changing its semantic order.
 * `undefined` means a legacy single-channel spec; an explicitly empty array
 * is retained so the UI can implement its deselect-all action honestly.
 */
export function normalizeVoltageChannels(
  channels: readonly VoltageChannel[] | undefined,
  fallback: VoltageChannel = "voltage",
): VoltageChannel[] {
  if (channels !== undefined) {
    return VOLTAGE_CHANNEL_ORDER.filter((channel) => channels.includes(channel));
  }
  return VOLTAGE_CHANNEL_ORDER.includes(fallback) ? [fallback] : ["voltage"];
}

function selectedVoltageChannels(
  selected: VoltageChannel | readonly VoltageChannel[],
): VoltageChannel[] {
  return typeof selected === "string" ? [selected] : [...selected];
}

/**
 * Fallback labels used when a channel's live backend label is unavailable —
 * before a result has loaded, or for a stale/legacy cached result lacking
 * `voltage_channels` (Spec 040.4's `RESULT_SCHEMA_VERSIONS` bump means this
 * should be rare in practice, but the component must still degrade safely
 * rather than throw). The backend's own `voltage_channels[...].label`
 * (`canonical_cycling.voltage_quantity_label`) is authoritative once
 * available; these defaults describe the same thing today because no
 * current source declares a different voltage role.
 */
export const DEFAULT_VOLTAGE_CHANNEL_LABELS: Record<VoltageChannel, string> = {
  voltage: "Cell voltage (V)",
  working_potential: "Working potential vs ref (V)",
  counter_potential: "Counter potential vs ref (V)",
};

const VOLTAGE_CHANNEL_SHORT_LABELS: Record<VoltageChannel, string> = {
  voltage: "Cell voltage",
  working_potential: "Working potential",
  counter_potential: "Counter potential",
};

export function voltageChannelLabel(
  channel: VoltageChannel,
  voltageChannels?: VoltageChannelAvailability
): string {
  return voltageChannels?.[channel]?.label ?? DEFAULT_VOLTAGE_CHANNEL_LABELS[channel];
}

export function voltageChannelShortLabel(channel: VoltageChannel): string {
  return VOLTAGE_CHANNEL_SHORT_LABELS[channel];
}

/** Human-readable axis/plot title for one or more selected voltage quantities. */
export function voltageChannelSelectionLabel(
  channels: readonly VoltageChannel[],
  voltageChannels?: VoltageChannelAvailability,
): string {
  if (channels.length === 0) return "No voltage quantities";
  if (channels.length === 1) return voltageChannelLabel(channels[0], voltageChannels);
  return `${channels
    .map((channel) => voltageChannelLabel(channel, voltageChannels).replace(/\s*\(V\)$/, ""))
    .join(" + ")} (V)`;
}

/** Compact value for the closed multi-select input. */
export function voltageChannelSelectionSummary(
  channels: readonly VoltageChannel[],
  voltageChannels?: VoltageChannelAvailability,
): string {
  if (channels.length === 0) return "No voltages selected";
  if (channels.length === 1) return voltageChannelLabel(channels[0], voltageChannels);
  return `${channels.length} voltage quantities selected`;
}

/**
 * A result is safe to render only when it was computed for the currently
 * selected canonical voltage quantity. React Query may otherwise expose a
 * previous result while a new channel request is in flight.
 */
export function timeCapacityResultMatchesVoltageChannel(
  result: TimeCapacityResult | undefined,
  selectedChannel: VoltageChannel,
): boolean {
  return timeCapacityResultMatchesVoltageChannels(result, [selectedChannel]);
}

/**
 * Reject a previous result when a multi-voltage selection changed. Checking
 * only the first channel would briefly render a one-channel result under a
 * two- or three-channel label while the replacement request is in flight.
 */
export function timeCapacityResultMatchesVoltageChannels(
  result: TimeCapacityResult | undefined,
  selectedChannels: readonly VoltageChannel[],
): boolean {
  if (!result) return false;
  const resultChannels = normalizeVoltageChannels(
    result.settings?.voltage_channels,
    result.settings?.voltage_channel ?? "voltage",
  );
  return (
    resultChannels.length === selectedChannels.length &&
    resultChannels.every((channel, index) => channel === selectedChannels[index])
  );
}

/**
 * Stable identity for the source/capability part of a Time/Capacity result.
 * Plot presentation and cycle-window changes may refetch the result without
 * changing which voltage quantities the selected sources provide. Source
 * hashes, parser identity, and the resolved capability map do change when
 * that scientific input changes, so they are the correct availability-reset
 * boundary.
 */
export function voltageChannelDataIdentity(
  result: TimeCapacityResult | undefined,
): string | undefined {
  if (!result) return undefined;
  if (result.source_data_signature) return result.source_data_signature;
  const sources = result.cell_traces
    .flatMap((trace) =>
      (trace.source_descriptors ?? []).map((source) => ({
        cell_id: trace.cell_id,
        source_position: source.source_position,
        source_hash: source.source_hash,
        status: source.status ?? null,
      }))
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    parser_version: result.parser_version,
    calc_version: result.calc_version,
    sources,
    voltage_channels: result.voltage_channels ?? null,
  });
}

/** Guard a delayed full-resolution export against both channel races. */
export function timeCapacityExportMatchesRequest(
  currentDataSignature: string,
  requestedDataSignature: string,
  currentChannel: VoltageChannel | readonly VoltageChannel[],
  requestedChannel: VoltageChannel | readonly VoltageChannel[],
  result: TimeCapacityResult,
  requestedSourceDataIdentity?: string,
): boolean {
  const currentChannels = selectedVoltageChannels(currentChannel);
  const requestedChannels = selectedVoltageChannels(requestedChannel);
  return (
    currentDataSignature === requestedDataSignature &&
    currentChannels.length === requestedChannels.length &&
    currentChannels.every((channel, index) => channel === requestedChannels[index]) &&
    timeCapacityResultMatchesVoltageChannels(result, requestedChannels) &&
    (requestedSourceDataIdentity === undefined ||
      voltageChannelDataIdentity(result) === requestedSourceDataIdentity)
  );
}

/**
 * `undefined` availability means that no current result has arrived yet. A
 * channel becomes explicitly unavailable only when the current result says
 * so; this preserves the pinned saved-plot choice during loading.
 */
export function voltageChannelUnavailable(
  channel: VoltageChannel,
  voltageChannels: VoltageChannelAvailability | undefined,
): boolean {
  return channel !== "voltage" && voltageChannels !== undefined && voltageChannels[channel]?.available === false;
}

export function voltageChannelUnavailableMessage(channel: VoltageChannel): string {
  return `${voltageChannelShortLabel(channel)} is unavailable for the current selection.`;
}

export function voltageChannelsUnavailable(
  channels: readonly VoltageChannel[],
  voltageChannels: VoltageChannelAvailability | undefined,
): boolean {
  return channels.some((channel) => voltageChannelUnavailable(channel, voltageChannels));
}

export function voltageChannelsUnavailableMessage(
  channels: readonly VoltageChannel[],
  voltageChannels: VoltageChannelAvailability | undefined,
): string {
  const unavailable = channels.filter((channel) =>
    voltageChannelUnavailable(channel, voltageChannels),
  );
  if (unavailable.length === 0) return "";
  return `${unavailable.map(voltageChannelShortLabel).join(", ")} ${
    unavailable.length === 1 ? "is" : "are"
  } unavailable for the current selection.`;
}

/** Text supplied by source metadata must not become Plotly markup or a template token. */
export function plotlySafeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/%/g, "&#37;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Full-resolution request options used by scientific Time/Capacity exports. */
export function timeCapacityExportOptions(viewportWidth: number) {
  return {
    viewport_width: viewportWidth,
    precision: "full" as const,
    compact: false,
  };
}

/**
 * Capability availability may be retained while only plot presentation or
 * cycle filters refetch. Selection membership and the result's source/data
 * identity are the safe reset boundaries.
 */
export function voltageChannelAvailabilitySignature(
  spec: Pick<AnalysisSpec, "selection">,
  sourceDataIdentity?: string | null,
): string {
  return JSON.stringify({
    entries: spec.selection.entries ?? [],
    exclusions: spec.selection.exclusions ?? [],
    hidden_replicate_group_ids: spec.selection.hidden_replicate_group_ids ?? [],
    source_data_identity: sourceDataIdentity ?? null,
  });
}

export function shouldResetVoltageChannelAvailability(
  previousSignature: string,
  nextSignature: string,
): boolean {
  return previousSignature !== nextSignature;
}

/**
 * Decide the callback sequence for one result publication. Keeping this
 * identity-aware makes a structurally shared channel map publish again when
 * the source identity changes, instead of leaving a cleared parent state.
 */
export function voltageChannelAvailabilityPublication(
  previousSignature: string,
  nextSignature: string,
  channels: VoltageChannelAvailability | undefined,
): { reset: boolean; channels: VoltageChannelAvailability | undefined } {
  return {
    reset: shouldResetVoltageChannelAvailability(previousSignature, nextSignature),
    channels,
  };
}

/**
 * The channel-option/visibility decision for the Time/Capacity voltage
 * quantity selector (Spec 040.4). Pure and explicit so the two-electrode
 * guarantee — an ordinary Neware source must never gain a working/counter
 * potential control, disabled or not — is protected by something
 * executable rather than resting on reading the component.
 *
 * Rules, in order:
 * - `voltage` (the primary/default channel) is always offered;
 * - an electrode potential is offered only when `voltageChannels` reports
 *   it `available: true` for the CURRENT selection — never merely because
 *   the canonical column name exists;
 * - the currently selected channel is always retained even if it has since
 *   become unavailable (e.g. a saved plot pinned to a channel that a
 *   sample-selection change made unavailable), so a user's choice is never
 *   silently dropped from the list out from under them;
 * - `voltageChannels` undefined (no result yet, or a stale pre-040.4
 *   cached result) behaves like "no electrode potential known available" —
 *   the same as an ordinary two-electrode source — except the selected
 *   channel is still retained per the rule above.
 */
export function voltageChannelSelectorOptions(
  selectedChannel: VoltageChannel | readonly VoltageChannel[],
  voltageChannels: VoltageChannelAvailability | undefined
): VoltageChannelOption[] {
  const selectedChannels = selectedVoltageChannels(selectedChannel);
  const availableExtraChannels = voltageChannels
    ? VOLTAGE_CHANNEL_ORDER.filter(
        (channel) => channel !== "voltage" && voltageChannels[channel]?.available
      )
    : [];
  return VOLTAGE_CHANNEL_ORDER.filter(
    (channel) =>
      channel === "voltage" ||
      availableExtraChannels.includes(channel) ||
      selectedChannels.includes(channel)
  ).map((channel) => ({ value: channel, label: voltageChannelLabel(channel, voltageChannels) }));
}

/**
 * Whether the selector should render at all. Hidden whenever the only
 * offered option is the primary "voltage" channel — this is what keeps an
 * ordinary two-electrode source's UI byte-for-byte the same as before this
 * child (spec: "do not show disabled WE/CE entries merely to advertise a
 * feature unavailable for that source").
 */
export function shouldShowVoltageChannelSelector(options: VoltageChannelOption[]): boolean {
  return options.length > 1;
}
