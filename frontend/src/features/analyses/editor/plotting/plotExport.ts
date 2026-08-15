import { notifications } from "@mantine/notifications";
import type { PlotAspectRatioKey, PlotExportFormat, PlotStyle } from "../../../../api";
import type { SourceExportColumn, SourceExportValue } from "./sourceChainPlot";

export type DataColumn = SourceExportColumn;

export function slugFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "analysis-plot"
  );
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function blobFromDataUrl(dataUrl: string, fallbackType: string): Blob {
  const [metadata, payload = ""] = dataUrl.split(",");
  const mime = metadata.match(/^data:([^;,]+)/)?.[1] ?? fallbackType;
  const bytes = metadata.includes(";base64")
    ? bytesFromDataUrl(dataUrl)
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes as BlobPart], { type: mime });
}

export function textFromDataUrl(dataUrl: string): string {
  const [metadata, payload = ""] = dataUrl.split(",", 2);
  return metadata.includes(";base64")
    ? new TextDecoder().decode(bytesFromDataUrl(dataUrl))
    : decodeURIComponent(payload);
}

// ------------------------------------------------------ data export (CSV/XLSX)

// Export exactly what is plotted: one x/y column pair per visible trace
// (works for any tab â€” traces need not share an x grid). Dispersion bands
// (fill traces) are skipped.
export function tracesToColumns(traces: Plotly.Data[], layout: Partial<Plotly.Layout>): DataColumn[] {
  const axisTitle = (axis: unknown): string =>
    String((axis as { title?: { text?: string } })?.title?.text ?? "");
  const columns: DataColumn[] = [];
  for (const raw of traces) {
    const t = raw as Record<string, unknown>;
    if (t.fill === "toself") continue;
    const exportXs = (
      t.meta as { cellxplorer_export_x?: (number | null)[] } | undefined
    )?.cellxplorer_export_x;
    const xs = exportXs ?? ((t.x as (number | null)[]) ?? []);
    const ys = (t.y as (number | null)[]) ?? [];
    if (!ys.length) continue;
    const exportColumns = t.cellxplorer_export_columns as DataColumn[] | undefined;
    if (Array.isArray(exportColumns)) columns.push(...exportColumns);
    const name = String(t.name ?? "series");
    const layoutRec = layout as Record<string, unknown>;
    const yKey = t.yaxis === "y3" ? "yaxis3" : t.yaxis === "y2" ? "yaxis2" : "yaxis";
    const xKey = t.xaxis === "x2" ? "xaxis2" : "xaxis";
    const exportAxisLabels = t.cellxplorer_export_axis_labels as
      | { x?: string; y?: string }
      | undefined;
    const xLabel = exportAxisLabels?.x || axisTitle(layoutRec[xKey]) || "x";
    const yLabel = exportAxisLabels?.y || axisTitle(layoutRec[yKey]) || "y";
    columns.push({ header: `${name} | ${xLabel}`, values: xs });
    columns.push({ header: `${name} | ${yLabel}`, values: ys });
  }
  return columns;
}

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

