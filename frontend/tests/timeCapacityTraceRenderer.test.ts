import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AnalysisSpec, TimeCapacityResult, TimeCapacityTrace } from "../src/api.ts";

type RenderedTrace = Plotly.Data & {
  cellxplorer_export_columns?: { header: string; values: unknown[] }[];
  cellxplorer_analysis_sample?: { cell_id: number; group_id: number | null; excluded: boolean };
};
type Renderer = (
  result: TimeCapacityResult,
  spec: AnalysisSpec,
  interactiveWebGl?: boolean,
  preserveAnalysisSampleVisibility?: boolean,
  includeExportColumns?: boolean,
) => RenderedTrace[];

let rendererPromise: Promise<Renderer> | undefined;

async function loadRenderer(): Promise<Renderer> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const { createServer } = await import("vite");
      const virtualPrefix = "virtual:time-capacity-renderer-test:";
      // Stub component dependencies only; trace, style, provenance and export
      // helpers are the actual production modules, as in cycleTraceRenderer.
      const stubs: Record<string, string> = {
        react:
          "export const memo=(fn)=>fn; export const useCallback=(fn)=>fn; export const useMemo=(fn)=>fn(); " +
          "export const useRef=(value)=>({current:value}); export const useState=(value)=>[value,()=>{}]; " +
          "export const useEffect=()=>{}; export const useLayoutEffect=()=>{}; " +
          "export const createContext=(value)=>({_currentValue:value}); " +
          "export const useContext=(context)=>context._currentValue; export default {createElement:()=>null};",
        "react/jsx-runtime": "export const jsx=()=>null; export const jsxs=()=>null; export const Fragment={};",
        "react/jsx-dev-runtime": "export const jsxDEV=()=>null; export const Fragment={};",
        "@mantine/core": [
          "ActionIcon", "Accordion", "Alert", "Badge", "Box", "Button", "Center", "Checkbox",
          "Combobox", "Group", "InputBase", "LoadingOverlay", "NumberInput", "Paper", "Select",
          "SegmentedControl", "Stack", "Switch", "Text", "Tooltip", "useCombobox",
        ].map((name) => `export const ${name}=()=>null;`).join(" "),
        "@mantine/notifications": "export const notifications={show(){},hide(){}};",
        "@tanstack/react-query": "export const useQuery=()=>({data:undefined}); export const useQueryClient=()=>({});",
        "@tabler/icons-react": "export const IconInfoCircle=()=>null;",
        "plotly.js-dist-min": "export default {};",
        "__debounced": "export const DebouncedNumberInput=()=>null;",
        "__plot": "export default ()=>null;",
        "__header": "export const PlotHeader=()=>null; export const ComputeProgress=()=>null;",
        "__stylepanel": "export const PlotStylePanel=()=>null;",
        "__navigation": "export const TimeCapacityCycleNavigation=()=>null;",
        "__warmup": "export const useTimeCapacityProgressiveWarmup=()=>{};",
        "__runtime":
          "export const interactivePlotTraces=()=>[]; export const newComputeToken=()=>42; " +
          "export const useDelayedFlag=()=>false; export const usePlotSizeSync=()=>{}; " +
          "export const useZoomMemory=()=>({apply:(value)=>value,reset:()=>{}});",
      };
      const suffixStubs: Record<string, string> = {
        "/components/DebouncedInputs": "__debounced",
        "/components/Plot": "__plot",
        "/plotting/PlotHeader": "__header",
        "/plotting/PlotStylePanel": "__stylepanel",
        "/plotting/plotRuntime": "__runtime",
        "/TimeCapacityCycleNavigation": "__navigation",
        "/useTimeCapacityProgressiveWarmup": "__warmup",
      };
      const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        configFile: false,
        plugins: [{
          name: "time-capacity-renderer-test-stubs",
          enforce: "pre",
          resolveId(id: string) {
            if (Object.prototype.hasOwnProperty.call(stubs, id)) return virtualPrefix + id;
            const normalized = id.replaceAll("\\", "/");
            for (const [suffix, key] of Object.entries(suffixStubs)) {
              if (normalized.endsWith(suffix)) return virtualPrefix + key;
            }
            return undefined;
          },
          load(id: string) {
            return id.startsWith(virtualPrefix) ? stubs[id.slice(virtualPrefix.length)] : undefined;
          },
        }],
        optimizeDeps: { exclude: ["plotly.js-dist-min"] },
        ssr: { noExternal: true },
        server: { middlewareMode: true },
        appType: "custom",
      });
      try {
        const module = await server.ssrLoadModule(
          "/src/features/analyses/editor/families/time-capacity/TimeCapacityPlotCard.tsx",
        );
        return module.timeCapacityTracesForResult as Renderer;
      } finally {
        await server.close();
      }
    })();
  }
  return rendererPromise;
}

