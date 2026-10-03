import tinycolor from "tinycolor2";
import type { CycleShadingConfig, PlotCycleShading } from "../../../../api";
import { hexToHsl, hslToHex } from "./paletteDraft.ts";

export const MAX_CYCLE_SHADING_BANDS = 20;
export const MAX_CYCLE_SHADING_BOUND = 1_000_000_000;
export const MAX_CYCLE_SHADING_SAMPLES = 5000;

export function cycleShadingSupported(view: string | undefined, xAxis: string | undefined) {
  return view === "voltage_current" && ["capacity_mah", "capacity_mah_g", "capacity_mah_cm2"].includes(xAxis ?? "");
}

export function cycleShadingSampleKey(key: string): string | null {
  const sample = key.split("|")[0];
  return /^[cg][1-9]\d*$/.test(sample) ? sample : null;
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function defaultCycleShadingConfig(maximum: number | null = null): CycleShadingConfig {
  return {
    enabled: false, mode: "lightness", first_lightness: 30, last_lightness: 75,
    first_saturation: 35, last_saturation: 90, reverse: false,
    progression: "smooth", bands: 5, cycle_start: 1,
    cycle_end: Math.floor(bounded(maximum, 1, 1, MAX_CYCLE_SHADING_BOUND)),
    range_source: maximum != null && Number.isFinite(maximum) && maximum >= 1 ? "full" : "manual",
    range_confirmed: maximum != null && Number.isFinite(maximum) && maximum >= 1,
  };
}

export function normalizeCycleShadingConfig(value: unknown): CycleShadingConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<CycleShadingConfig>;
  const defaults = defaultCycleShadingConfig();
  const validBounds = typeof raw.cycle_start === "number" && Number.isFinite(raw.cycle_start) && raw.cycle_start >= 1
    && typeof raw.cycle_end === "number" && Number.isFinite(raw.cycle_end) && raw.cycle_end >= raw.cycle_start;
  const start = Math.round(bounded(raw.cycle_start, 1, 1, MAX_CYCLE_SHADING_BOUND));
  return {
    enabled: raw.enabled === true && validBounds && raw.range_confirmed !== false,
    mode: ["lightness", "saturation", "both"].includes(raw.mode ?? "") ? raw.mode! : "lightness",
    first_lightness: bounded(raw.first_lightness, defaults.first_lightness, 0, 100),
    last_lightness: bounded(raw.last_lightness, defaults.last_lightness, 0, 100),
    first_saturation: bounded(raw.first_saturation, defaults.first_saturation, 0, 100),
    last_saturation: bounded(raw.last_saturation, defaults.last_saturation, 0, 100),
    reverse: raw.reverse === true,
    progression: raw.progression === "stepped" ? "stepped" : "smooth",
    bands: Math.round(bounded(raw.bands, defaults.bands, 2, MAX_CYCLE_SHADING_BANDS)),
    cycle_start: start,
    cycle_end: Math.max(start, Math.round(bounded(raw.cycle_end, start, 1, MAX_CYCLE_SHADING_BOUND))),
    range_source: raw.range_source === "full" ? "full" : "manual",
    range_confirmed: validBounds && raw.range_confirmed !== false,
  };
}

export function normalizeCycleShading(value: unknown): PlotCycleShading | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as PlotCycleShading;
  const defaults = normalizeCycleShadingConfig(raw.defaults);
  const samples: Record<string, CycleShadingConfig> = {};
  if (raw.samples && typeof raw.samples === "object" && !Array.isArray(raw.samples)) {
    for (const [key, value] of Object.entries(raw.samples).slice(0, MAX_CYCLE_SHADING_SAMPLES)) {
      if (cycleShadingSampleKey(key) !== key) continue;
      const config = normalizeCycleShadingConfig(value);
      if (config) samples[key] = config;
    }
  }
  return defaults || Object.keys(samples).length ? { ...(defaults ? { defaults } : {}), ...(Object.keys(samples).length ? { samples } : {}) } : undefined;
}

export function resolvedCycleShading(style: PlotCycleShading | undefined, sampleKey: string) {
  return style?.samples?.[sampleKey] ?? style?.defaults;
}

export function cycleShadingRangeReady(config: CycleShadingConfig) {
  return config.range_confirmed !== false && Number.isFinite(config.cycle_start) && config.cycle_start >= 1
    && Number.isFinite(config.cycle_end) && config.cycle_end >= config.cycle_start;
}

/** All-sample apply also replaces explicit sample exceptions; selected apply touches only its targets. */
export function applyCycleShading(
  style: PlotCycleShading | undefined,
  config: CycleShadingConfig,
  sampleKeys: string[] | null,
): PlotCycleShading {
  const next = normalizeCycleShading(style) ?? {};
  const normalized = normalizeCycleShadingConfig(config)!;
  if (sampleKeys === null) return { defaults: normalized };
  const samples = { ...(next.samples ?? {}) };
  for (const key of new Set(sampleKeys)) if (cycleShadingSampleKey(key) === key) samples[key] = { ...normalized };
  return { ...next, samples };
}

