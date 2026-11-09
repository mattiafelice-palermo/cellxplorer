import type { Badge } from "./api";
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
      for (const limitation of source.limitations ?? []) if (limitation.message) qualifications.add(limitation.message);
    } else if (!context || context.cycleBased) {
      qualifications.add(source.scientific_interpretation === "pending" ? "scientific interpretation pending; cycle-based quantities unavailable" : "unverified cycle identity; cycle-based quantities unavailable");
    }
  }
  const count = sources.filter((source) => source.scientific_interpretation === "verified" ? source.limitations?.length : !context || context.cycleBased).length;
  return qualifications.size ? `${count} source${count === 1 ? "" : "s"}: ${[...qualifications].join(" · ")}` : null;
}
