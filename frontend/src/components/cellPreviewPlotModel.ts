/** Shared figure geometry and trace conventions for cell preview plots. */

export type CellPreviewPlotColors = {
  background: string;
  text: string;
  border: string;
  grid: string;
};

export type CellPreviewCapacityMode = "discharge" | "both" | "charge";

export type CellPreviewCycleSeries = {
  x: Array<number | null>;
  sourceKey?: string;
  chargeX?: Array<number | null>;
  dischargeX?: Array<number | null>;
  chargeCapacityMah?: Array<number | null>;
  dischargeCapacityMah?: Array<number | null>;
  efficiencyX?: Array<number | null>;
  efficiencyPct?: Array<number | null>;
  massG?: number | null;
  name?: string;
  chargeColor?: string;
  dischargeColor?: string;
  efficiencyColor?: string;
  capacityOpacity?: number;
};

type CellPreviewTrace = {
  type: "scatter";
  mode: "lines" | "markers";
  name: string;
  x: Array<number | null>;
  y: Array<number | null>;
  yaxis?: "y2";
  line?: { color: string; width: number };
  marker?: { color: string; size: number; symbol: "circle" | "square"; opacity?: number };
  connectgaps?: boolean;
  hovertemplate: string;
  showlegend?: boolean;
};

const APP_COLORS = {
  voltage: "#12b886",
  current: "#2E86AB",
  charge: "#12b886",
  discharge: "#2E86AB",
  efficiency: "#E63946",
};

function frameShape(colors: CellPreviewPlotColors, width: number) {
  return {
    type: "rect" as const,
    xref: "paper" as const,
    yref: "paper" as const,
    x0: 0,
    x1: 1,
    y0: 0,
    y1: 1,
    line: { color: colors.border, width },
    fillcolor: "rgba(0,0,0,0)",
    layer: "above" as const,
  };
}

function axisTitle(text: string, colors: CellPreviewPlotColors) {
  return { text, font: { family: "Arial, sans-serif", size: 17, color: colors.text } };
}

function tickFont(colors: CellPreviewPlotColors) {
  return { family: "Arial, sans-serif", size: 17, color: colors.text };
}

/** Same 352px, two-pane voltage/current figure used by the Analysis picker. */
export function cellPreviewVoltageLayout(
  colors: CellPreviewPlotColors,
  xLabel: string,
  uirevision: string,
) {
  return {
    autosize: true,
    height: 352,
    margin: { l: 76, r: 24, t: 8, b: 58 },
    showlegend: false,
    paper_bgcolor: colors.background,
    plot_bgcolor: colors.background,
    font: { family: "Arial, sans-serif", color: colors.text, size: 17 },
    uirevision,
    xaxis: {
      title: axisTitle(xLabel, colors),
      domain: [0, 1],
      tickfont: tickFont(colors),
      showline: false,
      showgrid: false,
      zeroline: false,
      automargin: true,
      anchor: "y2" as const,
    },
    yaxis: {
      title: axisTitle("Voltage (V)", colors),
      tickfont: tickFont(colors),
      domain: [0.30, 1],
      showline: false,
      gridcolor: colors.grid,
      gridwidth: 0.5,
      zeroline: false,
      automargin: true,
    },
    yaxis2: {
      title: axisTitle("Current (mA)", colors),
      tickfont: tickFont(colors),
      domain: [0, 0.23],
      showline: false,
      gridcolor: colors.grid,
      gridwidth: 0.5,
      zeroline: false,
      automargin: true,
      anchor: "x" as const,
    },
    shapes: [frameShape(colors, 1)],
  };
}

/** Same framed capacity + CE plot, including the visible CE subplot baseline. */
export function cellPreviewCapacityLayout(
  colors: CellPreviewPlotColors,
  capacityLabel: string,
  ceRange: [number, number] | undefined,
  uirevision: string,
) {
  return {
    autosize: true,
    height: 352,
    margin: { l: 76, r: 24, t: 8, b: 58 },
    showlegend: false,
    paper_bgcolor: colors.background,
    plot_bgcolor: colors.background,
    font: { family: "Arial, sans-serif", color: colors.text, size: 17 },
    uirevision,
    xaxis: {
      title: axisTitle("Cycle", colors),
      tickfont: tickFont(colors),
      showline: false,
      showgrid: false,
      zeroline: false,
      automargin: true,
      anchor: "y" as const,
      autorange: true,
    },
    yaxis: {
      title: axisTitle(capacityLabel, colors),
      tickfont: tickFont(colors),
      domain: [0, 0.72],
      showline: false,
      gridcolor: colors.grid,
      gridwidth: 0.8,
      zeroline: false,
      automargin: true,
    },
    yaxis2: {
      title: axisTitle("CE (%)", colors),
      tickfont: tickFont(colors),
      domain: [0.77, 1],
      side: "left" as const,
      showline: false,
      gridcolor: colors.grid,
      gridwidth: 0.8,
      zeroline: false,
      automargin: true,
      anchor: "x" as const,
      autorange: ceRange === undefined,
      ...(ceRange ? { range: ceRange } : {}),
    },
    shapes: [
      frameShape(colors, 1.5),
      {
        type: "line" as const,
        xref: "paper" as const,
        yref: "paper" as const,
        x0: 0,
        x1: 1,
        y0: 0.77,
        y1: 0.77,
        line: { color: colors.border, width: 1 },
        layer: "above" as const,
      },
    ],
  };
}

