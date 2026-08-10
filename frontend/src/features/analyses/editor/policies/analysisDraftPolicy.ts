import type { AnalysisDraftPlot, AnalysisSpec, AnalysisTabKey, SavedAnalysisPlot } from "../../../../api";

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Same shape as saved-plot selection: membership stays on the analysis. */
function draftSelectionFromSpec(spec: Pick<AnalysisSpec, "selection">): AnalysisSpec["selection"] {
  return {
    entries: [],
    exclusions: clone(spec.selection.exclusions ?? []),
    hidden_replicate_group_ids: clone(spec.selection.hidden_replicate_group_ids ?? []),
  };
}

/** Analysis sample membership is never plot/draft-scoped. */
function withAnalysisMembership(
  selection: AnalysisSpec["selection"],
  entries: AnalysisSpec["selection"]["entries"],
): AnalysisSpec["selection"] {
  return {
    entries: clone(entries),
    exclusions: clone(selection.exclusions ?? []),
    hidden_replicate_group_ids: clone(selection.hidden_replicate_group_ids ?? []),
  };
}

function applySavedPlotToSpec(base: AnalysisSpec, plot: SavedAnalysisPlot): AnalysisSpec {
  const next = clone(base);
  next.selection = withAnalysisMembership(
    {
      entries: [],
      exclusions: plot.selection?.exclusions ?? [],
      hidden_replicate_group_ids: plot.selection?.hidden_replicate_group_ids ?? [],
    },
    base.selection.entries ?? [],
  );
  next.computation = clone(plot.computation);
  next.aggregation = clone(plot.aggregation);
  next.presentation = clone(plot.presentation);
  return next;
}

/** Top-level workspace fields restored when discarding a draft. */
export type NormalWorkspaceSnapshot = {
  selection: AnalysisSpec["selection"];
  computation: AnalysisSpec["computation"];
  aggregation: AnalysisSpec["aggregation"];
  presentation: AnalysisSpec["presentation"];
  tab: AnalysisTabKey;
};

export type DraftSaveSource = "live" | "draft";

export type ColdOpenWorkspace = {
  spec: AnalysisSpec;
  activeSavedPlotId: string | null;
  plotSessionActive: boolean;
  changed: boolean;
};

/** Stable artifact id for draft thumbnails — never appears in saved_plots / warmup. */
export function draftPreviewPlotId(tab: AnalysisTabKey): string {
  return `__draft__:${tab}`;
}

/** Draft preview ids are client-only; the plot-artifact API rejects them with 404. */
export function isDraftPreviewPlotId(plotId: string): boolean {
  return plotId.startsWith("__draft__:");
}

/** Drop any persisted draft fields — drafts are session-only. */
export function stripDraftPlots(spec: AnalysisSpec): AnalysisSpec {
  const next = clone(spec);
  next.draft_plots = null;
  next.draft_plot = null;
  return next;
}

export function captureNormalWorkspace(
  spec: AnalysisSpec,
  tab: AnalysisTabKey,
): NormalWorkspaceSnapshot {
  return {
    selection: clone(spec.selection),
    computation: clone(spec.computation),
    aggregation: clone(spec.aggregation),
    presentation: clone(spec.presentation),
    tab,
  };
}

export function applyNormalWorkspace(
  spec: AnalysisSpec,
  snapshot: NormalWorkspaceSnapshot,
): AnalysisSpec {
  const next = clone(spec);
  next.selection = withAnalysisMembership(snapshot.selection, spec.selection.entries ?? []);
  next.computation = clone(snapshot.computation);
  next.aggregation = clone(snapshot.aggregation);
  next.presentation = clone(snapshot.presentation);
  return next;
}

/** Snapshot the live workspace for draft-card thumbnails (not persisted). */
export function draftPlotFromWorkspace(
  spec: AnalysisSpec,
  tab: AnalysisTabKey,
  name: string | null,
  updatedAt: string,
): AnalysisDraftPlot {
  return {
    tab,
    name: name?.trim() || null,
    selection: draftSelectionFromSpec(spec),
    computation: clone(spec.computation),
    aggregation: clone(spec.aggregation),
    presentation: clone(spec.presentation),
    updated_at: updatedAt,
  };
}

export function draftAsSavedPlot(draft: AnalysisDraftPlot): SavedAnalysisPlot {
  return {
    id: draftPreviewPlotId(draft.tab),
    tab: draft.tab,
    name: draft.name?.trim() || "Unsaved plot",
    subtitle: "",
    description: null,
    selection: clone(draft.selection),
    computation: clone(draft.computation),
    aggregation: clone(draft.aggregation),
    presentation: clone(draft.presentation),
    created_at: draft.updated_at,
    modified_at: draft.updated_at,
  };
}

/**
 * Server-bound spec: never writes drafts. Unsaved plot edits (draft session or
 * dirty saved plot) are kept out of top-level so a kill/reopen lands on the
 * last stable analysis state. Membership always comes from the live workspace.
 */
export function buildStablePersistSpec(args: {
  current: AnalysisSpec;
  mode: "stable" | "draft_session" | "edited_saved";
  savedPlot?: SavedAnalysisPlot | null;
  normal?: NormalWorkspaceSnapshot | null;
}): AnalysisSpec {
  let next = stripDraftPlots(args.current);
  if (args.mode === "edited_saved" && args.savedPlot) {
    next = applySavedPlotToSpec(next, args.savedPlot);
    next = stripDraftPlots(next);
    return next;
  }
  if (args.mode === "draft_session" && args.normal) {
    next = applyNormalWorkspace(next, args.normal);
    return stripDraftPlots(next);
  }
  return next;
}

