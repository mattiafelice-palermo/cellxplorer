import type { ChargeBalanceReference } from "../../../../../api.ts";

/** The backend calculates SOC. The display can prompt as soon as a required input is cleared. */
export function hasSocCalibration(reference?: ChargeBalanceReference): boolean {
  const start = reference?.start_soc_pct;
  if (start == null || !Number.isFinite(start) || start < 0 || start > 100) return false;
  const positive = (value?: number | null): value is number => value != null && Number.isFinite(value) && value > 0;
  if (reference?.basis === "mass") {
    const specific = reference.specific_capacity_mah_g === undefined ? 820 : reference.specific_capacity_mah_g;
    if (!positive(reference.mass_mg) || !positive(specific)) return false;
    return positive(reference.mass_mg / 1000 * specific);
  }
  return positive(reference?.capacity_mah);
}
