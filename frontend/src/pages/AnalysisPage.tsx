import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";

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
  const navigate = useNavigate();
  const onOpenAnalysis = useCallback((id: number) => navigate(`/analyses/${id}`), [navigate]);
  const onOpenAnalysisDatabase = useCallback(() => navigate("/analyses"), [navigate]);

  return (
    <AnalysisEditor
      analysisId={aid}
      workspaceVisible={workspaceVisible}
      onOpenAnalysis={onOpenAnalysis}
      onOpenAnalysisDatabase={onOpenAnalysisDatabase}
    />
  );
}
