// Plotly wrapped for bundling with Vite (dist-min build + factory).
import Plotly from "plotly.js-dist-min";
import type { Figure, PlotParams } from "react-plotly.js";
import factoryModule from "react-plotly.js/factory";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolvePlotlyFactory } from "./plotFactory";
import {
  disposePlotlyCssZoomHoverCompensation,
  installPlotlyCssZoomHoverCompensation,
} from "../features/analyses/editor/plotting/plotRuntime";
import {
  blockPlotlyLegendVisibility,
  disablePlotlyLegendVisibility,
} from "../features/analyses/editor/policies/analysisVisibility";

const createPlotlyComponent = resolvePlotlyFactory(factoryModule);

const PlotlyComponent = createPlotlyComponent(Plotly as never);

type PlotTraceVisibility = readonly (boolean | "legendonly")[];

type ScatterGlOpacity = number | readonly number[];

type ScatterGlSceneOption = {
  opacity?: ScatterGlOpacity;
};

type ScatterGlComponent = {
  update(options: unknown): void;
};

type ScatterGlText = ScatterGlComponent & {
  render(): void;
};

type ScatterGlScene = {
  count?: number;
  lineOptions?: Array<ScatterGlSceneOption | null | undefined>;
  fillOptions?: Array<ScatterGlSceneOption | null | undefined>;
  markerOptions?: Array<ScatterGlSceneOption | null | undefined>;
  markerSelectedOptions?: Array<ScatterGlSceneOption | null | undefined>;
  markerUnselectedOptions?: Array<ScatterGlSceneOption | null | undefined>;
  errorXOptions?: Array<ScatterGlSceneOption | null | undefined>;
  errorYOptions?: Array<ScatterGlSceneOption | null | undefined>;
  textOptions?: Array<ScatterGlSceneOption | null | undefined>;
  selectBatch?: Array<readonly unknown[]>;
  unselectBatch?: Array<readonly unknown[]>;
  line2d?: unknown;
  fill2d?: unknown;
  scatter2d?: unknown;
  error2d?: unknown;
  select2d?: unknown;
  glText?: Array<ScatterGlText | null | undefined>;
  draw?: () => void;
};

type ScatterGlCalcDatum = {
  trace?: { type?: string };
  t?: { _scene?: ScatterGlScene; index?: number };
};

type PlotlyGraphDiv = HTMLElement & {
  calcdata?: Array<Array<ScatterGlCalcDatum>>;
  _fullLayout?: {
    _glcanvas?: {
      each?: (callback: (canvas: { regl?: { clear(options: unknown): void } }) => void) => void;
    };
  };
};

type ScatterGlOpacitySnapshot = {
  line?: ScatterGlOpacity;
  fill?: ScatterGlOpacity;
  marker?: ScatterGlOpacity;
  markerSelected?: ScatterGlOpacity;
  markerUnselected?: ScatterGlOpacity;
  errorX?: ScatterGlOpacity;
  errorY?: ScatterGlOpacity;
  text?: ScatterGlOpacity;
};

type ScatterGlVisibilityTarget = {
  scene: ScatterGlScene;
  index: number;
  traceIndex: number;
};

function hasScatterGlUpdate(value: unknown): value is ScatterGlComponent {
  return Boolean(value && typeof (value as Partial<ScatterGlComponent>).update === "function");
}

function cloneScatterGlOpacity(value: ScatterGlOpacity | undefined): ScatterGlOpacity | undefined {
  return Array.isArray(value) ? [...value] : value;
}

function hiddenScatterGlOpacity(value: ScatterGlOpacity | undefined): ScatterGlOpacity {
  return Array.isArray(value) ? value.map(() => 0) : 0;
}

function sceneOpacitySnapshot(
  scene: ScatterGlScene,
  index: number,
): ScatterGlOpacitySnapshot {
  return {
    line: cloneScatterGlOpacity(scene.lineOptions?.[index]?.opacity),
    fill: cloneScatterGlOpacity(scene.fillOptions?.[index]?.opacity),
    marker: cloneScatterGlOpacity(scene.markerOptions?.[index]?.opacity),
    markerSelected: cloneScatterGlOpacity(scene.markerSelectedOptions?.[index]?.opacity),
    markerUnselected: cloneScatterGlOpacity(scene.markerUnselectedOptions?.[index]?.opacity),
    errorX: cloneScatterGlOpacity(scene.errorXOptions?.[index]?.opacity),
    errorY: cloneScatterGlOpacity(scene.errorYOptions?.[index]?.opacity),
    text: cloneScatterGlOpacity(scene.textOptions?.[index]?.opacity),
  };
}