export function savedPlotFromDraftSource(args: {
  draft: AnalysisDraftPlot;
  name: string;
  subtitle: string;
  description: string | null;
  id?: string;
  createdAt?: string;
  modifiedAt: string;
}): SavedAnalysisPlot {
  return {
    id: args.id ?? `plot-${args.modifiedAt}`,
    tab: args.draft.tab,
    name: args.name.trim() || "Untitled plot",
    subtitle: args.subtitle,
    description: args.description?.trim() || null,
    selection: clone(args.draft.selection),
    computation: clone(args.draft.computation),
    aggregation: clone(args.draft.aggregation),
    presentation: clone(args.draft.presentation),
    created_at: args.createdAt ?? args.modifiedAt,
    modified_at: args.modifiedAt,
  };
}

export function buildCommitSavedPlotSpec(args: {
  current: AnalysisSpec;
  plot: SavedAnalysisPlot;
  source: DraftSaveSource;
  afterSave: "none" | "new_plot";
  newPlotWorkspace?: NormalWorkspaceSnapshot;
  clearDraftTab?: AnalysisTabKey;
}): AnalysisSpec {
  let next = stripDraftPlots(args.current);
  next.saved_plots = [...(next.saved_plots ?? []), args.plot];
  if (args.afterSave === "new_plot" && args.newPlotWorkspace) {
    next = applyNormalWorkspace(next, args.newPlotWorkspace);
  }
  return stripDraftPlots(next);
}

/** Discard leave for an edited saved plot: restore that plot. */
export function buildDiscardEditedSavedPlotSpec(
  current: AnalysisSpec,
  restored: AnalysisSpec,
): AnalysisSpec {
  const next = clone(current);
  next.selection = withAnalysisMembership(
    restored.selection,
    current.selection.entries ?? [],
  );
  next.computation = clone(restored.computation);
  next.aggregation = clone(restored.aggregation);
  next.presentation = clone(restored.presentation);
  return stripDraftPlots(next);
}

/** Discard leave for an unsaved new plot: restore normal. */
export function buildDiscardNewPlotSpec(
  current: AnalysisSpec,
  normal: NormalWorkspaceSnapshot,
): AnalysisSpec {
  return stripDraftPlots(applyNormalWorkspace(current, normal));
}

/**
 * Open a plot family tab: never invents a draft. Prefer `preferredPlotId` when it
 * still exists on the tab, otherwise the first saved plot, otherwise empty
 * (user must click New to start a draft).
 */
export function resolveColdOpenWorkspace(args: {
  spec: AnalysisSpec;
  tab: AnalysisTabKey;
  viewSignature: (spec: AnalysisSpec) => string;
  preferredPlotId?: string | null;
}): ColdOpenWorkspace {
  const stripped = stripDraftPlots(args.spec);
  const hadDrafts = Boolean(args.spec.draft_plots || args.spec.draft_plot);
  const tabPlots = (stripped.saved_plots ?? []).filter((plot) => plot.tab === args.tab);
  if (tabPlots.length > 0) {
    const preferred =
      args.preferredPlotId != null
        ? tabPlots.find((plot) => plot.id === args.preferredPlotId)
        : undefined;
    const chosen = preferred ?? tabPlots[0];
    const aligned = applySavedPlotToSpec(stripped, chosen);
    const changed =
      hadDrafts || args.viewSignature(aligned) !== args.viewSignature(stripped);
    return {
      spec: aligned,
      activeSavedPlotId: chosen.id,
      plotSessionActive: true,
      changed,
    };
  }
  return {
    spec: stripped,
    activeSavedPlotId: null,
    plotSessionActive: false,
    changed: hadDrafts,
  };
}

/** True when the live plot session belongs to this family tab (saved plot or draft). */
export function plotSessionBelongsToTab(args: {
  tab: AnalysisTabKey;
  activeTab: AnalysisTabKey;
  plotSessionActive: boolean;
  activeSavedPlotId: string | null;
  activePlotTab: AnalysisTabKey | null;
  plotWorkspaceTouched: boolean;
}): boolean {
  if (!args.plotSessionActive) return false;
  if (args.activeSavedPlotId != null) {
    return args.activePlotTab === args.tab;
  }
  // Draft session: only on the tab where New was clicked.
  return args.plotWorkspaceTouched && args.activeTab === args.tab;
}

/** Recap is an immediately readable summary; plot families still need a session. */
export function analysisTabRequiresPlotSession(tab: AnalysisTabKey): boolean {
  return tab !== "recap" && tab !== "settings";
}

/**
 * Live scientific queries belong to the visible plot workspace. Hidden
 * keep-mounted editors and empty family tabs must leave cache preparation to
 * the saved-plot warmup coordinator instead of starting foreground work.
 */
export function shouldRunLivePlotCompute(args: {
  workspaceVisible: boolean;
  plotSessionActive: boolean;
  hasSamples: boolean;
}): boolean {
  return args.workspaceVisible && args.plotSessionActive && args.hasSamples;
}
