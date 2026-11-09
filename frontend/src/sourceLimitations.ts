import type { Badge } from "./api";
export function sourceLimitations(badges: readonly Badge[] = []): Badge[] {
  const seen = new Set<string>();
  return badges.filter(badge => {
    if (badge.kind !== "exploratory_mpr" || badge.scientific_interpretation === "verified") return false;
    const key = `${badge.cell_id ?? ""}:${badge.source_id ?? badge.file ?? badge.detail}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function sourceLimitationFigureText(badges: readonly Badge[] = []): string | null {
  const sources = sourceLimitations(badges);
  if (!sources.length) return null;
  const pending = sources.every(source => source.scientific_interpretation === "pending");
  return `${sources.length} source${sources.length === 1 ? "" : "s"}: ${pending ? "scientific interpretation pending" : "unverified cycle identity"}; cycle-based quantities unavailable`;
}