function setSceneOptionOpacity(
  option: ScatterGlSceneOption | null | undefined,
  opacity: ScatterGlOpacity | undefined,
  hidden: boolean,
): void {
  if (!option) return;
  option.opacity = hidden ? hiddenScatterGlOpacity(opacity) : opacity ?? 1;
}

function setScatterGlSceneVisibility(
  scene: ScatterGlScene,
  index: number,
  hidden: boolean,
  snapshots: Map<number, ScatterGlOpacitySnapshot>,
): void {
  let snapshot = snapshots.get(index);
  if (!snapshot) {
    snapshot = sceneOpacitySnapshot(scene, index);
    snapshots.set(index, snapshot);
  }
  setSceneOptionOpacity(scene.lineOptions?.[index], snapshot.line, hidden);
  setSceneOptionOpacity(scene.fillOptions?.[index], snapshot.fill, hidden);
  setSceneOptionOpacity(scene.markerOptions?.[index], snapshot.marker, hidden);
  setSceneOptionOpacity(scene.markerSelectedOptions?.[index], snapshot.markerSelected, hidden);
  setSceneOptionOpacity(scene.markerUnselectedOptions?.[index], snapshot.markerUnselected, hidden);
  setSceneOptionOpacity(scene.errorXOptions?.[index], snapshot.errorX, hidden);
  setSceneOptionOpacity(scene.errorYOptions?.[index], snapshot.errorY, hidden);
  setSceneOptionOpacity(scene.textOptions?.[index], snapshot.text, hidden);
}

function sceneOpacityBatch(
  options: Array<ScatterGlSceneOption | null | undefined> | undefined,
  indices: readonly number[],
  count: number,
): Array<ScatterGlSceneOption | undefined> {
  const batch: Array<ScatterGlSceneOption | undefined> = new Array(
    Math.max(count, options?.length ?? 0),
  ).fill(undefined);
  for (const index of indices) {
    const option = options?.[index];
    if (option) batch[index] = { opacity: option.opacity };
  }
  return batch;
}

function updateScatterGlSceneStyles(
  scene: ScatterGlScene,
  indices: readonly number[],
): void {
  const count = scene.count ?? 0;
  if (hasScatterGlUpdate(scene.line2d)) {
    scene.line2d.update(sceneOpacityBatch(scene.lineOptions, indices, count));
  }
  if (hasScatterGlUpdate(scene.fill2d)) {
    scene.fill2d.update(sceneOpacityBatch(scene.fillOptions, indices, count));
  }
  if (hasScatterGlUpdate(scene.error2d)) {
    const errorBatch = new Array<ScatterGlSceneOption | undefined>(count * 2).fill(undefined);
    for (const index of indices) {
      const errorX = scene.errorXOptions?.[index];
      const errorY = scene.errorYOptions?.[index];
      if (errorX) errorBatch[index] = { opacity: errorX.opacity };
      if (errorY) errorBatch[count + index] = { opacity: errorY.opacity };
    }
    scene.error2d.update(errorBatch);
  }

  const selected = indices.filter(
    (index) =>
      Boolean(scene.selectBatch?.[index]?.length) ||
      Boolean(scene.unselectBatch?.[index]?.length),
  );
  const activeMarkerOptions = selected.length ? scene.markerUnselectedOptions : scene.markerOptions;
  if (hasScatterGlUpdate(scene.scatter2d)) {
    scene.scatter2d.update(sceneOpacityBatch(activeMarkerOptions, indices, count));
  }
  if (hasScatterGlUpdate(scene.select2d)) {
    scene.select2d.update(sceneOpacityBatch(scene.markerOptions, indices, count));
    scene.select2d.update(sceneOpacityBatch(scene.markerSelectedOptions, indices, count));
  }
  for (const index of indices) {
    const text = scene.glText?.[index];
    if (hasScatterGlUpdate(text)) {
      text.update({ opacity: scene.textOptions?.[index]?.opacity ?? 1 });
    }
  }
}