type Settings = NonNullable<AnalysisSpec["computation"]["time_capacity"]>;

function makeSpec(settings: Partial<Settings> = {}): AnalysisSpec {
  return {
    selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [] },
    presentation: { show_individual_cells: true, hidden_series_ids: [], plot_style: {} },
    computation: { time_capacity: {
      x_axis: "time", time_unit: "s", display_mode: "consecutive",
      view: "voltage_current", voltage_channels: ["voltage"], stacked: false, ...settings,
    } },
    aggregation: { min_n_for_band: 2 },
  } as unknown as AnalysisSpec;
}

function makeResult(compactSources = false): TimeCapacityResult {
  const trace: TimeCapacityTrace = {
    cell_id: 1, cell_name: "Cell A", label: "Cell A", group_id: null, group_name: null,
    excluded: false, active_mass_mg: 10, nominal_capacity_mah: 2, electrode_area_cm2: 4,
    cycle: [1, 1, 1, 1, 2, 2, 2, 2],
    time_s: [0, 10, 20, 30, 40, 50, 60, 70],
    capacity_mah: [0, 1, 0, 1, 0, 1, 0, 1], capacity_mah_g: [0, 100, 0, 100, 0, 100, 0, 100],
    voltage_v: [3, 4, null, 3.2, 3.1, 4.1, 3.9, 3.2],
    voltage_v_by_channel: {
      voltage: [3, 4, null, 3.2, 3.1, 4.1, 3.9, 3.2],
      working_potential: [3.2, 4.2, null, 3.4, 3.3, 4.3, 4.1, 3.4],
    },
    current_ma: [2, 2, null, -2, 2, 2, -2, -2],
    phase: ["charge", "charge", "discharge", "discharge", "charge", "charge", "discharge", "discharge"],
    status: Array(8).fill(null),
    derivative_x: [3, 4, 4, 3, 3, 4, 4, 3], derivative_y: [1, 2, null, -2, 2, 3, -3, -2],
    source_cycle: [1, 1, 1, 1, 1, 1, 1, 1],
    source_position: [1, 1, 1, 1, 2, 2, 2, 2],
    source_filename: ["a.nda", "a.nda", "a.nda", "a.nda", "b.nda", "b.nda", "b.nda", "b.nda"],
    source_hash: ["a", "a", "a", "a", "b", "b", "b", "b"],
    source_descriptors: [{ source_position: 2, status: "available", filename: "b.nda", file_hash: "b" }],
  } as TimeCapacityTrace;
  if (compactSources) {
    trace.sources = [{ position: 1, filename: "a.nda", hash: "a" }, { position: 2, filename: "b.nda", hash: "b" }];
    trace.source_index = [0, 0, 0, 0, 1, 1, 1, 1];
    delete trace.source_position;
    delete trace.source_filename;
    delete trace.source_hash;
  }
  return { cell_traces: [trace], badges: [], settings: {} } as unknown as TimeCapacityResult;
}

function withoutExportColumns(traces: RenderedTrace[]) {
  return traces.map(({ cellxplorer_export_columns: _columns, ...trace }) => trace);
}

async function assertParity(result: TimeCapacityResult, spec: AnalysisSpec, webGl = false, preserve = false) {
  const render = await loadRenderer();
  const before = structuredClone({ result, spec });
  const defaults = render(result, spec, webGl, preserve);
  const exported = render(result, spec, webGl, preserve, true);
  const interactive = render(result, spec, webGl, preserve, false);
  assert.deepEqual(defaults, exported, "the omitted fifth argument retains export columns");
  assert.deepEqual(withoutExportColumns(interactive), withoutExportColumns(exported));
  for (const trace of interactive) assert.equal(trace.cellxplorer_export_columns, undefined);
  if (exported.length) {
    assert.ok(exported.some((trace) => (trace.cellxplorer_export_columns?.length ?? 0) > 0));
  }
  assert.deepEqual({ result, spec }, before, "rendering must not mutate either input");
  return { exported, interactive };
}

