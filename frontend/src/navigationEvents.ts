export const ANALYSIS_LEAVE_EVENT = "cellxplorer:analysis-leave-request";

export interface AnalysisLeaveRequestDetail {
  proceed: () => void;
}
