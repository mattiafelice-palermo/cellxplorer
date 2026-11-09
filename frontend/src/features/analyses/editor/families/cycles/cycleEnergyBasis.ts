import type { EnergyProvenance, EnergyProvenanceEntry } from "../../../../../api";
import type * as Plotly from "plotly.js";

function basisLabel(basis: string): string {
  return basis === "calculated" ? "calculated net ∫V dQ"
    : basis === "mixed" ? "mixed measured / calculated net ∫V dQ" : basis;
}

export function cycleEnergyBasis(provenance: EnergyProvenance | undefined, quantity: string, index: number, contributorBasis?: Pick<EnergyProvenanceEntry, "basis" | "reason">[]): string {
  const contributor = contributorBasis?.[index];
  if (quantity.includes("energy") && contributor) return `${basisLabel(contributor.basis)}${contributor.reason ? ` (${contributor.reason})` : ""}`;
  if (!quantity.includes("energy") || !provenance) return "";
  const cumulative = /^(cumulative_|energy_throughput|net_energy_imbalance)/.test(quantity);
  const directions = quantity.includes("discharge") ? ["discharge"] as const
    : quantity.includes("charge") ? ["charge"] as const : ["charge", "discharge"] as const;
  return directions.map((direction) => {
    const entry = provenance[direction]?.[index];
    if (!entry) return "";
    const basis = cumulative ? entry.cumulative_basis : entry.basis;
    const reason = cumulative ? entry.cumulative_reason : entry.reason;
    const label = basisLabel(basis);
    return `${direction}: ${label}${reason ? ` (${reason})` : ""}`;
  }).filter(Boolean).join("; ");
}

export function takeEnergyProvenance(provenance: EnergyProvenance | undefined, indices: readonly number[]): EnergyProvenance | undefined {
  if (!provenance) return undefined;
  return { charge: indices.map((i) => provenance.charge[i]), discharge: indices.map((i) => provenance.discharge[i]) };
}

export function energyUnavailableReasons(provenance: EnergyProvenance | undefined, quantity: string): string[] {
  if (!quantity.includes("energy") || !provenance) return [];
  const cumulative = /^(cumulative_|energy_throughput|net_energy_imbalance)/.test(quantity);
  const directions = quantity.includes("discharge") ? ["discharge"] as const
    : quantity.includes("charge") ? ["charge"] as const : ["charge", "discharge"] as const;
  return [...new Set(directions.flatMap((direction) => provenance[direction].flatMap((entry) => {
    const reason = cumulative ? entry.cumulative_reason : entry.reason;
    return reason ? [`${direction}: ${reason}`] : [];
  })))];
}

/** Retained with the shared layout in saved, image and portable figures. */
export function withCycleEnergyNotice(layout: Partial<Plotly.Layout>, traces: Plotly.Data[], quantity: string): Partial<Plotly.Layout> {
  if (!quantity.includes("energy")) return layout;
  const calculated = traces.some((trace) => {
    const data = trace as { visible?: unknown; x?: unknown[]; y?: unknown[]; customdata?: unknown[][] };
    return data.visible !== false && data.visible !== "legendonly" && data.y?.some((y, index) => {
      const x = data.x?.[index];
      return typeof y === "number" && Number.isFinite(y) && typeof x === "number" && Number.isFinite(x)
        && data.customdata?.[index]?.some((v) => typeof v === "string" && v.includes("calculated net ∫V dQ"));
    });
  });
  if (!calculated) return layout;
  const shift = Math.max(12, ...(layout.annotations ?? []).filter((a) => a.yref === "paper" && a.y === 1).map((a) => (a.yshift ?? 0) + 17));
  return { ...layout, margin: { ...layout.margin, t: Math.max(layout.margin?.t ?? 0, shift + 24) },
    annotations: [...(layout.annotations ?? []), { text: "Calculated net energy: ∫V dQ using signed cell voltage", xref: "paper", yref: "paper", x: 0, y: 1,
      xanchor: "left", yanchor: "bottom", yshift: shift, showarrow: false, font: { size: 10 } }] };
}
