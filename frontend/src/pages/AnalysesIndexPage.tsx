import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  AnalysesIndexView,
  type AnalysesIndexNavigationOptions,
  type AnalysesIndexRouteIntent,
} from "../features/analyses/database/AnalysesIndexView";

export function AnalysesIndexPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeIntent: AnalysesIndexRouteIntent = {
    openCreate: searchParams.get("new") === "1",
    openPortableImport: searchParams.get("portableImport") === "1",
    portableSource: searchParams.get("portableSource"),
  };

  const consumeRouteKeys = useCallback(
    (keys: Array<"new" | "portableImport" | "portableSource">) => {
      const next = new URLSearchParams(searchParams);
      keys.forEach((key) => next.delete(key));
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true });
      }
    },
    [searchParams, setSearchParams],
  );

  const navigateToAnalysis = useCallback(
    (analysisId: number, options?: AnalysesIndexNavigationOptions) => {
      const plotQuery = options?.plotId
        ? `?plot=${encodeURIComponent(options.plotId)}`
        : "";
      navigate(`/analyses/${analysisId}${plotQuery}`);
    },
    [navigate],
  );

  const navigateToFolder = useCallback(
    (folderId: number) => navigate(`/projects?folder=${folderId}`),
    [navigate],
  );

  return (
    <AnalysesIndexView
      routeIntent={routeIntent}
      consumeRouteKeys={consumeRouteKeys}
      navigateToAnalysis={navigateToAnalysis}
      navigateToFolder={navigateToFolder}
    />
  );
}
