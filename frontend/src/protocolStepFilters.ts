import type { ProtocolStep } from "./api";

/**
 * Filtering for the protocol step list.
 *
 * A hundred-step protocol is only navigable if you can ask for "every step
 * above 1C" or "everything that stops at 2.8 V". Comparisons run against the
 * numeric fields the backend already provides rather than the formatted
 * strings, so `> 1C` means what it says instead of comparing "C/3" to "1.5C"
 * alphabetically.
 */

export type FilterOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains";

export type FilterField =
  | "number"
  | "type"
  | "rate"
  | "current"
  | "cutoff"
  | "until"
  | "maxtime"
  | "condition";

export interface StepFilter {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export const FILTER_FIELDS: {
  value: FilterField;
  label: string;
  numeric: boolean;
  hint?: string;
}[] = [
  { value: "number", label: "Step number", numeric: true },
  { value: "type", label: "Step type", numeric: false, hint: "charge, rest, CCCV…" },
  { value: "rate", label: "Rate (C)", numeric: true, hint: "0.33 or C/3 or 1.5C" },
  { value: "current", label: "Current (mA)", numeric: true },
  { value: "cutoff", label: "Cut-off (V)", numeric: true },
  { value: "until", label: "Until (C)", numeric: true, hint: "taper, e.g. C/20" },
  { value: "maxtime", label: "Max time", numeric: true, hint: "30s, 45min, 2h" },
  { value: "condition", label: "Condition", numeric: false, hint: "User1, ChargeAh…" },
];

const NUMERIC_OPERATORS: FilterOperator[] = ["=", "!=", "<", "<=", ">", ">="];
const TEXT_OPERATORS: FilterOperator[] = ["contains", "=", "!="];

export function operatorsFor(field: FilterField): FilterOperator[] {
  return FILTER_FIELDS.find((entry) => entry.value === field)?.numeric
    ? NUMERIC_OPERATORS
    : TEXT_OPERATORS;
}

/**
 * Read a C-rate the way a battery scientist writes one.
 *
 * "C/3", "1.5C" and "0.333" all mean the same thing, and requiring the decimal
 * would make the filter unusable for the notation actually used everywhere
 * else in the app.
 */
export function parseCRate(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  const fraction = /^c\s*\/\s*([\d.]+)$/i.exec(text);
  if (fraction) {
    const denominator = Number(fraction[1]);
    return Number.isFinite(denominator) && denominator > 0 ? 1 / denominator : null;
  }
  const multiple = /^([\d.]+)\s*c$/i.exec(text);
  if (multiple) {
    const value = Number(multiple[1]);
    return Number.isFinite(value) ? value : null;
  }
  const plain = Number(text);
  return Number.isFinite(plain) ? plain : null;
}

/** Read a duration as seconds; bare numbers are seconds. */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const match = /^([\d.]+)\s*(ms|s|sec|m|min|h|hr)?$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "h":
    case "hr":
      return value * 3600;
    case "m":
    case "min":
      return value * 60;
    case "ms":
      return value / 1000;
    default:
      return value;
  }
}

/** The step's cut-off: where a CC step is driving, or where a CV step holds. */
function cutoffVolts(step: ProtocolStep): number | null {
  return step.stop_voltage_v ?? step.target_voltage_v ?? null;
}

function numericValue(step: ProtocolStep, field: FilterField): number | null {
  switch (field) {
    case "number":
      return step.number;
    case "rate":
      return step.c_rate ?? null;
    case "current":
      return step.current_ma ?? null;
    case "cutoff":
      return cutoffVolts(step);
    case "until":
      return step.stop_c_rate ?? null;
    case "maxtime":
      return step.time_limit_s ?? null;
    default:
      return null;
  }
}

function textValue(step: ProtocolStep, field: FilterField): string {
  if (field === "type") return `${step.type} ${step.direction}`;
  if (field === "condition") {
    return (step.conditions ?? [])
      .map((condition) => `${condition.expression} ${condition.name ?? ""}`)
      .join(" ");
  }
  return "";
}

