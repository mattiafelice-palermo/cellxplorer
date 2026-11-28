import type { ChargeBalanceSettings, TimeCapacityTrace } from "../../../../../api";
import { compactHoverName, seriesPlotlyMode, seriesPlotlySymbol, type ResolvedSeriesStyle } from "../../plotting/seriesStyling";
import { sourceExportColumns } from "../../plotting/sourceChainPlot";

export function balanceAxisTitle(settings?: ChargeBalanceSettings) {
  return settings?.unit === "soc" ? "Estimated SOC (%)" : "Charge balance (mAh)";
}

export type BalanceLine = { style: ResolvedSeriesStyle; key: string; rank?: number };
export type BalanceLines = Partial<Record<"primary" | "voltage" | "current", BalanceLine>>;

export function chargeBalanceTraces(
  trace: TimeCapacityTrace, settings: ChargeBalanceSettings, lines: BalanceLines, legendShown: Set<string>,
  webgl: boolean, includeExport: boolean, stacked: boolean,
): Plotly.Data[] {
  if (!lines.primary && !lines.voltage && !lines.current) return [];
  const xs = trace.display_x ?? [];
  const balance = trace.charge_balance_mah ?? [];
  const ys = settings.unit === "soc" ? trace.estimated_soc_pct ?? [] : balance;
  const boundaries = [...new Set([0, ...(trace.display_break_before ?? []), ...(trace.source_boundary_indices ?? []), xs.length])]
    .sort((a, b) => a - b);
  const out: Plotly.Data[] = [];
  const lower: Plotly.Data[] = [];
  const sample = { cell_id: trace.cell_id, group_id: trace.group_id, excluded: trace.excluded };
  const appearance = ({ style, key, rank }: BalanceLine) => {
    const showlegend = style.showInLegend && !legendShown.has(key);
    legendShown.add(key);
    return {
      type: webgl ? "scattergl" : "scatter", name: style.name, legendgroup: key, legendrank: rank, showlegend,
      connectgaps: false, opacity: style.opacity, mode: seriesPlotlyMode(style),
      line: { color: style.color, width: style.lineWidth, dash: style.lineDash, shape: style.lineShape },
      marker: { color: style.color, size: style.markerSize, symbol: seriesPlotlySymbol(style) },
      cellxplorer_analysis_sample: sample,
    };
  };
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i];
    const y = ys.slice(start, end);
    const x = xs.slice(start, end);
    const voltage = trace.voltage_v.slice(start, end);
    const cycles = trace.cycle.slice(start, end);
    const currentValues = lines.current ? trace.current_ma.slice(start, end) : [];
    if (lines.current && currentValues.some(value => value != null && Number.isFinite(value))) {
      lower.push({
        ...appearance(lines.current), x, y: currentValues, xaxis: "x2", yaxis: "y2",
        customdata: cycles.map(cycle => cycle || "uncounted"),
        hovertemplate: "<b>" + compactHoverName(lines.current.style.name) + "</b><br>Current %{y:.5g} mA<br>Cycle %{customdata}<extra></extra>",
        cellxplorer_export_axis_labels: { y: "Current (mA)" },
      } as Plotly.Data);
    }
    if (lines.voltage && voltage.some(value => value != null && Number.isFinite(value))) {
      out.push({
        ...appearance(lines.voltage), x, y: voltage, yaxis: stacked ? "y3" : "y2",
        cellxplorer_export_axis_labels: { y: "Voltage (V)" },
        hovertemplate: "<b>" + compactHoverName(lines.voltage.style.name) + "</b><br>Voltage %{y:.4g} V<extra></extra>",
      } as Plotly.Data);
    }
    if (!lines.primary || !y.some(value => value != null && Number.isFinite(value))) continue;
    const columns = includeExport ? [
      ...sourceExportColumns(trace.cell_name, cycles, trace.source_cycle?.slice(start, end),
        trace.source_position?.slice(start, end), trace.source_filename?.slice(start, end), trace.source_hash?.slice(start, end)),
      { header: "Charge balance (mAh)", values: balance.slice(start, end) },
      { header: "Charge throughput (mAh)", values: trace.charge_throughput_mah?.slice(start, end) ?? [] },
      { header: "Voltage (V)", values: voltage },
      ...(lines.current ? [{ header: "Current (mA)", values: currentValues }] : []),
      ...(settings.unit === "soc" ? [
        { header: "Starting SOC (%)", values: x.map(() => trace.balance_start_soc_pct ?? null) },
        { header: "Reference capacity (mAh)", values: x.map(() => trace.balance_reference_mah ?? null) },
        { header: "Reference basis", values: x.map(() => settings.references?.[trace.cell_id]?.basis === "mass" ? "Initial active mass" : "Measured capacity") },
      ] : []),
    ] : undefined;
    out.push({
      ...appearance(lines.primary), x, y, cellxplorer_export_columns: columns,
      customdata: cycles.map((cycle, j) => [cycle || "uncounted", voltage[j] ?? "—", balance[start + j]]),
      hovertemplate: "<b>" + compactHoverName(lines.primary.style.name) + "</b><br>" +
        (settings.unit === "soc" ? "Estimated SOC %{y:.3f}%<br>Balance %{customdata[2]:.5g} mAh" : "Balance %{y:.5g} mAh") +
        "<br>Voltage %{customdata[1]:.4g} V<br>Cycle %{customdata[0]}<extra></extra>",
    } as Plotly.Data);
  }
  return out.concat(lower);
}