function scatterGlVisibilityTargets(
  graphDiv: PlotlyGraphDiv,
  data: PlotParams["data"],
  indices: readonly number[],
): ScatterGlVisibilityTarget[] {
  const targets: ScatterGlVisibilityTarget[] = [];
  for (const traceIndex of indices) {
    const dataTrace = data[traceIndex] as (Plotly.Data & { type?: string }) | undefined;
    const calcDatum = graphDiv.calcdata?.[traceIndex]?.[0];
    if (dataTrace?.type !== "scattergl" && calcDatum?.trace?.type !== "scattergl") continue;
    const scene = calcDatum?.t?._scene;
    const index = calcDatum?.t?.index;
    if (!scene || index === undefined) continue;
    targets.push({ scene, index, traceIndex });
  }
  return targets;
}

function redrawScatterGlScenes(graphDiv: PlotlyGraphDiv, scenes: Iterable<ScatterGlScene>): void {
  graphDiv._fullLayout?._glcanvas?.each?.((canvas) => {
    canvas.regl?.clear({ color: true, depth: true });
  });
  for (const scene of scenes) scene.draw?.();
}

function applyScatterGlVisibility(
  graphDiv: HTMLElement,
  data: PlotParams["data"],
  changed: readonly { index: number; hidden: boolean }[],
  snapshots: Map<ScatterGlScene, Map<number, ScatterGlOpacitySnapshot>>,
): Set<number> {
  const typedGraphDiv = graphDiv as PlotlyGraphDiv;
  const targets = scatterGlVisibilityTargets(
    typedGraphDiv,
    data,
    changed.map(({ index }) => index),
  );
  if (!targets.length) return new Set();

  const hiddenByTraceIndex = new Map(changed.map(({ index, hidden }) => [index, hidden]));
  const indicesByScene = new Map<ScatterGlScene, number[]>();
  const scenes = new Set<ScatterGlScene>();
  for (const row of typedGraphDiv.calcdata ?? []) {
    const scene = row[0]?.t?._scene;
    if (scene) scenes.add(scene);
  }
  for (const target of targets) {
    const sceneSnapshots = snapshots.get(target.scene) ?? new Map();
    snapshots.set(target.scene, sceneSnapshots);
    setScatterGlSceneVisibility(
      target.scene,
      target.index,
      hiddenByTraceIndex.get(target.traceIndex) ?? false,
      sceneSnapshots,
    );
    const sceneIndices = indicesByScene.get(target.scene) ?? [];
    if (!sceneIndices.includes(target.index)) sceneIndices.push(target.index);
    indicesByScene.set(target.scene, sceneIndices);
  }
  for (const [scene, sceneIndices] of indicesByScene) {
    updateScatterGlSceneStyles(scene, sceneIndices);
  }
  redrawScatterGlScenes(typedGraphDiv, scenes);
  return new Set(targets.map(({ traceIndex }) => traceIndex));
}

type PlotProps = PlotParams & {
  /**
   * Optional display-only visibility applied without replacing the figure.
   * Plotly.react treats a changed trace count as a full replot, so callers
   * with a stable trace array can use this for fast local visibility edits.
   */
  traceVisibility?: PlotTraceVisibility;
};

