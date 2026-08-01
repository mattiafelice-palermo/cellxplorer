export type ImportDraftMatch = {
  kind: "exact_duplicate" | "possible_update";
  registered?: boolean;
} | null;

export type ImportDraftLike = {
  staged_name: string;
  import_match: ImportDraftMatch;
};

export type ImportReplicateGroupLike = {
  id: string;
  name: string;
  description: string;
  staged_names: string[];
};

export type ImportRequestEntry = {
  staged_name: string;
  source_path?: string | null;
  filename: string;
};

export function isRegisteredExactDuplicate(draft: ImportDraftLike): boolean {
  return draft.import_match?.kind === "exact_duplicate" && draft.import_match.registered === true;
}

export function exactDuplicateCount(drafts: readonly ImportDraftLike[]): number {
  return drafts.filter(isRegisteredExactDuplicate).length;
}

export function includedSeparateCellDrafts<T extends ImportDraftLike>(drafts: readonly T[]): T[] {
  return drafts.filter((draft) => !isRegisteredExactDuplicate(draft));
}

export function cleanupStagedReplicateGroups<T extends ImportReplicateGroupLike>(
  groups: readonly T[],
  remainingStagedNames: ReadonlySet<string>,
): T[] {
  return groups
    .map((group) => ({
      ...group,
      staged_names: group.staged_names.filter((name) => remainingStagedNames.has(name)),
    }))
    .filter((group) => group.staged_names.length >= 2);
}

export function removeStagedDraft<T extends ImportDraftLike, G extends ImportReplicateGroupLike>(
  drafts: readonly T[],
  groups: readonly G[],
  activeIndex: number,
  stagedName: string,
): { drafts: T[]; groups: G[]; activeIndex: number | null } {
  const removedIndex = drafts.findIndex((draft) => draft.staged_name === stagedName);
  if (removedIndex < 0) {
    return { drafts: [...drafts], groups: [...groups], activeIndex: drafts.length ? activeIndex : null };
  }
  const nextDrafts = drafts.filter((draft) => draft.staged_name !== stagedName);
  const remaining = new Set(nextDrafts.map((draft) => draft.staged_name));
  return {
    drafts: nextDrafts,
    groups: cleanupStagedReplicateGroups(groups, remaining),
    activeIndex: replacementActiveIndex(activeIndex, removedIndex, drafts.length),
  };
}

export function removeAllRegisteredDuplicates<T extends ImportDraftLike, G extends ImportReplicateGroupLike>(
  drafts: readonly T[],
  groups: readonly G[],
  activeIndex: number,
): { drafts: T[]; groups: G[]; activeIndex: number | null } {
  const duplicateNames = new Set(
    drafts.filter(isRegisteredExactDuplicate).map((draft) => draft.staged_name),
  );
  if (!duplicateNames.size) {
    return { drafts: [...drafts], groups: [...groups], activeIndex: drafts.length ? activeIndex : null };
  }
  const nextDrafts = drafts.filter((draft) => !duplicateNames.has(draft.staged_name));
  const removedBeforeActive = drafts
    .slice(0, Math.max(0, activeIndex))
    .filter((draft) => duplicateNames.has(draft.staged_name)).length;
  const activeWasRemoved = drafts[activeIndex] && duplicateNames.has(drafts[activeIndex].staged_name);
  const nextIndex = activeWasRemoved
    ? Math.min(Math.max(0, activeIndex - removedBeforeActive), Math.max(0, nextDrafts.length - 1))
    : Math.min(Math.max(0, activeIndex - removedBeforeActive), Math.max(0, nextDrafts.length - 1));
  return {
    drafts: nextDrafts,
    groups: cleanupStagedReplicateGroups(groups, new Set(nextDrafts.map((draft) => draft.staged_name))),
    activeIndex: nextDrafts.length ? nextIndex : null,
  };
}

export function replacementActiveIndex(
  activeIndex: number,
  removedIndex: number,
  previousLength: number,
): number | null {
  const nextLength = previousLength - 1;
  if (nextLength <= 0) return null;
  if (activeIndex > removedIndex) return activeIndex - 1;
  return Math.min(activeIndex, nextLength - 1);
}

export function continuedImportIsBlocked(drafts: readonly ImportDraftLike[]): boolean {
  return drafts.some((draft) => draft.import_match?.kind === "exact_duplicate");
}

export function separateImportRequestEntries<T extends ImportDraftLike & ImportRequestEntry>(
  drafts: readonly T[],
): ImportRequestEntry[] {
  return includedSeparateCellDrafts(drafts).map((draft) => ({
    staged_name: draft.staged_name,
    source_path: draft.source_path,
    filename: draft.filename,
  }));
}

export function latePreviewBelongsToStagedDraft(
  drafts: readonly ImportDraftLike[],
  stagedName: string,
): boolean {
  return drafts.some((draft) => draft.staged_name === stagedName);
}
