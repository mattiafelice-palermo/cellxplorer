import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as referenceLines from "../src/features/analyses/editor/plotting/plotReferenceLines.ts";
import { normalizePlotStyle } from "../src/features/analyses/editor/plotting/plotStyle.ts";

type Props = Record<string, any>;

/** Run the production wrapper with hooks and Plotly's actual update-event contract. */
function makePlotHarness() {
  const slots: any[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  let layoutEffects: Array<() => void> = [];
  let props: Props;
  let figureProps: Props;
  const calls = { restyle: 0, relayout: 0, externalUpdates: 0 };
  let beforeRestyle: (() => Promise<void>) | undefined;
  const graph = {
    _fullLayout: {},
    data: [] as Props[],
    layout: {} as Props,
    querySelectorAll: () => [],
  };

  const changed = (previous: unknown[] | undefined, next: unknown[] | undefined) =>
    !previous || !next || next.length !== previous.length ||
    next.some((value, index) => !Object.is(value, previous[index]));
  const effect = (queue: Array<() => void>, callback: () => void, dependencies?: unknown[]) => {
    const index = cursor++;
    if (changed(slots[index], dependencies)) queue.push(callback);
    slots[index] = dependencies;
  };
  const react = {
    useRef(value: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
    useState(value: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next: any) => {
        const value = typeof next === "function" ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) dirty = true;
        slots[index] = value;
      }];
    },
    useMemo(callback: () => unknown, dependencies: unknown[]) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].dependencies, dependencies)) {
        slots[index] = { dependencies, value: callback() };
      }
      return slots[index].value;
    },
    useEffect: (callback: () => void, dependencies?: unknown[]) => effect(effects, callback, dependencies),
    useLayoutEffect: (callback: () => void, dependencies?: unknown[]) => effect(layoutEffects, callback, dependencies),
  };
  const emitUpdate = () => figureProps.onUpdate({ data: graph.data, layout: graph.layout }, graph);
  const plotly = {
    async restyle(_graph: unknown, update: Props, indices: number[]) {
      calls.restyle++;
      assert.ok(calls.restyle <= 8, "visibility entered a redraw feedback loop");
      await beforeRestyle?.();
      indices.forEach((index, offset) => {
        graph.data[index].opacity = update.opacity[offset];
        graph.data[index].showlegend = update.showlegend[offset];
      });
      // react-plotly.js calls onUpdate for both restyle and relayout events,
      // before each corresponding Plotly promise resolves.
      emitUpdate();
    },
    async relayout(_graph: unknown, _update: Props) {
      calls.relayout++;
      figureProps.onRelayout?.(_update);
      emitUpdate();
    },
  };
  const stubs: Record<string, unknown> = {
    "../features/analyses/editor/plotting/plotReferenceLines": referenceLines,
    react,
    "react/jsx-runtime": { jsx: (_component: unknown, props: Props) => props },
    "plotly.js-dist-min": { default: plotly },
    "react-plotly.js/factory": { default: () => () => null },
    "./plotFactory": { resolvePlotlyFactory: (module: any) => typeof module === "function" ? module : module.default },
    "../features/analyses/editor/plotting/plotRuntime": {
      installPlotlyCssZoomHoverCompensation() {},
      disposePlotlyCssZoomHoverCompensation() {},
    },
    "../features/analyses/editor/policies/analysisVisibility": {
      disablePlotlyLegendVisibility: (layout: unknown) => layout,
      blockPlotlyLegendVisibility: () => false,
    },
  };
  const source = readFileSync(new URL("../src/components/Plot.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} as { default?: (props: Props) => Props } };
  runInNewContext(compiled, {
    exports: module.exports,
    require(id: string) {
      assert.ok(id in stubs, `unexpected dependency ${id}`);
      return stubs[id];
    },
  });
  const Plot = module.exports.default!;

  function render() {
    cursor = 0;
    dirty = false;
    effects = [];
    layoutEffects = [];
    figureProps = Plot(props);
    layoutEffects.forEach((callback) => callback());
    effects.forEach((callback) => callback());
  }
  async function settle() {
    // Let the serial visibility queue and React's requested rerenders settle.
    // Bound iterations so the old implementation fails instead of hanging.
    for (let tick = 0; tick < 12; tick++) {
      if (dirty) render();
      await setImmediate();
    }
  }

  return {
    calls,
    graph,
    async mount(visibility: boolean[], data = [{ type: "scatter", opacity: 0.6, showlegend: true }, { type: "scatter" }], extra: Props = {}) {
      props = {
        data,
        layout: {},
        config: {},
        traceVisibility: visibility,
        traceVisibilityLayoutUpdate: { "xaxis.range": [0, 2] },
        traceVisibilityLayoutKey: JSON.stringify(visibility),
        onUpdate: () => calls.externalUpdates++,
        ...extra,
      };
      graph.data = data;
      graph.layout = props.layout;
      render();
      figureProps.onInitialized({ data, layout: graph.layout }, graph);
      await settle();
    },
    async visibility(value: boolean[]) {
      props = { ...props, traceVisibility: value, traceVisibilityLayoutKey: JSON.stringify(value) };
      render();
      await settle();
    },
    queueFigure(data: Props[]) {
      props = { ...props, data, layout: {} };
      render();
    },
    completeFigure() {
      graph.data = props.data;
      graph.layout = props.layout;
      emitUpdate();
    },
    emitUpdate,
    emitRelayout(event: Props) { figureProps.onRelayout?.(event); },
    readConfig() { return figureProps.config; },
    pauseRestyle(callback: () => Promise<void>) { beforeRestyle = callback; },
    settle,
  };
}

test("a saved hidden sample settles after one restyle and one axis fit", async () => {
  const harness = makePlotHarness();
  await harness.mount([false, true]);
  assert.equal(harness.calls.restyle, 1);
  assert.equal(harness.calls.relayout, 1);
  assert.equal(harness.calls.externalUpdates, 0);
  assert.equal(harness.graph.data[0].opacity, 0);
});

test("owned label dragging composes relayout and stays outside visibility/figure updates", async () => {
  const axes = [referenceLines.referenceAxis("x", "cycle", "", "Cycle"), referenceLines.referenceAxis("y", "capacity", "mAh", "Capacity")];
  const line = referenceLines.createReferenceLine(axes[1], axes[0], "threshold");
  const layout = referenceLines.withReferenceLines({}, normalizePlotStyle({ reference_lines: [line] }), axes);
  const harness = makePlotHarness();
  let zoomCallbacks = 0;
  const moves: referenceLines.ReferenceLabelMove[][] = [];
  await harness.mount([true, true], undefined, {
    layout, config: { edits: { legendPosition: true } },
    onRelayout: () => zoomCallbacks++, onReferenceLabelMove: (value: referenceLines.ReferenceLabelMove[]) => moves.push(value),
  });
  (harness.graph as any)._fullLayout = { xaxis: { range: [1, 9], domain: [0, 1] }, yaxis: { range: [0, 100], domain: [0, 1] } };
  assert.equal(harness.readConfig().edits.annotationPosition, true);
  assert.equal(harness.readConfig().edits.legendPosition, true);
  harness.emitRelayout({ "annotations[0].x": 0.25, "annotations[0].y": 50 });
  assert.equal(zoomCallbacks, 1); assert.equal(moves.length, 1); assert.equal(moves[0][0].y, 0.5);
  harness.pauseRestyle(async () => { harness.emitRelayout({ "annotations[0].x": 0.75, "annotations[0].y": 60 }); });
  await harness.visibility([false, true]);
  assert.equal(moves.length, 1, "internal visibility work cannot persist label changes");
  assert.equal(harness.calls.restyle, 1); assert.equal(harness.calls.relayout, 1);
  harness.queueFigure([{ type: "scatter", opacity: 0.4 }, { type: "scatter" }]);
  harness.emitRelayout({ "annotations[0].x": 0.75, "annotations[0].y": 60 });
  assert.equal(moves.length, 1, "a pending replacement cannot persist a stale annotation index");
});

test("hide and show restore authored style without axis-update feedback", async () => {
  const harness = makePlotHarness();
  await harness.mount([true, true]);
  assert.equal(harness.calls.restyle, 0);
  assert.equal(harness.calls.relayout, 0);
  await harness.visibility([false, true]);
  await harness.visibility([true, true]);
  assert.equal(harness.calls.restyle, 2);
  assert.equal(harness.calls.relayout, 2);
  assert.equal(harness.calls.externalUpdates, 0);
  assert.equal(harness.graph.data[0].opacity, 0.6);
  assert.equal(harness.graph.data[0].showlegend, true);
});

test("a figure replacement during a visibility update still completes and reapplies visibility", async () => {
  const harness = makePlotHarness();
  await harness.mount([true, true]);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  harness.pauseRestyle(() => pending);
  const hide = harness.visibility([false, true]);
  await setImmediate();
  harness.queueFigure([{ type: "scatter", opacity: 0.4 }, { type: "scatter" }]);
  harness.completeFigure();
  release();
  await hide;
  await harness.settle();
  assert.equal(harness.calls.externalUpdates, 1);
  assert.equal(harness.graph.data[0].opacity, 0);
  assert.equal(harness.calls.restyle, 2);
  assert.equal(harness.calls.relayout, 1);
});

test("an old restyle event cannot complete a queued replacement figure", async () => {
  const harness = makePlotHarness();
  await harness.mount([true, true]);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  harness.pauseRestyle(() => pending);
  const hide = harness.visibility([false, true]);
  await setImmediate();
  harness.queueFigure([{ type: "scatter", opacity: 0.4 }, { type: "scatter" }]);
  release();
  await hide;
  assert.equal(harness.calls.externalUpdates, 0);
  assert.equal(harness.calls.relayout, 0);
  harness.completeFigure();
  await harness.settle();
  assert.equal(harness.calls.externalUpdates, 1);
  assert.equal(harness.graph.data[0].opacity, 0);
});