function parseFilterValue(field: FilterField, raw: string): number | null {
  if (field === "rate" || field === "until") return parseCRate(raw);
  if (field === "maxtime") return parseDuration(raw);
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * How close counts as equal, per field.
 *
 * C-rates are usually derived from current and nominal capacity, so a step
 * shown as "C/3" is really 0.33353. Matching only the exact fraction would
 * mean `= C/3` never finds the step the reader is looking straight at, so
 * rate comparisons use the same 2% the display rounding allows. Step numbers,
 * voltages and durations are stated exactly in the file and get a tight
 * epsilon — 3.65 V must not match 3.72 V.
 */
function equalityTolerance(field: FilterField, expected: number): number {
  const magnitude = Math.abs(expected);
  if (field === "rate" || field === "until") {
    // Relative 2% handles the usual case — 1.49937 matches "1.5C" — and the
    // small absolute floor catches rates written as coarse fractions. It is
    // deliberately not the 0.05C a flat allowance would suggest: C/20 is
    // itself 0.05, so that window would reach 0.1C and merge C/20 with C/10.
    return Math.max(magnitude * 0.02, 0.02);
  }
  return Math.max(magnitude * 1e-6, 1e-9);
}

function compare(
  actual: number,
  operator: FilterOperator,
  expected: number,
  field: FilterField
): boolean {
  const tolerance = equalityTolerance(field, expected);
  switch (operator) {
    case "=":
      return Math.abs(actual - expected) <= tolerance;
    case "!=":
      return Math.abs(actual - expected) > tolerance;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected + tolerance;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected - tolerance;
    default:
      return false;
  }
}

export function stepMatchesFilter(step: ProtocolStep, filter: StepFilter): boolean {
  if (!filter.value.trim()) return true;
  const numeric = FILTER_FIELDS.find((entry) => entry.value === filter.field)?.numeric;

  if (numeric) {
    const expected = parseFilterValue(filter.field, filter.value);
    if (expected === null) return true; // an unreadable value filters nothing
    const actual = numericValue(step, filter.field);
    // A step with no value for the field cannot satisfy a comparison. Saying
    // "rate > 1C" must not return rests that have no rate at all.
    if (actual === null) return false;
    return compare(actual, filter.operator, expected, filter.field);
  }

  const haystack = textValue(step, filter.field).toLowerCase();
  const needle = filter.value.trim().toLowerCase();
  if (filter.operator === "contains") return haystack.includes(needle);
  if (filter.operator === "=") return haystack.split(/\s+/).includes(needle);
  return !haystack.includes(needle);
}

/** Free-text search across everything a reader can see on the row. */
export function stepMatchesQuery(step: ProtocolStep, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    step.number,
    step.type,
    step.direction,
    step.summary,
    ...(step.facts ?? []).map((fact) => `${fact.label} ${fact.value}`),
    ...(step.conditions ?? []).map((condition) => condition.expression),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function stepMatches(step: ProtocolStep, filters: StepFilter[], query: string): boolean {
  // Filters combine with AND: each one narrows the list further.
  return stepMatchesQuery(step, query) && filters.every((f) => stepMatchesFilter(step, f));
}

/**
 * C-rate to current, for the few rates a reader is most likely to need.
 *
 * Every rate in the list is derived from the nominal capacity, so showing the
 * conversion once removes the mental arithmetic from every row.
 */
export function cRateExamples(
  nominalCapacityMah: number | null | undefined
): { label: string; current: string }[] {
  if (!nominalCapacityMah || nominalCapacityMah <= 0) return [];
  const rates: { label: string; factor: number }[] = [
    { label: "C/20", factor: 1 / 20 },
    { label: "C/10", factor: 1 / 10 },
    { label: "C/3", factor: 1 / 3 },
    { label: "C/2", factor: 1 / 2 },
    { label: "1C", factor: 1 },
    { label: "1.5C", factor: 1.5 },
  ];
  return rates.map(({ label, factor }) => {
    const ma = nominalCapacityMah * factor;
    return { label, current: ma >= 100 ? `${ma.toFixed(0)} mA` : `${ma.toFixed(1)} mA` };
  });
}
