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

type PlotTraceVisibilityStyle = {
  opacity: number;
  showlegend: boolean;
};

type PlotlyGraphDiv = HTMLElement & {
  _fullLayout?: Plotly.Layout;
  calcdata?: Array<Array<{ trace?: { type?: string } }>>;
  once?: (eventName: string, listener: () => void) => void;
  removeListener?: (eventName: string, listener: () => void) => void;
};

function hasScatterGlVisibilityChange(
  graphDiv: HTMLElement,
  data: PlotParams["data"],
  changed: readonly { index: number }[],
): boolean {
  const typedGraphDiv = graphDiv as PlotlyGraphDiv;
  return changed.some(({ index }) => {
    const dataTrace = data[index] as (Plotly.Data & { type?: string }) | undefined;
    return (
      dataTrace?.type === "scattergl" ||
      typedGraphDiv.calcdata?.[index]?.[0]?.trace?.type === "scattergl"
    );
  });
}

type PlotFrameHold = {
  remove(): void;
};

function holdVisibleScatterGlFrame(graphDiv: HTMLElement): PlotFrameHold | null {
  const sourceCanvases = Array.from(
    graphDiv.querySelectorAll<HTMLCanvasElement>(
      ".gl-canvas-context, .gl-canvas-focus",
    ),
  );
  const overlays: HTMLCanvasElement[] = [];

  for (const source of sourceCanvases) {
    const parent = source.parentElement;
    if (!parent || source.width === 0 || source.height === 0) continue;

    const overlay = document.createElement("canvas");
    overlay.className = "cellxplorer-gl-frame-hold";
    overlay.width = source.width;
    overlay.height = source.height;
    overlay.style.cssText = source.style.cssText;
    overlay.style.pointerEvents = "none";

    const context = overlay.getContext("2d");
    if (!context) continue;
    try {
      context.drawImage(source, 0, 0);
    } catch {
      continue;
    }

    parent.appendChild(overlay);
    overlays.push(overlay);
  }

  if (overlays.length === 0) return null;

  let removed = false;
  return {
    remove() {
      if (removed) return;
      removed = true;
      for (const overlay of overlays) overlay.remove();
    },
  };
}

type PlotProps = PlotParams & {
  /**
   * Optional display-only visibility applied without replacing the figure.
   * Plotly.react treats a changed trace count as a full replot, so callers
   * with a stable trace array can use this for fast local visibility edits.
   */
  traceVisibility?: PlotTraceVisibility;
  /** Apply axis changes alongside a trace-visibility restyle, without Plotly.react. */
  traceVisibilityLayoutUpdate?: Partial<Plotly.Layout>;
  /** Changes only when a visibility or axis-mode edit requests a new fit. */
  traceVisibilityLayoutKey?: string;
};

