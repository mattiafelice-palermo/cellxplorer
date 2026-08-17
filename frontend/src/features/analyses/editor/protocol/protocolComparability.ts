import type { FileProtocol, ProtocolGroup, ProtocolStep } from "../../../../api";

export type ProtocolComparisonMode = "strict" | "workflow" | "custom";

export type ProtocolComparisonDimension =
  | "structure"
  | "rates"
  | "timing"
  | "voltage"
  | "recording";

export type ProtocolComparisonStatus = "same" | "different" | "ignored";

export interface ProtocolComparisonDimensions {
  structure: boolean;
  rates: boolean;
  timing: boolean;
  voltage: boolean;
  recording: boolean;
}

export interface ProtocolComparisonRow {
  key: ProtocolComparisonDimension;
  label: string;
  reference: string;
  candidate: string;
  status: ProtocolComparisonStatus;
}

export interface ProtocolComparisonResult {
  mode: ProtocolComparisonMode;
  dimensions: ProtocolComparisonDimensions;
  rows: ProtocolComparisonRow[];
  comparable: boolean;
  strictIdentityMatch: boolean;
  differingDimensions: ProtocolComparisonDimension[];
}

export const WORKFLOW_COMPARISON_DIMENSIONS: ProtocolComparisonDimensions = {
  structure: true,
  rates: true,
  timing: true,
  voltage: false,
  recording: false,
};

const STRICT_COMPARISON_DIMENSIONS: ProtocolComparisonDimensions = {
  structure: true,
  rates: true,
  timing: true,
  voltage: true,
  recording: true,
};

const DIMENSION_ORDER: ProtocolComparisonDimension[] = [
  "structure",
  "rates",
  "timing",
  "voltage",
  "recording",
];

const RATE_RELATIVE_TOLERANCE = 0.02;
const VALUE_ABSOLUTE_TOLERANCE = 1e-9;
const COMMON_C_RATE_DENOMINATORS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];

export function comparisonDimensionsFor(
  mode: ProtocolComparisonMode,
  custom: ProtocolComparisonDimensions = WORKFLOW_COMPARISON_DIMENSIONS,
): ProtocolComparisonDimensions {
  if (mode === "strict") return { ...STRICT_COMPARISON_DIMENSIONS };
  if (mode === "workflow") return { ...WORKFLOW_COMPARISON_DIMENSIONS };
  return { ...custom };
}

function exactNumberEqual(
  first: number | null | undefined,
  second: number | null | undefined,
): boolean {
  if (first == null || second == null) return first == null && second == null;
  return Math.abs(first - second) <= VALUE_ABSOLUTE_TOLERANCE;
}

