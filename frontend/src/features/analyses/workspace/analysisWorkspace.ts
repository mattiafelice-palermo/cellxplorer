import type { AnalysisSpec, AnalysisTabKey } from "../../../api";
import type { NormalWorkspaceSnapshot } from "../../../analysisDraftPolicy";

export const ANALYSIS_WORKSPACE_CHANGED_EVENT = "cellxplorer:analysis-workspace-changed";
export const ANALYSIS_WORKSPACE_TABS_EVENT = "cellxplorer:analysis-workspace-tabs";
export const ANALYSIS_WORKSPACE_MOUNTED_EVENT = "cellxplorer:analysis-workspace-mounted";
export const ANALYSIS_WORKSPACE_POLICY_EVENT = "cellxplorer:analysis-workspace-policy";
export const ANALYSIS_WORKSPACE_ACTIVE_EVENT = "cellxplorer:analysis-workspace-active";
export const ANALYSIS_WORKSPACE_STORAGE_KEY = "cellxplorer-analysis-workspace";
export const ANALYSIS_WORKSPACE_POLICY_STORAGE_KEY = "cellxplorer-analysis-workspace-policy";

export type AnalysisWorkspaceMemoryPolicy = "keep-mounted" | "unmount";

export interface AnalysisWorkspaceTab {
  id: number;
  title: string;
  path: string;
}

export interface AnalysisWorkspaceSnapshot {
  version: 1;
  tabs: AnalysisWorkspaceTab[];
  closedTabs: AnalysisWorkspaceTab[];
}

export interface AnalysisWorkspaceEditorState {
  analysisId: number;
  spec: AnalysisSpec | null;
  title: string;
  dirty: boolean;
  hasUnsavedPlot: boolean;
  activeTab: AnalysisTabKey;
  timeCapacityVisited: boolean;
  activeSavedPlotId: string | null;
  activePlotBaselineSignature: string | null;
  plotWorkspaceTouched: boolean;
  /** Last stable top-level view to restore when leaving/discarding a draft. */
  normalWorkspace: NormalWorkspaceSnapshot | null;
}

const editorStates = new Map<number, AnalysisWorkspaceEditorState>();
const mountedAnalysisIds = new Set<number>();
let activeWorkspaceViewId: number | null | undefined;

function validTab(value: unknown): value is AnalysisWorkspaceTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<AnalysisWorkspaceTab>;
  return (
    Number.isInteger(tab.id) &&
    Number(tab.id) > 0 &&
    typeof tab.title === "string" &&
    typeof tab.path === "string" &&
    tab.path.startsWith(`/analyses/${tab.id}`)
  );
}

