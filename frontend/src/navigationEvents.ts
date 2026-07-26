export const ANALYSIS_LEAVE_EVENT = "cellxplorer:analysis-leave-request";

/** Why the workspace is asking the active analysis to settle unsaved work. */
export type AnalysisLeaveReason = "navigate" | "close-tab";

export interface AnalysisLeaveRequestDetail {
  proceed: () => void;
  /**
   * `navigate` — another app page; tab stays open → auto-persist draft, no modal.
   * `close-tab` — user closed the analysis tab → show the leave prompt.
   */
  reason: AnalysisLeaveReason;
}