function Plot({ traceVisibility, traceVisibilityLayoutUpdate, traceVisibilityLayoutKey, ...props }: PlotProps) {
  const graphDivRef = useRef<HTMLElement | null>(null);
  const latestVisibilityRef = useRef<PlotTraceVisibility | undefined>(traceVisibility);
  latestVisibilityRef.current = traceVisibility;
  const appliedVisibilityRef = useRef<PlotTraceVisibility | null>(null);
  const appliedVisibilityLayoutRef = useRef<Partial<Plotly.Layout> | undefined>(undefined);
  const appliedVisibilityLayoutKeyRef = useRef<string | undefined>(undefined);
  const figureVersionRef = useRef(0);
  const baseVisibilityStylesRef = useRef<PlotTraceVisibilityStyle[]>([]);
  const visibilityUpdateRef = useRef(Promise.resolve());
  const internalVisibilityRestyleRef = useRef(0);
  const frameHoldsRef = useRef(new Set<PlotFrameHold>());
  const latestVisibilityLayoutRef = useRef(traceVisibilityLayoutUpdate);
  latestVisibilityLayoutRef.current = traceVisibilityLayoutUpdate;
  const latestVisibilityLayoutKeyRef = useRef(traceVisibilityLayoutKey);
  latestVisibilityLayoutKeyRef.current = traceVisibilityLayoutKey;
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
    if (!previous || previous.data !== props.data) {
      // Plotly.restyle mutates its resident trace objects. Capture the authored
      // values before the first visibility edit so showing a trace restores
      // its real style rather than the opacity:0/showlegend:false hide state.
      baseVisibilityStylesRef.current = props.data.map((trace) => {
        const styledTrace = trace as Plotly.Data & {
          opacity?: number;
          showlegend?: boolean;
        };
        return {
          opacity: Number(styledTrace.opacity ?? 1),
          showlegend: styledTrace.showlegend !== false,
        };
      });
    }
    if (
      previous &&
      (previous.data !== props.data || previous.layout !== passiveLayout || previous.config !== props.config)
    ) {
      // Wait until react-plotly.js has completed its Plotly.react call before
      // restyling visibility; otherwise a result replacement could race the
      // old graph and briefly apply indices to the wrong figure.
      figureUpdatePendingRef.current = true;
      figureVersionRef.current += 1;
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
    const queuedFigureVersion = figureVersionRef.current;

    visibilityUpdateRef.current = visibilityUpdateRef.current
      .catch(() => undefined)
      .then(async () => {
        const next = latestVisibilityRef.current;
        if (!next || graphDivRef.current !== graphDiv || figureVersionRef.current !== queuedFigureVersion) return;
        const previous = appliedVisibilityRef.current;
        if (figureUpdatePendingRef.current) return;
        const nextLayout = latestVisibilityLayoutRef.current;
        const nextLayoutKey = latestVisibilityLayoutKeyRef.current;
        const layoutChanged = nextLayoutKey === undefined
          ? nextLayout !== appliedVisibilityLayoutRef.current
          : nextLayoutKey !== appliedVisibilityLayoutKeyRef.current;
        const changed: Array<{ index: number; hidden: boolean }> = [];
        next.forEach((value, index) => {
          if (previous === null ? value !== true : previous[index] !== value) {
            changed.push({ index, hidden: value === false });
          }
        });
        if (changed.length === 0 && !layoutChanged) return;

        const indices = changed.map(({ index }) => index);
        const opacityValues = changed.map(({ index, hidden }) => {
          const baseStyle = baseVisibilityStylesRef.current[index];
          return hidden ? 0 : baseStyle?.opacity ?? 1;
        });
        const legendValues = changed.map(({ hidden, index }) => {
          const baseStyle = baseVisibilityStylesRef.current[index];
          return hidden ? false : baseStyle?.showlegend ?? true;
        });
        const frameHold = hasScatterGlVisibilityChange(graphDiv, props.data, changed)
          ? holdVisibleScatterGlFrame(graphDiv)
          : null;
        let releaseFrameHold: (() => void) | null = null;
        if (frameHold) {
          frameHoldsRef.current.add(frameHold);
          const plotlyGraphDiv = graphDiv as PlotlyGraphDiv;
          let fallbackTimer: number | null = null;
          releaseFrameHold = () => {
            plotlyGraphDiv.removeListener?.("plotly_afterplot", releaseFrameHold!);
            if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
            frameHold.remove();
            frameHoldsRef.current.delete(frameHold);
          };
          if (plotlyGraphDiv.once) {
            // scattergl resolves restyle before the browser necessarily shows
            // the replacement canvas. Hold the previous frame until Plotly's
            // own completed-paint boundary instead of guessing one RAF.
            plotlyGraphDiv.once("plotly_afterplot", releaseFrameHold);
            fallbackTimer = window.setTimeout(releaseFrameHold, 1_000);
          }
        }
        let layoutApplied = !layoutChanged || !nextLayout;
        try {
          // Plotly's supported restyle keeps its canonical trace, legend, and
          // hover state in sync. A short-lived copy of the visible WebGL
          // frame masks the shared-canvas clear while scattergl recalculates.
          if (changed.length > 0) {
            internalVisibilityRestyleRef.current += 1;
            await Plotly.restyle(
              graphDiv as never,
              { opacity: opacityValues, showlegend: legendValues } as unknown as Plotly.Data,
              indices,
            );
          }
          // A restyle can finish after a replacement figure has started. Never
          // relayout a graph that Plotly is updating or has already purged.
          const graphIsCurrent = () =>
            graphDivRef.current === graphDiv &&
            figureVersionRef.current === queuedFigureVersion &&
            !figureUpdatePendingRef.current &&
            Boolean((graphDiv as PlotlyGraphDiv)._fullLayout);
          // Plotly.react already receives the declarative axis ranges for the
          // initial/current figure. The supplemental relayout exists only to
          // refit axes after a trace visibility restyle; issuing it on the
          // mount path leaves Plotly's drag/zoom interaction in a broken state.
          if (layoutChanged && nextLayout && changed.length > 0 && graphIsCurrent()) {
            await Plotly.relayout(graphDiv as never, nextLayout as never);
            layoutApplied = true;
          }
        } finally {
          // Plotly emits plotly_restyle before resolving the promise. The
          // guard prevents that internal event from being treated as a new
          // externally-driven figure update.
          if (changed.length > 0) {
            internalVisibilityRestyleRef.current = Math.max(
              0,
              internalVisibilityRestyleRef.current - 1,
            );
          }
          if (frameHold && !(graphDiv as PlotlyGraphDiv).once) {
            requestAnimationFrame(() => {
              releaseFrameHold?.();
            });
          }
        }
        if (graphDivRef.current !== graphDiv || figureVersionRef.current !== queuedFigureVersion) return;
        if (changed.length > 0) appliedVisibilityRef.current = [...next];
        if (layoutChanged && layoutApplied) {
          appliedVisibilityLayoutRef.current = nextLayout;
          appliedVisibilityLayoutKeyRef.current = nextLayoutKey;
        }
      })
      .catch(() => {
        // Plotly can reject an in-flight restyle/relayout when React replaces
        // or purges the graph. The next committed figure reapplies visibility.
      });
  }, [plotGeneration, traceVisibility, traceVisibilityLayoutUpdate, traceVisibilityLayoutKey]);

  const handlePlotInitialized = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    graphDivRef.current = graphDiv as HTMLElement;
    figureUpdatePendingRef.current = false;
    figureVersionRef.current += 1;
    appliedVisibilityRef.current = null;
    appliedVisibilityLayoutRef.current = undefined;
    appliedVisibilityLayoutKeyRef.current = undefined;
    for (const frameHold of frameHoldsRef.current) frameHold.remove();
    frameHoldsRef.current.clear();
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
    figureVersionRef.current += 1;
    appliedVisibilityRef.current = null;
    for (const frameHold of frameHoldsRef.current) frameHold.remove();
    frameHoldsRef.current.clear();
    setPlotGeneration((generation) => generation + 1);
    installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
    props.onUpdate?.(figure, graphDiv);
  };

  const handlePlotPurged = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    figureVersionRef.current += 1;
    graphDivRef.current = null;
    appliedVisibilityRef.current = null;
    appliedVisibilityLayoutRef.current = undefined;
    appliedVisibilityLayoutKeyRef.current = undefined;
    for (const frameHold of frameHoldsRef.current) frameHold.remove();
    frameHoldsRef.current.clear();
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