export function parseAnalysisWorkspace(raw: string | null): AnalysisWorkspaceSnapshot {
  if (!raw) return { version: 1, tabs: [], closedTabs: [] };
  try {
    const value = JSON.parse(raw) as Partial<AnalysisWorkspaceSnapshot>;
    if (value.version !== 1 || !Array.isArray(value.tabs)) {
      return { version: 1, tabs: [], closedTabs: [] };
    }
    const uniqueTabs = (items: unknown[], excluded = new Set<number>()) => {
      const seen = new Set(excluded);
      return items.filter(validTab).filter((tab) => {
        if (seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      });
    };
    const tabs = uniqueTabs(value.tabs);
    const closedTabs = uniqueTabs(
      Array.isArray(value.closedTabs) ? value.closedTabs : [],
      new Set(tabs.map((tab) => tab.id)),
    ).slice(0, 20);
    return { version: 1, tabs, closedTabs };
  } catch {
    return { version: 1, tabs: [], closedTabs: [] };
  }
}

export function loadAnalysisWorkspace(): AnalysisWorkspaceSnapshot {
  if (typeof window === "undefined") return { version: 1, tabs: [], closedTabs: [] };
  return parseAnalysisWorkspace(window.localStorage.getItem(ANALYSIS_WORKSPACE_STORAGE_KEY));
}

export function saveAnalysisWorkspace(
  tabs: AnalysisWorkspaceTab[],
  closedTabs = loadAnalysisWorkspace().closedTabs,
): void {
  if (typeof window === "undefined") return;
  try {
    const snapshot = { version: 1, tabs, closedTabs } satisfies AnalysisWorkspaceSnapshot;
    window.localStorage.setItem(
      ANALYSIS_WORKSPACE_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
    window.dispatchEvent(
      new CustomEvent(ANALYSIS_WORKSPACE_TABS_EVENT, { detail: snapshot }),
    );
  } catch {
    // Losing tab history must never interfere with the analysis editor.
  }
}

export function openAnalysisWorkspaceTab(tab: AnalysisWorkspaceTab): AnalysisWorkspaceSnapshot {
  const current = loadAnalysisWorkspace();
  const existing = current.tabs.find((candidate) => candidate.id === tab.id);
  const tabs = existing
    ? current.tabs.map((candidate) => (candidate.id === tab.id ? { ...candidate, ...tab } : candidate))
    : [...current.tabs, tab];
  const closedTabs = current.closedTabs.filter((candidate) => candidate.id !== tab.id);
  saveAnalysisWorkspace(tabs, closedTabs);
  return { version: 1, tabs, closedTabs };
}

export function showAnalysisWorkspaceView(analysisId: number | null): void {
  activeWorkspaceViewId = analysisId;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(ANALYSIS_WORKSPACE_ACTIVE_EVENT, { detail: analysisId }),
  );
}

export function isAnalysisWorkspaceViewActive(analysisId: number): boolean {
  if (activeWorkspaceViewId !== undefined) return activeWorkspaceViewId === analysisId;
  if (typeof window === "undefined") return false;
  return window.location.pathname === `/analyses/${analysisId}`;
}

export function markAnalysisWorkspaceMounted(analysisId: number): void {
  if (mountedAnalysisIds.has(analysisId)) return;
  mountedAnalysisIds.add(analysisId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ANALYSIS_WORKSPACE_MOUNTED_EVENT, {
        detail: { analysisId, mounted: true },
      }),
    );
  }
}

export function unmarkAnalysisWorkspaceMounted(analysisId: number): void {
  if (!mountedAnalysisIds.delete(analysisId)) return;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ANALYSIS_WORKSPACE_MOUNTED_EVENT, {
        detail: { analysisId, mounted: false },
      }),
    );
  }
}

export function getMountedAnalysisWorkspaceIds(): number[] {
  return [...mountedAnalysisIds];
}

export function loadAnalysisWorkspaceMemoryPolicy(): AnalysisWorkspaceMemoryPolicy {
  if (typeof window === "undefined") return "keep-mounted";
  return window.localStorage.getItem(ANALYSIS_WORKSPACE_POLICY_STORAGE_KEY) === "unmount"
    ? "unmount"
    : "keep-mounted";
}

export function saveAnalysisWorkspaceMemoryPolicy(policy: AnalysisWorkspaceMemoryPolicy): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ANALYSIS_WORKSPACE_POLICY_STORAGE_KEY, policy);
  window.dispatchEvent(new CustomEvent(ANALYSIS_WORKSPACE_POLICY_EVENT, { detail: policy }));
}

export function getAnalysisWorkspaceEditorState(
  analysisId: number,
): AnalysisWorkspaceEditorState | null {
  return editorStates.get(analysisId) ?? null;
}

export function setAnalysisWorkspaceEditorState(state: AnalysisWorkspaceEditorState): void {
  const previous = editorStates.get(state.analysisId);
  editorStates.set(state.analysisId, state);
  const dirty = state.dirty || state.hasUnsavedPlot;
  const previousDirty = Boolean(previous?.dirty || previous?.hasUnsavedPlot);
  if (
    typeof window !== "undefined" &&
    (!previous || previous.title !== state.title || previousDirty !== dirty)
  ) {
    window.dispatchEvent(
      new CustomEvent(ANALYSIS_WORKSPACE_CHANGED_EVENT, {
        detail: {
          analysisId: state.analysisId,
          title: state.title,
          dirty,
        },
      }),
    );
  }
}

export function clearAnalysisWorkspaceEditorState(analysisId: number): void {
  editorStates.delete(analysisId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ANALYSIS_WORKSPACE_CHANGED_EVENT, {
        detail: { analysisId, title: null, dirty: false },
      }),
    );
  }
}

export function hasDirtyAnalysisWorkspaceEditors(): boolean {
  return [...editorStates.values()].some((state) => state.dirty || state.hasUnsavedPlot);
}
