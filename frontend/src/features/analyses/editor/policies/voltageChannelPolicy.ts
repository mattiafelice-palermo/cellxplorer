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
  selectedChannel: VoltageChannel,
  voltageChannels: VoltageChannelAvailability | undefined
): VoltageChannelOption[] {
  const availableExtraChannels = voltageChannels
    ? VOLTAGE_CHANNEL_ORDER.filter(
        (channel) => channel !== "voltage" && voltageChannels[channel]?.available
      )
    : [];
  return VOLTAGE_CHANNEL_ORDER.filter(
    (channel) =>
      channel === "voltage" ||
      availableExtraChannels.includes(channel) ||
      channel === selectedChannel
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