function Plot({ traceVisibility, ...props }: PlotProps) {
  const graphDivRef = useRef<HTMLElement | null>(null);
  const latestVisibilityRef = useRef<PlotTraceVisibility | undefined>(traceVisibility);
  latestVisibilityRef.current = traceVisibility;
  const appliedVisibilityRef = useRef<PlotTraceVisibility | null>(null);
  const visibilityUpdateRef = useRef(Promise.resolve());
  const internalVisibilityRestyleRef = useRef(0);
  const scatterGlVisibilitySnapshotsRef = useRef(
    new Map<ScatterGlScene, Map<number, ScatterGlOpacitySnapshot>>(),
  );
  const previousFigureRef = useRef<{
    data: PlotParams["data"];
    layout: PlotParams["layout"];
    config: PlotParams["config"];
  } | null>(null);
  const figureUpdatePendingRef = useRef(false);
  const [plotGeneration, setPlotGeneration] = useState(0);

  // Plot cards deliberately memoize layout objects because react-plotly.js
  // treats reference changes as update/relayout signals. Add the passive
  // legend flags without discarding that identity on unrelated React renders.
  const passiveLayout = useMemo(
    () => disablePlotlyLegendVisibility(props.layout),
    [props.layout],
  );

  useLayoutEffect(() => {
    const previous = previousFigureRef.current;
    if (
      previous &&
      (previous.data !== props.data || previous.layout !== passiveLayout || previous.config !== props.config)
    ) {
      // Wait until react-plotly.js has completed its Plotly.react call before
      // restyling visibility; otherwise a result replacement could race the
      // old graph and briefly apply indices to the wrong figure.
      figureUpdatePendingRef.current = true;
    }
    previousFigureRef.current = {
      data: props.data,
      layout: passiveLayout,
      config: props.config,
    };
  }, [passiveLayout, props.config, props.data]);

  useEffect(() => {
    const graphDiv = graphDivRef.current;
    const requested = traceVisibility;
    if (!graphDiv || !requested || figureUpdatePendingRef.current) return;

    visibilityUpdateRef.current = visibilityUpdateRef.current
      .catch(() => undefined)
      .then(async () => {
        const next = latestVisibilityRef.current;
        if (!next || graphDivRef.current !== graphDiv) return;
        const previous = appliedVisibilityRef.current;
        if (figureUpdatePendingRef.current) return;
        const changed: Array<{ index: number; hidden: boolean }> = [];
        next.forEach((value, index) => {
          if (previous === null ? value !== true : previous[index] !== value) {
            changed.push({ index, hidden: value === false });
          }
        });
        if (changed.length === 0) return;

        // scattergl classifies even opacity/showlegend edits as calc changes.
        // Update its resident GPU scene directly so hiding a trace does not
        // enter Plotly's full replot path or clear the shared canvas.
        const scatterGlIndices = applyScatterGlVisibility(
          graphDiv,
          props.data,
          changed,
          scatterGlVisibilitySnapshotsRef.current,
        );
        const restyleChanges = changed.filter(({ index }) => !scatterGlIndices.has(index));
        if (restyleChanges.length > 0) {
          const indices = restyleChanges.map(({ index }) => index);
          const opacityValues = restyleChanges.map(({ index, hidden }) => {
            const trace = props.data[index] as Plotly.Data & { opacity?: number } | undefined;
            return hidden ? 0 : Number(trace?.opacity ?? 1);
          });
          const legendValues = restyleChanges.map(({ hidden, index }) => {
            const trace = props.data[index] as Plotly.Data & { showlegend?: boolean } | undefined;
            return hidden ? false : trace?.showlegend !== false;
          });
          internalVisibilityRestyleRef.current += 1;
          try {
            // SVG traces support a genuine style-only restyle. Keep this
            // fallback for callers that provide a mixed SVG/WebGL figure or
            // for a graph whose private WebGL scene is not available yet.
            await Plotly.restyle(
              graphDiv as never,
              { opacity: opacityValues, showlegend: legendValues } as unknown as Plotly.Data,
              indices,
            );
          } finally {
            // Plotly emits plotly_restyle before resolving the promise. The
            // fallback also prevents a failed/mocked implementation from
            // suppressing the next real figure update.
            internalVisibilityRestyleRef.current = Math.max(
              0,
              internalVisibilityRestyleRef.current - 1,
            );
          }
        }
        appliedVisibilityRef.current = [...next];
      });
  }, [plotGeneration, traceVisibility]);

  const handlePlotInitialized = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    graphDivRef.current = graphDiv as HTMLElement;
    figureUpdatePendingRef.current = false;
    appliedVisibilityRef.current = null;
    scatterGlVisibilitySnapshotsRef.current.clear();
    setPlotGeneration((generation) => generation + 1);
    installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
    props.onInitialized?.(figure, graphDiv);
  };

  const handlePlotUpdated = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    if (internalVisibilityRestyleRef.current > 0) {
      internalVisibilityRestyleRef.current -= 1;
      return;
    }
    graphDivRef.current = graphDiv as HTMLElement;
    figureUpdatePendingRef.current = false;
    appliedVisibilityRef.current = null;
    scatterGlVisibilitySnapshotsRef.current.clear();
    setPlotGeneration((generation) => generation + 1);
    installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
    props.onUpdate?.(figure, graphDiv);
  };

  const handlePlotPurged = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    graphDivRef.current = null;
    appliedVisibilityRef.current = null;
    scatterGlVisibilitySnapshotsRef.current.clear();
    disposePlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
    props.onPurge?.(figure, graphDiv);
  };

  return (
    <PlotlyComponent
      {...props}
      layout={passiveLayout}
      onLegendClick={(event) => {
        props.onLegendClick?.(event);
        return blockPlotlyLegendVisibility();
      }}
      onLegendDoubleClick={(event) => {
        props.onLegendDoubleClick?.(event);
        return blockPlotlyLegendVisibility();
      }}
      onInitialized={handlePlotInitialized}
      onUpdate={handlePlotUpdated}
      onPurge={handlePlotPurged}
    />
  );
}

export default Plot;