/** Keep frontend C-rate comparison identical to backend protocol identity. */
export function normalizeProtocolRate(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const references = [
    ...COMMON_C_RATE_DENOMINATORS.map((denominator) => 1 / denominator),
    ...Array.from({ length: 100 }, (_, index) => Number(((index + 1) / 10).toFixed(1))),
    ...Array.from({ length: 100 }, (_, index) => index + 1),
  ];
  const nearest = references.reduce((best, reference) =>
    Math.abs(value - reference) < Math.abs(value - best) ? reference : best
  );
  return Math.abs(value - nearest) / nearest <= RATE_RELATIVE_TOLERANCE
    ? Number(nearest.toFixed(6))
    : Number(value.toFixed(6));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${formatNumber(seconds / 3600)} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${formatNumber(seconds / 60)} min`;
  return `${formatNumber(seconds)} s`;
}

function formatRate(rate: number): string {
  if (rate <= 0) return `${formatNumber(rate)} C`;
  if (rate < 1) {
    const reciprocal = 1 / rate;
    const rounded = Math.round(reciprocal);
    if (rounded >= 2 && Math.abs(reciprocal - rounded) / rounded <= RATE_RELATIVE_TOLERANCE) {
      return `C/${rounded}`;
    }
  }
  return `${formatNumber(rate)} C`;
}

function groupWorkflowToken(group: ProtocolGroup): unknown {
  return [
    group.kind,
    group.repeat_count,
    group.step_numbers.length,
    group.children.map(groupWorkflowToken),
  ];
}

function stepOrder(protocol: FileProtocol): Map<number, number> {
  return new Map(protocol.steps.map((step, index) => [step.number, index + 1]));
}

function conditionToken(
  step: ProtocolStep,
  strict: boolean,
  order: Map<number, number>,
): unknown[] {
  return (step.conditions ?? []).map((condition) => [
    condition.expression,
    condition.name,
    condition.value,
    condition.comparator_id,
    condition.global_user_id ?? null,
    condition.stores_as ?? null,
    condition.jump_step == null
      ? null
      : strict
        ? ["raw", condition.jump_step]
        : ["ordinal", order.get(condition.jump_step) ?? ["raw", condition.jump_step]],
  ]);
}

function structureToken(protocol: FileProtocol, strict: boolean): string {
  const order = stepOrder(protocol);
  const steps = protocol.steps.map((step) => ({
    number: strict ? step.number : null,
    type_id: step.type_id,
    direction: step.direction,
    loop_start_step: strict ? step.loop_start_step : null,
    loop_count: step.loop_count,
    conditions: conditionToken(step, strict, order),
  }));
  const groups = protocol.groups.map(groupWorkflowToken);
  return JSON.stringify({ steps, groups });
}

function rateToken(step: ProtocolStep): unknown[] {
  const current = step.c_rate == null ? step.current_ma : null;
  const stopCurrent = step.stop_c_rate == null ? step.stop_current_ma : null;
  return [normalizeProtocolRate(step.c_rate), current, normalizeProtocolRate(step.stop_c_rate), stopCurrent];
}

function ratesEqual(reference: FileProtocol, candidate: FileProtocol): boolean {
  if (reference.steps.length !== candidate.steps.length) return false;
  return reference.steps.every((step, index) => {
    const other = candidate.steps[index];
    const first = rateToken(step);
    const second = rateToken(other);
    return [0, 2].every((offset) => exactNumberEqual(first[offset] as number | null, second[offset] as number | null)) &&
      [1, 3].every((offset) => exactNumberEqual(first[offset] as number | null, second[offset] as number | null));
  });
}

function valuesEqual(
  reference: FileProtocol,
  candidate: FileProtocol,
  read: (step: ProtocolStep) => (number | null)[],
): boolean {
  if (reference.steps.length !== candidate.steps.length) return false;
  return reference.steps.every((step, index) => {
    const first = read(step);
    const second = read(candidate.steps[index]);
    return first.length === second.length && first.every((value, valueIndex) => exactNumberEqual(value, second[valueIndex]));
  });
}

function stepLabel(index: number): string {
  return `S${index + 1}`;
}

function conditionEvidence(step: ProtocolStep): string {
  return (step.conditions ?? [])
    .map((condition) => {
      const value = condition.value == null ? "?" : formatNumber(condition.value);
      const jump = condition.jump_step == null ? "no jump" : `jump S${condition.jump_step}`;
      return `if ${condition.expression}=${value}, ${jump}`;
    })
    .join("; ");
}

function groupEvidence(group: ProtocolGroup, order: Map<number, number>): string {
  const start = order.get(group.start_step) ?? group.start_step;
  const end = order.get(group.end_step) ?? group.end_step;
  const range = `S${start}-S${end}`;
  const label = group.kind === "repeated_block"
    ? `loop x${group.repeat_count} ${range}`
    : `sequence ${range}`;
  const children = group.children.map((child) => groupEvidence(child, order));
  return children.length > 0 ? `${label} [${children.join("; ")}]` : label;
}

function structureSummary(protocol: FileProtocol): string {
  const steps = protocol.steps.map((step, index) => {
    const condition = conditionEvidence(step);
    const loop = step.loop_count == null ? "" : ` x${step.loop_count}`;
    return `${stepLabel(index)} ${step.type}${loop}${condition ? ` (${condition})` : ""}`;
  });
  const blocks = protocol.groups.map((group) => groupEvidence(group, stepOrder(protocol)));
  return `flow ${steps.join(" -> ") || "Unavailable"} | ${blocks.join("; ") || "no blocks"}`;
}

function rateEvidence(step: ProtocolStep): string {
  const rate = step.c_rate == null
    ? step.current_ma == null
      ? null
      : `${formatNumber(Math.abs(step.current_ma))} mA`
    : formatRate(step.c_rate);
  const stop = step.stop_c_rate == null
    ? step.stop_current_ma == null
      ? null
      : `until ${formatNumber(Math.abs(step.stop_current_ma))} mA`
    : `until ${formatRate(step.stop_c_rate)}`;
  return [rate, stop].filter((value): value is string => value !== null).join("; ") || "Unavailable";
}

function ratesSummary(protocol: FileProtocol): string {
  return protocol.steps.map((step, index) => `${stepLabel(index)} ${rateEvidence(step)}`).join(" | ") || "Unavailable";
}

function timingSummary(protocol: FileProtocol): string {
  return protocol.steps
    .map((step, index) => `${stepLabel(index)} ${step.time_limit_s == null ? "Unavailable" : formatDuration(step.time_limit_s)}`)
    .join(" | ") || "Unavailable";
}

function voltageSummary(protocol: FileProtocol): string {
  return protocol.steps.map((step, index) => {
    const values: string[] = [];
    if (step.target_voltage_v != null) values.push(`hold ${formatNumber(step.target_voltage_v)} V`);
    if (step.stop_voltage_v != null) values.push(`stop ${formatNumber(step.stop_voltage_v)} V`);
    if (step.protection_lower_v != null || step.protection_upper_v != null) {
      values.push(`protect ${step.protection_lower_v == null ? "?" : formatNumber(step.protection_lower_v)}-${step.protection_upper_v == null ? "?" : formatNumber(step.protection_upper_v)} V`);
    }
    return `${stepLabel(index)} ${values.join("; ") || "Unavailable"}`;
  }).join(" | ") || "Unavailable";
}

function recordingSummary(protocol: FileProtocol): string {
  return protocol.steps.map((step, index) => {
    const values: string[] = [];
    if (step.record_interval_s != null) values.push(`${formatDuration(step.record_interval_s)} interval`);
    if (step.record_voltage_delta_v != null) values.push(`${formatNumber(step.record_voltage_delta_v)} V delta`);
    return `${stepLabel(index)} ${values.join("; ") || "Unavailable"}`;
  }).join(" | ") || "Unavailable";
}

function dimensionEqual(
  key: ProtocolComparisonDimension,
  reference: FileProtocol,
  candidate: FileProtocol,
  mode: ProtocolComparisonMode,
): boolean {
  switch (key) {
    case "structure":
      return structureToken(reference, mode === "strict") === structureToken(candidate, mode === "strict");
    case "rates":
      return ratesEqual(reference, candidate);
    case "timing":
      return valuesEqual(reference, candidate, (step) => [step.time_limit_s]);
    case "voltage":
      return valuesEqual(reference, candidate, (step) => [
        step.target_voltage_v,
        step.stop_voltage_v,
        step.protection_lower_v,
        step.protection_upper_v,
      ]);
    case "recording":
      return valuesEqual(reference, candidate, (step) => [
        step.record_interval_s,
        step.record_voltage_delta_v,
      ]);
  }
}

const ROW_DEFINITIONS: {
  key: ProtocolComparisonDimension;
  label: string;
  summary: (protocol: FileProtocol) => string;
}[] = [
  { key: "structure", label: "Step flow and loops", summary: structureSummary },
  { key: "rates", label: "C-rate / pulse schedule", summary: ratesSummary },
  { key: "timing", label: "Rest and hold timing", summary: timingSummary },
  { key: "voltage", label: "Voltage cutoffs and protection", summary: voltageSummary },
  { key: "recording", label: "Recording settings", summary: recordingSummary },
];

export function compareProtocolFamilies(
  reference: FileProtocol,
  candidate: FileProtocol,
  mode: ProtocolComparisonMode,
  custom: ProtocolComparisonDimensions = WORKFLOW_COMPARISON_DIMENSIONS,
): ProtocolComparisonResult {
  const dimensions = comparisonDimensionsFor(mode, custom);
  const rows = ROW_DEFINITIONS.map(({ key, label, summary }) => ({
    key,
    label,
    reference: summary(reference),
    candidate: summary(candidate),
    status: dimensions[key]
      ? dimensionEqual(key, reference, candidate, mode) ? "same" : "different"
      : "ignored",
  } satisfies ProtocolComparisonRow));
  const strictIdentityMatch = mode !== "strict" || reference.signature === candidate.signature;
  const differingDimensions = DIMENSION_ORDER.filter((key) => rows.some((row) => row.key === key && row.status === "different"));
  const hasSelectedDimension = DIMENSION_ORDER.some((key) => dimensions[key]);
  return {
    mode,
    dimensions,
    rows,
    comparable: hasSelectedDimension && strictIdentityMatch && differingDimensions.length === 0,
    strictIdentityMatch,
    differingDimensions,
  };
}
