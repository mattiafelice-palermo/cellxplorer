import type { AnalysisSpec, TimeCapacityResult, TimeCapacityTrace } from "../../../../../api.ts";
import { isAnalysisSampleHidden, isSeriesHidden } from "../../policies/analysisVisibility.ts";
import type { VoltageChannel } from "../../policies/voltageChannelPolicy.ts";
import { timeCapacityVoltageChannelShortLabel } from "../../plotting/seriesStyling.ts";

const TIME_CAPACITY_VISIBILITY_PREFIX = "time_capacity:";

export const timeCapacityVisibilityKey = (seriesKey: string) =>
  `${TIME_CAPACITY_VISIBILITY_PREFIX}${seriesKey}`;

export const timeCapacityVoltageVisibilityKey = (
  seriesKey: string,
  channel: VoltageChannel,
) => timeCapacityVisibilityKey(`${seriesKey}|${channel}`);

export function timeCapacityVisibleVoltageChannels(
  spec: AnalysisSpec,
  seriesKey: string,
  channels: readonly VoltageChannel[],
  multipleVoltageChannels: boolean,
): VoltageChannel[] {
  if (!multipleVoltageChannels) {
    return isSeriesHidden(spec, timeCapacityVisibilityKey(seriesKey)) ? [] : [...channels];
  }
  return channels.filter(
    (channel) => !isSeriesHidden(spec, timeCapacityVoltageVisibilityKey(seriesKey, channel)),
  );
}

function traceVoltageValues(
  trace: TimeCapacityTrace,
  channel: VoltageChannel,
  fallbackChannel: VoltageChannel,
): (number | null)[] {
  const values = trace.voltage_v_by_channel?.[channel];
  if (Array.isArray(values)) return values;
  return channel === fallbackChannel ? trace.voltage_v : [];
}

function hasFinitePoint(values: (number | null)[]): boolean {
  return values.some((value) => value !== null && Number.isFinite(value));
}

export function timeCapacityTraceIsHidden(
  trace: Pick<TimeCapacityTrace, "cell_id" | "group_id" | "excluded">,
  spec: AnalysisSpec,
): boolean {
  return isAnalysisSampleHidden(spec, trace);
}

/** Build the actual first-class visibility targets for a Time/Capacity view. */
export function timeCapacitySeriesVisibilityCandidatesForConfig(
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  config: {
    view: string;
    voltage_channels: readonly VoltageChannel[];
    voltage_channel: VoltageChannel;
  },
): { key: string; label: string }[] {
  const multipleVoltageChannels =
    config.view === "voltage_current" && config.voltage_channels.length > 1;
  const candidates: { key: string; label: string }[] = [];
  for (const trace of result.cell_traces) {
    if (timeCapacityTraceIsHidden(trace, spec)) continue;
    const seriesKey = trace.group_id ? `g${trace.group_id}` : `c${trace.cell_id}`;
    const baseLabel = trace.group_name ? `${trace.label} (${trace.group_name})` : trace.label;
    if (multipleVoltageChannels) {
      for (const channel of config.voltage_channels) {
        if (!hasFinitePoint(traceVoltageValues(trace, channel, config.voltage_channel))) continue;
        candidates.push({
          key: timeCapacityVoltageVisibilityKey(seriesKey, channel),
          label: `${baseLabel} — ${timeCapacityVoltageChannelShortLabel(channel)}`,
        });
      }
      continue;
    }
    const hasData =
      config.view === "voltage_current"
        ? config.voltage_channels.some((channel) =>
            hasFinitePoint(traceVoltageValues(trace, channel, config.voltage_channel)),
          )
        : hasFinitePoint(trace.derivative_x) && hasFinitePoint(trace.derivative_y);
    if (!hasData) continue;
    candidates.push({ key: timeCapacityVisibilityKey(seriesKey), label: baseLabel });
  }
  return candidates;
}
