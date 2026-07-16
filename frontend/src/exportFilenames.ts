export const EXPORT_FILENAME_TOKENS = [
  "{analysis}",
  "{plot_title}",
  "{quantity}",
  "{x_axis}",
  "{tab}",
  "{sample_summary}",
  "{date}",
  "{time}",
] as const;

export type ExportFilenameToken = (typeof EXPORT_FILENAME_TOKENS)[number];

export interface ExportFilenameContext {
  analysis: string;
  plotTitle: string;
  quantity: string;
  xAxis: string;
  tab: string;
  sampleSummary: string;
  now?: Date;
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTime(now: Date): string {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");
}

export function renderExportFilename(
  template: string,
  context: ExportFilenameContext,
): string {
  const now = context.now ?? new Date();
  const values: Record<ExportFilenameToken, string> = {
    "{analysis}": context.analysis,
    "{plot_title}": context.plotTitle,
    "{quantity}": context.quantity,
    "{x_axis}": context.xAxis,
    "{tab}": context.tab,
    "{sample_summary}": context.sampleSummary,
    "{date}": localDate(now),
    "{time}": localTime(now),
  };
  return EXPORT_FILENAME_TOKENS.reduce(
    (value, token) => value.split(token).join(values[token]),
    template,
  );
}

export function sanitizeExportFilename(value: string, fallback = "plot"): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return cleaned || fallback;
}

export function insertFilenameToken(
  value: string,
  token: ExportFilenameToken,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): { value: string; cursor: number } {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
  return { value: next, cursor: start + token.length };
}
