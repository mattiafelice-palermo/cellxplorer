import { useParams } from "react-router-dom";

import { AnalysisEditor } from "../features/analyses/editor/AnalysisEditor";

export interface AnalysisPageProps {
  analysisIdOverride?: number;
  workspaceVisible?: boolean;
}

export function AnalysisPage({
  analysisIdOverride,
  workspaceVisible = true,
}: AnalysisPageProps = {}) {
  const { analysisId } = useParams();
  const aid = analysisIdOverride ?? Number(analysisId);

  return <AnalysisEditor analysisId={aid} workspaceVisible={workspaceVisible} />;
}
