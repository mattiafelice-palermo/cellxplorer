import type { AnalysisSpec, ComputeResult } from "../../../../../api.ts";
import { isAnalysisSampleHidden, isSeriesHidden } from "../../policies/analysisVisibility.ts";
import { composeSeriesKey } from "../../plotting/seriesStyling.ts";

const CYCLES_VISIBILITY_PREFIX = "cycles:";

export const cycleVisibilityKey = (seriesKey: string) =>
  `${CYCLES_VISIBILITY_PREFIX}${seriesKey}`;

export const cycleCeSeriesKey = (sourceKey: string) =>
  composeSeriesKey({ sourceKey, axis: "y2", measure: "coulombic_efficiency" });

export const cycleCeVisibilityKey = (sourceKey: string) =>
  cycleVisibilityKey(cycleCeSeriesKey(sourceKey));

export function cycleTraceVisibility(
  spec: AnalysisSpec,
  sourceKey: string,
): { primaryVisible: boolean; ceVisible: boolean } {
  return {
    primaryVisible: !isSeriesHidden(spec, cycleVisibilityKey(sourceKey)),
    ceVisible: !isSeriesHidden(spec, cycleCeVisibilityKey(sourceKey)),
  };
}

type CycleVisibilityCandidate = { key: string; label: string };

/**
 * Build first-class Cycles visibility targets from the already display-filtered
 * result. Plotly helper traces are deliberately not represented here.
 */
export function cycleSeriesVisibilityCandidatesForResult(
  result: ComputeResult,
  spec: AnalysisSpec,
  options: {
    column: string;
    showIndividual: boolean;
    includeCoulombicEfficiency: boolean;
  },
): CycleVisibilityCandidate[] {
  const candidates: CycleVisibilityCandidate[] = [];
  for (const aggregate of result.aggregates) {
    const quantity = aggregate.quantities[options.column];
    if (!quantity || !quantity.mean.some((value) => value !== null && Number.isFinite(value))) {
      continue;
    }
    const sourceKey = `g${aggregate.group_id}`;
    candidates.push({
      key: cycleVisibilityKey(sourceKey),
      label: `${aggregate.group_name} mean`,
    });
    const ce = aggregate.quantities["coulombic_efficiency_pct"];
    if (
      options.includeCoulombicEfficiency &&
      ce?.mean.some((value) => value !== null && Number.isFinite(value))
    ) {
      candidates.push({
        key: cycleCeVisibilityKey(sourceKey),
        label: `${aggregate.group_name} CE`,
      });
    }
  }
  for (const series of result.cell_series) {
    if (
      isAnalysisSampleHidden(spec, series) ||
      (series.group_id !== null && !options.showIndividual) ||
      !series.quantities[options.column]?.some(
        (value) => value !== null && Number.isFinite(value),
      )
    ) {
      continue;
    }
    const sourceKey = `c${series.cell_id}`;
    candidates.push({ key: cycleVisibilityKey(sourceKey), label: series.label });
    const ce = series.quantities["coulombic_efficiency_pct"];
    if (
      options.includeCoulombicEfficiency &&
      ce?.some((value) => value !== null && Number.isFinite(value))
    ) {
      candidates.push({
        key: cycleCeVisibilityKey(sourceKey),
        label: `${series.label} CE`,
      });
    }
  }
  return candidates;
}
