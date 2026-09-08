/**
 * Presentation-only plot-style accordion memory.
 *
 * This intentionally stays outside the persisted AnalysisSpec: it describes
 * how a user has the editor arranged, not how the scientific plot is defined.
 */
const rememberedPlotStyleSections = new Map<string, string[]>();

export function plotStyleKeyFor(
  analysisId: number,
  tab: string,
  plotId: string | null,
  draftPlotSessionId: string,
): string {
  return `analysis:${analysisId}:${tab}:${plotId ?? `draft:${draftPlotSessionId}`}`;
}

export function readRememberedPlotStyleSections(plotKey?: string): string[] {
  return plotKey ? [...(rememberedPlotStyleSections.get(plotKey) ?? [])] : [];
}

export function rememberPlotStyleSections(
  plotKey: string | undefined,
  sections: readonly string[],
): void {
  if (plotKey) rememberedPlotStyleSections.set(plotKey, [...sections]);
}

/** Copy state when a draft receives its saved-plot identity. */
export function copyRememberedPlotStyleSections(
  sourcePlotKey: string | undefined,
  targetPlotKey: string | undefined,
): void {
  if (!targetPlotKey || sourcePlotKey === targetPlotKey) return;
  rememberPlotStyleSections(targetPlotKey, readRememberedPlotStyleSections(sourcePlotKey));
}
