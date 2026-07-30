import type {
  ContinuationFinding,
  ContinuationInspectResult,
  ContinuationInspectSource,
} from "./api";

export function isSubmitBlocked(result: ContinuationInspectResult): boolean {
  return !result.can_submit;
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
