import type { AnalysisSpec, ComputeResult } from "../../../../../api.ts";
import { isAnalysisSampleHidden } from "../../policies/analysisVisibility.ts";

export function cycleAvailability(result: ComputeResult | undefined, spec: AnalysisSpec) {
  const cells = (result?.cell_series ?? []).filter((cell) => !isAnalysisSampleHidden(spec, cell));
  const missingReference = cells.length > 0 && cells.every((cell) => !(cell.fec_reference_mah != null && Number.isFinite(cell.fec_reference_mah) && cell.fec_reference_mah > 0));
  const quantity = spec.presentation.quantity ?? "discharge_capacity";
  const info = result?.quantities.find((item) => item.key === quantity);
  const energy = /energy/.test(quantity);
  const noEnergy = energy && cells.length > 0 && cells.every((cell) => !(cell.quantities[info?.column ?? ""] ?? []).some((value) => value != null && Number.isFinite(value)));
  return {
    fecDisabled: missingReference,
    fecReason: missingReference ? "FEC requires a positive nominal capacity in Cell details. Energy quantities do not use this reference." : null,
    energyReason: noEnergy ? "This energy quantity has no plottable values. Cumulative energy stops at the first missing required energy value. Energy is independent of nominal capacity." : null,
  };
}
