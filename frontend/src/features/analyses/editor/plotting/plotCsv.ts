import type { PlotStyle } from "../../../../api";
import type { SourceExportColumn, SourceExportValue } from "./sourceChainPlot";

export type DataColumn = SourceExportColumn;

export function exportDecimalPlaces(header: string): number {
  const value = header.toLowerCase();
  if (value.includes("cycle")) return 0;
  if (value.includes("time")) return 3;
  if (value.includes("voltage") || value.includes("current")) return 5;
  if (value.includes("derivative") || value.includes("dq/dv") || value.includes("dv/dq")) return 7;
  return 6;
}

export function buildDelimitedText(
  columns: DataColumn[],
  precision: PlotStyle["data_precision"],
  decimal: PlotStyle["data_decimal_separator"],
  delimiter: PlotStyle["data_delimiter"],
): string {
  const sep = delimiter === "tab" ? "\t" : delimiter === "semicolon" ? ";" : ",";
  const formatNumber = (v: SourceExportValue | undefined, header: string) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    if (typeof v === "string") return v;
    const rounded =
      precision === "full"
        ? v
        : Number(v.toFixed(exportDecimalPlaces(header)));
    const s = String(rounded);
    return decimal === "comma" ? s.replace(".", ",") : s;
  };
  const quote = (s: string) =>
    s.includes(sep) || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
  const lines = [columns.map((c) => quote(c.header)).join(sep)];
  for (let i = 0; i < rowCount; i += 1) {
    lines.push(columns.map((c) => formatNumber(c.values[i], c.header)).join(sep));
  }
  // BOM so Excel detects UTF-8
  return "\uFEFF" + lines.join("\r\n");
}
