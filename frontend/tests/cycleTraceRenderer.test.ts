import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AnalysisSpec, ComputeResult } from "../src/api.ts";

type CycleTraceRenderer = (
  result: ComputeResult,
  spec: AnalysisSpec,
  compact?: boolean,
  includePointSelectionMetadata?: boolean,
) => Plotly.Data[];

let rendererPromise: Promise<CycleTraceRenderer> | undefined;

async function loadCycleTraceRenderer(): Promise<CycleTraceRenderer> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const { createServer } = await import("vite");
      const virtualPrefix = "virtual:spec-055-cycle-test:";
      const stubs: Record<string, string> = {
        react:
          "export const useCallback=(fn)=>fn; export const useMemo=(fn)=>fn(); " +
          "export const useRef=(value)=>({current:value}); export const useState=(value)=>[value,()=>{}]; " +
          "export const useEffect=()=>{}; export default {createElement:()=>null};",
        "react/jsx-runtime": "export const jsx=()=>null; export const jsxs=()=>null; export const Fragment={};",
        "react/jsx-dev-runtime": "export const jsxDEV=()=>null; export const Fragment={};",
        "@mantine/core":
          "export const ActionIcon=()=>null; export const Accordion=()=>null; export const Alert=()=>null; " +
          "export const Badge=()=>null; export const Box=()=>null; export const Center=()=>null; " +
          "export const Group=()=>null; export const LoadingOverlay=()=>null; export const NumberInput=()=>null; " +
          "export const Paper=()=>null; export const Select=()=>null; export const Stack=()=>null; " +
          "export const Switch=()=>null; export const Text=()=>null; export const Tooltip=()=>null;",
        "@mantine/notifications": "export const notifications={show(){},hide(){}};",
        "@tanstack/react-query": "export const useQuery=()=>({data:undefined});",
        "@tabler/icons-react": "export const IconInfoCircle=()=>null;",
        "plotly.js-dist-min": "export default {};",
        "__debounced": "export const DebouncedNumberInput=()=>null;",
        "__plot": "export default ()=>null;",
        "__header": "export const PlotHeader=()=>null; export const ComputeProgress=()=>null;",
        "__stylepanel": "export const PlotStylePanel=()=>null;",
        "__pointinspector":
          "export const CyclePointInspector=()=>null; export const CyclePointSelectionOverlay=()=>null;",
        "__pointselection":
          "export const useCyclePointSelection=()=>({records:[],completedShape:null,constructionVertices:[]," +
          "dragPreview:null,halos:[],anchorBounds:null,clear(){},refresh(){}," +
          "invalidateGeometry(){}," +
          "onPointerDownCapture(){},onPointerMoveCapture(){},onPointerUpCapture(){},onPointerCancelCapture(){}});",
        "__runtime":
          "export const interactivePlotTraces=()=>[]; export const newComputeToken=()=>42; " +
          "export const useDelayedFlag=()=>false; export const usePlotSizeSync=()=>{}; " +
          "export const useZoomMemory=()=>({apply:(value)=>value,reset:()=>{}});",
      };
      const stubPlugin = {
        name: "spec-055-cycle-test-stubs",
        enforce: "pre" as const,
        resolveId(id: string) {
          if (Object.prototype.hasOwnProperty.call(stubs, id)) return virtualPrefix + id;
          const normalized = id.replaceAll("\\", "/");
          if (normalized.includes("/components/DebouncedInputs")) {
            return virtualPrefix + "__debounced";
          }
          if (normalized.endsWith("/components/Plot")) return virtualPrefix + "__plot";
          if (normalized.endsWith("/plotting/PlotHeader")) return virtualPrefix + "__header";
          if (normalized.endsWith("/plotting/PlotStylePanel")) {
            return virtualPrefix + "__stylepanel";
          }
          if (
            normalized.includes("/families/cycles/CyclePointInspector") ||
            normalized === "./CyclePointInspector"
          ) {
            return virtualPrefix + "__pointinspector";
          }
          if (
            normalized.includes("/families/cycles/useCyclePointSelection") ||
            normalized === "./useCyclePointSelection"
          ) {
            return virtualPrefix + "__pointselection";
          }
          if (normalized.endsWith("/plotting/plotRuntime")) return virtualPrefix + "__runtime";
          return undefined;
        },
        load(id: string) {
          if (!id.startsWith(virtualPrefix)) return undefined;
          return stubs[id.slice(virtualPrefix.length)];
        },
      };
      const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        configFile: false,
        plugins: [stubPlugin],
        optimizeDeps: { exclude: ["plotly.js-dist-min"] },
        ssr: { noExternal: true },
        server: { middlewareMode: true },
        appType: "custom",
      });
      try {
        const module = await server.ssrLoadModule(
          "/src/features/analyses/editor/families/cycles/CyclePlotCard.tsx",
        );
        return module.cycleTracesForResult as CycleTraceRenderer;
      } finally {
        await server.close();
      }
    })();
  }
  return rendererPromise;
}

function cycleSpec(hiddenSeriesIds: string[] = []): AnalysisSpec {
  return {
    selection: { entries: [], exclusions: [] },
    presentation: {
      quantity: "discharge_capacity",
      ce_overlay: true,
      show_individual_cells: true,
      hide_diagnostic_cycles: false,
      reindex_diagnostic_cycles: false,
      hidden_series_ids: hiddenSeriesIds,
      plot_style: {},
    },
    computation: { formation_cycles: 0 },
    aggregation: { min_n_for_band: 2 },
  } as unknown as AnalysisSpec;
}

