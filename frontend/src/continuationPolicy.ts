import type {
  ContinuationFinding,
  ContinuationInspectResult,
  ContinuationInspectSource,
} from "./api";

export type ImportWorkflowMode = "separate" | "continued";

export type ContinuedScientificDraft = {
  active_material_selection: string;
  active_mass_mg_override: number | null;
  nominal_capacity_mah_override: number | null;
  electrode_area_cm2_override: number | null;
};

function positiveFinite(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value > 0);
}

export function scientificDraftIsValid(draft: ContinuedScientificDraft): boolean {
  if (!positiveFinite(draft.active_mass_mg_override)) return false;
  if (!positiveFinite(draft.nominal_capacity_mah_override)) return false;
  if (!positiveFinite(draft.electrode_area_cm2_override)) return false;
  if (draft.active_material_selection !== "custom") {
    return Boolean(
      draft.active_mass_mg_override !== null &&
        Number.isFinite(draft.active_mass_mg_override) &&
        draft.active_mass_mg_override > 0 &&
        draft.nominal_capacity_mah_override !== null &&
        Number.isFinite(draft.nominal_capacity_mah_override) &&
        draft.nominal_capacity_mah_override > 0,
    );
  }
  return true;
}

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

export function acknowledgedMetadataOnlySourceKeys(
  result: ContinuationInspectResult | null | undefined,
  acknowledged: Iterable<string>,
  currentSourceKeys?: Iterable<string>,
): string[] {
  if (!result) return [];
  const acknowledgedIds = new Set(acknowledged);
  const currentKeys = currentSourceKeys ? new Set(currentSourceKeys) : null;
  const sourceKeys = new Set<string>();
  for (const finding of result.findings) {
    if (
      finding.code !== "metadata_only_source" ||
      finding.severity !== "confirmation" ||
      !acknowledgedIds.has(finding.id)
    ) {
      continue;
    }
    for (const sourceKey of finding.source_keys) {
      if (!currentKeys || currentKeys.has(sourceKey)) sourceKeys.add(sourceKey);
    }
  }
  return Array.from(sourceKeys);
}

export function continuationSourceCanOpenRawData(
  source: Pick<ContinuationInspectSource, "metadata_only" | "canonical_cycling">
    & Partial<Pick<ContinuationInspectSource, "inspection_status">>,
  options?: { rawDataAvailable?: boolean },
): boolean {
  // Raw inspection is a parser/data-availability surface, not a claim that
  // the source has a verified canonical cycle interpretation. Continued
  // import sources may therefore expose raw rows while their capacity
  // analysis remains metadata-only or pending.
  if (options?.rawDataAvailable === true) return source.inspection_status !== "error";
  return source.metadata_only !== true && source.canonical_cycling !== false;
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

export type ContinuationFindingAction = "blocking" | "acknowledgement" | null;

/** Describe the inline action required before a continued import can be submitted. */
export function continuationFindingAction(
  result: ContinuationInspectResult | null | undefined,
  acknowledged?: Iterable<string>,
): ContinuationFindingAction {
  if (!result?.inspection_complete) return null;
  if (blockingFindings(result).length > 0) return "blocking";
  const acknowledgedIds = new Set(acknowledged ?? []);
  return acknowledgementFindingIds(result).some((id) => !acknowledgedIds.has(id))
    ? "acknowledgement"
    : null;
}

export type ContinuedInspectionStatus = "not_started" | "preparing" | "ready" | "error";

/** Keep footer copy honest about whether inspection has not run, is pending, or failed. */
export function continuedInspectionStatus(
  result: ContinuationInspectResult | null | undefined,
  requestFailed = false,
): ContinuedInspectionStatus {
  if (requestFailed || result?.sources.some((source) => source.inspection_status === "error")) {
    return "error";
  }
  if (!result) return "not_started";
  if (!result.inspection_complete) return "preparing";
  return "ready";
}

export function continuationInspectionHasErrors(
  result: ContinuationInspectResult | null | undefined,
): boolean {
  return Boolean(result?.sources.some((source) => source.inspection_status === "error"));
}
