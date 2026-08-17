// Plotly wrapped for bundling with Vite (dist-min build + factory).
import Plotly from "plotly.js-dist-min";
import factoryModule from "react-plotly.js/factory";
import { resolvePlotlyFactory } from "./plotFactory";

const createPlotlyComponent = resolvePlotlyFactory(factoryModule);
const Plot = createPlotlyComponent(Plotly as never);
export default Plot;
