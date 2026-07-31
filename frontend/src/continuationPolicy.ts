import type {
  ContinuationFinding,
  ContinuationInspectResult,
  ContinuationInspectSource,
} from "./api";

export type ImportWorkflowMode = "separate" | "continued";

export function preserveAcknowledgements(
  previous: Iterable<string>,
  result: ContinuationInspectResult | null | undefined,
): string[] {
  if (!result) return [];
  const valid = new Set(acknowledgementFindingIds(result));
  return Array.from(previous).filter((id) => valid.has(id));
}

export function continuedImportCanSubmit(
  result: ContinuationInspectResult | null | undefined,
  cellName: string,
  acknowledged: Iterable<string>,
): boolean {
  if (!result || isSubmitBlocked(result) || !cellName.trim()) return false;
  const acknowledgedSet = new Set(acknowledged);
  return acknowledgementFindingIds(result).every((id) => acknowledgedSet.has(id));
}

export function moveSource<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function isSubmitBlocked(result: ContinuationInspectResult): boolean {
  return !result.inspection_complete || !result.can_submit;
}

export function acknowledgementFindingIds(result: ContinuationInspectResult): string[] {
  return result.findings
    .filter((finding) => finding.severity === "confirmation")
    .map((finding) => finding.id);
}

export function applySuggestedOrder(
  currentOrder: string[],
  suggestedOrder: string[],
): string[] {
  if (!suggestedOrder.length) {
    return [...currentOrder];
  }
  const currentSet = new Set(currentOrder);
  const suggestedStaged = suggestedOrder.filter((key) => currentSet.has(key));
  if (!suggestedStaged.length) {
    return [...currentOrder];
  }
  const stagedSet = new Set(suggestedStaged);
  const prefix = currentOrder.filter((key) => !stagedSet.has(key));
  return [...prefix, ...suggestedStaged];
}

export function sourceRoleLabel(
  source: ContinuationInspectSource,
  index: number,
  total: number,
): "Historical source" | "Tracked tail" | null {
  if (total <= 1) {
    return source.kind === "existing" ? "Tracked tail" : null;
  }
  if (index === total - 1) {
    return "Tracked tail";
  }
  return "Historical source";
}

export function findingSummary(finding: ContinuationFinding): string {
  const names = finding.source_keys.join(" → ");
  if (names) {
    return `${finding.title}: ${finding.message} (${names})`;
  }
  return `${finding.title}: ${finding.message}`;
}

export function blockingFindings(result: ContinuationInspectResult): ContinuationFinding[] {
  return result.findings.filter((finding) => finding.severity === "blocking");
}

export function informationalFindings(result: ContinuationInspectResult): ContinuationFinding[] {
  return result.findings.filter(
    (finding) => finding.severity === "info" || finding.severity === "warning",
  );
}