function aggregateResult(): ComputeResult {
  return {
    quantities: [{ key: "discharge_capacity", column: "capacity", label: "Capacity" }],
    aggregates: [
      {
        group_id: 7,
        group_name: "LFP",
        x: [1, 2],
        quantities: {
          capacity: { mean: [1, 2], band_low: [0.8, 1.8], band_high: [1.2, 2.2], n: [2, 2] },
          coulombic_efficiency_pct: {
            mean: [98, 99],
            band_low: [97, 98],
            band_high: [99, 100],
            n: [2, 2],
          },
        },
      },
    ],
    cell_series: [],
  } as unknown as ComputeResult;
}

function cellResult(): ComputeResult {
  return {
    quantities: [{ key: "discharge_capacity", column: "capacity", label: "Capacity" }],
    aggregates: [],
    cell_series: [
      {
        cell_id: 1,
        label: "Cell A",
        group_id: null,
        excluded: false,
        x: [1, 2, 3],
        quantities: {
          capacity: [1, 2, 3],
          coulombic_efficiency_pct: [98, 99, 100],
        },
        source_cycle: [1, 2, 1],
        source_position: [1, 1, 2],
        source_filename: ["a.nda", "a.nda", "b.nda"],
        source_hash: ["a", "a", "b"],
      },
    ],
  } as unknown as ComputeResult;
}

test("Cycles renderer emits aggregate CE independently of primary helpers", async () => {
  const render = await loadCycleTraceRenderer();
  const traces = render(aggregateResult(), cycleSpec(["cycles:g7"]));

  assert.equal(traces.length, 1);
  assert.equal(traces[0].yaxis, "y2");
  assert.equal(traces[0].name, "LFP CE");
  assert.equal(traces.some((trace) => trace.name === "LFP mean"), false);
  assert.equal(traces.some((trace) => trace.name === "LFP band"), false);
  assert.equal(traces.some((trace) => trace.name === "LFP below minimum n"), false);
});

test("Cycles renderer emits cell CE independently of primary helpers", async () => {
  const render = await loadCycleTraceRenderer();
  const traces = render(cellResult(), {
    ...cycleSpec(["cycles:c1"]),
    selection: { entries: [{ kind: "cell", ref_id: 1 }], exclusions: [] },
  } as AnalysisSpec);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].yaxis, "y2");
  assert.equal(traces[0].name, "Cell A CE");
  assert.equal(traces.some((trace) => trace.name === "Cell A"), false);
  assert.equal(traces.some((trace) => trace.name === "Source boundary"), false);
});

test("Cycles renderer preserves primary helpers and CE when both targets are visible", async () => {
  const render = await loadCycleTraceRenderer();
  const traces = render(aggregateResult(), cycleSpec());

  assert.equal(traces.some((trace) => trace.name === "LFP mean"), true);
  assert.equal(traces.some((trace) => trace.name === "LFP band"), true);
  assert.equal(traces.some((trace) => trace.name === "LFP CE"), true);
});

test("aggregate selection metadata identifies the exact contributing Cells per point", async () => {
  const render = await loadCycleTraceRenderer();
  const result = aggregateResult();
  result.cell_series = [
    {
      cell_id: 11,
      label: "Cell A",
      group_id: 7,
      excluded: false,
      x: [1, 2],
      quantities: { capacity: [1, 2], coulombic_efficiency_pct: [98, null] },
    },
    {
      cell_id: 12,
      label: "Cell B",
      group_id: 7,
      excluded: false,
      x: [1, 2],
      quantities: { capacity: [1, null], coulombic_efficiency_pct: [null, 99] },
    },
  ] as ComputeResult["cell_series"];
  const traces = render(result, {
    ...cycleSpec(),
    presentation: { ...cycleSpec().presentation, show_individual_cells: false },
  } as AnalysisSpec, false, true);

  const primary = traces.find((trace) => trace.name === "LFP mean");
  const ce = traces.find((trace) => trace.name === "LFP CE");
  assert.deepEqual(
    (primary?.meta as { cellxplorerCycleSelection?: { detailCellIds?: number[][] } })
      .cellxplorerCycleSelection?.detailCellIds,
    [[11, 12], [11]],
  );
  assert.deepEqual(
    (ce?.meta as { cellxplorerCycleSelection?: { detailCellIds?: number[][] } })
      .cellxplorerCycleSelection?.detailCellIds,
    [[11], [12]],
  );
});

test("Cycles traces expose point metadata only for the live interactive path", async () => {
  const render = await loadCycleTraceRenderer();
  const result = aggregateResult();
  const viewSpec = cycleSpec();
  const artifactTraces = render(result, viewSpec);
  const interactiveTraces = render(result, viewSpec, false, true);

  assert.equal(
    artifactTraces.some((trace) =>
      Boolean((trace.meta as { cellxplorerCycleSelection?: unknown } | undefined)?.cellxplorerCycleSelection),
    ),
    false,
  );
  assert.equal(
    interactiveTraces.some((trace) =>
      Boolean((trace.meta as { cellxplorerCycleSelection?: unknown } | undefined)?.cellxplorerCycleSelection),
    ),
    true,
  );
});
