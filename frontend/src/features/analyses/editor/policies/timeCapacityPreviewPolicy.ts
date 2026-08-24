import type { AnalysisSpec, TimeCapacityResult } from "../../../../api";

import {
  normalizeVoltageChannels,
  timeCapacityResultMatchesVoltageChannels,
  voltageChannelsUnavailable,
  type VoltageChannel,
} from "./voltageChannelPolicy.ts";

function selectedVoltageChannels(spec: AnalysisSpec): VoltageChannel[] {
  const config = spec.computation.time_capacity;
  const selected = config?.voltage_channel;
  const fallback =
    selected === "working_potential" || selected === "counter_potential"
      ? selected
      : "voltage";
  return normalizeVoltageChannels(config?.voltage_channels, fallback);
}

/**
 * Gate every saved/portable Time-Capacity consumer on the requested channel.
 * A previous primary result or an explicitly unavailable auxiliary result is
 * never a valid fallback for the selected Working/Counter quantity.
 */
export function timeCapacityPreviewResult(
  result: TimeCapacityResult | undefined,
  spec: AnalysisSpec,
): TimeCapacityResult | undefined {
  if (!result) return undefined;
  const channels = selectedVoltageChannels(spec);
  if (!timeCapacityResultMatchesVoltageChannels(result, channels)) return undefined;
  if (voltageChannelsUnavailable(channels, result.voltage_channels)) return undefined;
  return result;
}

export function timeCapacityPreviewChannel(spec: AnalysisSpec): VoltageChannel {
  return selectedVoltageChannels(spec)[0] ?? "voltage";
}