test("voltage/time consecutive preserves source provenance without boundary markers", async () => {
  for (const compactSources of [false, true]) {
    const { exported, interactive } = await assertParity(makeResult(compactSources), makeSpec());
    assert.equal(interactive.length, 1);
    assert.deepEqual(interactive[0].x, [0, 10, 20, 30, 40, 50, 60, 70]);
    assert.deepEqual(interactive[0].customdata, [[1, 1], [1, 1], [1, 1], [1, 1], [2, 1], [2, 1], [2, 1], [2, 1]]);
    assert.match(interactive[0].hovertemplate as string, /customdata\[1\]/);
    assert.equal(interactive.some((trace) => trace.name === "Source boundary"), false);
    assert.deepEqual(exported[0].cellxplorer_export_columns?.find((column) => column.header === "Source file")?.values,
      ["a.nda", "a.nda", "a.nda", "a.nda", "b.nda", "b.nda", "b.nda", "b.nda"]);
  }
});

test("consecutive capacity omits rest rows and does not connect separate cycles", async () => {
  const result = makeResult();
  const trace = result.cell_traces[0];
  trace.cycle = [1, 1, 1, 2, 2, 2, 2, 2];
  trace.display_x = [0, 1, 1, 1, 2, 2, 3, 3];
  trace.phase = ["discharge", "discharge", "rest", "charge", "charge", "discharge", "discharge", "rest"];
  trace.voltage_v = [1, 0.8, 0.9, 1.2, 0.7, 0.9, 0.6, 0.5];
  trace.voltage_v_by_channel = { voltage: trace.voltage_v };

  const { interactive } = await assertParity(result, makeSpec({ x_axis: "capacity_mah" }));
  assert.equal(interactive.length, 3);
  assert.deepEqual(interactive.map((series) => series.x), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(interactive.map((series) => series.y), [[1, 0.8], [1.2, 0.7], [0.9, 0.6]]);
  assert.equal(interactive.filter((series) => series.showlegend).length, 1);
});

test("curve-only sources stay separate and are omitted when capacity is unavailable", async () => {
  const timeResult = makeResult();
  const trace = timeResult.cell_traces[0];
  trace.cycle = [...trace.cycle, 0, 0, 0, 0];
  trace.time_s = [...trace.time_s, 80, 90, 100, 110];
  trace.capacity_mah = [...trace.capacity_mah, 0, 0, 0, 0];
  trace.capacity_mah_g = [...trace.capacity_mah_g, 0, 0, 0, 0];
  trace.capacity_mah_cm2 = [...(trace.capacity_mah_cm2 ?? Array(8).fill(null)), 0, 0, 0, 0];
  trace.voltage_v = [...trace.voltage_v, 3.2, 3.3, 3.4, 3.5];
  trace.voltage_v_by_channel = {
    voltage: trace.voltage_v,
    working_potential: [...(trace.voltage_v_by_channel?.working_potential ?? []), 3.2, 3.3, 3.4, 3.5],
  };
  trace.current_ma = [...trace.current_ma, 0, 0, 0, 0];
  trace.phase = [...trace.phase, "rest", "rest", "rest", "rest"];
  trace.status = [...trace.status, null, null, null, null];
  trace.derivative_x = [...trace.derivative_x, 0, 0, 0, 0];
  trace.derivative_y = [...trace.derivative_y, null, null, null, null];
  trace.source_cycle = [...(trace.source_cycle ?? Array(8).fill(1)), 1, 1, 1, 1];
  trace.source_position = [...(trace.source_position ?? Array(8).fill(1)), 3, 3, 4, 4];
  trace.source_filename = [...(trace.source_filename ?? Array(8).fill("a.nda")), "c.mpr", "c.mpr", "d.mpr", "d.mpr"];
  trace.source_hash = [...(trace.source_hash ?? Array(8).fill("a")), "c", "c", "d", "d"];
  trace.display_only_cycle = [...Array(8).fill(false), true, true, true, true];

  const timeTraces = (await assertParity(timeResult, makeSpec())).interactive;
  const curveTraces = timeTraces.filter((series) =>
    Array.isArray(series.customdata)
      && (series.customdata as unknown[][]).some((point) => point[0] === "curve only (not a counted cycle)"),
  );
  assert.equal(curveTraces.length, 2);
  assert.deepEqual(curveTraces.map((series) => series.x), [[80, 90], [100, 110]]);

  const capacityResult = makeResult();
  const capacityTrace = capacityResult.cell_traces[0];
  capacityTrace.cycle = [...capacityTrace.cycle, 0, 0];
  capacityTrace.display_only_cycle = [...Array(8).fill(false), true, true];
  capacityTrace.display_x = [...Array.from({ length: 8 }, (_, index) => index), 0, 0];
  capacityTrace.capacity_mah = [...capacityTrace.capacity_mah, 0, 0];
  capacityTrace.capacity_mah_g = [...capacityTrace.capacity_mah_g, 0, 0];
  capacityTrace.time_s = [...capacityTrace.time_s, 80, 90];
  capacityTrace.voltage_v = [...capacityTrace.voltage_v, 3.2, 3.3];
  capacityTrace.voltage_v_by_channel = { voltage: capacityTrace.voltage_v };
  capacityTrace.current_ma = [...capacityTrace.current_ma, 0, 0];
  capacityTrace.phase = [...capacityTrace.phase, "rest", "rest"];
  capacityTrace.status = [...capacityTrace.status, null, null];
  capacityTrace.source_hash = [...(capacityTrace.source_hash ?? Array(8).fill("a")), "ocv", "ocv"];
  capacityTrace.derivative_x = [...capacityTrace.derivative_x, 0, 0];
  capacityTrace.derivative_y = [...capacityTrace.derivative_y, null, null];
  const capacityTraces = (await assertParity(capacityResult, makeSpec({ x_axis: "capacity_mah" }))).interactive;
  assert.equal(capacityTraces.some((series) =>
    Array.isArray(series.customdata)
      && (series.customdata as unknown[][]).some((point) => point[0] === "curve only (not a counted cycle)"),
  ), false);
});

test("phase-aligned reset and mirrored voltage/time retain segmentation and gaps", async () => {
  for (const display_mode of ["overlap_reset", "overlap_mirror"] as const) {
    const { interactive } = await assertParity(makeResult(), makeSpec({ display_mode }));
    const primary = interactive;
    assert.equal(primary.length, 4);
    assert.deepEqual(primary[0].x, [0, 10]);
    assert.deepEqual(primary[1].x, display_mode === "overlap_mirror" ? [10, 0] : [0, 10]);
    assert.deepEqual(primary[1].y, [null, 3.2]);
    for (const trace of primary) assert.equal(trace.connectgaps, false);
  }
});

test("stacked current keeps both axes, conversions, styles and WebGL trace types", async () => {
  const { interactive } = await assertParity(makeResult(), makeSpec({
    stacked: true, current_left: "current_density", current_right: "c_rate",
  }), true);
  assert.deepEqual(interactive.find((trace) => trace.yaxis === "y2")?.y, [.5, .5, null, -.5, .5, .5, -.5, -.5]);
  assert.deepEqual(interactive.find((trace) => trace.yaxis === "y3")?.y, [1, 1, null, -1, 1, 1, -1, -1]);
  for (const trace of interactive) assert.equal(trace.type, "scattergl");
});

test("derivative views retain cycle/phase splits, legend, metadata and nulls", async () => {
  for (const view of ["dqdv", "dvdq"] as const) {
    const { interactive } = await assertParity(makeResult(), makeSpec({ view }));
    assert.equal(interactive.length, 4);
    assert.equal(interactive[0].meta, "charge, cycle 1");
    assert.equal(interactive[1].meta, "discharge, cycle 1");
    assert.deepEqual(interactive[1].y, [null, -2]);
    assert.equal(interactive.filter((trace) => trace.showlegend).length, 1);
  }
});

test("series/channel and analysis-sample visibility do not depend on export metadata", async () => {
  const result = makeResult();
  const hidden = makeSpec();
  hidden.presentation.hidden_series_ids = ["time_capacity:c1"];
  assert.equal((await assertParity(result, hidden)).interactive.length, 0);
  const channels = makeSpec({ voltage_channels: ["voltage", "working_potential"] });
  channels.presentation.hidden_series_ids = ["time_capacity:c1|working_potential"];
  assert.equal((await assertParity(result, channels)).interactive.length, 1);
  const unselected = makeSpec();
  unselected.selection.entries = [];
  assert.equal((await assertParity(result, unselected)).interactive.length, 0);
  const retained = await assertParity(result, unselected, false, true);
  assert.equal(retained.interactive.length, 1);
  assert.deepEqual(retained.interactive[0].cellxplorer_analysis_sample, { cell_id: 1, group_id: null, excluded: false });
});
