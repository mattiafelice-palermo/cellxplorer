/**
 * Grouping rules for the project explorer's folder contents.
 *
 * A folder's rows can be shown flat (the historical behaviour) or grouped into two
 * collapsible sections, Analyses and Samples. The order of those rows is described
 * in two places — the JSX that renders them and `visibleTreeItems`, which backs
 * shift-click range selection — so the ordering itself lives here, in one function
 * both of them call. If the two descriptions ever disagree, a shift-click selects
 * rows that were never on screen.
 */

export type SectionKey = "analyses" | "samples";
export type SectionOrder = "analyses-first" | "samples-first";

export type SectionableFolder = {
  cells: unknown[];
  replicate_groups: unknown[];
  analyses: unknown[];
};

export type ProjectViewPreferences = {
  sectioned: boolean;
  order: SectionOrder;
  /** Metric columns (spec 026). On by default — they are the reason to look here. */
  showMetrics: boolean;
};

/** Sections off and samples first — i.e. what the tree did before they existed. */
export const DEFAULT_VIEW_PREFERENCES: ProjectViewPreferences = {
  sectioned: false,
  order: "samples-first",
  showMetrics: true,
};

const STORAGE_KEY = "cellxplorer.projects.view";

export function sectionCount(folder: SectionableFolder, section: SectionKey): number {
  return section === "analyses"
    ? folder.analyses.length
    : folder.cells.length + folder.replicate_groups.length;
}

/**
 * The sections to render for this folder, in display order.
 *
 * Empty sections are omitted: an "Analyses (0)" header in a folder that holds only
 * cells adds exactly the noise sectioning is meant to remove.
 */
export function visibleSections(
  folder: SectionableFolder,
  order: SectionOrder
): SectionKey[] {
  const ordered: SectionKey[] =
    order === "analyses-first" ? ["analyses", "samples"] : ["samples", "analyses"];
  return ordered.filter((section) => sectionCount(folder, section) > 0);
}

export function sectionStateKey(folderId: number, section: SectionKey): string {
  return `${folderId}:${section}`;
}

export function loadViewPreferences(
  storage: Pick<Storage, "getItem">
): ProjectViewPreferences {
  let stored: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIEW_PREFERENCES };
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_VIEW_PREFERENCES };
  }
  if (typeof stored !== "object" || stored === null) {
    return { ...DEFAULT_VIEW_PREFERENCES };
  }
  // Field by field, so a partially written or half-upgraded value still yields a
  // usable preference instead of resetting everything the user chose.
  const candidate = stored as Partial<ProjectViewPreferences>;
  return {
    sectioned:
      typeof candidate.sectioned === "boolean"
        ? candidate.sectioned
        : DEFAULT_VIEW_PREFERENCES.sectioned,
    order:
      candidate.order === "analyses-first" || candidate.order === "samples-first"
        ? candidate.order
        : DEFAULT_VIEW_PREFERENCES.order,
    showMetrics:
      typeof candidate.showMetrics === "boolean"
        ? candidate.showMetrics
        : DEFAULT_VIEW_PREFERENCES.showMetrics,
  };
}

export function saveViewPreferences(
  storage: Pick<Storage, "setItem">,
  value: ProjectViewPreferences
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A full or unavailable localStorage must not break the tree.
  }
}
