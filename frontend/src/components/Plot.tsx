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
        const indices: number[] = [];
        const opacityValues: number[] = [];
        const legendValues: boolean[] = [];
        next.forEach((value, index) => {
          if (previous === null ? value !== true : previous[index] !== value) {
            indices.push(index);
            const trace = props.data[index] as Plotly.Data & {
              opacity?: number;
              showlegend?: boolean;
            } | undefined;
            const hidden = value === false;
            opacityValues.push(hidden ? 0 : Number(trace?.opacity ?? 1));
            legendValues.push(hidden ? false : trace?.showlegend !== false);
          }
        });
        if (indices.length === 0) return;
        internalVisibilityRestyleRef.current += 1;
        try {
          // Plotly marks `visible` as a calc edit, which clears and rebuilds
          // the figure. Opacity and legend membership are style edits, so the
          // same stable traces can be hidden without clearing the plot.
          await Plotly.restyle(
            graphDiv as never,
            { opacity: opacityValues, showlegend: legendValues } as unknown as Plotly.Data,
            indices,
          );
          appliedVisibilityRef.current = [...next];
        } catch (error) {
          throw error;
        } finally {
          // Plotly emits plotly_restyle synchronously before resolving the
          // promise. The fallback also prevents a failed/mocked implementation
          // from suppressing the next real figure update.
          internalVisibilityRestyleRef.current = Math.max(
            0,
            internalVisibilityRestyleRef.current - 1,
          );
        }
      });
  }, [plotGeneration, traceVisibility]);

  const handlePlotInitialized = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    graphDivRef.current = graphDiv as HTMLElement;
    figureUpdatePendingRef.current = false;
    appliedVisibilityRef.current = null;
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
    setPlotGeneration((generation) => generation + 1);
    installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
    props.onUpdate?.(figure, graphDiv);
  };

  const handlePlotPurged = (figure: Readonly<Figure>, graphDiv: Readonly<HTMLElement>) => {
    graphDivRef.current = null;
    appliedVisibilityRef.current = null;
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
