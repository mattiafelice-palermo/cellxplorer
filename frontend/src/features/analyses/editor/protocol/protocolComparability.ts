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

export function comparisonDimensionsFor(
  mode: ProtocolComparisonMode,
  custom: ProtocolComparisonDimensions = WORKFLOW_COMPARISON_DIMENSIONS,
): ProtocolComparisonDimensions {
  if (mode === "strict") return { ...STRICT_COMPARISON_DIMENSIONS };
  if (mode === "workflow") return { ...WORKFLOW_COMPARISON_DIMENSIONS };
  return { ...custom };
}

function numberEqual(
  first: number | null | undefined,
  second: number | null | undefined,
  tolerance: number,
): boolean {
  if (first == null || second == null) return first == null && second == null;
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= tolerance * scale;
}

function exactNumberEqual(
  first: number | null | undefined,
  second: number | null | undefined,
): boolean {
  if (first == null || second == null) return first == null && second == null;
  return Math.abs(first - second) <= VALUE_ABSOLUTE_TOLERANCE;
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

function compactList(values: string[], empty = "Unavailable"): string {
  const distinct = unique(values);
  if (distinct.length === 0) return empty;
  if (distinct.length <= 4) return distinct.join(", ");
  return `${distinct.slice(0, 4).join(", ")} +${distinct.length - 4} more`;
}

function groupWorkflowToken(group: ProtocolGroup): unknown {
  return [
    group.kind,
    group.repeat_count,
    group.step_numbers.length,
    group.children.map(groupWorkflowToken),
  ];
}

function conditionToken(step: ProtocolStep, includeJump: boolean): unknown[] {
  return (step.conditions ?? []).map((condition) => [
    condition.expression,
    condition.name,
    condition.comparator_id,
    includeJump ? condition.jump_step : null,
  ]);
}

function structureToken(protocol: FileProtocol, strict: boolean): string {
  const steps = protocol.steps.map((step) => ({
    number: strict ? step.number : null,
    type_id: step.type_id,
    direction: step.direction,
    loop_start_step: strict ? step.loop_start_step : null,
    loop_count: step.loop_count,
    conditions: conditionToken(step, strict),
  }));
  const groups = protocol.groups.map(groupWorkflowToken);
  return JSON.stringify({ steps, groups });
}

function rateToken(step: ProtocolStep): unknown[] {
  const current = step.c_rate == null ? step.current_ma : null;
  const stopCurrent = step.stop_c_rate == null ? step.stop_current_ma : null;
  return [step.c_rate, current, step.stop_c_rate, stopCurrent];
}

function ratesEqual(reference: FileProtocol, candidate: FileProtocol): boolean {
  if (reference.steps.length !== candidate.steps.length) return false;
  return reference.steps.every((step, index) => {
    const other = candidate.steps[index];
    const first = rateToken(step);
    const second = rateToken(other);
    return [0, 2].every((offset) => numberEqual(first[offset] as number | null, second[offset] as number | null, RATE_RELATIVE_TOLERANCE)) &&
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

function structureSummary(protocol: FileProtocol): string {
  const groups = protocol.groups.length;
  return `${protocol.n_executable_steps} executable steps · ${groups} ${groups === 1 ? "block" : "blocks"}`;
}

function ratesSummary(protocol: FileProtocol): string {
  const values = protocol.steps.flatMap((step) => {
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
    return [rate, stop].filter((value): value is string => value !== null);
  });
  return compactList(values);
}

function timingSummary(protocol: FileProtocol): string {
  return compactList(
    protocol.steps
      .map((step) => step.time_limit_s)
      .filter((value): value is number => value != null)
      .map(formatDuration),
  );
}

function voltageSummary(protocol: FileProtocol): string {
  const values = protocol.steps.flatMap((step) => {
    const result: string[] = [];
    if (step.target_voltage_v != null) result.push(`hold ${formatNumber(step.target_voltage_v)} V`);
    if (step.stop_voltage_v != null) result.push(`stop ${formatNumber(step.stop_voltage_v)} V`);
    if (step.protection_lower_v != null || step.protection_upper_v != null) {
      result.push(`protect ${step.protection_lower_v ?? "?"}–${step.protection_upper_v ?? "?"} V`);
    }
    return result;
  });
  return compactList(values);
}

function recordingSummary(protocol: FileProtocol): string {
  const intervals = protocol.steps
    .map((step) => step.record_interval_s)
    .filter((value): value is number => value != null)
    .map((value) => `${formatDuration(value)} interval`);
  const deltas = protocol.steps
    .map((step) => step.record_voltage_delta_v)
    .filter((value): value is number => value != null)
    .map((value) => `Δ${formatNumber(value)} V`);
  return compactList([...intervals, ...deltas]);
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
  return {
    mode,
    dimensions,
    rows,
    comparable: strictIdentityMatch && differingDimensions.length === 0,
    strictIdentityMatch,
    differingDimensions,
  };
}