export async function downloadDataExport(columns: DataColumn[], style: PlotStyle, baseName: string): Promise<void> {
  if (columns.length === 0) return;
  if (style.data_export_format === "xlsx") {
    const XLSX = await import("xlsx");
    const rowCount = columns.reduce((max, c) => Math.max(max, c.values.length), 0);
    const aoa: (string | number | null)[][] = [columns.map((c) => c.header)];
    for (let i = 0; i < rowCount; i += 1) {
      aoa.push(
        columns.map((c) => {
          const v = c.values[i];
          if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
          if (typeof v === "string") return v;
          if (style.data_precision === "full") return v;
          return Number(v.toFixed(exportDecimalPlaces(c.header)));
        })
      );
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Data");
    const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
    await downloadBlob(
      new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${baseName}.xlsx`
    );
    return;
  }
  const text = buildDelimitedText(
    columns,
    style.data_precision,
    style.data_decimal_separator,
    style.data_delimiter
  );
  await downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `${baseName}.csv`);
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const { saveDownload } = await import("../../../../downloads");
  const result = await saveDownload(blob, filename);
  if (result.usedDefaultFolder && result.path) {
    notifications.show({ message: `Saved to ${result.path}`, color: "teal" });
  }
}

async function plotlyToImage(figure: unknown, options: unknown): Promise<string> {
  const { default: PlotlyLib } = await import("plotly.js-dist-min");
  return (
    PlotlyLib as unknown as {
      toImage: (fig: unknown, imageOptions: unknown) => Promise<string>;
    }
  ).toImage(figure, options);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32Bytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

export function pngWithPpi(dataUrl: string, ppi: number): Blob {
  const png = bytesFromDataUrl(dataUrl);
  if (png.length < 33) return blobFromDataUrl(dataUrl, "image/png");
  const ppm = Math.max(1, Math.round(ppi / 0.0254));
  const type = new TextEncoder().encode("pHYs");
  const data = new Uint8Array(9);
  data.set(uint32Bytes(ppm), 0);
  data.set(uint32Bytes(ppm), 4);
  data[8] = 1;
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, type.length);
  const chunk = new Uint8Array(4 + type.length + data.length + 4);
  chunk.set(uint32Bytes(data.length), 0);
  chunk.set(type, 4);
  chunk.set(data, 8);
  chunk.set(uint32Bytes(crc32(crcInput)), 17);
  return new Blob([png.slice(0, 33) as BlobPart, chunk as BlobPart, png.slice(33) as BlobPart], {
    type: "image/png",
  });
}

// Parse a Plotly SVG data URL into a live <svg> element for vector export.
function svgElementFromDataUrl(dataUrl: string): SVGSVGElement {
  const marker = "data:image/svg+xml,";
  const raw = dataUrl.startsWith(marker)
    ? decodeURIComponent(dataUrl.slice(marker.length))
    : dataUrl.includes(";base64,")
      ? new TextDecoder().decode(bytesFromDataUrl(dataUrl))
      : dataUrl;
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  return doc.documentElement as unknown as SVGSVGElement;
}

// Render a Plotly SVG into a real vector PDF (no rasterization) via
// jsPDF + svg2pdf. PDF is vector, so it uses a physical page size rather
// than borrowing the raster-only PPI setting.
export async function makeVectorPdf(
  svgDataUrl: string,
  ratio: number,
  aspect: PlotAspectRatioKey
): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const svg = svgElementFromDataUrl(svgDataUrl);
  const a4Long = 841.89;
  const a4Short = 595.28;
  const defaultLongEdge = 720;
  const [pageWidth, pageHeight] =
    aspect === "a4_landscape"
      ? [a4Long, a4Short]
      : aspect === "a4_portrait"
        ? [a4Short, a4Long]
        : ratio >= 1
          ? [defaultLongEdge, defaultLongEdge / ratio]
          : [defaultLongEdge * ratio, defaultLongEdge];
  const pdf = new jsPDF({
    orientation: pageWidth >= pageHeight ? "landscape" : "portrait",
    unit: "pt",
    format: [pageWidth, pageHeight],
  });
  await (
    pdf as unknown as {
      svg: (el: Element, opts: { x: number; y: number; width: number; height: number }) => Promise<void>;
    }
  ).svg(svg, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  return pdf.output("blob");
}

function aspectRatioValue(aspect: PlotAspectRatioKey, fallback: number): number {
  if (aspect === "square") return 1;
  if (aspect === "four_three") return 4 / 3;
  if (aspect === "sixteen_nine") return 16 / 9;
  if (aspect === "a4_landscape") return Math.SQRT2;
  if (aspect === "a4_portrait") return 1 / Math.SQRT2;
  return fallback;
}

type ExportPlan = {
  layoutWidth: number;
  layoutHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  innerRatio: number;
  margin: { l: number; r: number; t: number; b: number };
};

function layoutMargins(
  layout: Partial<Plotly.Layout>,
  style: PlotStyle
): ExportPlan["margin"] {
  const raw = (layout.margin ?? {}) as Partial<ExportPlan["margin"]>;
  const margin = {
    l: Number(raw.l ?? 60),
    r: Number(raw.r ?? 30),
    t: Number(raw.t ?? 20),
    b: Number(raw.b ?? 55),
  };
  if (style.export_include_title) {
    margin.t = Math.max(margin.t, style.axis_title_size + 34);
  }
  return margin;
}

export function resolveExportPlan(
  style: PlotStyle,
  viewSize: { width: number; height: number } | null,
  layout: Partial<Plotly.Layout>
): ExportPlan {
  const viewWidth = Math.max(320, Math.round(viewSize?.width || style.export_width));
  const viewHeight = Math.max(240, Math.round(viewSize?.height || Number(layout.height) || 500));
  const margin = layoutMargins(layout, style);
  const aspect = style.export_aspect_ratio ?? "view";
  const viewInnerWidth = Math.max(120, viewWidth - margin.l - margin.r);
  const viewInnerHeight = Math.max(120, viewHeight - margin.t - margin.b);
  const viewRatio = viewInnerWidth / viewInnerHeight;
  const layoutWidth = viewWidth;
  const pixelWidth = Math.max(320, Math.round(style.export_width || viewWidth));
  const scale = pixelWidth / layoutWidth;
  let layoutHeight: number;
  let pixelHeight: number;
  let innerRatio: number;
  if (aspect === "custom") {
    pixelHeight = Math.max(240, Math.round(style.export_height || viewHeight * scale));
    layoutHeight = Math.max(margin.t + margin.b + 120, pixelHeight / scale);
    pixelHeight = Math.round(layoutHeight * scale);
    innerRatio = viewInnerWidth / Math.max(120, layoutHeight - margin.t - margin.b);
  } else {
    innerRatio = aspectRatioValue(aspect, viewRatio);
    layoutHeight = viewInnerWidth / innerRatio + margin.t + margin.b;
    pixelHeight = Math.max(240, Math.round(layoutHeight * scale));
  }
  return {
    layoutWidth: Math.round(layoutWidth),
    layoutHeight: Math.round(layoutHeight),
    pixelWidth,
    pixelHeight,
    scale,
    innerRatio,
    margin,
  };
}

export function exportFigure(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  plan: ExportPlan
) {
  const exportLayout: Partial<Plotly.Layout> = {
    ...layout,
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    autosize: false,
    margin: plan.margin,
  };
  if (style.export_include_title) {
    exportLayout.title = { text: plotName, font: { size: style.axis_title_size + 3 } };
  }
  return { data: traces, layout: exportLayout };
}

export async function styledPlotExportPreview(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  viewSize: { width: number; height: number } | null,
): Promise<string | null> {
  if (traces.length === 0) return null;
  const plan = resolveExportPlan(style, viewSize, layout);
  return plotlyToImage(exportFigure(traces, layout, style, plotName, plan), {
    format: "png",
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    scale: Math.min(1, 420 / plan.layoutWidth),
  });
}

export async function downloadStyledPlotExport(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  style: PlotStyle,
  plotName: string,
  format: PlotExportFormat,
  baseName: string,
  viewSize: { width: number; height: number } | null,
): Promise<void> {
  if (traces.length === 0) return;
  const plan = resolveExportPlan(style, viewSize, layout);
  const figure = exportFigure(traces, layout, style, plotName, plan);
  if (format === "pdf") {
    const svgUrl = await plotlyToImage(figure, {
      format: "svg",
      width: plan.layoutWidth,
      height: plan.layoutHeight,
    });
    await downloadBlob(
      await makeVectorPdf(
        svgUrl,
        plan.pixelWidth / plan.pixelHeight,
        style.export_aspect_ratio,
      ),
      `${slugFilename(baseName)}.pdf`,
    );
    return;
  }
  const dataUrl = await plotlyToImage(figure, {
    format,
    width: plan.layoutWidth,
    height: plan.layoutHeight,
    scale: plan.scale,
  });
  const blob =
    format === "png"
      ? pngWithPpi(dataUrl, Math.max(36, style.export_ppi ?? 96))
      : blobFromDataUrl(dataUrl, "image/svg+xml");
  await downloadBlob(blob, `${slugFilename(baseName)}.${format}`);
}