export function paddedEfficiencyRange(values: readonly (number | null | undefined)[]): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  const padding = (max - min) * 0.15 || Math.max(Math.abs(min) * 0.15, 1);
  return [min - padding, max + padding];
}

export function cellPreviewVoltageTraces(
  series: Array<{ x: Array<number | null>; voltage: Array<number | null>; current?: Array<number | null>; name?: string; voltageColor?: string; currentColor?: string; opacity?: number }>,
): CellPreviewTrace[] {
  return series.flatMap((item) => {
    const voltageName = item.name ? `Voltage — ${item.name}` : "Voltage";
    const currentName = item.name ? `Current — ${item.name}` : "Current";
    const output: CellPreviewTrace[] = [{
      type: "scatter",
      mode: "lines",
      name: voltageName,
      x: item.x,
      y: item.voltage,
      line: { color: item.voltageColor ?? APP_COLORS.voltage, width: 2.6 },
      ...(item.opacity === undefined ? {} : { opacity: item.opacity }),
      connectgaps: false,
      hovertemplate: "%{x:.3g}<br>%{y:.4g} V<extra>Voltage</extra>",
      showlegend: false,
    }];
    if (item.current?.length === item.x.length) output.push({
      type: "scatter",
      mode: "lines",
      name: currentName,
      x: item.x,
      y: item.current,
      yaxis: "y2",
      line: { color: item.currentColor ?? APP_COLORS.current, width: 2 },
      ...(item.opacity === undefined ? {} : { opacity: item.opacity }),
      connectgaps: false,
      hovertemplate: "%{x:.3g}<br>%{y:.4g} mA<extra>Current</extra>",
      showlegend: false,
    });
    return output;
  });
}

export function cellPreviewCapacityTraces(
  series: CellPreviewCycleSeries[],
  mode: CellPreviewCapacityMode,
  normalizeByMass: boolean,
): CellPreviewTrace[] {
  return series.flatMap((item) => {
    const name = item.name ? ` — ${item.name}` : "";
    const capacity = (values: Array<number | null> | undefined) => (values ?? []).map((value) =>
      value === null || !normalizeByMass || !item.massG ? value : value / item.massG,
    );
    const traces: CellPreviewTrace[] = [];
    if (mode !== "charge" && item.dischargeCapacityMah?.length) traces.push({
      type: "scatter",
      mode: "markers",
      name: `Discharge capacity${name}`,
      x: item.dischargeX ?? item.x,
      y: capacity(item.dischargeCapacityMah),
      marker: { color: item.dischargeColor ?? APP_COLORS.discharge, size: 9, symbol: "square", ...(item.capacityOpacity === undefined ? {} : { opacity: item.capacityOpacity }) },
      hovertemplate: `Cycle %{x}<br>%{y:.4g} ${normalizeByMass && item.massG ? "mAh/g" : "mAh"}<extra>Discharge capacity</extra>`,
      showlegend: false,
    });
    if (mode !== "discharge" && item.chargeCapacityMah?.length) traces.push({
      type: "scatter",
      mode: "markers",
      name: `Charge capacity${name}`,
      x: item.chargeX ?? item.x,
      y: capacity(item.chargeCapacityMah),
      marker: { color: item.chargeColor ?? APP_COLORS.charge, size: 9, symbol: "circle", ...(item.capacityOpacity === undefined ? {} : { opacity: item.capacityOpacity }) },
      hovertemplate: `Cycle %{x}<br>%{y:.4g} ${normalizeByMass && item.massG ? "mAh/g" : "mAh"}<extra>Charge capacity</extra>`,
      showlegend: false,
    });
    if (item.efficiencyX?.length && item.efficiencyPct?.length) traces.push({
      type: "scatter",
      mode: "markers",
      name: `Coulombic efficiency${name}`,
      x: item.efficiencyX,
      y: item.efficiencyPct,
      yaxis: "y2",
      marker: { color: item.efficiencyColor ?? APP_COLORS.efficiency, size: 4.5, symbol: "circle", opacity: 0.3 },
      hovertemplate: "Cycle %{x}<br>%{y:.3g}%<extra>Coulombic efficiency</extra>",
      showlegend: false,
    });
    return traces;
  });
}
