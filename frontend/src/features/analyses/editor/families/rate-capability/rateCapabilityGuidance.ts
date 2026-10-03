import type { RateCapabilityComputationSpec } from "../../../../../api";

export interface RateCapabilityRecognitionEvidence {
  missing_nominal_rate_step_count: number;
  families: Record<"charge" | "discharge", {
    execution_count: number;
    completed_rate_count: number;
    unverified_voltage_execution_count: number;
  }>;
}

export interface RateCapabilityGuidanceCell {
  cell_id: number;
  cell_name: string;
  recognition_evidence?: RateCapabilityRecognitionEvidence;
  families: Record<"charge" | "discharge", { status: "matched" | "not_detected" }>;
}

export function rateCapabilityLimits(config: RateCapabilityComputationSpec) {
  return {
    minimum: Math.max(2, Math.trunc(config.min_points)),
    voltage: Number(Math.max(0.001, config.cutoff_tolerance_v).toPrecision(4)),
    ratePercent: Number((Math.max(0.001, config.rate_tolerance_fraction) * 100).toPrecision(4)),
  };
}

export function rateCapabilityNoMatchGuidance(config: RateCapabilityComputationSpec) {
  const { minimum } = rateCapabilityLimits(config);
  return `No supported rate-capability sweep matched. Look for at least ${minimum} distinct charging or discharging speeds while the opposite direction stays fixed, with completed voltage limits. Review recognition rules and inspect the protocol steps.`;
}

/** Evidence is descriptive: a short rate list does not prove a compatible sweep. */
export function rateCapabilityEvidenceMessages(
  cells: RateCapabilityGuidanceCell[],
  config: RateCapabilityComputationSpec,
) {
  const { minimum, voltage, ratePercent } = rateCapabilityLimits(config);
  return cells.flatMap((cell) => {
    const unmatched = (["charge", "discharge"] as const).filter(
      (family) => config.families[family].enabled && cell.families[family].status === "not_detected",
    );
    const evidence = cell.recognition_evidence;
    if (!evidence || !unmatched.length) return [];
    const messages: string[] = [];
    const missing = evidence.missing_nominal_rate_step_count;
    if (missing > 0) {
      messages.push(`${cell.cell_name}: ${missing} current-controlled protocol ${missing === 1 ? "step has" : "steps have"} no C-rate and no usable nominal capacity for conversion. Set nominal capacity in the cell metadata to convert those currents to C-rates. Steps with declared C-rates can already be used.`);
    }
    for (const family of unmatched) {
      const facts = evidence.families[family];
      if (facts.completed_rate_count > 0 && facts.completed_rate_count < minimum) {
        messages.push(`${cell.cell_name} — ${family}: only ${facts.completed_rate_count} distinct ${facts.completed_rate_count === 1 ? "rate has" : "rates have"} verified completed pairs; the current minimum is ${minimum}. Rates are compared using ${ratePercent}% tolerance, with a minimum difference allowance of 0.01C.`);
      }
      if (facts.unverified_voltage_execution_count > 0) {
        const count = facts.unverified_voltage_execution_count;
        messages.push(`${cell.cell_name} — ${family}: voltage completion could not be verified for ${count} executed ${count === 1 ? "measurement and its" : "measurements and their"} paired phases using ${voltage} V tolerance at the declared limits. These measurements are excluded; this does not establish why they ended.`);
      }
    }
    return messages;
  });
}
