export const DEFAULT_ELECTRODE_LABELS = {
  voltage: ["Full cell", "Cell"],
  working_potential: ["Working electrode", "Cathode", "Anode"],
  counter_potential: ["Counter electrode", "Anode", "Cathode"],
};
export type ElectrodeDisplayLabels = typeof DEFAULT_ELECTRODE_LABELS;
export const FIXED_ELECTRODE_LABELS = {
  voltage: "Full cell", working_potential: "Working electrode", counter_potential: "Counter electrode",
};
import type { SeriesStyleOverride } from "./api";


/** Imported presentation JSON must not be able to break a plot or its editor. */
export function normalizeChannelNaming(value: unknown): NonNullable<SeriesStyleOverride["channel_naming"]> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as NonNullable<SeriesStyleOverride["channel_naming"]>;
  if (typeof candidate.enabled !== "boolean" || typeof candidate.base_name !== "string"
    || !candidate.labels || typeof candidate.labels !== "object"
    || Object.keys(FIXED_ELECTRODE_LABELS).some(channel => {
      const label = candidate.labels[channel as keyof typeof FIXED_ELECTRODE_LABELS];
      return typeof label !== "string" || !label.trim() || label.length > 80;
    })) return null;
  return { ...candidate, invert_electrode_labels: candidate.invert_electrode_labels === true };
}
