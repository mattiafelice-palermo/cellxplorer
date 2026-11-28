import type { Badge } from "./api";
type SourceWarning = NonNullable<Badge["limitations"]>[number];

export function affectedQuantity(warning: SourceWarning): string | undefined {
  if (warning.code !== "biologic_quantity_unavailable") return undefined;
  // Previously cached MPR warnings only stored the reader's formatted sentence.
  return warning.quantity ?? /^\S+ (cycles|capacity|current) could not be fully verified\./i.exec(warning.message)?.[1].toLowerCase();
}

export function sourceWarningText(warning: SourceWarning): string {
  switch (affectedQuantity(warning)) {
    case "cycles": return "CellXplorer could not read the instrument’s cycle numbers for this file.";
    case "capacity": return "This file does not give a reliable capacity. Capacity and efficiency are unavailable for the affected measurements.";
    case "current": return "Some current readings are missing or unreliable. Those points are left out of the current curve.";
    default: return warning.code === "biologic_quantity_unavailable"
      ? "Some measurements in this file could not be used. Open the source details for more information."
      : warning.message;
  }
}
export function sourceDetailsHref(source: Pick<Badge, "cell_id" | "source_id">): string {
  return `/?cell=${source.cell_id}&cellTab=files${source.source_id != null ? `&sourceId=${source.source_id}` : ""}`;
}
export function sourceLimitations(badges: readonly Badge[] = []): Badge[] {
  const seen = new Set<string>();
  return badges.filter(badge => {
    if (badge.kind !== "exploratory_mpr" || (badge.scientific_interpretation === "verified" && !badge.limitations?.length)) return false;
    const key = `${badge.cell_id ?? ""}:${badge.source_id ?? badge.file ?? badge.detail}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export type LimitationFigureContext = { cellIds: number[]; cycleBased: boolean };
export function sourceLimitationFigureText(badges: readonly Badge[] = [], context?: LimitationFigureContext): string | null {
  const sources = sourceLimitations(badges).filter((source) => !context || (source.cell_id != null && context.cellIds.includes(source.cell_id)));
  if (!sources.length) return null;
  const qualifications = new Set<string>();
  for (const source of sources) {
    if (source.scientific_interpretation === "verified") {
      for (const limitation of source.limitations ?? []) {
        if (context && !context.cycleBased && affectedQuantity(limitation) === "cycles") continue;
        if (affectedQuantity(limitation) === "cycles" && source.cell_id != null &&
            badges.some(b => b.cell_id === source.cell_id && b.kind === "cycles_detected")) {
          qualifications.add("Some cycles were counted from the measured current.");
        } else if (limitation.message) qualifications.add(sourceWarningText(limitation));
      }
    } else if (!context || context.cycleBased) {
      qualifications.add(source.scientific_interpretation === "pending" ? "scientific interpretation pending; cycle-based quantities unavailable" : "unverified cycle identity; cycle-based quantities unavailable");
    }
  }
  const count = sources.filter((source) => source.scientific_interpretation === "verified"
    ? source.limitations?.some(w => !context || context.cycleBased || affectedQuantity(w) !== "cycles")
    : !context || context.cycleBased).length;
  return qualifications.size ? `${count} source${count === 1 ? "" : "s"}: ${[...qualifications].join(" · ")}` : null;
}
