/**
 * Which stored Cell metadata belongs in the flat metadata list.
 *
 * Two prefixes are owned by other surfaces:
 *
 * - `override.*` is rendered by the scientific rows, with source/override/effective
 *   values spelled out, so repeating the stored strings here is noise.
 * - `raw.*` is a legacy artifact of imports that flattened the whole file header
 *   onto the Cell. The header now lives once per source in `SourceFile.header_meta`
 *   and is shown in the per-source sections, so listing these too would make an
 *   old cell display the same ~977 fields twice.
 *
 * Cells imported after that change simply have no `raw.*` rows, which is why the
 * filter is a display rule rather than a migration.
 */
const HIDDEN_PREFIXES = ["override.", "raw."];

export function visibleCellMetadataEntries(
  metadata: Record<string, string>,
): [string, string][] {
  return Object.entries(metadata).filter(
    ([key]) => !HIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}
