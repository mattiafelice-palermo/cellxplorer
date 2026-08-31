// Plotly wrapped for bundling with Vite (dist-min build + factory).
import Plotly from "plotly.js-dist-min";
import type { PlotParams } from "react-plotly.js";
import factoryModule from "react-plotly.js/factory";
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

function Plot(props: PlotParams) {
  return (
    <PlotlyComponent
      {...props}
      layout={disablePlotlyLegendVisibility(props.layout)}
      onLegendClick={(event) => {
        props.onLegendClick?.(event);
        return blockPlotlyLegendVisibility();
      }}
      onLegendDoubleClick={(event) => {
        props.onLegendDoubleClick?.(event);
        return blockPlotlyLegendVisibility();
      }}
      onInitialized={(figure, graphDiv) => {
        installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
        props.onInitialized?.(figure, graphDiv);
      }}
      onUpdate={(figure, graphDiv) => {
        installPlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
        props.onUpdate?.(figure, graphDiv);
      }}
      onPurge={(figure, graphDiv) => {
        disposePlotlyCssZoomHoverCompensation(graphDiv as HTMLElement);
        props.onPurge?.(figure, graphDiv);
      }}
    />
  );
}

export default Plot;
