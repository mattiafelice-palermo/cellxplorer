import type { Provenance } from "../../../../api";

export interface ParserSourceBreakdownEntry {
  position: number;
  filename: string | null;
  parserVersion: string;
}

/**
 * Per-source parser identity breakdown for the Provenance panel's "mixed"
 * sentinel (Spec 040.3's `analysis_engine.display_parser_version`). When an
 * analysis' contributing sources carry different effective parser
 * identities, the compact saved-provenance summary is the literal string
 * `"mixed"` rather than an arbitrarily chosen source's value — truthful,
 * but useless on its own without a route to which source is which.
 *
 * `Provenance["sources"][].files[]` already pins the identity per
 * contributing source (Spec 040.3); this joins it against the same entry's
 * `source_descriptors` for a human-readable filename when available and
 * falls back to a bare position when it is not (a legacy pre-040.3 saved
 * analysis may carry `files` without descriptors after normalization).
 * Pure and presentation-only: it never recomputes or infers an identity.
 */
export function parserSourceBreakdown(
  sources: Provenance["sources"] | undefined
): ParserSourceBreakdownEntry[] {
  if (!sources) return [];
  const entries: ParserSourceBreakdownEntry[] = [];
  for (const source of sources) {
    const filenameByHash = new Map(
      (source.source_descriptors ?? []).map((descriptor) => [
        descriptor.source_hash,
        descriptor.filename,
      ])
    );
    for (const file of source.files ?? []) {
      entries.push({
        position: file.position,
        filename: filenameByHash.get(file.hash) ?? null,
        parserVersion: file.parser_version,
      });
    }
  }
  return entries;
}
