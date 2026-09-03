import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AnalysisSpec, ComputeResult, TimeCapacityResult, TimeCapacityTrace } from "../src/api.ts";
import {
  DEFAULT_PLOT_STYLE,
  normalizePlotStyle,
  plotStylePresetFamilyForTab,
} from "../src/features/analyses/editor/plotting/plotStyle.ts";
import {
  hoverLabelLayout,
  simpleCartesianLayout,
} from "../src/features/analyses/editor/plotting/plotLayout.ts";
import {
  cycleSeriesVisibilityCandidatesForResult,
  cycleTraceEmissionPlan,
  cycleTraceVisibility,
} from "../src/features/analyses/editor/families/cycles/cycleVisibility.ts";
import {
  timeCapacitySeriesVisibilityCandidatesForConfig,
  timeCapacityVisibleVoltageChannels,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityVisibility.ts";

const spec = { presentation: { legend: true } } as AnalysisSpec;
const traces = [
  { type: "scatter", x: [1, 2, 3], y: [10, 20, 30] },
] as Plotly.Data[];

test("simple plot families apply manual ranges, ticks, title gaps, and legend margins", () => {
  const style = normalizePlotStyle({
    ...DEFAULT_PLOT_STYLE,
    x_axis: {
      ...DEFAULT_PLOT_STYLE.x_axis,
      mode: "manual",
      min: 1,
      max: 3,
      tick_mode: "step",
      dtick: 1,
      title_standoff: 24,
    },
    y_axis: {
      ...DEFAULT_PLOT_STYLE.y_axis,
      mode: "manual",
      min: 10,
      max: 30,
      tick_mode: "count",
      tick_count: 3,
      title_standoff: 28,
    },
    legend_mode: "outside",
    legend_side: "right",
  });
  const layout = simpleCartesianLayout(style, spec, {
    traces,
    xTitle: "X",
    yTitle: "Y",
    baseMargin: { l: 72, r: 20, t: 12, b: 56 },
  });

  assert.deepEqual(layout.xaxis?.range, [1, 3]);
  assert.equal(layout.xaxis?.autorange, false);
  assert.equal(layout.xaxis?.dtick, 1);
  assert.deepEqual(layout.yaxis?.range, [10, 30]);
  assert.deepEqual(layout.yaxis?.tickvals, [10, 20, 30]);
  assert.equal(layout.xaxis?.title && "standoff" in layout.xaxis.title
    ? layout.xaxis.title.standoff
    : undefined, 24);
  assert.equal(layout.yaxis?.title && "standoff" in layout.yaxis.title
    ? layout.yaxis.title.standoff
    : undefined, 28);
  assert.equal(layout.legend?.orientation, "v");
  assert.equal(layout.legend?.x, 1.02);
  assert.equal(layout.margin?.r, 140);
});

test("categorical X layouts keep category ordering without applying numeric X controls", () => {
  const style = normalizePlotStyle({
    ...DEFAULT_PLOT_STYLE,
    x_axis: {
      ...DEFAULT_PLOT_STYLE.x_axis,
      mode: "manual",
      min: 1,
      max: 3,
      tick_mode: "step",
      dtick: 1,
    },
  });
  const layout = simpleCartesianLayout(style, spec, {
    traces: [{ type: "scatter", x: ["C/10", "C/2"], y: [1, 2] } as Plotly.Data],
    xTitle: "C-rate",
    yTitle: "Capacity",
    xAxis: { type: "category", categoryorder: "array", categoryarray: ["C/10", "C/2"] },
    xAxisNumeric: false,
  });

  assert.equal(layout.xaxis?.type, "category");
  assert.deepEqual(layout.xaxis?.categoryarray, ["C/10", "C/2"]);
  assert.equal(layout.xaxis?.range, undefined);
  assert.equal(layout.xaxis?.dtick, undefined);
});

test("specialized plot families have their own preset scopes", () => {
  assert.equal(plotStylePresetFamilyForTab("dcir"), "dcir");
  assert.equal(plotStylePresetFamilyForTab("crate"), "crate");
  assert.equal(plotStylePresetFamilyForTab("chargeability"), "chargeability");
  assert.equal(plotStylePresetFamilyForTab("steps"), "steps");
  assert.equal(plotStylePresetFamilyForTab("recap"), "all");
});

test("all audited simple plot families use the shared layout and opacity paths", () => {
  const families = [
    "../src/features/analyses/editor/families/dcir/DcirPlotCard.tsx",
    "../src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx",
    "../src/features/analyses/editor/families/chargeability/ChargeabilityPlotCard.tsx",
    "../src/features/analyses/editor/families/steps/StepsPlotCard.tsx",
  ];
  for (const family of families) {
    const source = readFileSync(new URL(family, import.meta.url), "utf8");
    assert.match(source, /simpleCartesianLayout/);
    assert.match(source, /return simpleCartesianLayout\(style, spec/);
    assert.match(source, /opacity: style\.individual_opacity/);
  }
});

test("hover labels keep the channel tint but use readable dark text and borders", () => {
  const hover = hoverLabelLayout(normalizePlotStyle(DEFAULT_PLOT_STYLE));
  assert.equal(hover.bgcolor, "#e6fcf5");
  assert.equal(hover.bordercolor, "#495057");
  assert.equal(hover.font.color, "#343a40");
  assert.equal(hover.font.weight, 400);
});

test("plot families do not expose an unrequested series visibility control", () => {
  const headerSource = readFileSync(
    new URL("../src/features/analyses/editor/plotting/PlotHeader.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(headerSource, /Series visibility/);
  assert.doesNotMatch(headerSource, /PlotSeriesVisibilityMenu/);

  const families = [
    "../src/features/analyses/editor/families/cycles/CyclePlotCard.tsx",
    "../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx",
    "../src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx",
  ];
  for (const family of families) {
    const source = readFileSync(new URL(family, import.meta.url), "utf8");
    assert.doesNotMatch(source, /seriesVisibility=/);
  }
});

test("Cycles and Time/Capacity builders keep first-class series independently targetable", () => {
  const cyclesSource = readFileSync(
    new URL("../src/features/analyses/editor/families/cycles/CyclePlotCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(cyclesSource, /cycleCeVisibilityKey\(sourceKey\)/);
  assert.match(cyclesSource, /const ceKey = cycleCeSeriesKey\(aggKey\)/);
  assert.match(cyclesSource, /const ceKey = cycleCeSeriesKey\(cellKey\)/);
  assert.match(cyclesSource, /cycleTraceEmissionPlan\(spec, aggKey,/);
  assert.match(cyclesSource, /cycleTraceEmissionPlan\(spec, cellKey,/);

  const timeCapacitySource = readFileSync(
    new URL(
      "../src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(timeCapacitySource, /timeCapacityVoltageVisibilityKey\(seriesKey, channel\)/);
  assert.match(timeCapacitySource, /timeCapacityVisibleVoltageChannels\(/);
  assert.match(timeCapacitySource, /timeCapacitySeriesVisibilityCandidatesForConfig\(/);
  assert.match(timeCapacitySource, /const multipleVoltageChannels =\s*cfg\.view === "voltage_current"/);
});

test("the Cycles visibility builder exposes CE separately and keeps helpers out", () => {
  const spec = {
    selection: { entries: [], exclusions: [] },
    presentation: { hidden_series_ids: [] },
  } as AnalysisSpec;
  const result = {
    aggregates: [
      {
        group_id: 7,
        group_name: "LFP",
        quantities: {
          capacity: { mean: [1], band_low: [1], band_high: [1], n: [2] },
          coulombic_efficiency_pct: { mean: [98], band_low: [97], band_high: [99], n: [2] },
        },
      },
    ],
    cell_series: [],
  } as unknown as ComputeResult;

  assert.deepEqual(
    cycleSeriesVisibilityCandidatesForResult(result, spec, {
      column: "capacity",
      showIndividual: false,
      includeCoulombicEfficiency: true,
    }),
    [
      { key: "cycles:g7", label: "LFP mean" },
      { key: "cycles:y2:coulombic_efficiency:g7", label: "LFP CE" },
    ],
  );
  assert.deepEqual(cycleTraceVisibility(spec, "g7"), {
    primaryVisible: true,
    ceVisible: true,
  });
  assert.deepEqual(
    cycleTraceVisibility(
      { ...spec, presentation: { hidden_series_ids: ["cycles:y2:coulombic_efficiency:g7"] } },
      "g7",
    ),
    { primaryVisible: true, ceVisible: false },
  );
  assert.deepEqual(
    cycleTraceEmissionPlan(
      { ...spec, presentation: { hidden_series_ids: ["cycles:g7"] } },
      "g7",
      { primary: true, ce: true },
    ),
    { primary: false, ce: true },
  );
});

test("the Time/Capacity visibility builder exposes each selected voltage channel", () => {
  const spec = {
    selection: {
      entries: [{ kind: "cell", ref_id: 1 }],
      exclusions: [],
    },
    presentation: { hidden_series_ids: [] },
  } as AnalysisSpec;
  const trace = {
    cell_id: 1,
    cell_name: "Cell A",
    label: "Cell A",
    group_id: null,
    group_name: null,
    excluded: false,
    voltage_v: [3.1, 3.2],
    voltage_v_by_channel: {
      voltage: [3.1, 3.2],
      working_potential: [3.0, 3.1],
      counter_potential: [0.1, 0.2],
    },
    derivative_x: [],
    derivative_y: [],
  } as unknown as TimeCapacityTrace;
  const result = { cell_traces: [trace] } as unknown as TimeCapacityResult;
  const config = {
    view: "voltage_current",
    voltage_channels: ["voltage", "working_potential", "counter_potential"] as const,
    voltage_channel: "voltage" as const,
  };

  const candidates = timeCapacitySeriesVisibilityCandidatesForConfig(result, spec, config);
  assert.deepEqual(candidates.map((candidate) => candidate.key), [
    "time_capacity:c1|voltage",
    "time_capacity:c1|working_potential",
    "time_capacity:c1|counter_potential",
  ]);
  assert.equal(new Set(candidates.map((candidate) => candidate.key)).size, 3);

  const hiddenSpec = {
    ...spec,
    presentation: { hidden_series_ids: ["time_capacity:c1|working_potential"] },
  } as AnalysisSpec;
  assert.deepEqual(
    timeCapacityVisibleVoltageChannels(
      hiddenSpec,
      "c1",
      config.voltage_channels,
      true,
    ),
    ["voltage", "counter_potential"],
  );
});