export function resetCycleShading(style: PlotCycleShading | undefined, sampleKeys: string[] | null): PlotCycleShading | undefined {
  if (sampleKeys === null) return undefined;
  // A disabled exception restores this sample's base colors even when the global default is enabled.
  const next = normalizeCycleShading(style) ?? {};
  const samples = { ...(next.samples ?? {}) };
  for (const key of new Set(sampleKeys)) {
    if (cycleShadingSampleKey(key) === key) samples[key] = { ...(resolvedCycleShading(next, key) ?? defaultCycleShadingConfig()), enabled: false };
  }
  return { ...next, samples };
}

export function cycleShadingFraction(cycle: number, config: CycleShadingConfig) {
  const width = config.cycle_end - config.cycle_start;
  let fraction = width > 0 ? Math.max(0, Math.min(1, (cycle - config.cycle_start) / width)) : 0;
  if (config.progression === "stepped") fraction = Math.min(config.bands - 1, Math.floor(fraction * config.bands)) / (config.bands - 1);
  return config.reverse ? 1 - fraction : fraction;
}

export function cycleShadedColor(baseColor: string, cycle: number | null | undefined, config: CycleShadingConfig | undefined) {
  if (!config?.enabled || cycle == null || !Number.isFinite(cycle) || cycle < 1) return baseColor;
  // CSS colors accepted by the existing style editor include names, rgb(a) and hsl(a).
  // tinycolor is already in the lockfile; a direct dependency makes this boundary explicit.
  const parsed = tinycolor(baseColor);
  if (!parsed.isValid()) return baseColor;
  const { a } = parsed.toHsl();
  const base = hexToHsl(parsed.toHexString());
  if (!base) return baseColor;
  const fraction = cycleShadingFraction(cycle, config);
  const interpolate = (first: number, last: number) => (first + (last - first) * fraction) / 100;
  // Achromatic colors have no sample hue: preserve their neutrality.
  const saturation = base.s === 0 || config.mode === "lightness" ? base.s : interpolate(config.first_saturation, config.last_saturation);
  const lightness = config.mode === "saturation" ? base.l : interpolate(config.first_lightness, config.last_lightness);
  const color = hslToHex(base.h, saturation, lightness);
  return a === 1 ? color : tinycolor({ ...hexToHsl(color)!, a }).toRgbString();
}

export function cycleShadingSummary(config: CycleShadingConfig) {
  const percent = (value: number) => Number(value.toFixed(1));
  const endpoints = [
    ...(config.mode !== "saturation" ? [`L ${percent(config.first_lightness)}→${percent(config.last_lightness)}%`] : []),
    ...(config.mode !== "lightness" ? [`S ${percent(config.first_saturation)}→${percent(config.last_saturation)}%`] : []),
  ].join(", ");
  return `Cycles ${config.cycle_start}–${config.cycle_end} · ${endpoints}${config.reverse ? " · reversed" : ""} · ${config.progression === "stepped" ? `${config.bands} bands` : "smooth"}`;
}

/** A bounded annotation key survives image/portable exports without adding legend traces. */
export function withCycleShadingKey(layout: Partial<Plotly.Layout>, traces: Plotly.Data[]) {
  const summaries = new Set<string>();
  for (const trace of traces) {
    const config = (trace as Plotly.Data & { cellxplorer_cycle_shading?: CycleShadingConfig }).cellxplorer_cycle_shading;
    if (config?.enabled) summaries.add(cycleShadingSummary(config));
  }
  if (!summaries.size) return layout;
  const shown = [...summaries].slice(0, 3);
  const lines = shown.flatMap((summary, index) => {
    const [range, endpoints, ...progression] = summary.split(" · ");
    return [index === 0 ? `Cycle shading · ${range}` : range, endpoints, progression.join(" · ")];
  });
  if (summaries.size > 3) lines.push(`+${summaries.size - 3} other fixed mappings`);
  const text = lines.join("<br>");
  return {
    ...layout,
    margin: { ...layout.margin, t: (layout.margin?.t ?? 20) + lines.length * 12 + 6 },
    annotations: [...(layout.annotations ?? []), {
      name: "cellxplorer-cycle-shading-key", text, xref: "paper" as const, yref: "paper" as const,
      x: 0, y: 1, xanchor: "left" as const, yanchor: "bottom" as const, yshift: 8,
      showarrow: false, align: "left" as const, font: { size: 10, color: layout.font?.color ?? "#555" },
    }],
  };
}
