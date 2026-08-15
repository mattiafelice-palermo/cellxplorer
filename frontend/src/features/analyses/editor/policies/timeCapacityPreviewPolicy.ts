import type { AnalysisSpec, TimeCapacityResult } from "../../../../api";

import {
  timeCapacityResultMatchesVoltageChannel,
  voltageChannelUnavailable,
  type VoltageChannel,
} from "./voltageChannelPolicy.ts";

function selectedVoltageChannel(spec: AnalysisSpec): VoltageChannel {
  const selected = spec.computation.time_capacity?.voltage_channel;
  return selected === "working_potential" || selected === "counter_potential"
    ? selected
    : "voltage";
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
  const channel = selectedVoltageChannel(spec);
  if (!timeCapacityResultMatchesVoltageChannel(result, channel)) return undefined;
  if (voltageChannelUnavailable(channel, result.voltage_channels)) return undefined;
  return result;
}

export function timeCapacityPreviewChannel(spec: AnalysisSpec): VoltageChannel {
  return selectedVoltageChannel(spec);
}
